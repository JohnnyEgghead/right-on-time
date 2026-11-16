// SPDX-License-Identifier: AGPL-3.0-or-later
// The native app's entry to the phone item store (P6-NATIVE-SHELL; D2): index.ts without the web app's IndexedDB store, so the native
// bundle carries no Dexie. The store, the engine, the send loop and the wire mapping are the same modules the web app runs.
export {
  ANSWERED_KEPT, ANSWERED_RESULTS, BLOB_KINDS, hasOldItem, isBlobKind, ITEMS_PER_SEND, OLD_ITEM_MS, oldItemCount, StoreWriteError,
  type AnsweredItem, type AnsweredResult, type BlobKind, type ClockOffset, type FinishPayload, type ItemBody, type ItemKind,
  type ItemResult, type ItemStamp, type ItemStore, type LastTry, type QueuedItem, type StatusKind,
} from './model.ts';
export { FileItemStore, TEMP_PREFIX, type StoreDir } from './file-store.ts';
export { sendWaiting, type CallFailure, type CallStop, type SendOptions, type SendReport, type Transport, type WireAnswer } from './send.ts';
export { newItemKey, offsetFromClock, stampEntry } from './stamp.ts';
export { blobContentType, blobQuery, failureOf, jsonOrNull, uploadAnswer, wireItem } from './wire.ts';
export { NotReadyError, SYNC_CALL_LIMIT_MS, SYNC_EVERY_MS, TechOutbox, uploadLimitMs, type EngineDeps, type EntryInput, type OutboxState } from './engine.ts';
