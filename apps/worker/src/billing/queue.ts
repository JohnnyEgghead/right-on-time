// SPDX-License-Identifier: AGPL-3.0-or-later
// The billing queue's writes outside the link worker (SPECIFICATIONS section 6.6, section 3 `billing_item`, the enum
// writer table): each runs inside its caller's 1 transaction (SD-6), so the queue change, its scheduled_event row,
// the job's billing_state mirror and the notice commit together or not at all.
//
//   billFinishedJob   the finish (API-26, API-102's finish item, the autopilot): 1 billing_item in `sending` and 1
//                     billing.send event (FR-BILL-1). Only a finished job: No one home and imported visits never
//                     reach billing (FR-BILL-9, OI-8).
//   sendAgain         API-61: a data error a person resolved; state `sending`, send_cause `sent_again`, 1 billing.send,
//                     job_change `sent_again` (FR-BILL-7, OI-12).
//   resendCorrected   API-62 after Correct the finish replaced the lines under the version gate: the same with
//                     send_cause `corrected` (its job_change `finish_corrected` is the correction write's).
//   retryNow/retryAll API-156, API-157: the pending retry of each `retrying` item moves to demo now; `waiting_person`
//                     items are skipped (FR-BILL-10).
//
// Invariant held by every writer here and by the link (invariant 2, "listed, never dropped"): an item in `sending` or
// `retrying` has exactly 1 due billing event (or a send in flight that will write the next one), an item in
// `waiting_person` has none, and an item that left (`in_billing`, `marked_fixed`) has none.
//
// Lock order (F-401): every billing writer takes the job's billing_item row first, and only then the job row and the
// job's scheduled_event rows (the link takes the job's billing advisory lock before the item). The item row is the
// gate: 2 writers of 1 job queue on it, so neither can hold the job row while it waits for the item. lockItemThenJob is
// that order for a writer that changes both. The finish is the one writer that arrives holding the job row (its
// version-gated write): billFinishedJob never waits on an existing item row there, and takes the job row at the
// strength that write holds (FOR NO KEY UPDATE), since raising it to FOR UPDATE queues behind a link's tx 2 already
// waiting on that row: a deadlock with no item row in it.
import { publishEvent, type Queryable } from '@bw/db';
import { BILLING_EVENT_KINDS, BILLING_RETRYING_LONG_MINUTES, storedFinishHasLines, type BillingEventKind, type BillingState } from '@bw/domain';
import type { Instant } from '@bw/time';

/** The event bus seam's publish (SPECIFICATIONS section 4.3): in the writing transaction, ids only. */
export type Publish = (tx: Queryable, name: 'billing.changed', ids: Record<string, string | number>) => Promise<void>;

/**
 * The default publish: @bw/db publishEvent, the bus's 1 publisher (packages/db/src/events.ts names the channel and the
 * payload, and checks both; F-385). It runs inside the writing transaction, so the notice leaves only at commit.
 * billing.changed carries jobNumber (UI-SPECIFICATION 12.3 EVT-07) and branch, which the bus filters on.
 */
export const busPublish: Publish = (tx, name, ids) => publishEvent(tx, name, ids);

/** A finish that must not commit: the caller's transaction is rolled back with it (FR-BILL-3, invariant 10). */
export class BillingRefusedError extends Error {
  readonly code: 'parts_required';
  constructor(jobNumber: number) {
    super(`job ${jobNumber} was finished with neither parts nor No parts used`);
    this.name = 'BillingRefusedError';
    this.code = 'parts_required';
  }
}

export type QueueRefusal = 'not_found' | 'not_waiting' | 'not_retrying';

const iso = (t: Instant): string => t.toString();

/** The scheduled_event subject of a job's billing events: its job number (ids only, NFR-05). */
export const billingSubject = (jobNumber: number): string => String(jobNumber);

