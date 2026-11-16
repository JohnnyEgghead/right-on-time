// SPDX-License-Identifier: AGPL-3.0-or-later
// What a write reads under its locks, and the settle step every write that touches a technician-day ends with
// (SPECIFICATIONS section 5.3 step 2, SD-15, SD-27): recompute the day's planned arrivals and check its jobs against
// its blocks. Every function here runs inside the caller's transaction, after the locks of locks.ts.
import type { Queryable } from '@bw/db';
import {
  dayKind, dayRoom, firstOverlap, isLive, offeredWindows, planDay, previousStop, skillMatch, technicianDayCapacity, technicianHasRoom, technicianRoomLimit, windowRoom, worksOn,
  type DayKind, type DayMode, type RoomLimit, type TechnicianFacts,
} from '@bw/domain';
import { atLocal, Temporal, toWire } from '@bw/time';
import { routedDrive } from '../../../maps/src/route-source.ts';
import type { TechnicianDayKey } from './locks.ts';

const instant = (d: Date): Temporal.Instant => Temporal.Instant.fromEpochMilliseconds(d.getTime());
export const wire = (d: Date, zone: string): string => toWire(instant(d), zone);
export const at = (date: string, time: string, zone: string): Date =>
  new Date(atLocal(date, time.slice(0, 5), zone, 'compatible').epochMilliseconds);

export interface Branch {
  id: string;
  zone: string;
  depot: { lon: number; lat: number };
}

export async function readBranch(tx: Queryable, id: string): Promise<Branch> {
  const r = await tx.query<{ id: string; zone: string; depot_lon: number; depot_lat: number }>(
    'SELECT id, zone, depot_lon, depot_lat FROM world.branch WHERE id = $1', [id]);
  const b = r.rows[0];
  if (!b) throw new Error(`branch ${id} does not exist`);
  return { id: b.id, zone: b.zone, depot: { lon: b.depot_lon, lat: b.depot_lat } };
}

export interface Technician extends TechnicianFacts {
  branch: string;
  name: string;
  shiftStart: string;
}

interface TechnicianRow {
  id: string; branch_id: string; name: string; installer: boolean; working_days: number[]; saturdays: TechnicianFacts['saturdays'];
  shift_start: string; time_off: { from: string; to: string }[];
}

const TECHNICIAN_SQL = `
  SELECT t.id, t.branch_id, t.name, t.installer, t.working_days, t.saturdays, t.shift_start::text AS shift_start,
         coalesce((SELECT json_agg(json_build_object('from', o.from_date, 'to', o.to_date)) FROM world.time_off o
                    WHERE o.technician_id = t.id), '[]'::json) AS time_off
    FROM world.technician t`;

const technicianOf = (r: TechnicianRow): Technician => ({
  id: r.id, branch: r.branch_id, name: r.name, installer: r.installer, workingDays: r.working_days, saturdays: r.saturdays,
  shiftStart: r.shift_start, timeOff: r.time_off,
});

export async function readTechnician(tx: Queryable, id: string): Promise<Technician | null> {
  const r = await tx.query<TechnicianRow>(`${TECHNICIAN_SQL} WHERE t.id = $1`, [id]);
  return r.rows[0] ? technicianOf(r.rows[0]) : null;
}

export async function branchTechnicians(tx: Queryable, branch: string): Promise<Technician[]> {
  const r = await tx.query<TechnicianRow>(`${TECHNICIAN_SQL} WHERE t.branch_id = $1 ORDER BY t.id`, [branch]);
  return r.rows.map(technicianOf);
}

export interface Window {
  id: string;
  branch: string;
  mode: DayMode;
  startLocal: string;
  endLocal: string;
  capacity: number | null;
}

export async function readWindow(tx: Queryable, id: string): Promise<Window | null> {
  const r = await tx.query<{ id: string; branch_id: string; mode: DayMode; start_local: string; end_local: string; capacity: number | null }>(
    'SELECT id, branch_id, mode, start_local::text AS start_local, end_local::text AS end_local, capacity FROM world.arrival_window WHERE id = $1', [id]);
  const w = r.rows[0];
  return w ? { id: w.id, branch: w.branch_id, mode: w.mode, startLocal: w.start_local, endLocal: w.end_local, capacity: w.capacity } : null;
}

