// SPDX-License-Identifier: AGPL-3.0-or-later
// The board's reads (UI-SPECIFICATION 12.2 API-20, API-30, API-131; SPECIFICATIONS SD-15, SD-26, FR-DISP-17):
//   API-20  board day        1 branch day: the technicians working it with their jobs and blocks, the Unassigned row, the
//                            day summary, the Needs attention lists and the flagged items. ETA and timing are SD-15's
//                            etaDay over the baked tracks, the same function and drive minutes the ETA sweep uses
//                            (apps/worker/src/outbox/eta-sweep.ts), so the board and the late texts agree.
//   API-30  suggested        SD-26's ranking (office-writes/dispatch-rules.ts suggestTechnicians) with each technician's
//           technicians      van, skills and load for the reassign dialog and the new-job form.
//   API-131 move preview     SD-15's planner on a copy of the target technician's day with the job inserted: it writes
//                            nothing and takes no lock (SPECIFICATIONS "Drop preview").
// Reads only: no row is written, no lock is taken.
import type { boardDay, movePreview, suggestTechnicians as suggestRow } from '@bw/api';
import { areaSql, etaDay, offeredWindows, planDay, technicianDayCapacity, worksOn, type EtaStatus } from '@bw/domain';
import { addDays, localDateOf } from '@bw/time';
import type { z } from 'zod';
import { routedDrive } from '../../../maps/src/route-source.ts';
import { at, branchTechnicians, branchWindows, readDayKind, readTechnician, wire, type Technician } from '../office-writes/day.ts';
import { suggestTechnicians } from '../office-writes/dispatch-rules.ts';
import { WriteRefused } from '../office-writes/service.ts';
import type { Handler, Tx } from '../types.ts';

type BoardAnswer = z.infer<typeof boardDay.response>;
type BoardIn = z.infer<typeof boardDay.request>;
type BoardJob = BoardAnswer['unassigned'][number];
type Attention = BoardAnswer['needsAttention']['late'][number];

/** FR-DISP-13, OA-64: the on-time goal the board shows the 7-day rate against. */
const ON_TIME_GOAL = 0.9;
/** The catalog key of the label the rate never shows without (FR-REP-4). */
const SIMULATED_LABEL_KEY = 'board.summary.simulated';

/** The 2 letters of a row's avatar: the first letters of the first and last name. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words[words.length - 1]!.charAt(0) : '';
  return (first + last).toUpperCase();
}

const TIMING = { on_time: 'onTime', at_risk: 'atRisk', late: 'late' } as const;

export interface BranchRow { id: string; zone: string; depot_lon: number; depot_lat: number }

export async function branchOf(tx: Tx, id: string): Promise<BranchRow | null> {
  const r = await tx.query<BranchRow>('SELECT id, zone, depot_lon, depot_lat FROM world.branch WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

export interface JobRow {
  job_number: number; version: number; customer: string; area: string; service_id: string; label_key: string; window_id: string;
  window_start: Date; window_end: Date; technician_id: string | null; planned_arrival: Date | null; expected_minutes: number;
  status: EtaStatus; booked_at: Date; on_the_way_at: Date | null; arrived_at: Date | null; ended_at: Date | null;
  late_text_sent_at: Date | null; confirmed_at: Date | null; lon: number; lat: number; zone: string;
}

/** Every live job of the branch day (canceled jobs leave the board), with its customer, area and service label key. */
export async function dayJobs(tx: Tx, branch: string, date: string): Promise<JobRow[]> {
  const r = await tx.query<JobRow>(
    `SELECT j.job_number, j.version, c.name AS customer, ${areaSql('s.city', 's.zip')} AS area, j.service_id, st.screen_label_key AS label_key, j.window_id,
            j.window_start, j.window_end, j.technician_id, j.planned_arrival, j.expected_minutes, j.status, j.booked_at,
            j.on_the_way_at, j.arrived_at, j.ended_at, j.late_text_sent_at, j.confirmed_at, c.lon, c.lat, j.zone
       FROM world.job j
       JOIN world.customer c ON c.id = j.customer_id
       JOIN world.street s ON s.id = c.street_id
       JOIN world.service_type st ON st.id = j.service_id
      WHERE j.branch_id = $1 AND j.date = $2::date AND j.status <> 'canceled'
      ORDER BY j.window_start, j.booked_at, j.job_number`, [branch, date]);
  return r.rows;
}

const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());

