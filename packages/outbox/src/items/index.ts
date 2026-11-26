// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/outbox's phone item store (SPECIFICATIONS section 4.6 SD-16, section 5.1; D2: shared by both technician apps).
// Client-safe: it imports no server module, so the apps import this entry, never the package root (which holds the
// server's text outbox). The web app's store is DexieItemStore; the native app's FileItemStore (apps/tech-native) implements the
// same ItemStore. Both apps run the same engine (engine.ts) and read answers through the same wire mapping (wire.ts).
export {
  ANSWERED_KEPT, ANSWERED_RESULTS, BLOB_KINDS, hasOldItem, isBlobKind, ITEMS_PER_SEND, OLD_ITEM_MS, oldItemCount, StoreWriteError,
  type AnsweredItem, type AnsweredResult, type BlobKind, type ClockOffset, type FinishPayload, type ItemBody, type ItemKind,
  type ItemResult, type ItemStamp, type ItemStore, type LastTry, type QueuedItem, type StatusKind,
} from './model.ts';
export { DEFAULT_DB_NAME, DexieItemStore, type DexieStoreOptions } from './dexie-store.ts';
export { FileItemStore, TEMP_PREFIX, type StoreDir } from './file-store.ts';
export { sendWaiting, type CallFailure, type CallStop, type SendOptions, type SendReport, type Transport, type WireAnswer } from './send.ts';
export { newItemKey, offsetFromClock, stampEntry } from './stamp.ts';
export { blobContentType, blobQuery, failureOf, jsonOrNull, uploadAnswer, wireItem } from './wire.ts';
export { FinishLeave, signatureOwed } from './finish-leave.ts';
export { NotReadyError, SYNC_CALL_LIMIT_MS, SYNC_EVERY_MS, TechOutbox, uploadLimitMs, type EngineDeps, type EntryInput, type OutboxState } from './engine.ts';
