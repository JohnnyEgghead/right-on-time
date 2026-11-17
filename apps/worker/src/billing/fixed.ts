// SPDX-License-Identifier: AGPL-3.0-or-later
// Mark fixed (API-158; SPECIFICATIONS section 6.6 FR-BILL-11; UC-20; invariant 10): a person marks a listed job fixed
// with a reason. pbs records the job's 1 invoice as entered by hand (a new one, or the invoice a held or late request
// already stored, re-marked), then the item leaves the list as `marked_fixed` with who, when and the reason, its pending
// retry is retired, and a later Retry all finds nothing to retry.
//
// Re-run semantics: pbs's record comes first and is idempotent (re-marking an entered-by-hand invoice changes nothing),
// then the world write. A crash between the 2 leaves the item listed; Mark fixed again repeats pbs's record harmlessly
// and completes. A send in flight meanwhile records its attempt but cannot move the item back (link.ts), and its held
// request finds the invoice at store and answers already_have: 1 invoice.
import { inTransaction, type Queryable } from '@bw/db';
import { MARK_FIXED_REASON_MAX, type BillingState } from '@bw/domain';
import type { Instant } from '@bw/time';
import type pg from 'pg';
import { BillingUnavailableError, type BillingClient } from './client.ts';
import { composeFromJob, type Composed } from './compose.ts';
import { busPublish, listedRule, supersedeDueBillingEvents, type Publish } from './queue.ts';

export type MarkFixedResult =
  /** `again`: the item had already been marked fixed (a second press); the world is unchanged and the web route answers not_on_billing_list. */
  | { ok: true; again?: true }
  | { ok: false; code: 'validation_failed' | 'not_found' | 'not_listed' | 'billing_unavailable' | 'world_reset' };

type Before =
  | { kind: 'refuse'; code: 'not_found' | 'not_listed' }
  | { kind: 'done' }
  | { kind: 'go'; epoch: number; composed: Composed };

/**
 * Phase 1: is the item markable, and what pbs will record for it. Markable is listed, by the same listedRule the
 * billing list reads at the same demo now (F-1865): every row the office sees can be marked fixed, and no other.
 */
async function readBefore(tx: Queryable, jobNumber: number, now: Instant): Promise<Before> {
  const listed = listedRule(now, 2);
  const r = await tx.query<{ state: BillingState; listed: boolean }>(
    `SELECT bi.state, ${listed.sql} AS listed FROM world.billing_item bi WHERE bi.job_number = $1`, [jobNumber, ...listed.params]);
  const item = r.rows[0];
  if (!item) return { kind: 'refuse', code: 'not_found' };
  if (item.state === 'marked_fixed') return { kind: 'done' };
  if (!item.listed) return { kind: 'refuse', code: 'not_listed' };
  const epoch = (await tx.query<{ world_epoch: number }>('SELECT world_epoch FROM system.demo_clock WHERE id = 1')).rows[0]!.world_epoch;
  return { kind: 'go', epoch, composed: await composeFromJob(tx, jobNumber) };
}

/** Phase 2: pbs records the job once as entered by hand. */
async function enterAtPbs(client: BillingClient, input: MarkFixedInput, epoch: number, c: Composed): Promise<MarkFixedResult | null> {
  const at = input.at.toString();
  try {
    await client.enterByHand({
      jobNumber: input.jobNumber, reason: input.reason, by: input.by, at, worldEpoch: epoch,
      customerName: c.customerName ?? `Job ${input.jobNumber}`, doneAt: c.doneAt ?? at,
      // A job that could not be composed (its data error) is recorded with no lines: the person entered it by hand.
      lines: c.ok ? c.lines : [], totalCents: c.ok ? c.totalCents : 0,
    });
  } catch (e) {
    if (e instanceof BillingUnavailableError) return { ok: false, code: 'billing_unavailable' };
    throw e;
  }
  return null;
}