/** SD-15 ETA and timing of 1 technician's day, keyed by job number; the legs from SD-49's route source (routedDrive). */
export async function etas(tx: Tx, branch: BranchRow, t: Technician, date: string, jobs: readonly JobRow[], now: number) {
  const day = {
    now, shiftStart: at(date, t.shiftStart, branch.zone).getTime(), depot: { lon: branch.depot_lon, lat: branch.depot_lat },
    stops: jobs.map((j) => ({
      jobNumber: j.job_number, status: j.status, windowStart: j.window_start.getTime(), windowEnd: j.window_end.getTime(), bookedAt: j.booked_at.getTime(),
      expectedMinutes: j.expected_minutes, point: { lon: j.lon, lat: j.lat }, onTheWayAt: ms(j.on_the_way_at), arrivedAt: ms(j.arrived_at), endedAt: ms(j.ended_at),
    })),
  };
  const results = etaDay({ ...day, drive: await routedDrive(tx, branch.id, (drive) => etaDay({ ...day, drive })) });
  return new Map(results.map((e) => [e.jobNumber, e]));
}

const ENDED = new Set(['done', 'no_one_home']);

function boardJobOf(j: JobRow, eta: { eta: number; timing: keyof typeof TIMING } | undefined, skill: string | null): BoardJob {
  return {
    jobNumber: j.job_number, version: j.version, customerName: j.customer, area: j.area, serviceId: j.service_id, serviceLabelKey: j.label_key,
    windowId: j.window_id, window: { start: wire(j.window_start, j.zone), end: wire(j.window_end, j.zone) }, technicianId: j.technician_id,
    plannedArrival: j.planned_arrival ? wire(j.planned_arrival, j.zone) : null,
    eta: eta ? wire(new Date(eta.eta), j.zone) : null,
    expectedMinutes: j.expected_minutes,
    status: j.status as BoardJob['status'],
    // SD-15: an open or on-site job's timing; an ended job shows Done or No one home, and an unassigned job has no ETA.
    timing: eta && !ENDED.has(j.status) ? TIMING[eta.timing] : null,
    lateTextSent: j.late_text_sent_at !== null,
    confirmed: j.confirmed_at !== null,
    position: { lon: j.lon, lat: j.lat },
    technicianSkill: skill,
  };
}

/**
 * FR-DISP-13, FR-REP-4: the on-time rate of the 7 days before the shown day from the report view (SD-25, the simulated
 * pilot data): visits with an arrival, on time when at or before the window's end; the no-one-home-only rows are left out.
 */