export async function branchWindows(tx: Queryable, branch: string): Promise<Window[]> {
  const r = await tx.query<{ id: string }>('SELECT id FROM world.arrival_window WHERE branch_id = $1 ORDER BY mode, start_local', [branch]);
  // F-886: 1 query at a time on the transaction's client (a Promise.all here issued a query on a busy client; pg warns and drops this in pg@9).
  const windows: Window[] = [];
  for (const x of r.rows) {
    const w = await readWindow(tx, x.id);
    if (w !== null) windows.push(w);
  }
  return windows;
}

/** The kind of a branch day: its day_mode row (none: two_hour), a Saturday or a Sunday (FR-BOOK-2, FR-BOOK-10). */
export async function readDayKind(tx: Queryable, branch: string, date: string): Promise<DayKind> {
  const r = await tx.query<{ mode: DayMode }>('SELECT mode FROM world.day_mode WHERE branch_id = $1 AND date = $2::date', [branch, date]);
  return dayKind(date, r.rows[0]?.mode ?? 'two_hour');
}

/** Whether the date offers the window (FR-BOOK-7, FR-BOOK-10). */
export function windowOffered(w: Window, kind: DayKind): boolean {
  return offeredWindows([w], kind).length === 1;
}

export async function serviceIsInstall(tx: Queryable, serviceId: string): Promise<boolean | null> {
  const r = await tx.query<{ skill: string }>('SELECT skill FROM world.service_type WHERE id = $1', [serviceId]);
  return r.rows[0] ? r.rows[0].skill === 'install' : null;
}

/** A branch day's room for a service on the office channel: dayRoom, and the day's live jobs that each window's room is counted from. */
export interface OfficeDay {
  room: number;
  live: readonly { window_id: string }[];
}

/**
 * The facts of the office channel's room (FR-BOOK-5, FR-BOOK-6, FR-DISP-8: no online cutoff, same day allowed). `excludeJob` leaves out
 * the job being moved, so a reschedule counts the day without itself.
 */
export async function officeDay(tx: Queryable, input: { branch: string; date: string; kind: DayKind; install: boolean; excludeJob?: number }): Promise<OfficeDay> {
  const techs = (await branchTechnicians(tx, input.branch)).filter((t) => worksOn(t, input.date));
  const jobs = await tx.query<{ install: boolean; window_id: string; status: string }>(
    `SELECT s.skill = 'install' AS install, j.window_id, j.status FROM world.job j JOIN world.service_type s ON s.id = j.service_id
      WHERE j.branch_id = $1 AND j.date = $2::date AND j.job_number <> $3`, [input.branch, input.date, input.excludeJob ?? -1]);
  const live = jobs.rows.filter((j) => isLive(j.status));
  return { room: dayRoom({ kind: input.kind, working: techs, serviceIsInstall: input.install, liveJobs: live }), live };
}

export const roomInWindow = (day: OfficeDay, window: Window): number =>
  windowRoom({ windowCapacity: window.capacity, windowLiveJobs: day.live.filter((j) => j.window_id === window.id).length, dayRoom: day.room });

/** windowRoom for the office channel, read under the booking-day lock. */
export async function officeWindowRoom(tx: Queryable, input: {
  branch: string; date: string; window: Window; kind: DayKind; install: boolean; excludeJob?: number;
}): Promise<number> {
  return roomInWindow(await officeDay(tx, input), input.window);
}

/**
 * API-29's count for a span of days (SPECIFICATIONS FR-DISP-8, UI-SPECIFICATION 12.4): how many of the branch's technicians with the
 * service's skill, primary or secondary, have SD-27 room in a window. Reads the span's facts once: the page asks for 60 days.
 */
