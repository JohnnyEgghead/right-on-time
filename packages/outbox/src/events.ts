// SPDX-License-Identifier: AGPL-3.0-or-later
// Writing a side-effect event (SPECIFICATIONS section 3 `scheduled_event`; section 5.2). The event dispatcher of the
// worker claims due rows in (due_at, id) order and runs each at its own time. Payloads hold ids only (NFR-05).
import type { Queryable } from '@bw/db';
import type { Instant } from '@bw/time';
import { TEXT_TRY, type TextTryPayload } from './model.ts';

export async function scheduleEvent(
  tx: Queryable,
  e: { kind: string; dueAt: Instant; subject: string; payload: Record<string, unknown> },
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ($1, $2, $3, $4, 'due') RETURNING id`,
    [e.dueAt.toString(), e.kind, e.subject, JSON.stringify(e.payload)],
  );
  return r.rows[0]!.id;
}

/** The text.try event that makes try `number` of a text at `dueAt`. A text has at most 1 due text.try event. */
export function scheduleTry(tx: Queryable, dueAt: Instant, payload: TextTryPayload): Promise<string> {
  return scheduleEvent(tx, { kind: TEXT_TRY, dueAt, subject: payload.textId, payload: { ...payload } });
}
