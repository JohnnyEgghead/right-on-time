// SPDX-License-Identifier: AGPL-3.0-or-later
// The text.reminder handler (SPECIFICATIONS section 6.4 Reminder; REQUIREMENTS FR-TEXT-2, FR-TEXT-13): at 6:00 PM the
// evening before a visit, in the customer's zone, enqueue the reminder text, or, with no mobile or texts off, a call
// list entry. The text is stamped at the event's own time (the dispatcher's `now` is max(due_at, demo now)), so a replay
// across 6:00 PM still stamps 6:00 PM. Quiet hours hold the text like any other (enqueueText).
import { fireReminder, giveUpReminder, type TextContext } from '@bw/outbox';
import { Temporal } from '@bw/time';
import type { DueEvent, EventHandler, GiveUp } from '../dispatcher.ts';

/** The event's reminder (its job number, its time, F-446's atOnce), or null when its payload names no job. */
function reminderOf(event: DueEvent, now: Parameters<typeof fireReminder>[2]['now']): Parameters<typeof fireReminder>[2] | null {
  const jobNumber = Number((event.payload as { jobNumber?: unknown } | null)?.jobNumber);
  if (!Number.isInteger(jobNumber)) return null;
  // F-446: a reminder planned after its 6:00 PM carries atOnce and the visit's date (planReminder).
  const p = event.payload as { atOnce?: unknown; visitDate?: unknown };
  const atOnce = p.atOnce === true && typeof p.visitDate === 'string' ? { visitDate: p.visitDate } : undefined;
  return { jobNumber, eventDueAt: Temporal.Instant.from(event.dueAt.toString()), now, ...(atOnce ? { atOnce } : {}) };
}

export function reminderHandler(ctx: TextContext): EventHandler {
  return async (event, { tx, now }) => {
    const input = reminderOf(event, now);
    if (!input) return { state: 'skipped', result: 'no_job' };
    const r = await fireReminder(tx, ctx, input);
    return r.result === 'skipped' ? { state: 'skipped', result: r.why } : { state: 'done', result: r.result };
  };
}

/**
 * F-2006 K-03: a text.reminder that failed MAX_HANDLER_FAILURES runs (a reminder whose text can never be enqueued) puts
 * its visit on the call list (giveUpReminder), then ends skipped as handler_failed like every given-up event.
 */
export const giveUpReminderEvent: GiveUp = async (event, { tx, now }) => {
  const input = reminderOf(event, now);
  if (input) await giveUpReminder(tx, input);
  return { state: 'skipped', result: 'handler_failed' };
};