export async function skilledRoomCounter(tx: Queryable, input: { branch: string; serviceId: string; from: string; to: string; excludeJob?: number }): Promise<(date: string, window: Window, kind: DayKind) => number> {
  const service = await tx.query<{ skill: string }>('SELECT skill FROM world.service_type WHERE id = $1', [input.serviceId]);
  const skills = await tx.query<{ id: string; primary_skill: string; skills: string[] }>('SELECT id, primary_skill, skills FROM world.technician WHERE branch_id = $1', [input.branch]);
  const can = new Set(skills.rows.filter((r) => skillMatch({ primarySkill: r.primary_skill, skills: r.skills }, service.rows[0]?.skill ?? '') !== 'none').map((r) => r.id));
  const skilled = (await branchTechnicians(tx, input.branch)).filter((t) => can.has(t.id));
  const jobs = await tx.query<{ technician_id: string; date: string; window_id: string; n: string }>(
    `SELECT technician_id, date::text AS date, window_id, count(*) AS n FROM world.job
      WHERE technician_id = ANY($1) AND date BETWEEN $2::date AND $3::date AND status <> 'canceled' AND job_number <> $4
      GROUP BY technician_id, date, window_id`, [skilled.map((t) => t.id), input.from, input.to, input.excludeJob ?? -1]);
  const inDay = new Map<string, number>();
  const inWindow = new Map<string, number>();
  for (const j of jobs.rows) {
    const day = `${j.technician_id} ${j.date}`;
    inDay.set(day, (inDay.get(day) ?? 0) + Number(j.n));
    inWindow.set(`${day} ${j.window_id}`, Number(j.n));
  }
  return (date, window, kind) => skilled.filter((t) => worksOn(t, date) && technicianHasRoom({
    capacity: technicianDayCapacity(t, kind), jobsThatDay: inDay.get(`${t.id} ${date}`) ?? 0, jobsInWindow: inWindow.get(`${t.id} ${date} ${window.id}`) ?? 0, windowMode: window.mode,
  })).length;
}

/**
 * SD-27 room for 1 technician in 1 window, read under that technician-day's lock, leaving out `excludeJob` (the job
 * being placed, so placing a job where it already is counts the day without it).
 */
export async function technicianRoom(tx: Queryable, t: Technician, date: string, window: Window, kind: DayKind, excludeJob: number): Promise<boolean> {
  return (await technicianRoomRefusal(tx, t, date, window, kind, excludeJob)) === null;
}

/** The same read as technicianRoom, answering the limit that refuses the placement (F-1701), or null when there is room. */
export async function technicianRoomRefusal(tx: Queryable, t: Technician, date: string, window: Window, kind: DayKind, excludeJob: number): Promise<RoomLimit | null> {
  const r = await tx.query<{ day: string; win: string }>(
    `SELECT count(*) AS day, count(*) FILTER (WHERE window_id = $3) AS win FROM world.job
      WHERE technician_id = $1 AND date = $2::date AND status <> 'canceled' AND job_number <> $4`, [t.id, date, window.id, excludeJob]);
  const row = r.rows[0] ?? { day: '0', win: '0' };
  return technicianRoomLimit({ capacity: technicianDayCapacity(t, kind), installer: t.installer, jobsThatDay: Number(row.day), jobsInWindow: Number(row.win), windowMode: window.mode });
}

/** SD-22's previous stop of the leg to `jobNumber`, read from the technician's day: the last ended job, or null for the depot (F-515). */
export async function readPreviousStop(tx: Queryable, technicianId: string, date: string, jobNumber: number): Promise<{ jobNumber: number; lon: number; lat: number } | null> {
  const r = await tx.query<{ job_number: number; status: string; ended_at: Date | null; lon: number; lat: number }>(
    `SELECT p.job_number, p.status, p.ended_at, c.lon, c.lat FROM world.job p JOIN world.customer c ON c.id = p.customer_id
      WHERE p.technician_id = $1 AND p.date = $2::date AND p.status IN ('done', 'no_one_home')`, [technicianId, date]);
  const stop = previousStop(r.rows.map((j) => ({ jobNumber: j.job_number, status: j.status, endedAt: j.ended_at?.getTime() ?? null, lon: j.lon, lat: j.lat })), jobNumber);
  return stop ? { jobNumber: stop.jobNumber, lon: stop.lon, lat: stop.lat } : null;
}

