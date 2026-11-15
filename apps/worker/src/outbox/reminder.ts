// SPDX-License-Identifier: AGPL-3.0-or-later
// The text.reminder handler (SPECIFICATIONS section 6.4 Reminder; REQUIREMENTS FR-TEXT-2, FR-TEXT-13): at 6:00 PM the
// evening before a visit, in the customer's zone, enqueue the reminder text, or, with no mobile or texts off, a call
// list entry. The text is stamped at the event's own time (the dispatcher's `now` is max(due_at, demo now)), so a replay
// across 6:00 PM still stamps 6:00 PM. Quiet hours hold the text like any other (enqueueText).
import { fireReminder, type TextContext } from '@bw/outbox';
import { Temporal } from '@bw/time';
import type { EventHandler } from '../dispatcher.ts';

export function reminderHandler(ctx: TextContext): EventHandler {
  return async (event, { tx, now }) => {
    const jobNumber = Number((event.payload as { jobNumber?: unknown }).jobNumber);
    if (!Number.isInteger(jobNumber)) return { state: 'skipped', result: 'no_job' };
    // F-446: a reminder planned after its 6:00 PM carries atOnce and the visit's date (planReminder).
    const p = event.payload as { atOnce?: unknown; visitDate?: unknown };
    const atOnce = p.atOnce === true && typeof p.visitDate === 'string' ? { visitDate: p.visitDate } : undefined;
    const r = await fireReminder(tx, ctx, { jobNumber, eventDueAt: Temporal.Instant.from(event.dueAt.toString()), now, ...(atOnce ? { atOnce } : {}) });
    return r.result === 'skipped' ? { state: 'skipped', result: r.why } : { state: 'done', result: r.result };
  };
}
