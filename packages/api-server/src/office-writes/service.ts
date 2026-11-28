// SPDX-License-Identifier: AGPL-3.0-or-later
// The office write service (SPECIFICATIONS section 5.3, SD-14; invariant 3, D15; FR-BOOK-5, FR-BOOK-6, FR-DISP-2,
// FR-DISP-6, FR-DISP-8, FR-DISP-34; SD-15, SD-27, SD-45). Every office write that changes a job's technician, day or
// window, and every block write, goes through 1 function here, inside the handler's 1 transaction (SD-6):
//
//   1. lock      booking-day rows, then technician-day locks (locks.ts; section 5.3 step 6's order), before the write reads anything it
//                decides on: the window's capacity and the day's mode have writers of their own (API-155, API-91), which hold the same rows (F-745)
//   2. gate      the conditional UPDATE ... SET version = version + 1 WHERE ... AND version = baseVersion; 0 rows answers
//                version_conflict naming the change that made the current version (who, what, the technician, when)
//   3. check     under the locks: the day is open, the window has room (windowRoom), the technician works the day and
//                has room (SD-27), and no overlap the write causes between a scheduled job's planned time and a block (time_overlap):
//                one not on the row before the write, on a day the write adds work to; a day it only takes work off never refuses (OA-92)
//   4. settle    planned arrivals recomputed for every technician-day the write touched, the old and the new (SD-15)
//   5. record    exactly 1 job_change row per job written (its from and to versions are the gate's trail) ...
//   6. notify    ... and exactly 1 notice per job or block written, ids only (events.ts publish)
//
// A refusal throws WriteRefused; the handler answers it and the kernel rolls the transaction back, so a refused write
// leaves no row, no planned-arrival change and no notice. Retry semantics: every write is gated by the version it
// read (a block create and a job create by the locks and the counts), so a replayed request whose first try committed
// answers version_conflict (or, for a create, makes a second job only if room is left: creates are not idempotent,
// as API-28 carries no key; the office re-reads the board after any answer). Derived planned arrivals never bump a
// version, so a settle never causes a conflict (D15).
import { deleteTracksNaming, publishEvent, type Queryable } from '@bw/db';
import { keepTechnicianOnReschedule, worksOn, type JobChangeKind } from '@bw/domain';
import { cancelUnsentConfirmations, REASON } from '@bw/outbox';
import { addDays, localDateOf, Temporal } from '@bw/time';
import { endOnTheWay } from '../tech-items/effects.ts';
import {
  at, officeWindowRoom, readBranch, readDayKind, readTechnician, readWindow, serviceIsInstall, settleDay,
  technicianRoom, technicianRoomRefusal, windowOffered, wire, type Overlap, type Technician, type Window,
} from './day.ts';
import { LockOrderRetry, type HeldDay } from '@bw/import';
import { drawnOnceForCall } from '../../../maps/src/route-source.ts';
import { lockBookingDays, lockTechnicianDays, tryLockTechnicianDays, type TechnicianDayKey } from './locks.ts';

/** The office channel's horizon: create and reschedule reach 60 days after today (SD-27, GAP-9). */
export const OFFICE_HORIZON_DAYS = 60;

export type RefusalCode =
  | 'not_found' | 'validation_failed' | 'version_conflict' | 'time_overlap' | 'technician_no_room' | 'rule_refused'
  | 'window_full' | 'day_closed' | 'day_past' | 'parts_required';

