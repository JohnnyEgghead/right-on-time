// SPDX-License-Identifier: AGPL-3.0-or-later
// Try now (SPECIFICATIONS section 5.2 step 4; FR-TEXT-24, OI-23; API-144): move a failed text's next try to now. It
// is that numbered try, not an extra one, so the 5-try limit and the call list and alert after the 5th failure still
// hold. In quiet hours (not for an exempt kind, F-1545) the try is moved to the next 8:00 AM in the customer's zone and the answer says so (heldUntil).
//
// Lock order is the dispatcher's, event then text, so Try now and a running try never deadlock. If the dispatcher is
// running this text's try right now, the event lookup waits for it; that try's commit marks the event done and may
// write the next one, which a second lookup (a new statement, so it sees that commit) finds.
import type { Queryable } from '@bw/db';
import type { Instant } from '@bw/time';
import { MAX_TRIES, TEXT_TRY, type TextTryPayload } from './model.ts';
import { publishTextChanged } from './notify.ts';
import { inQuietHours, releaseTime } from './quiet-hours.ts';

export type TryNowResult =
  | { ok: true; textId: string; number: number; at: Instant; heldUntil: Instant | null }
  | { ok: false; reason: 'not_retryable' };

export async function tryNow(tx: Queryable, input: { textId: string; by: string; now: Instant }): Promise<TryNowResult> {
  const findEvent = () =>
    tx.query<{ id: string; payload: TextTryPayload }>(
      `SELECT id, payload FROM world.scheduled_event
        WHERE kind = $1 AND subject = $2 AND state = 'due'
        ORDER BY due_at, id LIMIT 1
          FOR UPDATE`,
      [TEXT_TRY, input.textId],
    );
  const event = (await findEvent()).rows[0] ?? (await findEvent()).rows[0];
  if (!event) return { ok: false, reason: 'not_retryable' };

  const { rows } = await tx.query<{ status: string; tries: number; zone: string; kind: string; branch_id: string; customer_id: string; job_number: number | null }>(
    `SELECT t.status, t.tries, t.kind, c.zone, c.branch_id, t.customer_id, t.job_number
       FROM world.outbox_text t JOIN world.customer c ON c.id = t.customer_id
      WHERE t.id = $1
        FOR UPDATE OF t`,
    [input.textId],
  );
  const t = rows[0];
  // FR-TEXT-24: only on a failed text with tries left (CTL-OFC-08-17: "Failed, retrying, with tries left").
  if (!t || t.status !== 'retrying' || t.tries >= MAX_TRIES || event.payload.number !== t.tries + 1) return { ok: false, reason: 'not_retryable' };

  const heldUntil = inQuietHours(input.now, t.zone, t.kind) ? releaseTime(input.now, t.zone, t.kind) : null;
  const at = heldUntil ?? input.now;
  const payload: TextTryPayload = { textId: input.textId, number: event.payload.number, by: input.by };
  await tx.query(`UPDATE world.scheduled_event SET due_at = $2, payload = $3 WHERE id = $1`, [event.id, at.toString(), JSON.stringify(payload)]);
  await tx.query(`UPDATE world.outbox_text SET next_try_at = $2 WHERE id = $1`, [input.textId, at.toString()]);
  await publishTextChanged(tx, { textId: input.textId, customerId: t.customer_id, jobNumber: t.job_number, branch: t.branch_id });
  return { ok: true, textId: input.textId, number: payload.number, at, heldUntil };
}
