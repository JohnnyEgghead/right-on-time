// SPDX-License-Identifier: AGPL-3.0-or-later
// The billing link (SPECIFICATIONS section 6.6, section 2 "Billing link | job finished; event billing.retry";
// invariants 2 and 10; FR-BILL-1, FR-BILL-2, FR-BILL-6, FR-BILL-7, FR-BILL-8, FR-BILL-12, FR-BILL-13; UC-07).
//
// 1 billing event (billing.send or billing.retry) runs in the worker event dispatcher's parallel claim lane
// (apps/worker/src/dispatcher.ts LaneRunner, F-357): billing events run concurrently across jobs, 1 at a time per job,
// at most BILLING_CONCURRENCY in flight, below the worker's pool (F-382). It runs in 3 steps, and no transaction, pooled
// connection or row lock is held while pbs is called (F-382):
//   1. tx 1 (short, holding the event row): take the job's billing lock (a transaction advisory lock); the item must
//      still want a send (`sending`, `retrying`); read the item's try count and the world epoch; compose the invoice
//      from the job at send time (SD-20). A job that cannot be composed is a data error recorded without calling pbs.
//      Commit: the event is still due; nothing is written.
//   2. no transaction: send through the billing client: 30 s real-time timeout, Idempotency-Key job-<n>, the world
//      epoch (SD-12).
//   3. tx 2 (short): the job's billing lock, the item row, then the event row and the job row (item first, the order
//      every billing writer uses, F-401: queue.ts);
//      record: append billing_attempt n, move the item and the job's billing_state, retire the event, and write the
//      next retry 15 demo minutes after this try (timeout, down, wrong_epoch), or hold a data error for a person with
//      no retry (FR-BILL-7), or record the success with left_at/left_how when the item had been listed.
//
// Re-run semantics, at every durable write:
//   - The attempt, the item's move, the next retry and the event's done mark commit together, in tx 2 (1 transaction per
//     event outcome). A crash or an error before tx 2 commits leaves none of them, and the event is still due: the send
//     runs again, pbs answers already_have to a send it already stored (FR-BILL-8), and the link records that as the
//     success. The job converges on 1 invoice and 1 in_billing item; the only trace of the lost run is pbs's call row.
//   - 1 send per job at a time: the dispatcher's lane runs 1 event per job (its in-flight key), and the job's advisory
//     lock keeps tx 1 and tx 2 of 2 runners of 1 job apart (a tx 1 that finds it held throws BillingBusyError, so its
//     event stays due for a later pass). tx 2 records only when the item's try count is still the one tx 1 read, so a
//     second runner (another dispatcher) can make a second call (answered already_have) but never a second outcome.
//     tx 2 retires every other due billing event of the job and writes at most 1 retry, so duplicates can never fan
//     out into 2 retry chains (invariant 2: exactly 1 due event while `sending` or `retrying`).
//   - The world epoch is read in tx 1 and checked again in tx 2 under FOR SHARE on the clock row (a reset updates it),
//     so an answer from the old world is never recorded into a newer one; pbs checks the epoch on receipt and at store
//     under FOR UPDATE on pbs.mode.
//   - An item that left while the call was in flight (Mark fixed, which no longer waits on the call) keeps its state:
//     tx 2 finds the event retired and appends the attempt as history only.
//   - The healer (startBillingHealer, a worker job) writes a retry for any `sending` or `retrying` item left with no
//     due event, so no item is ever dropped.
import { inTransaction, type Queryable } from '@bw/db';
import {
  BILLING_EVENT_KINDS, RETRY_DEMO_MINUTES, type AttemptResult, type BillingState, type InvoiceRequest,
} from '@bw/domain';
import type { Logger } from '@bw/log';
import type { Clock, Instant } from '@bw/time';
import type pg from 'pg';
import type { DueEvent, EventOutcome, ParallelLane, SplitHandler } from '../dispatcher.ts';
import { HttpBillingClient, type BillingClient, type SendOutcome } from './client.ts';
import { composeFromJob } from './compose.ts';
import { billingSubject, busPublish, scheduleBillingEvent, supersedeDueBillingEvents, type Publish } from './queue.ts';

/** The advisory lock class of a job's billing send ("bi"); the second key is the job number. */
export const BILLING_LOCK_CLASS = 0x6269;

/** The worker's pool size (apps/worker/src/main.ts creates its pool with it). */
export const WORKER_POOL_MAX = 4;

