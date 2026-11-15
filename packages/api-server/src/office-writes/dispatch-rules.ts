// SPDX-License-Identifier: AGPL-3.0-or-later
// The dispatch rules on the office write service (SPECIFICATIONS SD-26, SD-28, SD-45; FR-DISP-28, FR-DISP-33; OA-78,
// OI-44). The decisions are @bw/domain's pure rules (dispatch.ts); this file reads their facts under the locks of
// locks.ts (section 5.3) and writes the result in the caller's 1 transaction, as service.ts does:
//
//   suggestTechnicians  SD-26 ranking, a read (API-30). No lock: it is advice, and assignJob re-checks under the locks.
//   recordTimeOff       SD-28: lock the technician-day of every date in the span, refuse (rule_refused) while a job is on the
//                       way or on site, store the span, unassign the scheduled jobs (version + 1 and a job_change row of
//                       kind unassigned_time_off each), settle the days, return the jobs for reassignment (API-148).
//   removeTimeOff       delete the span; no job changes and nothing is asked (OI-44: the opposite control undoes it, API-169).
//   setWorkingHours     API-33's hours write: a write that changes a technician's day (section 5.3 step 2), so it takes the day locks and settles
//                       every day from today on; a job left on a day no longer worked stays and is named (no text moves it, F-764).
//   The reschedule keep-or-unassign rule (SD-45) is rescheduleJob's, in service.ts, deciding with keepTechnicianOnReschedule.
import { publishEvent, type Queryable } from '@bw/db';
import {
  approximateDriveMinutes, areaSql, rankTechnicians, skillMatch, technicianDayCapacity, timeOffOutcome, worksOn,
  type Ranked, type RankFacts,
} from '@bw/domain';
import { addDays, Temporal } from '@bw/time';
import { legFor } from '../../../maps/src/route-source.ts';
import { at, branchTechnicians, readBranch, readDayKind, readTechnician, readWindow, settleDay, technicianRoom, wire } from './day.ts';
import { lockTechnicianDays, type TechnicianDayKey } from './locks.ts';
import { appendJobChange, OFFICE_HORIZON_DAYS, WriteRefused, type WriteContext } from './service.ts';

/** The longest span 1 time-off write locks (1 lock per day): a year. */
export const MAX_TIME_OFF_DAYS = 366;

export interface SuggestInput {
  branch: string;
  serviceId: string;
  customerId: string;
  date: string;
  windowId: string;
  /** The job being moved, left out of every count and of the stop before (a job already on the board). */
  excludeJob?: number;
}

/** The stop before the window (F-424: the 1 the drive minutes are counted from): its planned time and area; null when the day has none (the branch depot). */
export interface StopBefore {
  jobNumber: number;
  plannedArrival: string;
  area: string;
}

