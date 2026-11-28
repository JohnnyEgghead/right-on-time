// SPDX-License-Identifier: AGPL-3.0-or-later
// The technician apps' item engine (SPECIFICATIONS section 5.1 steps 1 and 2, SD-47; UI-SPECIFICATION 4.5; D2: shared by the web
// app and the native app): the 1 place an app's screens
// enter items and the 1 sender. It wraps the shared store and send loop with the app's reads: who is signed in (API-07), the clock
// offset (API-10), the sync report (API-162). Each app supplies its store, transport, triggers and connection state.
//
// Entry (step 1): enter() stamps the item from the stored clock offset and the phone's real time and resolves only once
// the store has committed it (I1); only then may a screen say Saved. Then, with signal, a send starts.
// Sending (step 2; SD-47 "on open, on focus, after each send, and every 60 s"): the app calls sync() on open, when the platform
// says the connection is back, on focus, after each entry and every 60 s while it is open (rule 5: the web app sends only while
// open; the native app's uploads also finish after it is left, from their files). 1 sync at a time per engine (a second call joins
// the running one); the web app also serializes tabs with the Web Locks API; 2 senders at once would still be safe, since the
// server answers a repeated key duplicate (I3). A sync: API-07 (the caller, saved for an open with no signal), the send loop for
// that technician's items, the API-162 report of the waiting count, then API-10 and the saved offset.
// No signal: the platform says offline (isOnline), or the last call failed for the network. The No signal banner and the
// waiting count read this engine's state.
import { readClock, reportSync, whoAmI, type ApiClient } from '@bw/api';
import { toWire, type Instant } from '@bw/time';
import { isBlobKind, oldItemCount, type AnsweredItem, type FinishPayload, type ItemBody, type ItemStore, type QueuedItem } from './model.ts';
import { sendWaiting, type SendReport, type Transport } from './send.ts';
import { newItemKey, offsetFromClock, stampEntry } from './stamp.ts';
import { failureOf } from './wire.ts';

export const SYNC_EVERY_MS = 60_000;

/**
 * F-1746: the longest 1 call of a sync may take (the client's timeoutMs, @bw/api createClient): a call with no answer by then is cancelled
 * and read as no signal, so the sync ends, the screen leaves Sending and the next sync tries again under the same keys (I3).
 */
export const SYNC_CALL_LIMIT_MS = 30_000;
/** F-1746: the slowest line an upload's limit allows for, in bytes per ms (32 KB/s, about 0.26 Mbit/s: 10 MB in about 5.5 minutes). */
const UPLOAD_FLOOR_BYTES_PER_MS = 32;
/**
 * F-1746: the limit for 1 photo or signature upload (API-103): the call limit plus its bytes' time at the floor rate, so a large photo on
 * a slow line still finishes and a small one that never answers ends as soon as a read would.
 */
export const uploadLimitMs = (bytes: number): number => SYNC_CALL_LIMIT_MS + Math.ceil(bytes / UPLOAD_FLOOR_BYTES_PER_MS);

export interface OutboxState {
  /** The store has been read once. */
  ready: boolean;
  waiting: QueuedItem[];
  /** False while the app has no connection to the server (CTL-CMP-10-01). */
  online: boolean;
  sending: boolean;
  /** How many items have waited over 24 hours of the device's real time (CTL-CMP-10-03 shows while any has). */
  oldCount: number;
  /** The last completed send's answered items, for the sent announcement (CTL-CMP-10-04). */
  lastSent: AnsweredItem[];
  /** The last sync found the session gone (401): the app shows its sign-in; every item still waits. */
  signedOut: boolean;
  /** The person the phone's store last knew (API-07 / entry); the screens show only this person's items (F-1033). Absent in a preview's fixed state. */
  userId?: string | null;
}

