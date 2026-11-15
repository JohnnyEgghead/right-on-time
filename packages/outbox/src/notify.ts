// SPDX-License-Identifier: AGPL-3.0-or-later
// The outbox's publish calls (SPECIFICATIONS section 4.3, SD-13): every outbox event leaves through @bw/db publishEvent,
// the bus's 1 publisher, inside the writing transaction, so the event leaves only at commit, with ids only (D1, NFR-05).
import { publishEvent, type Queryable } from '@bw/db';

export type OutboxEventName = 'text.changed' | 'alert.created' | 'job.changed';

export async function publish(tx: Queryable, name: OutboxEventName, ids: Record<string, string | number>): Promise<void> {
  await publishEvent(tx, name, ids);
}

/** What a text.changed event names: the text, its customer, its job (when it has one) and its branch. */
export interface TextChangedIds {
  textId: string;
  customerId: string | number;
  jobNumber: number | null;
  branch: string;
}

/**
 * The text.changed ids (UI-SPECIFICATION 12.3 EVT-03: textId, customerId, jobNumber), plus branch, which the bus filters
 * on (packages/api-server/src/events/bus.ts). A text with no job (an office text) carries no jobNumber (F-370).
 */
export function textChangedIds(t: TextChangedIds): Record<string, string | number> {
  const ids: Record<string, string | number> = { textId: t.textId, customerId: t.customerId, branch: t.branch };
  if (t.jobNumber !== null) ids.jobNumber = t.jobNumber;
  return ids;
}

export async function publishTextChanged(tx: Queryable, t: TextChangedIds): Promise<void> {
  await publishEvent(tx, 'text.changed', textChangedIds(t));
}
