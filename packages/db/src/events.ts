// SPDX-License-Identifier: AGPL-3.0-or-later
// The event bus contract (SPECIFICATIONS section 4.3, SD-13; UI-SPECIFICATION 12.3). The ONE place that names the notify
// channel and the payload shape: the publisher (publishEvent, below, or any writer that emits through its own function),
// the LISTEN side (@bw/api-server events/bus.ts) and the tests all import from here.
//
// Wire payload of 1 notification on BUS_CHANNEL: {"name": EventName, "ids": {<id name>: string | number}}. IDS ONLY (D1): a
// value is a string or a number, never an object, a row or a list. `seq` is not on the notification: the web process's
// LISTEN side stamps each delivered event with a rising seq (BusEvent), which is what the stream's `id:` line carries.
import type { Queryable } from './client.ts';

/** The channel every event leaves on: `SELECT pg_notify('bw_events', json)` and `LISTEN bw_events`. */
export const BUS_CHANNEL = 'bw_events';

export const EVENT_NAMES = [
  'job.changed', 'board.refresh', 'text.changed', 'alert.created', 'clock.changed',
  'world.reset', 'billing.changed', 'import.run.changed', 'settings.changed', 'block.changed',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export type EventIds = Record<string, string | number>;

/** What a subscriber receives: the ids and a rising seq (SPECIFICATIONS 4.3). */
export interface BusEvent {
  seq: number;
  name: EventName;
  ids: EventIds;
}

/** The notification's JSON text. Throws on an unknown name or an id value that is not a string or a number. */
export function encodeNotification(name: EventName, ids: EventIds): string {
  if (!(EVENT_NAMES as readonly string[]).includes(name)) throw new Error(`unknown event name ${String(name)}`);
  for (const [k, v] of Object.entries(ids)) {
    if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`event id ${k} must be a string or a number (ids only)`);
  }
  return JSON.stringify({ name, ids });
}

/** The event a notification payload holds, or null when it is not a well-formed bus payload (it is then dropped). */
export function decodeNotification(payload: string | undefined): { name: EventName; ids: EventIds } | null {
  if (payload === undefined) return null;
  let v: unknown;
  try {
    v = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const { name, ids } = v as { name?: unknown; ids?: unknown };
  if (typeof name !== 'string' || !(EVENT_NAMES as readonly string[]).includes(name)) return null;
  if (typeof ids !== 'object' || ids === null || Array.isArray(ids)) return null;
  const out: EventIds = {};
  for (const [k, id] of Object.entries(ids)) {
    if (typeof id !== 'string' && typeof id !== 'number') return null;
    out[k] = id;
  }
  return { name: name as EventName, ids: out };
}

/**
 * Publish 1 event inside the writing transaction: the notification leaves the database only when `tx` commits and is
 * dropped if it rolls back (SPECIFICATIONS 4.3 Publish).
 */
export async function publishEvent(tx: Queryable, name: EventName, ids: EventIds = {}): Promise<void> {
  await tx.query('SELECT pg_notify($1, $2)', [BUS_CHANNEL, encodeNotification(name, ids)]);
}