export interface EngineDeps {
  store: ItemStore;
  transport: Transport;
  client: ApiClient;
  /** realNow('device_stamp'): the stamps, the offset save and the report time. */
  deviceNow: () => Instant;
  /** realNow('tech_waiting_banner'): the 24-hour banner's clock. */
  bannerNow: () => number;
  isOnline: () => boolean;
  /** The device and app version the sync report names (API-162). */
  device: string;
  /** Serialize syncs across tabs (navigator.locks.request); runs fn directly when absent. */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** The app the sync report names (API-162 app); the web app when absent. */
  app?: 'web' | 'native';
  /** The platform's UUID v4 source for item keys (newItemKey); globalThis.crypto.randomUUID when absent (the native app has none). */
  uuid?: () => string;
  /** How long an entry waits for the first sync's offset before it is refused with no_clock (F-1482); JOIN_LIMIT_MS when absent. */
  joinLimitMs?: number;
}

/** F-1482: a server that never answers must not hold an entry for ever: the person gets the Connect-once notice after this long. */
const JOIN_LIMIT_MS = 5_000;

export class NotReadyError extends Error {
  readonly reason: 'no_clock' | 'no_user';
  constructor(reason: 'no_clock' | 'no_user') {
    super(reason === 'no_clock' ? 'the app has not read the clock with signal yet' : 'no technician has signed in with signal on this phone');
    this.name = 'NotReadyError';
    this.reason = reason;
  }
}

export interface EntryInput {
  jobNumber: number;
  /** The job version the app last read; ignored (null) for a photo or signature. */
  baseVersion: number | null;
  body: ItemBody;
  /** A photo's or signature's bytes. */
  blob?: Uint8Array;
}

export class TechOutbox {
  private state: OutboxState = { ready: false, waiting: [], online: true, sending: false, oldCount: 0, lastSent: [], signedOut: false };
  private readonly listeners = new Set<(s: OutboxState) => void>();
  private running: Promise<SendReport | null> | null = null;
  private networkDown = false;
  private version: string;

