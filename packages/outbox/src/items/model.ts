// SPDX-License-Identifier: AGPL-3.0-or-later
// The phone item store's model (SPECIFICATIONS section 4.6 SD-16, section 5.1 steps 1, 2 and 10; UI-SPECIFICATION 4.5;
// invariant 1; D2: shared by the web app's DexieItemStore and the native app's FileItemStore). Client-safe: no server
// module is imported here, so both technician apps bundle it.
//
// The store's invariants (P5-TWA-OUTBOX), each held by a test named for it:
//   I1 durable before Saved: put() resolves only after the 1 transaction that holds the item (and its photo or signature
//      bytes) has committed, so the app says Saved only for an item a reload, a closed app or a dead tab still holds.
//   I2 leaves only on its key's answer: nothing removes an item but markAnswered() for its key with a result of
//      applied, duplicate, flagged, history_only or world_reset; a refusal, a network error, a 5xx, a signed-out answer,
//      a missing answer or another technician's session leaves it waiting, with the reason recorded (rule 1, rule 10).
//   I3 replay is idempotent: an item is sent under its own key until answered, so a send whose answer was lost is sent
//      again and answered duplicate with the stored message (section 5.1 step 3); markAnswered() of a key that is no
//      longer waiting changes nothing; the waiting list converges to what the server's ledger holds.
//   I4 entry order: waiting() lists items in the order they were entered, and a send keeps it (blobs first, step 2).
//   I5 own items only: an item is sent only under the session of the technician who entered it (rule 4).
// A finish the server refused (parts_required, validation_failed) is corrected in place by correctFinish(): the same key, the
// same place in entry order, the same stamp, a new payload. The item never leaves (I2), and a refused item writes no row on the
// server (api-server tech-items/shared.ts), so its key is still unused there and the corrected item is sent under it (I3).
import type { Instant } from '@bw/time';

/** At most 50 items per send (section 5.1 step 2; @bw/api MAX_ITEMS_PER_BATCH, pinned by a test). */
export const ITEMS_PER_SEND = 50;
/** FR-TECH-7: the banner shows once any item has waited over 24 hours of the device's real time. */
export const OLD_ITEM_MS = 24 * 60 * 60 * 1000;
/** How many answered items the store keeps for the screens that show what was sent (CTL-CMP-10-04, SCR-TEC-09). */
export const ANSWERED_KEPT = 100;

export type StatusKind = 'on_my_way' | 'arrived' | 'finished' | 'no_one_home';
export type BlobKind = 'photo' | 'signature';
export type ItemKind = 'note' | StatusKind | BlobKind;
export const BLOB_KINDS: readonly ItemKind[] = ['photo', 'signature'];
export const isBlobKind = (k: ItemKind): k is BlobKind => k === 'photo' || k === 'signature';

/** The facts section 5.1 step 1 stamps on every item at entry; the times travel as RFC 9557 wire times. */
export interface ItemStamp {
  /** UUID v4, minted on the phone; the server's idempotency key. */
  key: string;
  worldEpoch: number;
  /** The phone's own real time at entry (realNow('device_stamp')). */
  deviceTime: string;
  /** The server's real time when the stored offset was saved (API-10's realNow). */
  offsetSavedReal: string;
  /** deviceTime minus the phone's own real time at that save. */
  sinceSaveMs: number;
  /** deviceTime + the stored demo-minus-real offset (FR-DEMO-9). */
  demoTime: string;
  /** deviceTime in epoch milliseconds: the 24-hour banner's clock (FR-TECH-7, a named exception to FR-DEMO-2). */
  enteredRealMs: number;
}

export interface FinishPayload {
  parts: { partId: string; quantity: number }[];
  noPartsUsed: boolean;
  laborMinutes: number;
  workDone: string[];
}

export type ItemBody =
  | { kind: 'note'; payload: { text: string } }
  | { kind: 'on_my_way' | 'arrived' | 'no_one_home' }
  | { kind: 'finished'; payload: FinishPayload }
  | { kind: BlobKind; contentType: 'image/jpeg' | 'image/png' };

/** Why an item is still waiting after a send tried it (shown on the item in SCR-TEC-09: the code's message, or "Will try again"). */
export interface LastTry {
  atRealMs: number;
  outcome: 'network' | 'server_error' | 'signed_out' | 'forbidden' | 'refused' | 'unanswered';
  /** For a refusal: its code (parts_required; validation_failed or not_found of an upload). */
  code?: string;
  messageKey?: string | null;
}

