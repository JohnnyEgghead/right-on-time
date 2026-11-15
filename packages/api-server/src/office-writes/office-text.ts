// SPDX-License-Identifier: AGPL-3.0-or-later
// sendOfficeText (UI-SPECIFICATION 12.2 API-143, SCR-OFC-35; FR-TEXT-20, OA-66; SPECIFICATIONS section 3 job_change kind
// office_text). The office's own words to a customer, held to 1 message (invariant 8: the shared segment counter, D12)
// and to quiet hours (invariant 9: the outbox holds it until 8:00 AM the customer's time). The text is made only by
// @bw/outbox's enqueueText, the 1 way any text is made (SD-18), in the handler's transaction; it leaves only through the
// worker's try handler. An office text about a job also writes 1 job_change row (no version bump: a text changes no job
// field) and 1 job.changed notice, so the job page's timeline shows it.
import { publishEvent, type Queryable } from '@bw/db';
import { countBody, enqueueText } from '@bw/outbox';
import { Temporal, toWire } from '@bw/time';
import { appendJobChange, WriteRefused, type WriteContext } from './service.ts';

export const OFFICE_TEXT_CHANGE = 'office_text';

export interface OfficeTextSent {
  id: string;
  status: 'sending' | 'held';
  heldUntil: string | null;
  encoding: 'gsm7' | 'ucs2';
  characters: number;
}

export class OfficeTextRefused extends Error {
  readonly code: 'message_too_long' | 'texts_off' | 'no_mobile';
  readonly detail: unknown;
  constructor(code: OfficeTextRefused['code'], detail?: unknown) {
    super(code);
    this.name = 'OfficeTextRefused';
    this.code = code;
    this.detail = detail;
  }
}

export async function sendOfficeText(tx: Queryable, ctx: WriteContext, input: { customerId: string; body: string; jobNumber: number | null }): Promise<OfficeTextSent> {
  const c = await tx.query<{ zone: string }>('SELECT zone FROM world.customer WHERE id = $1', [input.customerId]);
  if (!c.rows[0]) throw new WriteRefused('not_found', `customer ${input.customerId} does not exist`);
  let job: { version: number; branch_id: string } | null = null;
  if (input.jobNumber !== null) {
    const j = await tx.query<{ version: number; branch_id: string }>(
      'SELECT version, branch_id FROM world.job WHERE job_number = $1 AND customer_id = $2', [input.jobNumber, input.customerId]);
    job = j.rows[0] ?? null;
    if (!job) throw new WriteRefused('validation_failed', `job ${input.jobNumber} is not this customer's`);
  }
  const now = Temporal.Instant.fromEpochMilliseconds(ctx.at.getTime());
  const r = await enqueueText(tx, { kind: 'office', customerId: input.customerId, jobNumber: input.jobNumber, body: input.body, sentBy: ctx.actor.userId, now });
  if (!r.ok) {
    if (r.reason === 'message_too_long') {
      const counted = countBody(input.body);
      throw new OfficeTextRefused('message_too_long', { characters: counted.characters, limit: counted.encoding === 'gsm7' ? 160 : 70, encoding: counted.encoding });
    }
    throw new OfficeTextRefused(r.reason);
  }
  const counted = countBody(input.body);
  if (job && input.jobNumber !== null) {
    await appendJobChange(tx, ctx, {
      jobNumber: input.jobNumber, kind: OFFICE_TEXT_CHANGE, fromVersion: job.version, toVersion: job.version,
      data: { textId: r.textId, status: r.status },
    });
    await publishEvent(tx, 'job.changed', { jobNumber: input.jobNumber, branch: job.branch_id });
  }
  return {
    id: r.textId, status: r.status === 'held' ? 'held' : 'sending', heldUntil: r.heldUntil ? toWire(r.heldUntil, c.rows[0].zone) : null,
    encoding: counted.encoding, characters: counted.characters,
  };
}