  private readonly deps: EngineDeps;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.version = deps.app ?? 'web';
  }

  get snapshot(): OutboxState {
    return this.state;
  }

  subscribe(fn: (s: OutboxState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<OutboxState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  /** Re-read the store: the waiting list, the 24-hour banner, the connection state. */
  async refresh(): Promise<void> {
    const [waiting, userId] = await Promise.all([this.deps.store.waiting(), this.deps.store.user()]);
    this.set({ ready: true, waiting, userId, oldCount: oldItemCount(waiting, this.deps.bannerNow()), online: this.deps.isOnline() && !this.networkDown });
  }

  /** Section 5.1 step 1: stamp and keep 1 item; resolves after the store committed it (I1), then starts a send. */
  async enter(input: EntryInput): Promise<QueuedItem> {
    // F-1469: the stamp's time is the moment the person pressed, read before any wait for the first sync below.
    const tappedAt = this.deps.deviceNow();
    let [offset, userId] = await Promise.all([this.deps.store.clockOffset(), this.deps.store.user()]);
    if (!offset && this.deps.isOnline()) {
      // Online with no offset saved yet: the first sync is running or starts now; join it (it never throws) and read again.
      // The item is not in the store yet, so that sync cannot send or enter it; only this call enters it, once.
      // F-1482: the wait has a limit; the sync keeps running and still saves the offset if it answers later.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.deps.joinLimitMs ?? JOIN_LIMIT_MS); });
      await Promise.race([this.sync(), limit]);
      clearTimeout(timer);
      [offset, userId] = await Promise.all([this.deps.store.clockOffset(), this.deps.store.user()]);
    }
    if (!offset) throw new NotReadyError('no_clock');
    if (!userId) throw new NotReadyError('no_user');
    const item = {
      ...stampEntry(offset, tappedAt, this.deps.uuid ? newItemKey(this.deps.uuid) : newItemKey()),
      jobNumber: input.jobNumber, baseVersion: isBlobKind(input.body.kind) ? null : input.baseVersion, userId, ...input.body,
    } as QueuedItem;
    await this.deps.store.put(item, input.blob);
    // F-1975: the entry is kept; a list read that fails after it keeps the last list on screen and is not the entry's answer.
    await this.refresh().catch(() => undefined);
    if (this.state.online) void this.sync();
    return item;
  }

  /**
   * F-1025: a finish the server refused (parts_required) is corrected in place under its key (model.ts, ItemStore.correctFinish),
   * after any running send has settled, so that send's answer for the old payload is not recorded on the corrected one. Resolves
   * after the store committed the correction (I1), then starts a send.
   */
  async correctFinish(key: string, payload: FinishPayload): Promise<QueuedItem> {
    await this.running?.catch(() => null);
    const was = this.state.waiting.find((i) => i.key === key);
    await this.deps.store.correctFinish(key, payload);
    // F-1975: the correction is kept; a list read that fails after it is not the correction's answer.
    const read = await this.refresh().then(() => true, () => false);
    const item = (read ? this.state.waiting.find((i) => i.key === key) : was ? { ...was, payload } : undefined) as QueuedItem;
    if (this.state.online) void this.sync();
    return item;
  }

  /**
   * 1 sync (see the header); joins a running one. Never rejects (F-1849): any throw (the store, the transport, the lock, a read)
   * ends the sync with null, every item still waiting under its key, Sending off, and the next sync tries again (I3). F-2006
   * K-10.5: the catch sets the no-signal state itself (online false, as a sync that found no signal), so the screens show the
   * same states as that sync; there is no other banner state. The next read that answers sets online again.
   */
  sync(): Promise<SendReport | null> {
    if (!this.running) {
      this.running = this.guardedSync().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async guardedSync(): Promise<SendReport | null> {
    try {
      return await (this.deps.lock ? this.deps.lock(() => this.syncOnce()) : this.syncOnce());
    } catch {
      this.networkDown = true;
      this.set({ online: false, sending: false });
      return null;
    }
  }

  private async syncOnce(): Promise<SendReport | null> {
    if (!this.deps.isOnline()) {
      await this.refresh();
      return null;
    }
    this.set({ sending: true });
    try {
      const me = await this.read(() => this.deps.client.call(whoAmI, {}));
      if (!me) return null;
      await this.deps.store.saveUser(me.data.userId);
      const report = await sendWaiting(this.deps.store, this.deps.transport, { userId: me.data.userId, nowMs: () => this.deps.deviceNow().epochMilliseconds });
      this.networkDown = report.stopped === 'network';
      if (report.stopped === 'signed_out') this.set({ signedOut: true });
      if (report.answered.length > 0) this.set({ lastSent: report.answered });
      if (report.stopped === null) {
        const zone = (await this.deps.store.clockOffset())?.zone ?? 'UTC';
        await this.read(() => this.deps.client.call(reportSync, {
          app: this.deps.app ?? 'web', waitingCount: report.waitingAfter, lastSyncAt: toWire(this.deps.deviceNow(), zone), device: this.deps.device, version: this.version,
        }));
        const before = this.deps.deviceNow();
        const clock = await this.read(() => this.deps.client.call(readClock, {}));
        if (clock) await this.deps.store.saveClockOffset(offsetFromClock(clock.data, before));
      }
      return report;
    } finally {
      this.set({ sending: false });
      // F-1849: a store that cannot be read now keeps the last list on screen; it is not the sync's answer.
      await this.refresh().catch(() => undefined);
    }
  }

  /** 1 read; a failure marks the connection down (network) or signed out (401) and answers null. */
  private async read<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      const r = await fn();
      this.networkDown = false;
      this.set({ signedOut: false });
      return r;
    } catch (e) {
      const f = failureOf(e);
      if (f.stop === 'network') this.networkDown = true;
      if (f.stop === 'signed_out') this.set({ signedOut: true });
      return null;
    }
  }

  /** The demo time now on this phone (FR-DEMO-9): its own real time plus the stored offset, as an item is stamped; null before the first read with signal. */
  async demoNowMs(): Promise<number | null> {
    const o = await this.deps.store.clockOffset();
    return o ? this.deps.deviceNow().epochMilliseconds + o.demoMinusRealMs : null;
  }

  /** The answered items the store keeps, newest first (SCR-TEC-09: today's flagged, history-only and not-added results). */
  answered(): Promise<AnsweredItem[]> {
    return this.deps.store.answered();
  }

  /** The bytes of a waiting photo or signature (a thumbnail of the technician's own unsent photo). */
  blob(key: string): Promise<Uint8Array | null> {
    return this.deps.store.blob(key);
  }

  /** The source commit the sync report names as the app's version (API-02), read once. */
  setVersion(v: string): void {
    this.version = v.slice(0, 40) || (this.deps.app ?? 'web');
  }
}