export interface Overlap {
  block: { blockId: string; label: string; place: string | null; start: string; end: string };
  job: { jobNumber: number; plannedArrival: string; plannedEnd: string };
}

/**
 * Settle 1 technician-day (section 5.3 step 2, SD-15): plan its live jobs, write each changed planned arrival (derived:
 * the version is untouched), and return the first overlap between a scheduled job's planned time and a block on the
 * row, or null. Only scheduled jobs are checked: a job on the way, on site or ended has actual times, not a plan.
 * The caller holds the day's lock and decides what an overlap means (refuse, or unassign as SD-45 does).
 */
export async function settleDay(tx: Queryable, key: TechnicianDayKey): Promise<Overlap | null> {
  const t = await readTechnician(tx, key.technicianId);
  if (!t) throw new Error(`technician ${key.technicianId} does not exist`);
  const branch = await readBranch(tx, t.branch);
  const jobs = await tx.query<{
    job_number: number; window_start: Date; booked_at: Date; expected_minutes: number; status: string; planned_arrival: Date | null; lon: number; lat: number;
  }>(
    `SELECT j.job_number, j.window_start, j.booked_at, j.expected_minutes, j.status, j.planned_arrival, c.lon, c.lat
       FROM world.job j JOIN world.customer c ON c.id = j.customer_id
      WHERE j.technician_id = $1 AND j.date = $2::date AND j.status <> 'canceled'`, [t.id, key.date]);
  // SD-15 (F-380): drive minutes are the leg's track's last cumulative second / 60, rounded up, else SD-22's approximate minutes. The
  // tracks come from SD-49's route source for the legs the plan walks (routedDrive): a leg no track covers is routed live and stored
  // (P6-LIVE-ROUTING). In the web server the ask waits between 2 passes of the call, with no transaction and so no lock held (F-1504,
  // route-source.ts routedOutside); docs/build/spikes/P6-LIVE-ROUTING.md measured the lock time on the timeout path before that.
  const day = {
    shiftStart: at(key.date, t.shiftStart, branch.zone).getTime(),
    depot: branch.depot,
    stops: jobs.rows.map((j) => ({
      jobNumber: j.job_number, windowStart: j.window_start.getTime(), bookedAt: j.booked_at.getTime(), expectedMinutes: j.expected_minutes,
      point: { lon: j.lon, lat: j.lat },
    })),
  };
  const plan = planDay({ ...day, drive: await routedDrive(tx, branch.id, (drive) => planDay({ ...day, drive })) });
  const before = new Map(jobs.rows.map((j) => [j.job_number, j]));
  const changed = plan.filter((p) => before.get(p.jobNumber)?.planned_arrival?.getTime() !== p.plannedArrival);
  if (changed.length > 0) {
    await tx.query(
      `UPDATE world.job j SET planned_arrival = p.at FROM unnest($1::int[], $2::timestamptz[]) AS p(n, at) WHERE j.job_number = p.n`,
      [changed.map((p) => p.jobNumber), changed.map((p) => new Date(p.plannedArrival))]);
  }
  const blocks = await tx.query<{ id: string; label: string; place: string | null; start: Date; end: Date }>(
    'SELECT id, label, place, start, "end" FROM world.time_block WHERE technician_id = $1 AND date = $2::date ORDER BY start, id', [t.id, key.date]);
  const scheduled = plan.filter((p) => before.get(p.jobNumber)?.status === 'scheduled');
  const hit = firstOverlap(scheduled, blocks.rows.map((b) => ({ ...b, start: b.start.getTime(), end: b.end.getTime() })));
  if (!hit) return null;
  const z = branch.zone;
  return {
    block: { blockId: hit.block.id, label: hit.block.label, place: hit.block.place, start: wire(new Date(hit.block.start), z), end: wire(new Date(hit.block.end), z) },
    job: { jobNumber: hit.job.jobNumber, plannedArrival: wire(new Date(hit.job.plannedArrival), z), plannedEnd: wire(new Date(hit.job.plannedEnd), z) },
  };
}