/**
 * Billing sends in flight at once in 1 dispatcher: below the worker's pool (F-357, F-382), so the serial lane and the
 * clock reads always find a connection even while every billing slot is in tx 1 or tx 2.
 */
export const BILLING_CONCURRENCY = WORKER_POOL_MAX - 1;

export interface BillingEvent {
  id: string;
  kind: string;
  subject: string;
  payload: unknown;
}

/** What 1 run of a billing event did: an attempt result, or why it made no call. */
export type HandleResult = AttemptResult | 'not_needed' | 'not_due' | 'busy' | 'world_reset';

/** Another runner of the same job holds its billing lock; the event stays due and runs on a later pass. */
export class BillingBusyError extends Error {
  constructor(jobNumber: number) {
    super(`job ${jobNumber} has a billing send in flight`);
    this.name = 'BillingBusyError';
  }
}

export interface RunDeps {
  client: BillingClient;
  log: Logger;
  /** The bus publish (default: @bw/db publishEvent, the bus's 1 publisher; F-385). */
  publish?: Publish;
  /** Real ms (FR-BILL-6: 30,000). Absent: the client's own default, BILLING_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Real ms a try waits during a clock jump's replay (F-386). Absent: REPLAY_BILLING_TIMEOUT_MS. */
  replayTimeoutMs?: number;
}

/** Owner ruling b3abd03a (Nov 2, 2026; F-386): during a clock jump, a replayed billing try gives up after about 2 s. */
export const REPLAY_BILLING_TIMEOUT_MS = 2_000;

/** What tx 1 hands the call and tx 2: the job, the world epoch and try count it read, the invoice (or why none). */
export interface PreparedSend {
  jobNumber: number;
  epoch: number;
  tries: number;
  invoice: InvoiceRequest | null;
  dataError: string | null;
}

export const jobOfEvent = (e: Pick<BillingEvent, 'id' | 'subject' | 'payload'>): number => {
  const p = e.payload as { jobNumber?: unknown } | null;
  const n = typeof p?.jobNumber === 'number' ? p.jobNumber : Number(e.subject);
  if (!Number.isInteger(n) || n < 1) throw new Error(`billing event ${e.id} names no job number`);
  return n;
};

const WANTS_SEND: readonly BillingState[] = ['sending', 'retrying'];

async function worldEpoch(tx: Queryable, lock: '' | ' FOR SHARE'): Promise<number> {
  const r = await tx.query<{ world_epoch: number }>(`SELECT world_epoch FROM system.demo_clock WHERE id = 1${lock}`);
  const row = r.rows[0];
  if (!row) throw new Error('system.demo_clock holds no row');
  return row.world_epoch;
}

const resultOf = (o: SendOutcome): AttemptResult =>
  o.outcome === 'accepted' || o.outcome === 'already_have' ? 'success' : o.outcome;

/**
 * Step 3, in tx 2 (the lane's lock step already holds the job's lock and the item row). Answers null when the answer no
 * longer applies: another runner recorded a try of this item after tx 1 read its count.
 */
