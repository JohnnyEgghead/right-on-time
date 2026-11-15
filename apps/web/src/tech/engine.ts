// SPDX-License-Identifier: AGPL-3.0-or-later
// The web technician app's item engine is the shared one (@bw/outbox engine.ts; P6-NATIVE-SHELL moved it there so the native app
// runs the same entry and send rules). The web app gives it IndexedDB, fetch, the browser's triggers and navigator.onLine (useOutbox.ts).
export { NotReadyError, SYNC_EVERY_MS, TechOutbox, type EngineDeps, type EntryInput, type OutboxState } from '@bw/outbox/src/items/index.ts';
