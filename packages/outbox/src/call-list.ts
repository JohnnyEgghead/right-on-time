// SPDX-License-Identifier: AGPL-3.0-or-later
// The reminder call of FR-TEXT-13 (SPECIFICATIONS section 6.4): 1 call list row per visit and call date, for a customer
// with no mobile or texts off. API-42 lists the next day's such visits all day (F-651), before the 6:00 PM reminder event
// has written any row, so a reminder call has its row id before the row exists: `reminderCallId` derives it from the job
// and the call date. Every writer of a reminder call row (fireReminder at the reminder event, API-38 on the first call
// outcome) inserts it with that id and ON CONFLICT DO NOTHING, and migration 0016's partial unique index on (job_number,
// call_date) for the 2 reminder reasons holds the rule for any other writer: a re-plan or a 2nd fire never makes a 2nd
// row (F-653), and the id the page holds before 6:00 PM is the id of the row after it.
import type { Queryable } from '@bw/db';
import { Temporal, type Instant } from '@bw/time';

export const REMINDER_CALL_REASONS = ['no_mobile', 'texts_off'] as const;
export type ReminderCallReason = (typeof REMINDER_CALL_REASONS)[number];

// A UUID of version 8 (RFC 9562, the custom layout): the job number in the 1st group, the call date as days since
// 1970-01-01 in the 3rd and 4th, and fixed tag groups. A database id (uuidv7 / random) is never version 8, so the 2 never meet.
const TAG2 = 'ca11';
const TAG5 = 'ca11ca11ca11';
const SHAPE = /^([0-9a-f]{8})-ca11-8([0-9a-f]{3})-8([0-9a-f]{3})-ca11ca11ca11$/;
const EPOCH = Temporal.PlainDate.from('1970-01-01');

/** The id of the reminder call row of a visit on a call date. */
export function reminderCallId(jobNumber: number, callDate: string): string {
  if (!Number.isInteger(jobNumber) || jobNumber < 1 || jobNumber > 0x7fffffff) throw new Error(`reminderCallId: job number ${jobNumber} out of range`);
  const days = Temporal.PlainDate.from(callDate).since(EPOCH, { largestUnit: 'days' }).days;
  if (days < 0 || days > 0xffffff) throw new Error(`reminderCallId: call date ${callDate} out of range`);
  const d = days.toString(16).padStart(6, '0');
  return `${jobNumber.toString(16).padStart(8, '0')}-${TAG2}-8${d.slice(0, 3)}-8${d.slice(3)}-${TAG5}`;
}

/** The job and call date a reminder call id names; null for any other id (a row written with a database id). */
export function parseReminderCallId(id: string): { jobNumber: number; callDate: string } | null {
  const m = SHAPE.exec(id.toLowerCase());
  if (!m) return null;
  const jobNumber = Number.parseInt(m[1]!, 16);
  const days = Number.parseInt(`${m[2]}${m[3]}`, 16);
  return { jobNumber, callDate: EPOCH.add({ days }).toString() };
}

/**
 * Write the reminder call row of a visit on a call date, once: a 2nd write for the same visit and date (a re-plan the
 * same evening, a replayed event, the 6:00 PM fire after an outcome was recorded in the morning) changes nothing.
 * Returns the row's id.
 */
export async function upsertReminderCall(
  tx: Queryable,
  input: { branchId: string; callDate: string; customerId: string; jobNumber: number; reason: ReminderCallReason; addedAt: Instant },
): Promise<string> {
  const id = reminderCallId(input.jobNumber, input.callDate);
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO world.call_list_entry (id, branch_id, call_date, customer_id, job_number, reason, added_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING id`,
    [id, input.branchId, input.callDate, input.customerId, input.jobNumber, input.reason, input.addedAt.toString()],
  );
  if (ins.rows[0]) return ins.rows[0].id;
  // The visit's row for that date is already there: under this id, or under a database id written before migration 0016.
  const had = await tx.query<{ id: string }>(
    `SELECT id FROM world.call_list_entry WHERE job_number = $1 AND call_date = $2 AND reason = ANY($3::text[]) ORDER BY added_at, id LIMIT 1`,
    [input.jobNumber, input.callDate, [...REMINDER_CALL_REASONS]],
  );
  return had.rows[0]?.id ?? id;
}