/** 1 waiting item as the store holds it (a photo's or signature's bytes are kept beside it, read with blob()). */
export type QueuedItem = ItemStamp & ItemBody & {
  jobNumber: number;
  /** The job version the app last read; null for a photo or signature, which always apply. */
  baseVersion: number | null;
  /** The technician who entered it: it is sent only under that technician's session (I5). */
  userId: string;
  lastTry?: LastTry;
};

export type AnsweredResult = 'applied' | 'duplicate' | 'flagged' | 'history_only' | 'world_reset';
export const ANSWERED_RESULTS: readonly AnsweredResult[] = ['applied', 'duplicate', 'flagged', 'history_only', 'world_reset'];

/** The server's answer for 1 key that removes the item (UI-SPECIFICATION 4.5 rule 1). */
export interface ItemResult {
  result: AnsweredResult;
  code: string | null;
  messageKey: string | null;
  values: Record<string, string | number | null> | null;
}

/** An answered item, kept for the screens that show what was sent and what the office was told about. */
export interface AnsweredItem extends ItemResult {
  key: string;
  kind: ItemKind;
  jobNumber: number;
  enteredRealMs: number;
  answeredRealMs: number;
  /** The technician the item was entered under (F-1033: the screens show only the signed-in person's); absent on a record kept before this field. */
  userId?: string;
}

/** The clock offset saved at the last read of API-10 with signal (section 5.1 step 2; section 4.6 saveClockOffset). */
export interface ClockOffset {
  demoMinusRealMs: number;
  worldEpoch: number;
  savedServerReal: Instant;
  savedDeviceReal: Instant;
  /** The branch zone API-10's demo time carries; the wire times of the items stamped from this offset use it. */
  zone?: string;
}

/** Section 4.6's seam, with the reads and the try record the send loop and the sync strip need. */
export interface ItemStore {
  /** Durable before it resolves (I1): 1 transaction holds the item and, for a photo or signature, its bytes (required). */
  put(item: QueuedItem, blob?: Uint8Array): Promise<void>;
  /** Replaces the bytes of a waiting photo or signature; refused when no such item waits, so no bytes are kept without an item. */
  putBlob(key: string, bytes: Uint8Array): Promise<void>;
  /**
   * Replaces the payload of a waiting finish whose last try was refused, in 1 write, and clears that try; the key, the stamp and
   * the place in entry order stay. Refused (StoreWriteError) when no such finish waits or its last try was not a refusal.
   */
  correctFinish(key: string, payload: FinishPayload): Promise<void>;
  /** In entry order (I4). */
  waiting(): Promise<QueuedItem[]>;
  /** The keys of unanswered items the store holds but cannot read (the native file store); a store that cannot tell leaves it out (F-1093). */
  damaged?(): string[];
  /** Removes the item and its bytes and keeps the answer, in 1 transaction; a key that no longer waits changes nothing (I3). */
  markAnswered(key: string, result: ItemResult, answeredRealMs?: number): Promise<void>;
  saveClockOffset(o: ClockOffset): Promise<void>;
  clockOffset(): Promise<ClockOffset | null>;
  blob(key: string): Promise<Uint8Array | null>;
  /** Records why each of these waiting items is still waiting; never removes one (I2). */
  recordTry(keys: readonly string[], t: LastTry): Promise<void>;
  /** The answered items, newest first. */
  answered(limit?: number): Promise<AnsweredItem[]>;
  /** The technician last signed in with signal, so an open with no signal can still enter items under that name. */
  saveUser(userId: string): Promise<void>;
  user(): Promise<string | null>;
}

/** Thrown by put() when the item cannot be kept; the app then says it was not saved (the frame's Store write fails). */
export class StoreWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreWriteError';
  }
}

/** How many waiting items have waited over 24 hours of the device's real time (FR-TECH-7: the banner shows while any has). */
export function oldItemCount(items: readonly Pick<QueuedItem, 'enteredRealMs'>[], deviceNowMs: number): number {
  return items.filter((i) => deviceNowMs - i.enteredRealMs > OLD_ITEM_MS).length;
}

/** True when any waiting item has waited over 24 hours of the device's real time (FR-TECH-7). */
export function hasOldItem(items: readonly Pick<QueuedItem, 'enteredRealMs'>[], deviceNowMs: number): boolean {
  return oldItemCount(items, deviceNowMs) > 0;
}