export class WriteRefused extends Error {
  readonly code: RefusalCode;
  readonly detail: unknown;
  constructor(code: RefusalCode, why: string, detail?: unknown) {
    super(why);
    this.name = 'WriteRefused';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The catalog keys a rule_refused answer carries (UI-SPECIFICATION section 4.3: "carries a catalog key naming the rule";
 * F-506). Each office write that refuses for a rule names 1 of these, so the dialog shows that rule's message.
 */
export const RULE = {
  /** UI-SPECIFICATION 12.1 item 9: the job is Done, No one home or Canceled (F-505). */
  jobClosed: 'rule.jobClosed',
  technicianOtherBranch: 'rule.technicianOtherBranch',
  technicianNotWorking: 'rule.technicianNotWorking',
  pastHorizon: 'rule.pastHorizon',
  windowNotOffered: 'rule.windowNotOffered',
  customerNotActive: 'rule.customerNotActive',
} as const;
type RuleKey = (typeof RULE)[keyof typeof RULE];

/** A rule_refused refusal with its rule's catalog key (the detail API-22, 24, 25, 26, 27 and 28 name: ruleRefusedDetail). */
const ruleRefused = (key: RuleKey, why: string): WriteRefused => new WriteRefused('rule_refused', why, { key });

/** The statuses whose job the office may no longer change (CTL-OFC-03-04 to -08; UI-SPECIFICATION 12.1 item 9; F-505). */
const CLOSED: ReadonlySet<WrittenJob['status']> = new Set(['done', 'no_one_home', 'canceled']);

/** The 1 status rule of the office job writes API-22, 24, 25, 27 and the office finish API-26 (F-505). */
export function refuseClosed(job: { job_number: number; status: WrittenJob['status'] }): void {
  if (CLOSED.has(job.status)) throw ruleRefused(RULE.jobClosed, `job ${job.job_number} is ${job.status}`);
}

/** A visit the technician has begun: On the way or On site. */
const begun = (status: WrittenJob['status']): boolean => status === 'on_the_way' || status === 'on_site';

/**
 * The office changed a begun visit (cancel, reassign, reschedule; SPECIFICATIONS 6.4 Live map ends): its live map link
 * ends, so the page says the visit changed and never shows a wrong van (owner ruling 2142ce69, "End the link"), and an
 * on-the-way text not yet sent is canceled (owner ruling 7ccb76ec call 8, F-566). The arrival's own end (endOnTheWay).
 */
async function endBegunVisit(tx: Queryable, job: { job_number: number; status: WrittenJob['status'] }, at: Date): Promise<void> {
  if (!begun(job.status)) return;
  await endOnTheWay(tx, { jobNumber: job.job_number, at: Temporal.Instant.fromEpochMilliseconds(at.getTime()), reason: REASON.visitChanged });
}

/** The begun visit's own facts, cleared when the office sets it back to Scheduled (owner ruling d0c0a033). */
const BACK_TO_SCHEDULED = `status = 'scheduled', on_the_way_at = NULL, arrived_at = NULL, texted_arrival = NULL`;

/** Who writes, and the demo time of the write (job_change.at, invariant 4). */
export interface WriteContext {
  actor: { kind: 'office'; userId: string };
  at: Date;
}

/** The customer's own move on the reschedule page (API-118, P5-INBOX): no user, the job_change actor is the customer. */
export interface CustomerWriteContext {
  actor: { kind: 'customer'; userId: null };
  at: Date;
}

/**
 * Thrown by createJob for an online booking whose key a job already holds when the booking-day lock is taken (SPECIFICATIONS 6.1 Booking
 * write, K-01). Not a refusal: the handler rolls the send back to its savepoint and answers the held job's booking as a repeat.
 */
export class BookingKeyHeld extends Error {
  constructor() { super('the booking key is already held by a job'); this.name = 'BookingKeyHeld'; }
}

/** The customer's own booking (API-113): no signed-in user, the job_change's actor is `customer` (SPECIFICATIONS section 5.1 step 5). */
export interface OnlineContext {
  actor: { kind: 'customer'; userId: null };
  at: Date;
}

export interface WrittenJob {
  jobNumber: number; branch: string; customerId: string; serviceId: string; date: string; windowId: string;
  window: { start: string; end: string }; technicianId: string | null;
  status: 'scheduled' | 'on_the_way' | 'on_site' | 'done' | 'no_one_home' | 'canceled';
  version: number; plannedArrival: string | null; expectedMinutes: number;
}

export interface WrittenBlock {
  blockId: string; technicianId: string; date: string; label: string; place: string | null; start: string; end: string; version: number;
}

interface JobRow {
  job_number: number; branch_id: string; customer_id: string; service_id: string; date: string; zone: string; window_id: string;
  window_start: Date; window_end: Date; technician_id: string | null; status: WrittenJob['status']; version: number;
  planned_arrival: Date | null; expected_minutes: number;
}

const JOB_COLUMNS = `job_number, branch_id, customer_id, service_id, date::text AS date, zone, window_id, window_start, window_end,
  technician_id, status, version, planned_arrival, expected_minutes`;

async function readJob(tx: Queryable, jobNumber: number): Promise<JobRow | null> {
  const r = await tx.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM world.job WHERE job_number = $1`, [jobNumber]);
  return r.rows[0] ?? null;
}

const writtenJob = (j: JobRow): WrittenJob => ({
  jobNumber: j.job_number, branch: j.branch_id, customerId: j.customer_id, serviceId: j.service_id, date: j.date, windowId: j.window_id,
  window: { start: wire(j.window_start, j.zone), end: wire(j.window_end, j.zone) }, technicianId: j.technician_id, status: j.status,
  version: j.version, plannedArrival: j.planned_arrival ? wire(j.planned_arrival, j.zone) : null, expectedMinutes: j.expected_minutes,
});

async function answerJob(tx: Queryable, jobNumber: number): Promise<WrittenJob> {
  const j = await readJob(tx, jobNumber);
  if (!j) throw new Error(`job ${jobNumber} vanished inside its own write`);
  return writtenJob(j);
}

/** The job row and the after-write answer, for the office finish (finish.ts), which follows the same steps. */
export { readJob as readJobForWrite, answerJob as answerJobForWrite };

/**
 * The version_conflict members (section 5.3 step 1, FR-DISP-6): the job_change row that made the job's current version,
 * its actor's name and kind, the technician the job has now, and when. Read in the refused write's transaction.
 */
async function jobConflict(tx: Queryable, jobNumber: number): Promise<WriteRefused> {
  const r = await tx.query<{ version: number; zone: string; kind: string | null; actor_kind: string | null; at: Date | null; by: string | null; technician: string | null }>(
    `SELECT j.version, j.zone, c.kind, c.actor_kind, c.at, u.name AS by, t.name AS technician
       FROM world.job j
       LEFT JOIN LATERAL (SELECT kind, actor_kind, actor_user_id, at FROM world.job_change
                           WHERE job_number = j.job_number AND to_version = j.version AND to_version > from_version
                           ORDER BY at DESC, id DESC LIMIT 1) c ON true
       LEFT JOIN world."user" u ON u.id = c.actor_user_id
       LEFT JOIN world.technician t ON t.id = j.technician_id
      WHERE j.job_number = $1`, [jobNumber]);
  const c = r.rows[0];
  if (!c) return new WriteRefused('not_found', `job ${jobNumber} does not exist`);
  return new WriteRefused('version_conflict', `job ${jobNumber} is at version ${c.version}`, {
    by: c.actor_kind === 'office' || c.actor_kind === 'technician' ? c.by : null,
    byKind: c.actor_kind, change: c.kind, technician: c.technician, at: c.at ? wire(c.at, c.zone) : null, currentVersion: c.version,
  });
}

/** Step 2: the conditional update. An office write marks the job touched by a person (SD-21; F-423). `set` names columns from $3 on; 0 rows answers version_conflict (or not_found). */
export async function gatedJobUpdate(tx: Queryable, jobNumber: number, baseVersion: number, set: string, values: unknown[]): Promise<void> {
  const r = await tx.query(
    `UPDATE world.job SET ${set}, touched_by_person = true, version = version + 1 WHERE job_number = $1 AND version = $2`, [jobNumber, baseVersion, ...values]);
  if ((r.rowCount ?? 0) === 0) throw await jobConflict(tx, jobNumber);
}

/** Step 5: the 1 job_change row of a job write (section 3 job_change; data holds ids and values, never a phone or address). */
export async function appendJobChange(tx: Queryable, ctx: WriteContext | CustomerWriteContext | OnlineContext | { actor: { kind: 'office'; userId: string | null }; at: Date }, row: {
  jobNumber: number; kind: JobChangeKind; fromVersion: number; toVersion: number; data: Record<string, unknown>;
}): Promise<void> {
  await tx.query(
    `INSERT INTO world.job_change (job_number, at, actor_user_id, actor_kind, kind, from_version, to_version, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [row.jobNumber, ctx.at, ctx.actor.userId, ctx.actor.kind, row.kind, row.fromVersion, row.toVersion, JSON.stringify(row.data)]);
}

const overlapRefusal = (o: Overlap): WriteRefused =>
  new WriteRefused('time_overlap', `job ${o.job.jobNumber}'s planned time overlaps block ${o.block.blockId}`, o);

const dayId = (d: TechnicianDayKey): string => `${d.technicianId}|${d.date}`;
/** A (job, block) pair on its row: the pair, not its times, so a pair already there is not new when the plan moves it. */
const pairId = (d: TechnicianDayKey, o: Overlap): string => `${dayId(d)}|${o.job.jobNumber}|${o.block.blockId}`;

/**
 * Every overlap on 1 technician-day as its stored plan has it: a scheduled job's planned time (planned arrival to planned arrival
 * + expected minutes) against a block on the row, half-open as firstOverlap (touching ends do not overlap), in plan then block order.
 */
async function dayOverlaps(tx: Queryable, d: TechnicianDayKey): Promise<Overlap[]> {
  const r = await tx.query<{
    job_number: number; zone: string; planned_arrival: Date; planned_end: Date; id: string; label: string; place: string | null; start: Date; end: Date;
  }>(
    `SELECT j.job_number, j.zone, j.planned_arrival, j.planned_arrival + make_interval(mins => j.expected_minutes) AS planned_end,
            b.id, b.label, b.place, b.start, b."end"
       FROM world.job j JOIN world.time_block b ON b.technician_id = j.technician_id AND b.date = j.date
      WHERE j.technician_id = $1 AND j.date = $2::date AND j.status = 'scheduled' AND j.planned_arrival IS NOT NULL
        AND j.planned_arrival < b."end" AND b.start < j.planned_arrival + make_interval(mins => j.expected_minutes)
      ORDER BY j.planned_arrival, j.job_number, b.start, b.id`, [d.technicianId, d.date]);
  return r.rows.map((o) => ({
    block: { blockId: o.id, label: o.label, place: o.place, start: wire(o.start, o.zone), end: wire(o.end, o.zone) },
    job: { jobNumber: o.job_number, plannedArrival: wire(o.planned_arrival, o.zone), plannedEnd: wire(o.planned_end, o.zone) },
  }));
}

/** The days a write adds work to and the overlaps already on them, read under their locks before the write changes them. */
interface OverlapsBefore { adds: ReadonlySet<string>; pairs: ReadonlySet<string> }

/**
 * Section 5.3 step 2 (owner answer 2f636a8d, "Only overlaps it causes"; OA-92, "Allow it"; F-2012 K-09.1): `adds` are the
 * technician-days the write puts work on (a job or a block ends the write there). Every other day the write touches only
 * loses work, and is never refused for an overlap, neither one already there nor one its recompute makes. Called after the
 * days are locked and before the write's first UPDATE, so the pairs read are the row as it was before the write.
 */
async function overlapsBefore(tx: Queryable, adds: readonly TechnicianDayKey[]): Promise<OverlapsBefore> {
  const pairs = new Set<string>();
  for (const d of adds) for (const o of await dayOverlaps(tx, d)) pairs.add(pairId(d, o));
  return { adds: new Set(adds.map(dayId)), pairs };
}

/** Settle 1 day; answer the first overlap the write caused there: on a day it adds work to, one not on the row before; else none. */
async function settleCaused(tx: Queryable, d: TechnicianDayKey, before: OverlapsBefore | null): Promise<Overlap | null> {
  await settleDay(tx, d);
  if (!before?.adds.has(dayId(d))) return null;
  return (await dayOverlaps(tx, d)).find((o) => !before.pairs.has(pairId(d, o))) ?? null;
}

/** Settle every touched day; the first overlap the write caused refuses it (step 3, step 4). `null` settles and never refuses. */
async function settleOrRefuse(tx: Queryable, days: readonly TechnicianDayKey[], before: OverlapsBefore | null): Promise<void> {
  for (const d of days) {
    const o = await settleCaused(tx, d, before);
    if (o) throw overlapRefusal(o);
  }
}

const dayKeys = (pairs: readonly (readonly [string | null, string])[]): TechnicianDayKey[] =>
  pairs.filter((p): p is readonly [string, string] => p[0] !== null).map(([technicianId, date]) => ({ technicianId, date }));

/** The date rules of the office channel (FR-DISP-8, FR-BOOK-10, SD-27): not before demo today, not a Sunday, inside 60 days, an offered window. */
async function officeDay(tx: Queryable, branch: string, zone: string, date: string, window: Window, now: Date) {
  const today = localDateOf(Temporal.Instant.fromEpochMilliseconds(now.getTime()), zone);
  if (date < today) throw new WriteRefused('day_past', `${date} is before ${today}`);
  const kind = await readDayKind(tx, branch, date);
  if (kind === 'sunday') throw new WriteRefused('day_closed', `${date} is a Sunday`);
  if (date > addDays(today, OFFICE_HORIZON_DAYS)) throw ruleRefused(RULE.pastHorizon, `${date} is past the office's ${OFFICE_HORIZON_DAYS}-day horizon`);
  if (!windowOffered(window, kind)) throw ruleRefused(RULE.windowNotOffered, `window ${window.id} is not offered on ${date} (${kind})`);
  return kind;
}

/** A technician the job may go to: of the job's branch and working the date with no time off (else rule_refused). */
async function workingTechnician(tx: Queryable, id: string, branch: string, date: string): Promise<Technician> {
  const t = await readTechnician(tx, id);
  if (!t || t.branch !== branch) throw ruleRefused(RULE.technicianOtherBranch, `technician ${id} is not on branch ${branch}`);
  if (!worksOn(t, date)) throw ruleRefused(RULE.technicianNotWorking, `technician ${id} does not work ${date}`);
  return t;
}

/**
 * assignJob (API-22; FR-DISP-2, FR-DISP-6, FR-DISP-34, GAP-12): give the job to a technician, or to nobody (Unassigned).
 * Locks the old and the new technician's day; a job not Done, No one home or Canceled (F-505); the target must work the
 * day and have room in the job's window (technician_no_room); both days are settled. Kind `assigned`. Move it anyway is
 * this call again with the version the conflict answered (currentVersion; UD-6). A begun job given to another technician
 * goes back to Scheduled (owner ruling d0c0a033), its live map link ends and its unsent on-the-way text is canceled.
 * The technician's room depends on the day's mode, whose writer (API-91) holds the booking-day row, so an assign to a technician
 * holds that row too (F-745); an unassign decides nothing on the day and takes only the technician-day lock.
 */
export async function assignJob(tx: Queryable, ctx: WriteContext, input: { jobNumber: number; technicianId: string | null; baseVersion: number }): Promise<WrittenJob> {
  const job = await readJob(tx, input.jobNumber);
  if (!job) throw new WriteRefused('not_found', `job ${input.jobNumber} does not exist`);
  const days = dayKeys([[job.technician_id, job.date], [input.technicianId, job.date]]);
  if (input.technicianId !== null) await lockBookingDays(tx, [{ branch: job.branch_id, date: job.date }]);
  await lockTechnicianDays(tx, days);
  // The new technician's day gains the job; the old one only loses it (an unassign adds to no day).
  const before = await overlapsBefore(tx, dayKeys([[input.technicianId, job.date]]));
  // planned_arrival is null while Unassigned (section 3); settle writes it again for the new technician's day.
  // A begun job that changes hands goes back to Scheduled for the new technician (d0c0a033); the same technician keeps it as it is.
  const reassigned = begun(job.status) && input.technicianId !== job.technician_id;
  await gatedJobUpdate(tx, job.job_number, input.baseVersion,
    `technician_id = $3, planned_arrival = NULL${reassigned ? `, ${BACK_TO_SCHEDULED}` : ''}`, [input.technicianId]);
  // The gate passed, so the job read above is the version the caller saw: its day, window and status are current.
  refuseClosed(job);
  if (input.technicianId !== null) {
    const t = await workingTechnician(tx, input.technicianId, job.branch_id, job.date);
    const window = await readWindow(tx, job.window_id) as Window;
    const kind = await readDayKind(tx, job.branch_id, job.date);
    const refused = await technicianRoomRefusal(tx, t, job.date, window, kind, job.job_number);
    if (refused) throw new WriteRefused('technician_no_room', `technician ${t.id} has no room in window ${window.id} on ${job.date}`, refused);
  }
  await settleOrRefuse(tx, days, before);
  if (reassigned) await endBegunVisit(tx, job, ctx.at);
  await appendJobChange(tx, ctx, {
    jobNumber: job.job_number, kind: 'assigned', fromVersion: input.baseVersion, toVersion: input.baseVersion + 1,
    data: reassigned
      ? { from: { technicianId: job.technician_id, status: job.status }, to: { technicianId: input.technicianId, status: 'scheduled' } }
      : { from: { technicianId: job.technician_id }, to: { technicianId: input.technicianId } },
  });
  await publishEvent(tx, 'job.changed', { jobNumber: job.job_number, branch: job.branch_id });
  return answerJob(tx, job.job_number);
}

/**
 * rescheduleJob (API-24; SD-45, FR-BOOK-3, FR-DISP-34): a new date and window. Locks both booking days and the
 * technician's old and new day; the new window must have room (window_full); the technician is kept when they work the
 * new date, have room in the new window and no block overlap, else the job becomes Unassigned. Kind `rescheduled`.
 * The new confirmation text and the reminder move are the handler's (F-671), sent after this returns; this cancels any unsent
 * confirmation of the old day first (F-799). The handler fills outcome.textSent from its own confirmation (handlers/dispatch-writes.ts), so it is false here.
 * A job not Done, No one home or Canceled (F-505). A begun job moved to a new day or window is a new visit: it goes back
 * to Scheduled (the section 3 writer table), its live map link ends and its unsent on-the-way text is canceled.
 */
export async function rescheduleJob(tx: Queryable, ctx: WriteContext | CustomerWriteContext, input: { jobNumber: number; date: string; windowId: string; baseVersion: number }) {
  const job = await readJob(tx, input.jobNumber);
  if (!job) throw new WriteRefused('not_found', `job ${input.jobNumber} does not exist`);
  // F-745: the lock comes before the window and the day are read: the capacity and the mode this write decides on are the ones the lock serialized.
  await lockBookingDays(tx, [{ branch: job.branch_id, date: job.date }, { branch: job.branch_id, date: input.date }]);
  const window = await readWindow(tx, input.windowId);
  if (!window || window.branch !== job.branch_id) throw new WriteRefused('validation_failed', `window ${input.windowId} is not a window of ${job.branch_id}`);
  const branch = await readBranch(tx, job.branch_id);
  const kind = await officeDay(tx, branch.id, branch.zone, input.date, window, ctx.at);
  const oldDay = dayKeys([[job.technician_id, job.date]]);
  const newDay = dayKeys([[job.technician_id, input.date]]);
  await lockTechnicianDays(tx, [...oldDay, ...newDay]);
  const before = await overlapsBefore(tx, newDay);
  const start = at(input.date, window.startLocal, branch.zone);
  const end = at(input.date, window.endLocal, branch.zone);
  const moved = begun(job.status);
  await gatedJobUpdate(tx, job.job_number, input.baseVersion, `date = $3::date, window_id = $4, window_start = $5, window_end = $6, planned_arrival = NULL,
     late_text_sent_at = CASE WHEN date IS DISTINCT FROM $3::date OR window_id IS DISTINCT FROM $4 THEN NULL ELSE late_text_sent_at END${moved ? `, ${BACK_TO_SCHEDULED}` : ''}`,
    [input.date, window.id, start, end]);
  // F-510: a rescheduled visit is a new visit, so it can be late again and get its own late text (SD-15).

  refuseClosed(job);
  const install = await serviceIsInstall(tx, job.service_id) ?? false;
  if ((await officeWindowRoom(tx, { branch: branch.id, date: input.date, window, kind, install, excludeJob: job.job_number })) <= 0) {
    throw new WriteRefused('window_full', `window ${window.id} on ${input.date} has no room`);
  }
  let kept = false;
  if (job.technician_id !== null) {
    const t = await readTechnician(tx, job.technician_id);
    const worksNewDate = t !== null && worksOn(t, input.date);
    const hasRoom = t !== null && worksNewDate && (await technicianRoom(tx, t, input.date, window, kind, job.job_number));
    // The trial settle plans the new day with this job in it; a block overlap the move causes then unassigns (SD-45). An overlap
    // already on the new day that the move leaves as it was keeps the technician (F-2012 K-09.2).
    const blockOverlap = hasRoom && (await settleCaused(tx, newDay[0] as TechnicianDayKey, before)) !== null;
    kept = keepTechnicianOnReschedule({ assigned: true, worksNewDate, hasRoom, blockOverlap });
    if (!kept) {
      await tx.query('UPDATE world.job SET technician_id = NULL, planned_arrival = NULL WHERE job_number = $1', [job.job_number]);
      // The trial settle above planned the new day with this job in it; plan it again without (that day is otherwise unchanged).
      await settleDay(tx, newDay[0] as TechnicianDayKey);
    }
  }
  // Not kept, the job is on no technician's day: the old day only lost it, even when it is the same day as the new one.
  await settleOrRefuse(tx, kept ? [...oldDay, ...newDay] : oldDay, kept ? before : null);
  if (moved) await endBegunVisit(tx, job, ctx.at);
  // F-799: a confirmation not yet sent names the old day; the handler's new confirmation is the 1 that stays (SD-45).
  // F-828: the same day and window is no new visit: a confirmation, sent or not, already names it and stays.
  if (job.date !== input.date || job.window_id !== window.id) {
    await cancelUnsentConfirmations(tx, job.job_number);
    // F-808 (SD-45): a moved visit ends the visit's open reschedule links, so an old R-reply link answers gone (SD-17, OA-62).
    await tx.query(`UPDATE world.link_token SET ended_at = $2 WHERE job_number = $1 AND kind = 'reschedule' AND ended_at IS NULL`, [job.job_number, ctx.at]);
  }
  await appendJobChange(tx, ctx, {
    jobNumber: job.job_number, kind: 'rescheduled', fromVersion: input.baseVersion, toVersion: input.baseVersion + 1,
    data: {
      from: { date: job.date, windowId: job.window_id, technicianId: job.technician_id, ...(moved ? { status: job.status } : {}) },
      to: { date: input.date, windowId: window.id, technicianId: kept ? job.technician_id : null, ...(moved ? { status: 'scheduled' } : {}) },
    },
  });
  await publishEvent(tx, 'job.changed', { jobNumber: job.job_number, branch: branch.id });
  return { job: await answerJob(tx, job.job_number), outcome: { technicianKept: kept, textSent: false } };
}

/**
 * cancelJob (API-25; FR-TECH-6): a Scheduled, On the way or On site job becomes `canceled` (CTL-OFC-03-07, owner ruling
 * 4241980e; F-505). A technician-day write (section 5.3 step 2): it locks the assigned technician's day, takes the version
 * gate, and settles that day so the canceled job leaves the planned arrivals. Done, No one home or Canceled answers
 * rule_refused (RULE.jobClosed). A begun job's live map link ends and its unsent on-the-way text is canceled (2142ce69,
 * 7ccb76ec call 8). Any unsent confirmation is canceled too (F-799). The job keeps its technician for history.
 * Kind `canceled`. No text is sent (FR-TEXT-9: no cancel text exists).
 */
export async function cancelJob(tx: Queryable, ctx: WriteContext, input: { jobNumber: number; baseVersion: number }): Promise<WrittenJob> {
  const job = await readJob(tx, input.jobNumber);
  if (!job) throw new WriteRefused('not_found', `job ${input.jobNumber} does not exist`);
  const days = dayKeys([[job.technician_id, job.date]]);
  await lockTechnicianDays(tx, days);
  await gatedJobUpdate(tx, job.job_number, input.baseVersion, `status = 'canceled', planned_arrival = NULL`, []);
  // The gate passed, so the job read above is the version the caller saw: its status is current.
  refuseClosed(job);
  // F-504: a removal is not refused for the plan it shifts (as deleteBlock, F-378): removing the job can pull a later job over a block,
  // and API-25 names no time_overlap, so the day settles and the overlap, if any, stays for the office to see.
  for (const d of days) await settleDay(tx, d);
  await endBegunVisit(tx, job, ctx.at);
  // F-799: canceling sends no text (SD-45), so a confirmation not yet sent does not go out either.
  await cancelUnsentConfirmations(tx, job.job_number);
  await appendJobChange(tx, ctx, {
    jobNumber: job.job_number, kind: 'canceled', fromVersion: input.baseVersion, toVersion: input.baseVersion + 1,
    data: { from: { status: job.status }, to: { status: 'canceled' } },
  });
  await publishEvent(tx, 'job.changed', { jobNumber: job.job_number, branch: job.branch_id });
  return answerJob(tx, job.job_number);
}

/**
 * editJob (API-27; FR-TECH-6): the service, the equipment (or none) and the problem text. A new service changes the job's
 * expected minutes, so the assigned technician's day is locked and settled again (a longer service whose recompute causes a block overlap refuses; a shorter one never does, OA-93). The
 * equipment must be the job's customer's. A job not Done, No one home or Canceled (F-505: a Done job's service is what
 * billing sends). A service that crosses FR-BOOK-5's pools (install and not) is a capacity write (section 5.3 step 3,
 * F-507 item 3): it takes the booking-day lock and answers window_full when the new pool has no room. Kind `details`.
 */
export async function editJob(tx: Queryable, ctx: WriteContext, input: {
  jobNumber: number; serviceId: string; equipmentId: string | null; problem: string | null; baseVersion: number;
}): Promise<WrittenJob> {
  const job = await readJob(tx, input.jobNumber);
  if (!job) throw new WriteRefused('not_found', `job ${input.jobNumber} does not exist`);
  const s = await tx.query<{ expected_minutes: number; skill: string }>('SELECT expected_minutes, skill FROM world.service_type WHERE id = $1', [input.serviceId]);
  const service = s.rows[0];
  if (!service) throw new WriteRefused('validation_failed', `service ${input.serviceId} does not exist`);
  if (input.equipmentId !== null) {
    const e = await tx.query('SELECT 1 FROM world.equipment WHERE id = $1 AND customer_id = $2', [input.equipmentId, job.customer_id]);
    if ((e.rowCount ?? 0) === 0) throw new WriteRefused('validation_failed', `equipment ${input.equipmentId} is not the customer's`);
  }
  const install = service.skill === 'install';
  const crossesPools = install !== ((await serviceIsInstall(tx, job.service_id)) ?? false);
  const days = dayKeys([[job.technician_id, job.date]]);
  // Section 5.3 step 6's order: the booking-day row before the technician-day lock.
  if (crossesPools) await lockBookingDays(tx, [{ branch: job.branch_id, date: job.date }]);
  await lockTechnicianDays(tx, days);
  // The job stays on its day with its new minutes: an edit to the same or a longer service changes the work on the day.
  // OA-93 (F-2044): an edit to a shorter service only takes work off the day, so its recompute never refuses; the board shows the overlap.
  const overlaps = await overlapsBefore(tx, service.expected_minutes < job.expected_minutes ? [] : days);
  // The old equipment and problem are read under the lock and before the gate; a stale base version then refuses.
  const before = await tx.query<{ equipment_id: string | null; problem: string | null }>(
    'SELECT equipment_id, problem FROM world.job WHERE job_number = $1', [job.job_number]);
  await gatedJobUpdate(tx, job.job_number, input.baseVersion, 'service_id = $3, equipment_id = $4, problem = $5, expected_minutes = $6',
    [input.serviceId, input.equipmentId, input.problem, service.expected_minutes]);
  refuseClosed(job);
  if (crossesPools) {
    const window = await readWindow(tx, job.window_id) as Window;
    const kind = await readDayKind(tx, job.branch_id, job.date);
    if ((await officeWindowRoom(tx, { branch: job.branch_id, date: job.date, window, kind, install, excludeJob: job.job_number })) <= 0) {
      throw new WriteRefused('window_full', `window ${window.id} on ${job.date} has no room for this service's pool`);
    }
  }
  await settleOrRefuse(tx, days, overlaps);
  const was = before.rows[0] as { equipment_id: string | null; problem: string | null };
  await appendJobChange(tx, ctx, {
    jobNumber: job.job_number, kind: 'details', fromVersion: input.baseVersion, toVersion: input.baseVersion + 1,
    data: {
      from: { serviceId: job.service_id, equipmentId: was.equipment_id, problem: was.problem },
      to: { serviceId: input.serviceId, equipmentId: input.equipmentId, problem: input.problem },
    },
  });
  await publishEvent(tx, 'job.changed', { jobNumber: job.job_number, branch: job.branch_id });
  return answerJob(tx, job.job_number);
}

/**
 * createJob (API-28; FR-DISP-8, FR-BOOK-3, FR-BOOK-6, FR-DISP-34): the office channel of windowRoom (no online cutoff,
 * same day allowed, day_past refused), under the booking-day lock, with an optional technician checked as assignJob
 * checks one. booked_via office, version 1, kind `created`. The confirmation text is the handler's (handlers/dispatch-writes.ts createJobHandler, F-671), sent after this returns.
 */
export async function createJob(tx: Queryable, ctx: WriteContext | OnlineContext, input: {
  customerId: string; serviceId: string; equipmentId: string | null; problem: string | null; date: string; windowId: string; technicianId: string | null;
  /**
   * API-113 (FR-BOOK-1): the customer's own booking. Same locks, same room check; only the channel columns differ (booked_via online, no
   * booked_by, the token, the page's booking key). A job that already holds the key when the booking-day lock is taken throws
   * {@link BookingKeyHeld} (SPECIFICATIONS 6.1 Booking write, K-01): a send of the same draft won the lock first.
   */
  online?: { bookingToken: string; bookingKey: string };
}): Promise<WrittenJob> {
  const c = await tx.query<{ branch_id: string; status: string }>('SELECT branch_id, status FROM world.customer WHERE id = $1', [input.customerId]);
  const customer = c.rows[0];
  if (!customer) throw new WriteRefused('validation_failed', `customer ${input.customerId} does not exist`);
  if (customer.status !== 'active') throw ruleRefused(RULE.customerNotActive, `customer ${input.customerId} is ${customer.status}`);
  const s = await tx.query<{ expected_minutes: number; skill: string }>('SELECT expected_minutes, skill FROM world.service_type WHERE id = $1', [input.serviceId]);
  const service = s.rows[0];
  if (!service) throw new WriteRefused('validation_failed', `service ${input.serviceId} does not exist`);
  if (input.equipmentId !== null) {
    const e = await tx.query('SELECT 1 FROM world.equipment WHERE id = $1 AND customer_id = $2', [input.equipmentId, input.customerId]);
    if ((e.rowCount ?? 0) === 0) throw new WriteRefused('validation_failed', `equipment ${input.equipmentId} is not the customer's`);
  }
  // F-745: the lock comes before the window and the day are read: the capacity and the mode this write decides on are the ones the lock serialized.
  await lockBookingDays(tx, [{ branch: customer.branch_id, date: input.date }]);
  // SPECIFICATIONS 6.1 Booking write (K-01): the key is looked up again under the lock, before the room check. A send of the same draft
  // that held this day's lock first has committed its job by now, and this send books nothing. A race onto another day takes another
  // lock, so the unique constraint job_booking_key_key settles that one (the INSERT below fails, and the handler answers as a repeat).
  if (input.online && (await tx.query('SELECT 1 FROM world.job WHERE booking_key = $1', [input.online.bookingKey])).rowCount) {
    throw new BookingKeyHeld();
  }
  const window = await readWindow(tx, input.windowId);
  if (!window || window.branch !== customer.branch_id) throw new WriteRefused('validation_failed', `window ${input.windowId} is not a window of ${customer.branch_id}`);
  const branch = await readBranch(tx, customer.branch_id);
  const kind = await officeDay(tx, branch.id, branch.zone, input.date, window, ctx.at);
  const days = dayKeys([[input.technicianId, input.date]]);
  await lockTechnicianDays(tx, days);
  const before = await overlapsBefore(tx, days);
  if ((await officeWindowRoom(tx, { branch: branch.id, date: input.date, window, kind, install: service.skill === 'install' })) <= 0) {
    throw new WriteRefused('window_full', `window ${window.id} on ${input.date} has no room`);
  }
  if (input.technicianId !== null) {
    const t = await workingTechnician(tx, input.technicianId, branch.id, input.date);
    const refused = await technicianRoomRefusal(tx, t, input.date, window, kind, -1);
    if (refused) throw new WriteRefused('technician_no_room', `technician ${t.id} has no room in window ${window.id} on ${input.date}`, refused);
  }
  // F-1509: the web server may run this call twice (route-source.ts routedOutside), and a rollback does not return a sequence's number, so
  // the number is drawn once for the call: the second pass reuses the first pass's number ($17) while the sequence has handed it out
  // (it never hands it out again) and no job holds it; else, as after a reset that wound the sequence back (SD-12), it draws a new one.
  // The check is part of the insert, which holds world.job's lock, so a reset (TRUNCATE) cannot come between them.
  const jobNumber = await drawnOnceForCall<number>('world.job.job_number', async (prior) => {
    const ins = await tx.query<{ job_number: number }>(
      `INSERT INTO world.job (job_number, customer_id, branch_id, service_id, equipment_id, problem, date, zone, window_id, window_start, window_end,
                              technician_id, status, version, expected_minutes, booked_via, booked_at, booked_by, billing_state,
                              autopilot, touched_by_person, pilot, booking_token, booking_key)
       VALUES (CASE WHEN $17::int <= pg_sequence_last_value(pg_get_serial_sequence('world.job', 'job_number')::regclass)
                     AND NOT EXISTS (SELECT 1 FROM world.job WHERE job_number = $17::int) THEN $17::int
                    ELSE nextval(pg_get_serial_sequence('world.job', 'job_number'))::int END,
               $1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, 'scheduled', 1, $12, $15, $13, $14, 'not_sent', false, true, false, $16, $18)
       RETURNING job_number`,
      [input.customerId, branch.id, input.serviceId, input.equipmentId, input.problem, input.date, branch.zone, window.id,
        at(input.date, window.startLocal, branch.zone), at(input.date, window.endLocal, branch.zone), input.technicianId,
        service.expected_minutes, ctx.at, ctx.actor.userId, input.online ? 'online' : 'office', input.online?.bookingToken ?? null, prior ?? null, input.online?.bookingKey ?? null]);
    return (ins.rows[0] as { job_number: number }).job_number;
  });
  // F-680: the status read above came before the locks. The INSERT's foreign key waits on a merge that holds this customer FOR UPDATE
  // and goes ahead once it commits; READ COMMITTED now sees the merge, and a job on a merged record is refused (the transaction rolls back).
  const after = await tx.query<{ status: string }>('SELECT status FROM world.customer WHERE id = $1', [input.customerId]);
  if (after.rows[0]?.status !== 'active') throw ruleRefused(RULE.customerNotActive, `customer ${input.customerId} is ${after.rows[0]?.status ?? 'gone'}`);
  await settleOrRefuse(tx, days, before);
  await appendJobChange(tx, ctx, {
    jobNumber, kind: 'created', fromVersion: 0, toVersion: 1,
    data: { via: input.online ? 'online' : 'office', date: input.date, windowId: window.id, technicianId: input.technicianId, serviceId: input.serviceId },
  });
  await publishEvent(tx, 'job.changed', { jobNumber, branch: branch.id });
  return answerJob(tx, jobNumber);
}

// --- Blocks: a technician's labeled time block on 1 day (FR-DISP-34; OA-72, OA-75) -------------------------------

interface BlockRow { id: string; technician_id: string; date: string; zone: string; start: Date; end: Date; label: string; place: string | null; version: number }
const BLOCK_COLUMNS = 'id, technician_id, date::text AS date, zone, start, "end", label, place, version';

async function readBlock(tx: Queryable, id: string): Promise<BlockRow | null> {
  const r = await tx.query<BlockRow>(`SELECT ${BLOCK_COLUMNS} FROM world.time_block WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

const writtenBlock = (b: BlockRow): WrittenBlock => ({
  blockId: b.id, technicianId: b.technician_id, date: b.date, label: b.label, place: b.place,
  start: wire(b.start, b.zone), end: wire(b.end, b.zone), version: b.version,
});

/** The block's span from local times on its date; end must come after start (time_block_end_after_start). */
function blockSpan(date: string, start: string, end: string, zone: string): [Date, Date] {
  const s = at(date, start, zone);
  const e = at(date, end, zone);
  if (e.getTime() <= s.getTime()) throw new WriteRefused('validation_failed', `block end ${end} is not after its start ${start}`);
  return [s, e];
}

async function blockTechnician(tx: Queryable, id: string, branch?: string): Promise<Technician> {
  const t = await readTechnician(tx, id);
  if (!t || (branch !== undefined && t.branch !== branch)) throw new WriteRefused('validation_failed', `technician ${id} is not on this branch`);
  return t;
}

/** createBlock (API-136): a block on a technician's row, under that day's lock; no scheduled job's planned time may overlap it. */
export async function createBlock(tx: Queryable, _ctx: WriteContext, input: {
  technicianId: string; date: string; label: string; place: string | null; start: string; end: string;
}): Promise<WrittenBlock> {
  const t = await blockTechnician(tx, input.technicianId);
  const branch = await readBranch(tx, t.branch);
  const [start, end] = blockSpan(input.date, input.start, input.end, branch.zone);
  const day = { technicianId: t.id, date: input.date };
  await lockTechnicianDays(tx, [day]);
  const before = await overlapsBefore(tx, [day]);
  const r = await tx.query<{ id: string }>(
    `INSERT INTO world.time_block (technician_id, date, zone, start, "end", label, place, version, seeded)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, 1, false) RETURNING id`,
    [t.id, input.date, branch.zone, start, end, input.label, input.place]);
  const id = (r.rows[0] as { id: string }).id;
  await settleOrRefuse(tx, [day], before);
  await publishEvent(tx, 'block.changed', { blockId: id, branch: branch.id, date: input.date });
  return writtenBlock(await readBlock(tx, id) as BlockRow);
}

/** The kind a block move writes in the block change log (owner ruling 8ef38e83, F-354). */
const BLOCK_MOVED = 'moved';

/**
 * The version_conflict members of a block (FR-DISP-34, FR-DISP-6; owner ruling 8ef38e83): the block change log row that
 * made the block's current version, its actor's name and kind, the block's technician now, and when. A block still at
 * its first version was never moved and has no row, so who and when are null.
 */
async function blockConflict(tx: Queryable, blockId: string): Promise<WriteRefused> {
  const r = await tx.query<{ version: number; zone: string; technician: string; kind: string | null; actor_kind: string | null; at: Date | null; by: string | null }>(
    `SELECT b.version, b.zone, t.name AS technician, c.kind, c.actor_kind, c.at, u.name AS by
       FROM world.time_block b
       JOIN world.technician t ON t.id = b.technician_id
       LEFT JOIN LATERAL (SELECT kind, actor_kind, actor_user_id, at FROM world.time_block_change
                           WHERE block_id = b.id AND to_version = b.version ORDER BY at DESC, id DESC LIMIT 1) c ON true
       LEFT JOIN world."user" u ON u.id = c.actor_user_id
      WHERE b.id = $1`, [blockId]);
  const c = r.rows[0];
  if (!c) return new WriteRefused('not_found', `block ${blockId} was deleted`);
  return new WriteRefused('version_conflict', `block ${blockId} is at version ${c.version}`, {
    by: c.actor_kind === 'office' ? c.by : null, byKind: c.actor_kind, change: c.kind, technician: c.technician,
    at: c.at ? wire(c.at, c.zone) : null, currentVersion: c.version,
  });
}

/**
 * moveBlock (API-137; section 5.3 step 4): to another time on its date, or another technician of its branch, gated on
 * the block's own version. A move appends 1 row to the block change log (who, their kind, the change and when; owner
 * ruling 8ef38e83), which a later conflicting move is answered from.
 */
export async function moveBlock(tx: Queryable, ctx: WriteContext, input: {
  blockId: string; technicianId: string; start: string; end: string; baseVersion: number;
}): Promise<WrittenBlock> {
  const b = await readBlock(tx, input.blockId);
  if (!b) throw new WriteRefused('not_found', `block ${input.blockId} does not exist`);
  const from = await blockTechnician(tx, b.technician_id);
  const to = await blockTechnician(tx, input.technicianId, from.branch);
  const [start, end] = blockSpan(b.date, input.start, input.end, b.zone);
  const days = [{ technicianId: from.id, date: b.date }, { technicianId: to.id, date: b.date }];
  await lockTechnicianDays(tx, days);
  // The block ends on the new technician's row; the old row, when it is another, only loses it.
  const before = await overlapsBefore(tx, [{ technicianId: to.id, date: b.date }]);
  const u = await tx.query(
    `UPDATE world.time_block SET technician_id = $3, start = $4, "end" = $5, version = version + 1 WHERE id = $1 AND version = $2`,
    [b.id, input.baseVersion, to.id, start, end]);
  if ((u.rowCount ?? 0) === 0) throw await blockConflict(tx, b.id);
  await settleOrRefuse(tx, days, before);
  await tx.query(
    `INSERT INTO world.time_block_change (block_id, at, actor_user_id, actor_kind, kind, from_version, to_version, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [b.id, ctx.at, ctx.actor.userId, ctx.actor.kind, BLOCK_MOVED, input.baseVersion, input.baseVersion + 1, JSON.stringify({
      from: { technicianId: b.technician_id, start: wire(b.start, b.zone), end: wire(b.end, b.zone) },
      to: { technicianId: to.id, start: wire(start, b.zone), end: wire(end, b.zone) },
    })]);
  await publishEvent(tx, 'block.changed', { blockId: b.id, branch: from.branch, date: b.date });
  return writtenBlock(await readBlock(tx, b.id) as BlockRow);
}

/** deleteBlock (API-138; OA-75): from any state; frees the time at once. */
export async function deleteBlock(tx: Queryable, _ctx: WriteContext, input: { blockId: string }): Promise<void> {
  const b = await readBlock(tx, input.blockId);
  if (!b) throw new WriteRefused('not_found', `block ${input.blockId} does not exist`);
  const t = await blockTechnician(tx, b.technician_id);
  const day = { technicianId: t.id, date: b.date };
  await lockTechnicianDays(tx, [day]);
  const d = await tx.query('DELETE FROM world.time_block WHERE id = $1', [b.id]);
  if ((d.rowCount ?? 0) === 0) throw new WriteRefused('not_found', `block ${b.id} was deleted`);
  // OA-75: a delete is allowed from any state. Settle the day but never refuse: an overlap that remains is another
  // block's with a job (a merge writes such overlaps by design), not one this delete caused (F-378).
  await settleDay(tx, day);
  await publishEvent(tx, 'block.changed', { blockId: b.id, branch: t.branch, date: b.date });
}

// --- Customer merges: each job moved is logged as a merged change (owner ruling a7cafbb1, F-267) --------------------

/** The job_change kind a merge and its undo write for each job they move (F-267; section 3's enum gets it at the phase 3 doc batch). */
const MERGE_CHANGE_KIND: JobChangeKind = 'merged';

type JobPick = { job_number: number; technician_id: string | null; date: string };

const freshDays = (pick: readonly JobPick[], locked: readonly TechnicianDayKey[]): TechnicianDayKey[] =>
  dayKeys(pick.map((r) => [r.technician_id, r.date] as const)).filter((d) => !locked.some((l) => l.technicianId === d.technicianId && l.date === d.date));

/**
 * F-379, F-622 (section 5.3 step 6): lock the technician-days of the jobs `read` returns, always in 1 sorted batch, then read
 * again with a plain SELECT. A job that has moved to a day not held is found by that read; the batch is then rolled back
 * (a lock taken after a savepoint is released by the rollback to it) and taken again with the new day in its sorted place,
 * so a day is never asked for after one that sorts later, and 2 writes that need the same set cannot cross. A reassign must
 * hold the job's day to move it away, so once every day of every job is held the job cannot move before the UPDATE.
 */
async function holdJobDays(
  tx: Queryable, read: () => Promise<JobPick[]>, seed: readonly TechnicianDayKey[],
): Promise<{ pick: JobPick[]; locked: TechnicianDayKey[] }> {
  let known: TechnicianDayKey[] = [...seed, ...freshDays(await read(), seed)];
  for (;;) {
    await tx.query('SAVEPOINT job_days');
    await lockTechnicianDays(tx, known);
    const pick = await read();
    const fresh = freshDays(pick, known);
    if (fresh.length === 0) {
      await tx.query('RELEASE SAVEPOINT job_days');
      return { pick, locked: known };
    }
    await tx.query('ROLLBACK TO SAVEPOINT job_days');
    known = [...known, ...fresh];
  }
}

/**
 * The technician-days an address edit may have to plan again (API-36, F-1933; SD-15): those of the customer's open jobs from
 * today on, locked before the customer row, then the customer row itself, which is held FOR UPDATE on return. A day already
 * past, an ended job and a canceled job keep the plan they ran on.
 *
 * Lock order (section 5.3 step 6; F-379, F-622): the days in 1 sorted batch, the jobs' rows, the customer row. The job rows come
 * before the customer because a technician's item holds its job's row and then refers to the customer (a text's foreign key):
 * with the rows held, the plan's UPDATE never waits for one while the customer is held. A job that reached the customer between
 * the read and the customer lock (a booking, a merge into the customer) starts the lock phase again with its day in the sorted
 * batch, as mergePair does on LockOrderRetry; no day is ever asked for while the customer row is held, and each new start
 * follows a job that committed meanwhile.
 */
export async function lockAddressEdit(tx: Queryable, customerId: string, now: Temporal.Instant): Promise<TechnicianDayKey[]> {
  const read = async (): Promise<JobPick[]> => (await tx.query<JobPick>(
    `SELECT j.job_number, j.technician_id, j.date::text AS date FROM world.job j JOIN world.branch b ON b.id = j.branch_id
      WHERE j.customer_id = $1 AND j.technician_id IS NOT NULL AND j.status IN ('scheduled', 'on_the_way', 'on_site')
        AND j.date >= ($2::timestamptz AT TIME ZONE b.zone)::date ORDER BY j.job_number`, [customerId, now.toString()])).rows;
  let seed: readonly TechnicianDayKey[] = [];
  await tx.query('SAVEPOINT address_edit');
  for (;;) {
    const { pick, locked } = await holdJobDays(tx, read, seed);
    await tx.query('SELECT 1 FROM world.job WHERE job_number = ANY($1::int[]) ORDER BY job_number FOR NO KEY UPDATE', [pick.map((j) => j.job_number)]);
    await tx.query('SELECT 1 FROM world.customer WHERE id = $1 FOR UPDATE', [customerId]);
    const after = await read();
    if (after.every((j) => pick.some((x) => x.job_number === j.job_number))) {
      await tx.query('RELEASE SAVEPOINT address_edit');
      return dayKeys(after.map((j) => [j.technician_id, j.date] as const));
    }
    await tx.query('ROLLBACK TO SAVEPOINT address_edit');
    seed = [...locked, ...freshDays(after, locked)];
  }
}

/**
 * The plan half of an address edit that moved the point (F-1933): each day lockAddressEdit returned is settled from the new
 * point. As in a merge, an overlap it causes is not a refusal (API-36 answers no time_overlap): the plan is written and the
 * board shows it. 1 board.refresh when any planned arrival moved, so an open board follows (F-822), and never a job.changed.
 */
export async function planAddressEdit(tx: Queryable, days: readonly TechnicianDayKey[]): Promise<void> {
  const plans = async () => (await tx.query<{ branch_id: string; job_number: number; at: Date | null }>(
    `SELECT j.branch_id, j.job_number, j.planned_arrival AS at FROM world.job j
       JOIN unnest($1::uuid[], $2::date[]) AS d(technician_id, date) ON d.technician_id = j.technician_id AND d.date = j.date ORDER BY j.job_number`,
    [days.map((d) => d.technicianId), days.map((d) => d.date)])).rows;
  const before = new Map((await plans()).map((j) => [j.job_number, j.at?.getTime()]));
  for (const d of days) await settleDay(tx, d);
  const moved = (await plans()).filter((j) => before.get(j.job_number) !== j.at?.getTime());
  for (const branch of new Set(moved.map((j) => j.branch_id))) await publishEvent(tx, 'board.refresh', { branch });
}

/**
 * Move jobs from 1 customer to another for a merge or its undo (@bw/import's JobMover port). Each moved job gets
 * version + 1, 1 job_change row of kind `merged` (data: mergeId, step merge or undo, from and to customer) and 1
 * job.changed notice; its technician-day is settled again, since the job's place is now the kept record's address.
 * A merge is not a scheduling decision, so an overlap it causes is not a refusal: the plan is written and the board
 * shows it. Lock order holds (F-379): the jobs' technician-days are locked, the jobs are read again and any day they have
 * moved to is locked too, until no new day shows; only then are the rows written. The `late` lock below is left for a job
 * with no technician that was assigned in the milliseconds after the last read.
 */
export async function moveJobsToCustomer(tx: Queryable, move: {
  from: string; to: string; jobNumbers: readonly number[] | null; mergeId: string; step: 'merge' | 'undo'; by: string | null; at: Date;
  held?: readonly HeldDay[];
}): Promise<number[]> {
  const readPicks = async (): Promise<JobPick[]> => (move.jobNumbers === null
    ? await tx.query<JobPick>('SELECT job_number, technician_id, date::text AS date FROM world.job WHERE customer_id = $1 ORDER BY job_number', [move.from])
    : await tx.query<JobPick>('SELECT job_number, technician_id, date::text AS date FROM world.job WHERE job_number = ANY($1::int[]) ORDER BY job_number', [[...move.jobNumbers]])
  ).rows;
  let pick: JobPick[];
  let locked: TechnicianDayKey[];
  if (move.held === undefined) ({ pick, locked } = await holdJobDays(tx, readPicks, []));
  else {
    // The caller (mergePair) holds the days of the jobs it read and has taken the customer rows since. A job that reached a
    // day beyond those is only try-locked: waiting here would be a day lock after a customer lock (F-622).
    locked = [...move.held];
    for (;;) {
      pick = await readPicks();
      const fresh = freshDays(pick, locked);
      if (fresh.length === 0) break;
      if (!(await tryLockTechnicianDays(tx, fresh))) throw new LockOrderRetry([...locked, ...fresh]);
      locked = [...locked, ...fresh];
    }
  }
  if (pick.length === 0) return [];
  // F-2012 K-09.3: only an open job from demo today on is planned again; a past day and an ended or canceled job keep the plan they
  // ran on (as an address edit's days, lockAddressEdit). Every job still moves to the kept record.
  const moved = await tx.query<{ job_number: number; version: number; branch_id: string; technician_id: string | null; date: string; replan: boolean }>(
    `UPDATE world.job SET customer_id = $2, touched_by_person = true, version = version + 1 WHERE job_number = ANY($1::int[])
     RETURNING job_number, version, branch_id, technician_id, date::text AS date,
               (status IN ('scheduled', 'on_the_way', 'on_site') AND date >= ($3::timestamptz AT TIME ZONE zone)::date) AS replan`,
    [pick.map((r) => r.job_number), move.to, move.at]);
  // F-510, SD-49: a van_track, baked or live, is drawn to the customer point it was made for; a job moved to a customer at another point
  // has none, so every row naming it goes (the route source routes the new point on its next read).
  const points = await tx.query<{ id: string; lon: number; lat: number }>('SELECT id, lon, lat FROM world.customer WHERE id = ANY($1::uuid[])', [[move.from, move.to]]);
  const [p0, p1] = [points.rows.find((r) => r.id === move.from), points.rows.find((r) => r.id === move.to)];
  if (!p0 || !p1 || p0.lon !== p1.lon || p0.lat !== p1.lat) await deleteTracksNaming(tx, moved.rows.map((r) => r.job_number));
  const days = dayKeys(moved.rows.filter((r) => r.replan).map((r) => [r.technician_id, r.date] as const));
  const late = days.filter((d) => !locked.some((l) => l.technicianId === d.technicianId && l.date === d.date));
  if (late.length > 0) await lockTechnicianDays(tx, late);
  for (const d of days) await settleDay(tx, d);
  const ctx = { actor: { kind: 'office' as const, userId: move.by }, at: move.at };
  for (const j of [...moved.rows].sort((x, y) => x.job_number - y.job_number)) {
    await appendJobChange(tx, ctx, {
      jobNumber: j.job_number, kind: MERGE_CHANGE_KIND, fromVersion: j.version - 1, toVersion: j.version,
      data: { mergeId: move.mergeId, step: move.step, fromCustomerId: move.from, toCustomerId: move.to },
    });
    await publishEvent(tx, 'job.changed', { jobNumber: j.job_number, branch: j.branch_id });
  }
  return moved.rows.map((r) => r.job_number).sort((x, y) => x - y);
}

/** The mergePair port (F-379, F-622): the technician-days of record `from`'s jobs, locked in 1 sorted batch before any customer row. */
moveJobsToCustomer.lockDays = async (tx: Queryable, from: string, seed: readonly HeldDay[]): Promise<readonly HeldDay[]> =>
  (await holdJobDays(tx, async () => (await tx.query<JobPick>(
    'SELECT job_number, technician_id, date::text AS date FROM world.job WHERE customer_id = $1 ORDER BY job_number', [from])).rows, seed)).locked;