/** Phase 3: the world write, once pbs holds the record. */
async function leaveList(tx: Queryable, publish: Publish, input: MarkFixedInput, epoch: number): Promise<MarkFixedResult> {
  const at = input.at.toString();
  const r = await tx.query<{ state: BillingState; version: number; branch_id: string }>(
    `SELECT bi.state, j.version, j.branch_id FROM world.billing_item bi JOIN world.job j USING (job_number)
      WHERE bi.job_number = $1 FOR UPDATE OF bi`, [input.jobNumber]);
  const item = r.rows[0];
  const now = (await tx.query<{ world_epoch: number }>('SELECT world_epoch FROM system.demo_clock WHERE id = 1 FOR SHARE')).rows[0]!.world_epoch;
  if (!item || now !== epoch) return { ok: false, code: 'world_reset' };
  if (item.state === 'marked_fixed') return { ok: true, again: true };
  // An in-flight send that landed after pbs took the record (in_billing) is overridden: pbs now says entered by hand.
  await tx.query(
    `UPDATE world.billing_item SET state = 'marked_fixed', left_at = $2, left_how = 'marked_fixed', left_by = $3, left_reason = $4,
            send_cause = NULL, next_try_at = NULL WHERE job_number = $1`, [input.jobNumber, at, input.by, input.reason]);
  await tx.query(`UPDATE world.job SET billing_state = 'marked_fixed' WHERE job_number = $1`, [input.jobNumber]);
  await supersedeDueBillingEvents(tx, input.jobNumber, null, 'marked_fixed');
  await tx.query(
    `INSERT INTO world.job_change (job_number, at, actor_user_id, actor_kind, kind, from_version, to_version, data)
     VALUES ($1, $2, $3, 'office', 'marked_fixed', $4, $4, $5)`, [input.jobNumber, at, input.by, item.version, JSON.stringify({ reason: input.reason })]);
  await publish(tx, 'billing.changed', { jobNumber: input.jobNumber, branch: item.branch_id });
  return { ok: true };
}

interface MarkFixedInput { jobNumber: number; reason: string; by: string; at: Instant }

/** The reason, trimmed, or null when it is empty or too long. */
const cleanReason = (raw: string): string | null => {
  const reason = raw.trim();
  return reason === '' || reason.length > MARK_FIXED_REASON_MAX ? null : reason;
};

export async function markFixed(deps: { pool: pg.Pool; client: BillingClient; publish?: Publish }, input: MarkFixedInput): Promise<MarkFixedResult> {
  const reason = cleanReason(input.reason);
  if (reason === null) return { ok: false, code: 'validation_failed' };
  const clean = { ...input, reason };
  const publish = deps.publish ?? busPublish;
  const before = await inTransaction(deps.pool, (tx) => readBefore(tx, input.jobNumber, input.at));
  if (before.kind === 'done') return { ok: true, again: true };
  if (before.kind === 'refuse') return { ok: false, code: before.code };
  const failed = await enterAtPbs(deps.client, clean, before.epoch, before.composed);
  if (failed) return failed;
  return inTransaction(deps.pool, (tx) => leaveList(tx, publish, clean, before.epoch));
}

/**
 * Mark fixed inside the caller's 1 transaction (API-158 under the web kernel, SD-6): the same 3 phases as markFixed, but phase 2 (the
 * call to pbs) runs inside that transaction, where markFixed runs it between its 2. The client bounds that call at
 * PBS_CALL_TIMEOUT_MS (5 s, F-508), so a wedged pbs holds a pooled web connection for seconds, not the 30 s of a send. pbs's
 * record is idempotent and comes before the world write, so a rollback of the caller's transaction leaves the item listed
 * and Mark fixed pressed again repeats pbs's record harmlessly and completes.
 */
export async function markFixedInTx(tx: Queryable, deps: { client: BillingClient; publish?: Publish }, input: MarkFixedInput): Promise<MarkFixedResult> {
  const reason = cleanReason(input.reason);
  if (reason === null) return { ok: false, code: 'validation_failed' };
  const clean = { ...input, reason };
  const before = await readBefore(tx, input.jobNumber, input.at);
  if (before.kind === 'done') return { ok: true, again: true };
  if (before.kind === 'refuse') return { ok: false, code: before.code };
  const failed = await enterAtPbs(deps.client, clean, before.epoch, before.composed);
  if (failed) return failed;
  return leaveList(tx, deps.publish ?? busPublish, clean, before.epoch);
}