async function record(
  tx: Queryable,
  input: { eventId: string; due: boolean; prepared: PreparedSend; now: Instant; outcome: SendOutcome },
  publish: Publish,
): Promise<HandleResult | null> {
  const { eventId, due, now, outcome } = input;
  const { jobNumber, epoch, tries } = input.prepared;
  const r = await tx.query<{ state: BillingState; tries: number; send_cause: 'sent_again' | 'corrected' | null; version: number; branch_id: string }>(
    `SELECT bi.state, bi.tries, bi.send_cause, j.version, j.branch_id FROM world.billing_item bi JOIN world.job j USING (job_number)
      WHERE bi.job_number = $1 FOR UPDATE OF bi`, [jobNumber]);
  const item = r.rows[0];
  if (!item || (await worldEpoch(tx, ' FOR SHARE')) !== epoch) return 'world_reset';
  if (item.tries !== tries) return null;
  const n = item.tries + 1;
  const result = resultOf(outcome);
  const at = now.toString();
  const httpStatus = outcome.outcome === 'timeout' ? null : outcome.httpStatus;
  const reason = outcome.outcome === 'data_error' || outcome.outcome === 'down' ? outcome.reason : null;
  await tx.query(
    'INSERT INTO world.billing_attempt (job_number, number, at, result, http_status, reason) VALUES ($1, $2, $3, $4, $5, $6)',
    [jobNumber, n, at, result, httpStatus, reason]);
  if (!due || !WANTS_SEND.includes(item.state)) {
    // The item left meanwhile (Mark fixed retired its event during the call): the attempt is history; the state stays.
    await tx.query('UPDATE world.billing_item SET tries = $2, last_try_at = $3 WHERE job_number = $1', [jobNumber, n, at]);
  } else if (result === 'success') {
    // FR-BILL-12: left_at/left_how only for an item that was listed; a first-try success never listed.
    const leftHow = item.send_cause ?? (n > 1 ? 'automatic_retry' : null);
    await tx.query(
      `UPDATE world.billing_item SET state = 'in_billing', tries = $2, last_try_at = $3, next_try_at = NULL, reason_key = NULL,
              send_cause = NULL, left_at = $4, left_how = $5 WHERE job_number = $1`,
      [jobNumber, n, at, leftHow === null ? null : at, leftHow]);
    await tx.query(`UPDATE world.job SET billing_state = 'in_billing' WHERE job_number = $1`, [jobNumber]);
    await supersedeDueBillingEvents(tx, jobNumber, eventId, 'superseded');
    await tx.query(
      `INSERT INTO world.job_change (job_number, at, actor_user_id, actor_kind, kind, from_version, to_version, data)
       VALUES ($1, $2, NULL, 'system', 'billing_sent', $3, $3, $4)`, [jobNumber, at, item.version, JSON.stringify({ try: n })]);
  } else if (result === 'data_error') {
    // FR-BILL-7: held for a person; no retry event.
    await supersedeDueBillingEvents(tx, jobNumber, eventId, 'superseded');
    await tx.query(
      `UPDATE world.billing_item SET state = 'waiting_person', tries = $2, last_try_at = $3, next_try_at = NULL, reason_key = $4,
              send_cause = NULL WHERE job_number = $1`, [jobNumber, n, at, reason]);
    await tx.query(`UPDATE world.job SET billing_state = 'waiting_person' WHERE job_number = $1`, [jobNumber]);
  } else {
    // FR-BILL-6, invariant 2: a timeout or down is a retry, 15 demo minutes after this try, never a drop.
    await supersedeDueBillingEvents(tx, jobNumber, eventId, 'superseded');
    const next = now.add({ minutes: RETRY_DEMO_MINUTES });
    await scheduleBillingEvent(tx, 'billing.retry', jobNumber, next);
    await tx.query(
      `UPDATE world.billing_item SET state = 'retrying', tries = $2, last_try_at = $3, next_try_at = $4, send_cause = NULL WHERE job_number = $1`,
      [jobNumber, n, at, next.toString()]);
    await tx.query(`UPDATE world.job SET billing_state = 'retrying' WHERE job_number = $1`, [jobNumber]);
  }
  // EVT-07 (UI-SPECIFICATION 12.3: jobNumber), plus branch, which the bus filters on.
  await publish(tx, 'billing.changed', { jobNumber, branch: item.branch_id });
  return result;
}

const outcomeOf = (result: HandleResult): EventOutcome => ({
  state: result === 'not_needed' || result === 'world_reset' ? 'skipped' : 'done',
  result,
});