export async function scheduleBillingEvent(tx: Queryable, kind: BillingEventKind, jobNumber: number, dueAt: Instant): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ($1, $2, $3, $4, 'due') RETURNING id`,
    [iso(dueAt), kind, billingSubject(jobNumber), JSON.stringify({ jobNumber })],
  );
  return r.rows[0]!.id;
}

/** Retire every due billing event of the job except `keep` (the 1 being run), so the job never holds 2 (invariant 2). */
export async function supersedeDueBillingEvents(tx: Queryable, jobNumber: number, keep: string | null, result: string): Promise<number> {
  const r = await tx.query(
    `UPDATE world.scheduled_event SET state = 'skipped', result = $3
      WHERE kind = ANY($1) AND subject = $2 AND state = 'due' AND ($4::uuid IS NULL OR id <> $4)`,
    [BILLING_EVENT_KINDS, billingSubject(jobNumber), result, keep],
  );
  return r.rowCount ?? 0;
}

/** The item and job a billing writer changes, locked item first (F-401). Null when the job has no billing item. */
export async function lockItemThenJob(tx: Queryable, jobNumber: number): Promise<{ state: BillingState; tries: number; version: number; branch_id: string } | null> {
  const i = await tx.query<{ state: BillingState; tries: number }>('SELECT state, tries FROM world.billing_item WHERE job_number = $1 FOR UPDATE', [jobNumber]);
  const item = i.rows[0];
  if (!item) return null;
  // FOR NO KEY UPDATE: the strength the job's own UPDATE takes, so a job_change insert's key-share check is not held up.
  const j = await tx.query<{ version: number; branch_id: string }>('SELECT version, branch_id FROM world.job WHERE job_number = $1 FOR NO KEY UPDATE', [jobNumber]);
  const job = j.rows[0];
  if (!job) return null;
  return { state: item.state, tries: item.tries, version: job.version, branch_id: job.branch_id };
}

async function setJobBillingState(tx: Queryable, jobNumber: number, state: BillingState): Promise<void> {
  await tx.query('UPDATE world.job SET billing_state = $2 WHERE job_number = $1', [jobNumber, state]);
}

async function branchOf(tx: Queryable, jobNumber: number): Promise<string> {
  const r = await tx.query<{ branch_id: string }>('SELECT branch_id FROM world.job WHERE job_number = $1', [jobNumber]);
  return r.rows[0]?.branch_id ?? '';
}

export type BillFinishedResult = { queued: true } | { queued: false; why: 'not_found' | 'not_finished' | 'already_queued' };

/**
 * The billing half of a finish (FR-BILL-1, FR-BILL-9, OI-8), called by the finish path inside its transaction after
 * it wrote the finish. A job whose status is not `done` (No one home, canceled, an open visit) creates nothing. A job
 * finished with neither parts nor No parts used throws BillingRefusedError, so the finish rolls back (FR-BILL-3).
 * Calling it again for a job already queued changes nothing.
 */
export async function billFinishedJob(tx: Queryable, input: { jobNumber: number; at: Instant }, publish: Publish = busPublish): Promise<BillFinishedResult> {
  const { jobNumber, at } = input;
  const j = await tx.query<{ status: string; no_parts_used: boolean; parts: number; branch_id: string }>(
    `SELECT status, no_parts_used, branch_id, (SELECT count(*) FROM world.job_part p WHERE p.job_number = j.job_number)::integer AS parts
       FROM world.job j WHERE job_number = $1 FOR NO KEY UPDATE`, [jobNumber]);
  const job = j.rows[0];
  if (!job) return { queued: false, why: 'not_found' };
  if (job.status !== 'done') return { queued: false, why: 'not_finished' };
  if (!storedFinishHasLines(job.parts, job.no_parts_used)) throw new BillingRefusedError(jobNumber);
  // F-401: the finish holds the job row, so an existing item is seen by a plain read, never waited on: a link's tx 2
  // holding that item (and waiting for this job row) would otherwise deadlock with the INSERT's unique check below.
  const had = await tx.query('SELECT 1 FROM world.billing_item WHERE job_number = $1', [jobNumber]);
  if (had.rows.length > 0) return { queued: false, why: 'already_queued' };
  const ins = await tx.query(`INSERT INTO world.billing_item (job_number, state, tries) VALUES ($1, 'sending', 0) ON CONFLICT (job_number) DO NOTHING`, [jobNumber]);
  if ((ins.rowCount ?? 0) === 0) return { queued: false, why: 'already_queued' };
  await setJobBillingState(tx, jobNumber, 'sending');
  await scheduleBillingEvent(tx, 'billing.send', jobNumber, at);
  await publish(tx, 'billing.changed', { jobNumber, branch: job.branch_id });
  return { queued: true };
}

async function requeueByPerson(
  tx: Queryable, cause: 'sent_again' | 'corrected', input: { jobNumber: number; by: string; at: Instant }, publish: Publish,
): Promise<{ ok: true } | { ok: false; code: QueueRefusal }> {
  const { jobNumber, by, at } = input;
  const item = await lockItemThenJob(tx, jobNumber);
  if (!item) return { ok: false, code: 'not_found' };
  if (item.state !== 'waiting_person') return { ok: false, code: 'not_waiting' };
  await tx.query(
    `UPDATE world.billing_item SET state = 'sending', send_cause = $2, reason_key = NULL, next_try_at = NULL WHERE job_number = $1`,
    [jobNumber, cause]);
  await setJobBillingState(tx, jobNumber, 'sending');
  await supersedeDueBillingEvents(tx, jobNumber, null, 'superseded');
  await scheduleBillingEvent(tx, 'billing.send', jobNumber, at);
  if (cause === 'sent_again') {
    await tx.query(
      `INSERT INTO world.job_change (job_number, at, actor_user_id, actor_kind, kind, from_version, to_version, data)
       VALUES ($1, $2, $3, 'office', 'sent_again', $4, $4, '{}')`, [jobNumber, iso(at), by, item.version]);
  }
  await publish(tx, 'billing.changed', { jobNumber, branch: item.branch_id });
  return { ok: true };
}

/** Send again (API-61; FR-BILL-7, OA-57, OI-12): only an item waiting for a person. */
export function sendAgain(tx: Queryable, input: { jobNumber: number; by: string; at: Instant }, publish: Publish = busPublish) {
  return requeueByPerson(tx, 'sent_again', input, publish);
}

/** After Correct the finish (API-62; OA-61): the correction write already replaced the lines and appended its job_change. */
export function resendCorrected(tx: Queryable, input: { jobNumber: number; by: string; at: Instant }, publish: Publish = busPublish) {
  return requeueByPerson(tx, 'corrected', input, publish);
}

async function moveRetryToNow(tx: Queryable, jobNumber: number, at: Instant): Promise<void> {
  const moved = await tx.query(
    `UPDATE world.scheduled_event SET due_at = $3 WHERE kind = ANY($1) AND subject = $2 AND state = 'due'`,
    [BILLING_EVENT_KINDS, billingSubject(jobNumber), iso(at)]);
  // A retrying item always holds its retry; should one be missing, Retry now writes it rather than doing nothing.
  if ((moved.rowCount ?? 0) === 0) await scheduleBillingEvent(tx, 'billing.retry', jobNumber, at);
  await tx.query('UPDATE world.billing_item SET next_try_at = $2 WHERE job_number = $1', [jobNumber, iso(at)]);
}

/** Retry now (API-156; FR-BILL-10): the next call of 1 retrying item happens at demo now. */
export async function retryNow(tx: Queryable, input: { jobNumber: number; at: Instant }, publish: Publish = busPublish): Promise<{ ok: true } | { ok: false; code: QueueRefusal }> {
  const r = await tx.query<{ state: BillingState }>('SELECT state FROM world.billing_item WHERE job_number = $1 FOR UPDATE', [input.jobNumber]);
  const item = r.rows[0];
  if (!item) return { ok: false, code: 'not_found' };
  if (item.state !== 'retrying') return { ok: false, code: 'not_retrying' };
  await moveRetryToNow(tx, input.jobNumber, input.at);
  await publish(tx, 'billing.changed', { jobNumber: input.jobNumber, branch: await branchOf(tx, input.jobNumber) });
  return { ok: true };
}

/** Retry all (API-157; FR-BILL-10): every retrying item of the branch (all branches when none is named). Answers how many. */
export async function retryAll(tx: Queryable, input: { at: Instant; branchId?: string }, publish: Publish = busPublish): Promise<number> {
  const r = await tx.query<{ job_number: number; branch_id: string }>(
    `SELECT bi.job_number, j.branch_id FROM world.billing_item bi JOIN world.job j USING (job_number)
      WHERE bi.state = 'retrying' AND ($1::text IS NULL OR j.branch_id = $1) ORDER BY bi.job_number FOR UPDATE OF bi`,
    [input.branchId ?? null]);
  for (const row of r.rows) {
    await moveRetryToNow(tx, row.job_number, input.at);
    await publish(tx, 'billing.changed', { jobNumber: row.job_number, branch: row.branch_id });
  }
  return r.rows.length;
}

export interface ListedItem {
  jobNumber: number;
  state: 'sending' | 'retrying' | 'waiting_person';
  reason: string | null;
  tries: number;
  lastTryAt: string | null;
  nextTryAt: string | null;
  sendCause: 'sent_again' | 'corrected' | null;
}

export interface LeftItem {
  jobNumber: number;
  leftAt: string;
  leftHow: 'automatic_retry' | 'sent_again' | 'corrected' | 'marked_fixed';
  leftBy: string | null;
  leftReason: string | null;
  tries: number;
}

/**
 * The 1 "listed" rule (FR-BILL-2): an item is on the office billing list when it has not left (`sending`, `retrying` or
 * `waiting_person`) and it failed at least once (tries > 0). F-1844: also an item still `sending` with 0 tries once its
 * send has been due for BILLING_RETRYING_LONG_MINUTES (60) demo minutes (its billing event, due since then, has not run
 * to an outcome: a send that keeps throwing never writes a try, and the healer leaves it alone while that event is due),
 * the limit the billing_retrying_long alert uses. Before the 60 minutes it is a send in progress and is not listed.
 *
 * F-1865: billingList lists by this rule and Mark fixed (fixed.ts) accepts by it, so a row the office sees is always
 * one it can mark fixed (FR-BILL-11). It is a SQL boolean over `bi` (world.billing_item) at demo `now`; its 3
 * parameters are numbered from `$first`, and the caller appends `params` to its own.
 */
export function listedRule(now: Instant, first: number): { sql: string; params: [string, readonly string[], number] } {
  const [nowP, kindsP, minutesP] = [first, first + 1, first + 2];
  return {
    sql: `(bi.state IN ('sending', 'retrying', 'waiting_person')
        AND (bi.tries > 0
          OR (bi.state = 'sending' AND EXISTS (
                SELECT 1 FROM world.scheduled_event e
                 WHERE e.kind = ANY($${kindsP}::text[]) AND e.subject = bi.job_number::text AND e.state = 'due'
                   AND e.due_at <= $${nowP}::timestamptz - make_interval(mins => $${minutesP})))))`,
    params: [iso(now), BILLING_EVENT_KINDS, BILLING_RETRYING_LONG_MINUTES],
  };
}

/**
 * What the office billing list shows for a branch (API-60's waiting list and leftLast7Days; FR-BILL-2, FR-BILL-12):
 * every item the listedRule lists, and the items that left within the last 7 demo days.
 */
export async function billingList(q: Queryable, input: { branchId: string; now: Instant }): Promise<{ waiting: ListedItem[]; leftLast7Days: LeftItem[] }> {
  const listed = listedRule(input.now, 2);
  const w = await q.query<{ job_number: number; state: ListedItem['state']; reason_key: string | null; tries: number; last_try_at: Date | null; next_try_at: Date | null; send_cause: ListedItem['sendCause'] }>(
    `SELECT bi.job_number, bi.state, bi.reason_key, bi.tries, bi.last_try_at, bi.next_try_at, bi.send_cause
       FROM world.billing_item bi JOIN world.job j USING (job_number)
      WHERE j.branch_id = $1 AND ${listed.sql}
      ORDER BY bi.last_try_at, bi.job_number`, [input.branchId, ...listed.params]);
  const l = await q.query<{ job_number: number; left_at: Date; left_how: LeftItem['leftHow']; left_by: string | null; left_reason: string | null; tries: number }>(
    `SELECT bi.job_number, bi.left_at, bi.left_how, bi.left_by, bi.left_reason, bi.tries
       FROM world.billing_item bi JOIN world.job j USING (job_number)
      WHERE j.branch_id = $1 AND bi.left_at IS NOT NULL AND bi.left_at > $2::timestamptz - interval '7 days' AND bi.left_at <= $2::timestamptz
      ORDER BY bi.left_at DESC, bi.job_number`, [input.branchId, iso(input.now)]);
  const t = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    waiting: w.rows.map((r) => ({ jobNumber: r.job_number, state: r.state, reason: r.reason_key, tries: r.tries, lastTryAt: t(r.last_try_at), nextTryAt: t(r.next_try_at), sendCause: r.send_cause })),
    leftLast7Days: l.rows.map((r) => ({ jobNumber: r.job_number, leftAt: r.left_at.toISOString(), leftHow: r.left_how, leftBy: r.left_by, leftReason: r.left_reason, tries: r.tries })),
  };
}