/** SD-26 over the database: the branch's technicians who work the date with no time off, ranked for the job, each with its stop before (F-424). */
export async function suggestTechnicians(tx: Queryable, input: SuggestInput): Promise<(Ranked & { stopBefore: StopBefore | null })[]> {
  const s = await tx.query<{ skill: string }>('SELECT skill FROM world.service_type WHERE id = $1', [input.serviceId]);
  const service = s.rows[0];
  if (!service) throw new WriteRefused('validation_failed', `service ${input.serviceId} does not exist`);
  const c = await tx.query<{ lon: number; lat: number }>('SELECT lon, lat FROM world.customer WHERE id = $1', [input.customerId]);
  const customer = c.rows[0];
  if (!customer) throw new WriteRefused('validation_failed', `customer ${input.customerId} does not exist`);
  const window = await readWindow(tx, input.windowId);
  if (!window || window.branch !== input.branch) throw new WriteRefused('validation_failed', `window ${input.windowId} is not a window of ${input.branch}`);
  const branch = await readBranch(tx, input.branch);
  const kind = await readDayKind(tx, branch.id, input.date);
  const exclude = input.excludeJob ?? -1;
  const windowStart = at(input.date, window.startLocal, branch.zone);
  // F-427: a job already on the board sorts in its window by booked at, then job number (planDay's order), so the stop
  // before it is the last job that sorts before it; a job booked after it in the same window comes after it in the plan.
  const moved = input.excludeJob === undefined ? null
    : (await tx.query<{ booked_at: Date }>('SELECT booked_at FROM world.job WHERE job_number = $1', [input.excludeJob])).rows[0] ?? null;
  const skillRows = await tx.query<{ id: string; primary_skill: string; skills: string[] }>(
    'SELECT id, primary_skill, skills FROM world.technician WHERE branch_id = $1', [branch.id]);
  const skillOf = new Map(skillRows.rows.map((r) => [r.id, r]));
  const facts: RankFacts[] = [];
  const stops = new Map<string, StopBefore | null>();
  for (const t of (await branchTechnicians(tx, branch.id)).filter((x) => worksOn(x, input.date))) {
    const day = await tx.query<{ n: string }>(
      `SELECT count(*) AS n FROM world.job WHERE technician_id = $1 AND date = $2::date AND status <> 'canceled' AND job_number <> $3`,
      [t.id, input.date, exclude]);
    // The stop before the window: the last live job that day starting at or before the window, in plan order (SD-15).
    const prior = await tx.query<{ job_number: number; lon: number; lat: number; area: string; planned: Date; zone: string }>(
      `SELECT j.job_number, c.lon, c.lat, ${areaSql('s.city', 's.zip')} AS area, COALESCE(j.planned_arrival, j.window_start) AS planned, j.zone
          FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.street s ON s.id = c.street_id
        WHERE j.technician_id = $1 AND j.date = $2::date AND j.status <> 'canceled' AND j.job_number <> $3
          AND (j.window_start < $4 OR (j.window_start = $4 AND ($5::timestamptz IS NULL OR (j.booked_at, j.job_number) < ($5::timestamptz, $3))))
        ORDER BY j.window_start DESC, j.booked_at DESC, j.job_number DESC LIMIT 1`,
      [t.id, input.date, exclude, windowStart, moved?.booked_at ?? null]);
    const row = skillOf.get(t.id);
    // SD-15 (F-425): the same drive minutes the planner uses, from SD-49's route source (the stored track, else a live route). A job not
    // yet on the board has no number, so its leg is SD-22's approximate minutes.
    const stop = prior.rows[0];
    const from = stop ? { lon: stop.lon, lat: stop.lat } : branch.depot;
    const driveMinutes = input.excludeJob === undefined
      ? approximateDriveMinutes(from, customer)
      : (await legFor(tx, branch.id, { job: stop?.job_number ?? null, ...from }, { job: input.excludeJob, ...customer })).minutes;
    stops.set(t.id, stop ? { jobNumber: stop.job_number, plannedArrival: wire(stop.planned, stop.zone), area: stop.area } : null);
    facts.push({
      id: t.id, name: t.name,
      skill: row ? skillMatch({ primarySkill: row.primary_skill, skills: row.skills }, service.skill) : 'none',
      room: await technicianRoom(tx, t, input.date, window, kind, exclude),
      driveMinutes,
      jobsThatDay: Number(day.rows[0]?.n ?? 0),
      capacity: technicianDayCapacity(t, kind),
    });
  }
  return rankTechnicians(facts).map((r) => ({ ...r, stopBefore: stops.get(r.technicianId) ?? null }));
}

export interface UnassignedJob {
  jobNumber: number; date: string; windowId: string; window: { start: string; end: string }; customerId: string; serviceId: string; version: number;
}

export interface TimeOffRecorded {
  timeOffId: string;
  technicianId: string;
  from: string;
  to: string;
  /** The booked jobs that came off the technician, listed for reassignment (GAP-25), in date then job order. */
  unassigned: UnassignedJob[];
}

/** The days from `from` to `to` inclusive, or null when either is not a real YYYY-MM-DD date. Counts with Temporal; builds no list. */
const spanDays = (from: string, to: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
  try {
    return Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to), { largestUnit: 'days' }).days + 1;
  } catch {
    return null;
  }
};

const datesIn = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

/**
 * recordTimeOff (API-148; SD-28, OA-78): the technician is off from `from` to `to` (inclusive local dates). Refuses
 * with rule_refused, naming the jobs, while a job of theirs in the span is on the way or on site; the refusal rolls
 * the whole write back, so no span is stored. Otherwise every scheduled job in the span is unassigned with
 * version + 1 and a job_change row of kind `unassigned_time_off`, and returned.
 */
