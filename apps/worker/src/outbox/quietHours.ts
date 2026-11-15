// SPDX-License-Identifier: AGPL-3.0-or-later
// Invariant 9 at the try (SPECIFICATIONS section 5.2 step 3; FR-TEXT-7; section 11.6 enforcement matrix): every try
// rechecks quiet hours at its own run time, in the customer's zone, before the gateway is called. enqueueText already
// holds a text due in quiet hours and every retry is planned outside them; this recheck is what makes a hold
// impossible to skip when a try runs at another time than planned (a clock jump, a worker that was down, Try now).
import type { Queryable } from '@bw/db';
import { inQuietHours, REASON, releaseTime, scheduleTry, type TextTryPayload } from '@bw/outbox';
import type { Instant } from '@bw/time';

/**
 * If `at` is in quiet hours in `zone`, hold the text (status held, held_until and next_try_at = the next 8:00 AM there)
 * and move its try to then: a new text.try event for the same try number, so the held try still counts once. Returns
 * the release time, or null when the try may go now. Runs in the try's transaction, with the text's row locked.
 */
export async function holdIfQuiet(tx: Queryable, text: { id: string; zone: string; kind: string }, at: Instant, payload: TextTryPayload): Promise<Instant | null> {
  if (!inQuietHours(at, text.zone, text.kind)) return null;
  const until = releaseTime(at, text.zone, text.kind);
  await tx.query(
    `UPDATE world.outbox_text SET status = 'held', reason_key = $2, held_until = $3, next_try_at = $3 WHERE id = $1`,
    [text.id, REASON.quietHours, until.toString()],
  );
  await scheduleTry(tx, until, payload);
  return until;
}
