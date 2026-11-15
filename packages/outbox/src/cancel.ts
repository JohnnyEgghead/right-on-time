// SPDX-License-Identifier: AGPL-3.0-or-later
// Cancel at arrival (SPECIFICATIONS section 5.2 step 5; FR-TEXT-19, NFR-04): recording an arrival cancels that job's
// on-the-way text if it is not yet delivered, so the customer never gets an on-the-way text after the technician
// arrived. Called in the arrival's transaction (P3-ITEMS' applyItem). The text's due try event is left due: the try
// handler finds the text no longer sendable and the dispatcher marks the event skipped (section 3 scheduled_event.state).
// The office's cancel, reassign or reschedule of a job On the way or On site cancels it the same way (owner ruling 7ccb76ec
// call 8, F-566), with its own reason, so the Messages page says why.
//
// A held or retrying confirmation ends the same way when its visit is canceled or moved (F-799, F-729; SD-45: canceling sends no
// text, a reschedule sends a new confirmation). It is canceled in the write's transaction, so a refused write leaves it as it was
// and the Messages page says why at once. The try takes the text's row lock, so a send in flight and this write are ordered: a
// text the send got to first stays delivered, and a text this write got to first is skipped at the try. A re-run finds nothing left
// to cancel, and a moved visit's new confirmation is made after this runs, so it is the 1 unsent confirmation the job keeps.
import type { Queryable } from '@bw/db';
import { REASON, type TextKind } from './model.ts';
import { publishTextChanged } from './notify.ts';

async function cancelUnsent(tx: Queryable, jobNumber: number, kind: TextKind, reason: string): Promise<string[]> {
  const { rows } = await tx.query<{ id: string; branch_id: string; customer_id: string }>(
    `UPDATE world.outbox_text t
        SET status = 'canceled', reason_key = $2, next_try_at = NULL
       FROM world.customer c
      WHERE c.id = t.customer_id AND t.job_number = $1 AND t.kind = $3 AND t.status IN ('queued', 'held', 'retrying')
      RETURNING t.id, c.branch_id, t.customer_id`,
    [jobNumber, reason, kind],
  );
  for (const r of rows) await publishTextChanged(tx, { textId: r.id, customerId: r.customer_id, jobNumber, branch: r.branch_id });
  return rows.map((r) => r.id);
}

export function cancelOnTheWayText(tx: Queryable, jobNumber: number, reason: string = REASON.arrivedFirst): Promise<string[]> {
  return cancelUnsent(tx, jobNumber, 'on_the_way', reason);
}

/** The visit was canceled or moved: its unsent confirmations name a day that is no longer true (F-799). */
export function cancelUnsentConfirmations(tx: Queryable, jobNumber: number): Promise<string[]> {
  return cancelUnsent(tx, jobNumber, 'confirmation', REASON.visitChanged);
}

/** The visit moved and a new reminder is planned: an unsent one would be a second reminder for the 1 visit (F-831, FR-TEXT-2). */
export function cancelUnsentReminders(tx: Queryable, jobNumber: number): Promise<string[]> {
  return cancelUnsent(tx, jobNumber, 'reminder', REASON.visitChanged);
}