export async function recordTimeOff(tx: Queryable, ctx: WriteContext, input: {
  technicianId: string; from: string; to: string; note: string | null;
}): Promise<TimeOffRecorded> {
  // F-426: check the dates and the span before building the list of days, so a span to year 9999 or a malformed date costs nothing.
  const span = spanDays(input.from, input.to);
  if (span === null) throw new WriteRefused('validation_failed', `time off from ${input.from} to ${input.to} is not 2 dates of the form YYYY-MM-DD`);
  if (span < 1) throw new WriteRefused('validation_failed', `time off ends ${input.to}, before it starts ${input.from}`);
  if (span > MAX_TIME_OFF_DAYS) throw new WriteRefused('validation_failed', `time off spans ${span} days; the most is ${MAX_TIME_OFF_DAYS}`);
  const days = datesIn(input.from, input.to);
  const who = await tx.query<{ branch_id: string }>('SELECT branch_id FROM world.technician WHERE id = $1', [input.technicianId]);
  if (!who.rows[0]) throw new WriteRefused('not_found', `technician ${input.technicianId} does not exist`);
  const keys: TechnicianDayKey[] = days.map((date) => ({ technicianId: input.technicianId, date }));
  await lockTechnicianDays(tx, keys);
  // Job rows come after the day locks (section 5.3 step 6); FOR UPDATE keeps an item write from moving one under us.
  const jobs = await tx.query<{
    job_number: number; status: string; date: string; window_id: string; window_start: Date; window_end: Date; zone: string;
    customer_id: string; service_id: string; version: number;
  }>(
    `SELECT job_number, status, date::text AS date, window_id, window_start, window_end, zone, customer_id, service_id, version
       FROM world.job WHERE technician_id = $1 AND date BETWEEN $2::date AND $3::date AND status <> 'canceled'
      ORDER BY date, job_number FOR UPDATE`, [input.technicianId, input.from, input.to]);
  const outcome = timeOffOutcome(jobs.rows.map((j) => ({ jobNumber: j.job_number, status: j.status })));
  if (outcome.refused.length > 0) {
    throw new WriteRefused('rule_refused', `technician ${input.technicianId} has a job on the way or on site in the span`, { jobNumbers: outcome.refused });
  }
  const ins = await tx.query<{ id: string }>(
    'INSERT INTO world.time_off (technician_id, from_date, to_date, note, created_by) VALUES ($1, $2::date, $3::date, $4, $5) RETURNING id',
    [input.technicianId, input.from, input.to, input.note, ctx.actor.userId]);
  const unassigned: UnassignedJob[] = [];
  for (const j of jobs.rows.filter((r) => outcome.unassign.includes(r.job_number))) {
    // Unconditional on the version: the locks and FOR UPDATE above hold the row; the new version is the one read plus 1.
    await tx.query('UPDATE world.job SET technician_id = NULL, planned_arrival = NULL, touched_by_person = true, version = version + 1 WHERE job_number = $1', [j.job_number]);
    await appendJobChange(tx, ctx, {
      jobNumber: j.job_number, kind: 'unassigned_time_off', fromVersion: j.version, toVersion: j.version + 1,
      data: { from: { technicianId: input.technicianId }, to: { technicianId: null }, timeOffId: ins.rows[0]?.id },
    });
    await publishEvent(tx, 'job.changed', { jobNumber: j.job_number, branch: (who.rows[0] as { branch_id: string }).branch_id });
    unassigned.push({
      jobNumber: j.job_number, date: j.date, windowId: j.window_id,
      window: { start: wire(j.window_start, j.zone), end: wire(j.window_end, j.zone) }, customerId: j.customer_id, serviceId: j.service_id,
      version: j.version + 1,
    });
  }
  // Re-plan the days the time off emptied of scheduled jobs (a job done earlier that day still has its plan).
  for (const date of new Set(jobs.rows.map((j) => j.date))) await settleDay(tx, { technicianId: input.technicianId, date });
  return { timeOffId: ins.rows[0]?.id as string, technicianId: input.technicianId, from: input.from, to: input.to, unassigned };
}

/**
 * removeTimeOff (API-169; SD-28, OI-44): delete the span. No confirm step, and no job changes: the jobs that came off
 * stay Unassigned until the office reassigns them. Adding the span again is its opposite control.
 */
export async function removeTimeOff(tx: Queryable, _ctx: WriteContext, input: { timeOffId: string }): Promise<void> {
  const d = await tx.query('DELETE FROM world.time_off WHERE id = $1', [input.timeOffId]);
  if ((d.rowCount ?? 0) === 0) throw new WriteRefused('not_found', `time off ${input.timeOffId} does not exist`);
}

export interface OffDayJob { jobNumber: number; date: string; window: { start: string; end: string } }