/** The billing link's 3 steps for the dispatcher's parallel lane (see the header). */
export function billingSplitHandler(deps: RunDeps): SplitHandler<PreparedSend, SendOutcome> {
  const publish = deps.publish ?? busPublish;
  return {
    async prepare(event, { tx, now }) {
      const jobNumber = jobOfEvent(event);
      const got = await tx.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1, $2) AS ok', [BILLING_LOCK_CLASS, jobNumber]);
      if (!got.rows[0]?.ok) throw new BillingBusyError(jobNumber);
      // A plain read, no row lock: tx 2 checks the state, the try count and the epoch again under the item's row lock.
      const it = await tx.query<{ state: BillingState; tries: number }>('SELECT state, tries FROM world.billing_item WHERE job_number = $1', [jobNumber]);
      const item = it.rows[0];
      if (item === undefined || !WANTS_SEND.includes(item.state)) return { settle: outcomeOf('not_needed') };
      const epoch = await worldEpoch(tx, '');
      const c = await composeFromJob(tx, jobNumber);
      return {
        call: {
          jobNumber,
          epoch,
          tries: item.tries,
          invoice: c.ok ? { jobNumber, customerName: c.customerName, doneAt: c.doneAt, sentAt: now.toString(), lines: c.lines, totalCents: c.totalCents } : null,
          dataError: c.ok ? null : c.reason,
        },
      };
    },
    async call(p, _event, _now, replay) {
      if (p.invoice === null) return { outcome: 'data_error', httpStatus: null, reason: p.dataError ?? 'invoice_not_composed' };
      // Owner ruling b3abd03a (F-386): during a clock jump's replay each try still really calls billing, and gives up
      // after REPLAY_BILLING_TIMEOUT_MS instead of 30 s; the try is still recorded as timed out.
      const timeoutMs = replay ? (deps.replayTimeoutMs ?? REPLAY_BILLING_TIMEOUT_MS) : deps.timeoutMs;
      return deps.client.sendInvoice(p.invoice, timeoutMs === undefined ? { worldEpoch: p.epoch } : { worldEpoch: p.epoch, timeoutMs });
    },
    async lock(p, _event, tx) {
      await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [BILLING_LOCK_CLASS, p.jobNumber]);
      await tx.query('SELECT 1 FROM world.billing_item WHERE job_number = $1 FOR UPDATE', [p.jobNumber]);
    },
    async record(p, outcome, event, { tx, now, due }) {
      const result = await record(tx, { eventId: event.id, due, prepared: p, now, outcome }, publish);
      if (result === null) return null;
      const status = outcome.outcome === 'timeout' ? undefined : outcome.httpStatus ?? undefined;
      deps.log.info(status === undefined
        ? { jobNumber: p.jobNumber, demoTime: now.toString(), errorCode: result }
        : { jobNumber: p.jobNumber, demoTime: now.toString(), status, errorCode: result });
      return outcomeOf(result);
    },
  };
}

/** The billing lane of the worker dispatcher: billing.send and billing.retry, keyed by job, BILLING_CONCURRENCY wide. */
export function billingLane(deps: RunDeps & { concurrency?: number }): ParallelLane<PreparedSend, SendOutcome> {
  return {
    name: 'billing',
    kinds: BILLING_EVENT_KINDS,
    keyOf: (e: DueEvent) => String(jobOfEvent(e)),
    concurrency: deps.concurrency ?? BILLING_CONCURRENCY,
    handler: billingSplitHandler(deps),
  };
}

/**
 * The production billing lane (apps/worker/src/jobs.ts `eventLanes`): the HTTP client to PBS_URL with the client's own
 * timeout (BILLING_TIMEOUT_MS), the bus publish and the production concurrency. G-CI10's production-timing case builds
 * its link through this factory (F-383), so a changed default timeout fails it.
 */
export function billingLaneFor(d: { settings: { PBS_URL: string }; log: Logger }): ParallelLane<PreparedSend, SendOutcome> {
  return billingLane({ client: new HttpBillingClient(d.settings.PBS_URL), log: d.log });
}

/** Write a retry at `now` for every item that wants a send and holds no due event. Answers how many. */
export async function healBillingItems(pool: pg.Pool, now: Instant): Promise<number> {
  return inTransaction(pool, async (tx) => {
    const r = await tx.query<{ job_number: number; state: BillingState }>(
      `SELECT bi.job_number, bi.state FROM world.billing_item bi
        WHERE bi.state IN ('sending', 'retrying')
          AND NOT EXISTS (SELECT 1 FROM world.scheduled_event e WHERE e.kind = ANY($1) AND e.subject = bi.job_number::text AND e.state = 'due')
        FOR UPDATE OF bi SKIP LOCKED`, [BILLING_EVENT_KINDS]);
    for (const row of r.rows) {
      await scheduleBillingEvent(tx, row.state === 'sending' ? 'billing.send' : 'billing.retry', row.job_number, now);
      if (row.state === 'retrying') await tx.query('UPDATE world.billing_item SET next_try_at = $2 WHERE job_number = $1', [row.job_number, now.toString()]);
    }
    return r.rows.length;
  });
}

/** The healer as a worker job (apps/worker/src/jobs.ts `jobs`): every `everyMs` real ms (default 30 s), at demo now. */
export function startBillingHealer(
  d: { pool: pg.Pool; clock: Pick<Clock, 'demoNow'>; log: Logger },
  everyMs = 30_000,
): { readonly name: string; stop(): Promise<void> } {
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped) return;
    running = d.clock.demoNow().then((now) => healBillingItems(d.pool, now)).catch(() => {
      d.log.error({ status: 'unhandled error', errorCode: 'billing_heal_failed' });
    });
  }, everyMs);
  return {
    name: 'billing healer',
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

export { billingSubject };