export async function onTimeRate(tx: Tx, branch: string, from: string, to: string): Promise<number | null> {
  const r = await tx.query<{ n: string; on_time: string }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE on_time) AS on_time FROM world.report_visit
      WHERE branch_id = $1 AND date BETWEEN $2::date AND $3::date AND on_time IS NOT NULL AND NOT no_one_home_only`, [branch, from, to]);
  const n = Number(r.rows[0]?.n ?? 0);
  return n === 0 ? null : Number(r.rows[0]?.on_time ?? 0) / n;
}

type FlaggedEntry = NonNullable<BoardAnswer['needsAttention']['flagged'][number]['entry']>;

/**
 * F-1139 (API-20; owner ruling c4aa4366): each flagged row's kept entry (tech_item.payload) as the dispatcher's row shows it, by conflict id.
 * A finish's parts carry the list's name, or null with the id the phone sent for a part the list does not hold; a status change has no entry, and a
 * refused photo or signature has the key of its kept image (F-1168).
 */
async function flaggedEntries(tx: Tx, rows: readonly { id: string; item_key: string; item_kind: string; payload: unknown }[]): Promise<Map<string, FlaggedEntry>> {
  type Payload = { parts?: { partId: string; quantity: number }[]; noPartsUsed?: boolean; laborMinutes?: number; workDone?: string[]; text?: string; file?: string };
  const ids = [...new Set(rows.flatMap((r) => (r.item_kind === 'finished' ? ((r.payload as Payload | null)?.parts ?? []).map((p) => p.partId) : [])))];
  const names = ids.length === 0 ? [] : (await tx.query<{ id: string; name: string }>('SELECT id::text AS id, name FROM world.part WHERE id::text = ANY($1::text[])', [ids])).rows;
  const nameOf = new Map(names.map((p) => [p.id, p.name]));
  const out = new Map<string, FlaggedEntry>();
  for (const r of rows) {
    const p = r.payload as Payload | null;
    if (!p) continue;
    if (r.item_kind === 'finished') {
      out.set(r.id, {
        kind: 'finish', parts: (p.parts ?? []).map((x) => ({ partId: x.partId, name: nameOf.get(x.partId) ?? null, quantity: x.quantity })),
        noPartsUsed: p.noPartsUsed ?? false, laborMinutes: p.laborMinutes ?? 0, workDone: p.workDone ?? [],
      });
    } else if (r.item_kind === 'note' && typeof p.text === 'string') out.set(r.id, { kind: 'note', text: p.text });
    else if ((r.item_kind === 'photo' || r.item_kind === 'signature') && typeof p.file === 'string') out.set(r.id, { kind: r.item_kind, key: r.item_key });
  }
  return out;
}

export const boardDayHandler: Handler<BoardAnswer> = async (req, tx) => {
  const p = req.params as BoardIn;
  const branch = await branchOf(tx, p.branch);
  if (!branch) return { ok: false, status: 404, code: 'not_found' };
  const now = req.demoNow.epochMilliseconds;
  const today = localDateOf(req.demoNow, branch.zone);
  const date = p.date === 'today' ? today : p.date;
  const kind = await readDayKind(tx, branch.id, date);
  const windows = offeredWindows(await branchWindows(tx, branch.id), kind === 'sunday' ? 'two_hour' : kind);
  const spanStart = windows.map((w) => w.startLocal.slice(0, 5)).sort()[0] ?? '08:00';
  const spanEnd = windows.map((w) => w.endLocal.slice(0, 5)).sort().at(-1) ?? '18:00';

  const people = await tx.query<{ id: string; primary_skill: string; skills: string[]; van: string | null }>(
    'SELECT t.id, t.primary_skill, t.skills, v.number AS van FROM world.technician t LEFT JOIN world.van v ON v.id = t.van_id WHERE t.branch_id = $1', [branch.id]);
  const facts = new Map(people.rows.map((r) => [r.id, r]));
  const working = (await branchTechnicians(tx, branch.id)).filter((t) => worksOn(t, date)).sort((a, b) => a.name.localeCompare(b.name, 'en'));

  const jobs = await dayJobs(tx, branch.id, date);
  const blocks = await tx.query<{ id: string; technician_id: string; version: number; label: string; place: string | null; start: Date; end: Date; zone: string }>(
    `SELECT b.id, b.technician_id, b.version, b.label, b.place, b.start, b."end", b.zone FROM world.time_block b
       JOIN world.technician t ON t.id = b.technician_id WHERE t.branch_id = $1 AND b.date = $2::date ORDER BY b.start, b.id`, [branch.id, date]);
  const names = new Map((await branchTechnicians(tx, branch.id)).map((t) => [t.id, t] as const));

  const rows: BoardAnswer['technicians'] = [];
  const all: BoardJob[] = [];
  // A technician off that day keeps any job still on their row: such a job is shown (and counted) with its technician.
  const rowIds = new Set(working.map((t) => t.id));
  for (const id of new Set(jobs.map((j) => j.technician_id).filter((x): x is string => x !== null))) rowIds.add(id);
  for (const id of new Set(blocks.rows.map((b) => b.technician_id))) rowIds.add(id);
  const rowTechs = [...rowIds].map((id) => names.get(id)).filter((t): t is Technician => t !== undefined).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const t of rowTechs) {
    const f = facts.get(t.id);
    const mine = jobs.filter((j) => j.technician_id === t.id);
    const e = await etas(tx, branch, t, date, mine, now);
    const out = mine.map((j) => boardJobOf(j, e.get(j.job_number), f?.primary_skill ?? null));
    all.push(...out);
    rows.push({
      id: t.id, initials: initialsOf(t.name), name: t.name, van: f?.van ?? null,
      skills: f ? [f.primary_skill, ...f.skills.filter((s) => s !== f.primary_skill)] : [],
      capacity: technicianDayCapacity(t, kind),
      jobs: out,
      blocks: blocks.rows.filter((b) => b.technician_id === t.id).map((b) => ({
        blockId: b.id, version: b.version, label: b.label, place: b.place, start: wire(b.start, b.zone), end: wire(b.end, b.zone),
      })),
    });
  }
  const unassigned = jobs.filter((j) => j.technician_id === null).map((j) => boardJobOf(j, undefined, null));
  all.push(...unassigned);

  const techName = new Map(rowTechs.map((t) => [t.id, t.name]));
  const attention = (j: BoardJob, label: string): Attention => ({
    jobNumber: j.jobNumber, label, customerName: j.customerName, area: j.area,
    technician: j.technicianId ? techName.get(j.technicianId) ?? null : null, eta: j.eta, window: j.window,
  });
  const late = all.filter((j) => j.timing === 'late');
  const atRisk = all.filter((j) => j.timing === 'atRisk');

  const flagged = await tx.query<{ id: string; job_number: number; listed: boolean; message_key: string; message_values: Record<string, string | number | null>; offline_at: Date; sent_at: Date; item_kind: string; item_key: string; payload: unknown }>(
    // F-562: a row with no job reference (a job number the world does not hold, migration 0022) shows the number the phone sent.
    // F-1139: the item's kept entry (tech_item.payload) rides with the row.
    `SELECT o.id, COALESCE(o.job_number, (o.message_values->>'job')::integer) AS job_number, o.job_number IS NOT NULL AS listed, o.message_key, o.message_values, o.offline_at, o.sent_at,
            i.kind AS item_kind, i.key AS item_key, i.payload
       FROM world.offline_conflict o JOIN world.tech_item i ON i.key = o.item_key
      WHERE o.branch_id = $1 AND o.handled_at IS NULL ORDER BY o.sent_at, o.id`, [branch.id]);
  const entries = await flaggedEntries(tx, flagged.rows);

  const from = addDays(date, -7);
  const to = addDays(date, -1);
  return {
    ok: true, status: 200, data: {
      date, today: date === today, zone: branch.zone,
      dayMode: kind === 'sunday' ? 'closed' : kind === 'four_hour' ? 'four_hour' : 'two_hour',
      workingHours: { start: wire(at(date, spanStart, branch.zone), branch.zone), end: wire(at(date, spanEnd, branch.zone), branch.zone) },
      onShift: working.length,
      onTime7: { rate: await onTimeRate(tx, branch.id, from, to), goal: ON_TIME_GOAL, labelKey: SIMULATED_LABEL_KEY, from, to },
      technicians: rows,
      unassigned,
      needsAttention: {
        late: late.map((j) => attention(j, 'status.timing.late')),
        atRisk: atRisk.map((j) => attention(j, 'status.timing.atRisk')),
        unassigned: unassigned.map((j) => attention(j, 'status.job.unassigned')),
        flagged: flagged.rows.map((f) => ({
          conflictId: f.id, jobNumber: f.job_number, listed: f.listed, messageKey: f.message_key, values: setValues(f.message_values),
          offlineAt: wire(f.offline_at, branch.zone), sentAt: wire(f.sent_at, branch.zone), entry: entries.get(f.id) ?? null,
        })),
      },
      counts: {
        jobs: all.length, done: all.filter((j) => j.status === 'done').length, onSite: all.filter((j) => j.status === 'on_site').length,
        onTheWay: all.filter((j) => j.status === 'on_the_way').length, late: late.length, atRisk: atRisk.length, unassigned: unassigned.length,
        flagged: flagged.rows.length, lateTextSent: late.filter((j) => j.lateTextSent).length,
      },
    },
  };
};

/**
 * The flag's message values as API-20 answers them: the server writes null for a value its column has none of (who moved
 * the job, where to, when; section 5.1 step 8), and the contract's values hold only strings and numbers, so a null is left
 * out (no message reads a value its column leaves null). Before this every server-written flag made the board answer 500.
 */
const setValues = (v: Record<string, string | number | null>): Record<string, string | number> =>
  Object.fromEntries(Object.entries(v).filter((e): e is [string, string | number] => e[1] !== null));

type PreviewAnswer = z.infer<typeof movePreview.response>;
type PreviewIn = z.infer<typeof movePreview.request>;

/** API-131: the planned arrival the move would give (SD-15 on a copy of the target day with the job in it). */
export const movePreviewHandler: Handler<PreviewAnswer> = async (req, tx) => {
  const p = req.params as PreviewIn;
  const r = await tx.query<{ job_number: number; branch_id: string; date: string; zone: string; window_start: Date; window_end: Date; booked_at: Date; expected_minutes: number; lon: number; lat: number }>(
    `SELECT j.job_number, j.branch_id, j.date::text AS date, j.zone, j.window_start, j.window_end, j.booked_at, j.expected_minutes, c.lon, c.lat
       FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.job_number = $1`, [p.jobNumber]);
  const job = r.rows[0];
  if (!job) return { ok: false, status: 404, code: 'not_found' };
  const window = { start: wire(job.window_start, job.zone), end: wire(job.window_end, job.zone) };
  if (p.technicianId === null) return { ok: true, status: 200, data: { arrivesAbout: null, insideWindow: null, window } };
  const t = await readTechnician(tx, p.technicianId);
  if (!t || t.branch !== job.branch_id) return { ok: false, status: 404, code: 'not_found' };
  const branch = await branchOf(tx, job.branch_id);
  if (!branch) return { ok: false, status: 404, code: 'not_found' };
  const day = await tx.query<{ job_number: number; window_start: Date; booked_at: Date; expected_minutes: number; lon: number; lat: number }>(
    `SELECT j.job_number, j.window_start, j.booked_at, j.expected_minutes, c.lon, c.lat FROM world.job j JOIN world.customer c ON c.id = j.customer_id
      WHERE j.technician_id = $1 AND j.date = $2::date AND j.status <> 'canceled' AND j.job_number <> $3`, [t.id, job.date, job.job_number]);
  const stops = [...day.rows, job].map((j) => ({
    jobNumber: j.job_number, windowStart: j.window_start.getTime(), bookedAt: j.booked_at.getTime(), expectedMinutes: j.expected_minutes, point: { lon: j.lon, lat: j.lat },
  }));
  const input = { shiftStart: at(job.date, t.shiftStart, branch.zone).getTime(), depot: { lon: branch.depot_lon, lat: branch.depot_lat }, stops };
  const plan = planDay({ ...input, drive: await routedDrive(tx, branch.id, (drive) => planDay({ ...input, drive })) });
  const mine = plan.find((s) => s.jobNumber === job.job_number);
  if (!mine) throw new Error(`job ${job.job_number} left its own preview plan`);
  const inside = mine.plannedArrival >= job.window_start.getTime() && mine.plannedArrival <= job.window_end.getTime();
  return { ok: true, status: 200, data: { arrivesAbout: wire(new Date(mine.plannedArrival), job.zone), insideWindow: inside, window } };
};

type SuggestAnswer = z.infer<typeof suggestRow.response>;
type SuggestIn = z.infer<typeof suggestRow.request>;

/** API-30: SD-26's ranking with each technician's van, skills and load (jobs of capacity that day, the moved job left out). */
export const suggestTechniciansHandler: Handler<SuggestAnswer> = async (req, tx) => {
  const p = req.params as SuggestIn;
  if ((p.jobNumber === undefined) === (p.customerId === undefined)) return { ok: false, status: 422, code: 'validation_failed' };
  let customerId = p.customerId;
  if (p.jobNumber !== undefined) {
    const j = await tx.query<{ customer_id: string; branch_id: string }>('SELECT customer_id, branch_id FROM world.job WHERE job_number = $1', [p.jobNumber]);
    const row = j.rows[0];
    if (!row || row.branch_id !== p.branch) return { ok: false, status: 404, code: 'not_found' };
    customerId = row.customer_id;
  }
  let ranked;
  try {
    ranked = await suggestTechnicians(tx, {
      branch: p.branch, serviceId: p.serviceId, customerId: customerId as string, date: p.date, windowId: p.windowId,
      ...(p.jobNumber === undefined ? {} : { excludeJob: p.jobNumber }),
    });
  } catch (e) {
    if (e instanceof WriteRefused) return { ok: false, status: 422, code: 'validation_failed' };
    throw e;
  }
  const kind = await readDayKind(tx, p.branch, p.date);
  const people = await tx.query<{ id: string; primary_skill: string; skills: string[]; van: string | null; installer: boolean; jobs: string }>(
    `SELECT t.id, t.primary_skill, t.skills, v.number AS van, t.installer,
            (SELECT count(*) FROM world.job j WHERE j.technician_id = t.id AND j.date = $2::date AND j.status <> 'canceled' AND j.job_number <> $3) AS jobs
       FROM world.technician t LEFT JOIN world.van v ON v.id = t.van_id WHERE t.branch_id = $1`, [p.branch, p.date, p.jobNumber ?? -1]);
  const by = new Map(people.rows.map((r) => [r.id, r]));
  const need = await tx.query<{ skill: string }>('SELECT skill FROM world.service_type WHERE id = $1', [p.serviceId]);
  return {
    ok: true, status: 200, data: {
      serviceSkill: need.rows[0]?.skill ?? '',
      technicians: ranked.map((r) => {
        const f = by.get(r.technicianId);
        return {
          id: r.technicianId, name: r.name, van: f?.van ?? null,
          skills: f ? [f.primary_skill, ...f.skills.filter((s) => s !== f.primary_skill)] : [],
          minutesFromStopBefore: r.driveMinutes, stopBefore: r.stopBefore,
          load: { jobs: Number(f?.jobs ?? 0), capacity: f ? technicianDayCapacity({ installer: f.installer }, kind) : 0 },
          room: r.room, suggested: r.suggested, reason: r.reason,
        };
      }),
    },
  };
};