/**
 * setWorkingHours (API-33; FR-DISP-33, section 5.3 step 2, F-764): store the shift, the weekdays and the Saturday pattern, then settle what they change.
 *   Locks: every technician-day from today through the office horizon, and any later day holding a job. A day with no job is locked too: a booking
 *   running beside this write reads the old shift under its day lock, so without that lock it could commit a plan this write never settles.
 *   Settle: every day from today on that holds a job (planned arrivals are derived: no version change, no job_change row, section 5.3 step 1). A past day
 *   keeps the plan it ran on. An overlap with a block is not a refusal: API-33 names no time_overlap, so it stays for the office to see, as a cancel's does (F-504).
 *   Events: 1 board.refresh for the branch when any planned arrival moved, so an open board follows (F-822). No text or worker reads the event, so a re-run adds nothing.
 *   A scheduled job on a day no longer worked is unassigned, as SD-28 does for time off (owner ruling c9f57035, F-794: "Unassign it"): technician and
 *   planned arrival cleared, version + 1, a job_change row of kind `assigned` (from this technician to nobody, by the editing office person), job.changed;
 *   the jobs are returned for the page to name, and stay Unassigned until the office reassigns them. A job on the way or on site is being worked and stays.
 *   Replay: the same hours sent again write the same row, settle to the same plan (settleDay writes only what changed), publish nothing and return [] (the jobs are already off).
 * The caller holds the technician row with FOR NO KEY UPDATE, never FOR UPDATE: a writer under a day lock takes FOR KEY SHARE on that row when it
 * sets a job's technician, and FOR UPDATE would deadlock against the day locks taken here.
 */
export async function setWorkingHours(tx: Queryable, ctx: WriteContext, input: {
  technicianId: string; branch: string; today: string; hours: { start: string; end: string; days: readonly number[]; saturdays: string };
}): Promise<OffDayJob[]> {
  const { technicianId: id, today, hours: h } = input;
  const dated = await tx.query<{ date: string }>(`SELECT DISTINCT date::text AS date FROM world.job WHERE technician_id = $1 AND date >= $2::date AND status <> 'canceled'`, [id, today]);
  const horizon = datesIn(today, addDays(today, OFFICE_HORIZON_DAYS));
  await lockTechnicianDays(tx, [...horizon, ...dated.rows.map((r) => r.date)].map((date) => ({ technicianId: id, date })));
  // Read under the locks: a write that held one of the days has committed, and any job it placed is here.
  type Live = { job_number: number; date: string; status: string; planned_arrival: Date | null; window_start: Date; window_end: Date; zone: string };
  const live = async () => (await tx.query<Live>(
    `SELECT job_number, date::text AS date, status, planned_arrival, window_start, window_end, zone FROM world.job
      WHERE technician_id = $1 AND date >= $2::date AND status <> 'canceled' ORDER BY date, job_number`, [id, today])).rows;
  const before = await live();
  await tx.query('UPDATE world.technician SET shift_start = $2::time, shift_end = $3::time, working_days = $4, saturdays = $5 WHERE id = $1',
    [id, h.start, h.end, [...h.days].sort(), h.saturdays]);
  const t = await readTechnician(tx, id);
  if (!t) throw new Error(`technician ${id} does not exist`);
  // F-794: a scheduled job on a day this week no longer works comes off the technician, as time off does (SD-28).
  const off = (await live()).filter((j) => j.status === 'scheduled' && !worksOn(t, j.date));
  const unassigned: OffDayJob[] = [];
  for (const j of off) {
    const v = (await tx.query<{ version: number }>(
      'UPDATE world.job SET technician_id = NULL, planned_arrival = NULL, touched_by_person = true, version = version + 1 WHERE job_number = $1 RETURNING version', [j.job_number])).rows[0]!.version;
    await appendJobChange(tx, ctx, {
      jobNumber: j.job_number, kind: 'assigned', fromVersion: v - 1, toVersion: v,
      data: { from: { technicianId: id }, to: { technicianId: null } },
    });
    await publishEvent(tx, 'job.changed', { jobNumber: j.job_number, branch: input.branch });
    unassigned.push({ jobNumber: j.job_number, date: j.date, window: { start: wire(j.window_start, j.zone), end: wire(j.window_end, j.zone) } });
  }
  for (const date of new Set(before.map((j) => j.date))) await settleDay(tx, { technicianId: id, date });
  const after = await live();
  const was = new Map(before.map((j) => [j.job_number, j.planned_arrival?.getTime() ?? null]));
  // F-822: 1 board.refresh for the branch, never a job.changed per job: a job page answers job.changed with 'This job changed', and a moved plan is not a
  // change the job page shows (it draws no planned arrival; a done job's plan moves with its eta, version and job_change rows untouched).
  if (after.some((j) => was.get(j.job_number) !== (j.planned_arrival?.getTime() ?? null))) await publishEvent(tx, 'board.refresh', { branch: input.branch });
  return unassigned;
}
