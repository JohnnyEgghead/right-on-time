// SPDX-License-Identifier: AGPL-3.0-or-later
// The billing area's office writes (UI-SPECIFICATION 12.2 API-61, API-62, API-156, API-157; SPECIFICATIONS section 6.6
// FR-BILL-3, FR-BILL-7, FR-BILL-10, OA-57, OA-61). Each is the web face of a service that
// bw-worker exports from `./billing` (sendAgain, resendCorrected, retryNow, retryAll), run inside the handler's 1 transaction (SD-6):
// the queue change, its billing.send event, the job's billing_state, the job_change row and the notice commit together
// or not at all. A refusal throws BillingRefused (or the office write service's WriteRefused for the version gate) and
// the kernel rolls the transaction back.
//
// Correct a finish and send again (API-62; OA-61), in order:
//   1. lines    the finishLines validator, before anything else (FR-BILL-3: 1 rule on every finish path), so a correction
//               with neither parts nor No parts used answers parts_required whatever the job is
//   2. waiting  the item must be waiting for a person (not_waiting_for_person)
//   3. gate     the job version gate (office-writes gatedJobUpdate: labor_minutes and no_parts_used, version + 1)
//   4. replace  the job's job_part rows are replaced by the corrected ones
//   5. record   1 job_change row `finish_corrected` by the person (OI-12), then the resend (`corrected`, 1 billing.send)
import { publishEvent, type Queryable } from '@bw/db';
import { finishLines } from '@bw/domain';
import type { Instant } from '@bw/time';
import { lockItemThenJob, resendCorrected, retryAll, retryNow, sendAgain } from 'bw-worker/billing';
import { appendJobChange, gatedJobUpdate } from '../office-writes/service.ts';

export type BillingRefusalCode = 'not_waiting_for_person' | 'not_retrying' | 'not_on_billing_list' | 'parts_required' | 'validation_failed';

export class BillingRefused extends Error {
  readonly code: BillingRefusalCode;
  constructor(code: BillingRefusalCode, why: string) {
    super(why);
    this.name = 'BillingRefused';
    this.code = code;
  }
}

export interface QueueItemView {
  jobNumber: number;
  state: 'sending' | 'retrying' | 'waiting_person' | 'in_billing' | 'marked_fixed';
  tries: number;
}

/** Who writes and the demo time of the write. */
export interface BillingActor {
  userId: string;
  at: Instant;
}

export async function readItem(tx: Queryable, jobNumber: number): Promise<QueueItemView | null> {
  const r = await tx.query<{ job_number: number; state: QueueItemView['state']; tries: number }>(
    'SELECT job_number, state, tries FROM world.billing_item WHERE job_number = $1', [jobNumber]);
  const row = r.rows[0];
  return row ? { jobNumber: row.job_number, state: row.state, tries: row.tries } : null;
}

async function itemAfter(tx: Queryable, jobNumber: number): Promise<QueueItemView> {
  const item = await readItem(tx, jobNumber);
  if (!item) throw new Error(`billing item of job ${jobNumber} vanished inside its own write`);
  return item;
}

/** API-61: only an item waiting for a person (FR-BILL-7); the job history names the person. */
export async function sendAgainWrite(tx: Queryable, actor: BillingActor, input: { jobNumber: number }): Promise<QueueItemView> {
  const r = await sendAgain(tx, { jobNumber: input.jobNumber, by: actor.userId, at: actor.at });
  if (!r.ok) throw new BillingRefused('not_waiting_for_person', `job ${input.jobNumber} is not waiting for a person (${r.code})`);
  return itemAfter(tx, input.jobNumber);
}

/** API-156: only a retrying item. An item that left the list (or never was listed) is not_on_billing_list. */
export async function retryNowWrite(tx: Queryable, actor: BillingActor, input: { jobNumber: number }): Promise<QueueItemView> {
  const item = await readItem(tx, input.jobNumber);
  if (!item || item.state === 'in_billing' || item.state === 'marked_fixed') {
    throw new BillingRefused('not_on_billing_list', `job ${input.jobNumber} is not on the billing list`);
  }
  const r = await retryNow(tx, { jobNumber: input.jobNumber, at: actor.at });
  if (!r.ok) throw new BillingRefused(r.code === 'not_found' ? 'not_on_billing_list' : 'not_retrying', `job ${input.jobNumber} is not retrying (${r.code})`);
  return itemAfter(tx, input.jobNumber);
}

/** API-157: every retrying item of the branch; waiting_person items are skipped (FR-BILL-10). Answers how many. */
export function retryAllWrite(tx: Queryable, actor: BillingActor, input: { branch: string }): Promise<number> {
  return retryAll(tx, { at: actor.at, branchId: input.branch });
}

export interface CorrectionInput {
  jobNumber: number;
  parts: readonly { partId: string; quantity: number }[];
  noPartsUsed: boolean;
  laborMinutes: number;
  baseVersion: number;
}

/** API-62: replace the finish lines under the version gate and resend the job once. */
export async function correctFinishWrite(
  tx: Queryable, actor: BillingActor, input: CorrectionInput,
): Promise<{ item: QueueItemView; job: { jobNumber: number; version: number } }> {
  const { jobNumber } = input;
  const seeded = new Set((await tx.query<{ id: string }>('SELECT id::text FROM world.part')).rows.map((p) => p.id));
  const lines = finishLines({ parts: input.parts, noPartsUsed: input.noPartsUsed, laborMinutes: input.laborMinutes }, (id) => seeded.has(id));
  if (!lines.ok) throw new BillingRefused(lines.code, `the corrected finish is refused (${lines.problem})`);

  // F-401: the item row, then the job row, before the version-gated job write (the order every billing writer uses).
  const item = await lockItemThenJob(tx, jobNumber);
  if (!item || item.state !== 'waiting_person') throw new BillingRefused('not_waiting_for_person', `job ${jobNumber} is not waiting for a person`);

  await gatedJobUpdate(tx, jobNumber, input.baseVersion, 'labor_minutes = $3, no_parts_used = $4', [lines.lines.laborMinutes, lines.lines.noPartsUsed]);
  await tx.query('DELETE FROM world.job_part WHERE job_number = $1', [jobNumber]);
  for (const p of lines.lines.parts) {
    await tx.query('INSERT INTO world.job_part (job_number, part_id, quantity) VALUES ($1, $2, $3)', [jobNumber, p.partId, p.quantity]);
  }
  await appendJobChange(tx, { actor: { kind: 'office', userId: actor.userId }, at: new Date(actor.at.epochMilliseconds) }, {
    jobNumber, kind: 'finish_corrected', fromVersion: input.baseVersion, toVersion: input.baseVersion + 1,
    data: { parts: lines.lines.parts.length, noPartsUsed: lines.lines.noPartsUsed, laborMinutes: lines.lines.laborMinutes },
  });
  await publishEvent(tx, 'job.changed', { jobNumber, branch: item.branch_id });
  const r = await resendCorrected(tx, { jobNumber, by: actor.userId, at: actor.at });
  if (!r.ok) throw new BillingRefused('not_waiting_for_person', `job ${jobNumber} is not waiting for a person (${r.code})`);
  return { item: await itemAfter(tx, jobNumber), job: { jobNumber, version: input.baseVersion + 1 } };
}
