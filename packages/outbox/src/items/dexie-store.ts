// SPDX-License-Identifier: AGPL-3.0-or-later
// DexieItemStore: the web technician app's item store (SPECIFICATIONS section 4.6 SD-16, UI-SPECIFICATION 4.5; the
// invariants are model.ts's I1 to I4). IndexedDB through Dexie, 1 database per origin:
//   items     the waiting items in entry order (++seq), 1 row per key (&key)
//   blobs     a photo's or signature's bytes, by key, written in the same transaction as its item
//   answered  the last ANSWERED_KEPT answers, for the screens that show what was sent and what the office was told
//   meta      the clock offset of the last API-10 read and the technician last signed in with signal
// Durability (I1): every write transaction asks for strict durability (Dexie's chromeTransactionDurability), so Chromium
// flushes it to disk before the transaction completes, as WebKit does by default; Chromium's own default is relaxed,
// which can lose a transaction the page was told had completed if the device loses power. put() resolves only when its
// transaction has committed (Dexie's transaction promise), and the bytes of a photo ride in that same transaction.
import { Dexie, type Table } from 'dexie';
import { Temporal } from '@bw/time';
import {
  ANSWERED_KEPT, isBlobKind, StoreWriteError,
  type AnsweredItem, type ClockOffset, type FinishPayload, type ItemResult, type ItemStore, type LastTry, type QueuedItem,
} from './model.ts';

export const DEFAULT_DB_NAME = 'bw-tech-items';

type ItemRow = QueuedItem & { seq?: number };
interface BlobRow { key: string; bytes: Uint8Array }
type AnsweredRow = AnsweredItem & { id?: number };
type MetaRow =
  | { id: 'clock'; demoMinusRealMs: number; worldEpoch: number; savedServerRealMs: number; savedDeviceRealMs: number; zone: string | null }
  | { id: 'user'; userId: string };

export interface DexieStoreOptions {
  /** For tests: an IndexedDB implementation other than the platform's (fake-indexeddb). */
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof IDBKeyRange;
}

const strip = (r: ItemRow): QueuedItem => {
  const item = { ...r };
  delete item.seq;
  return item as QueuedItem;
};

export class DexieItemStore implements ItemStore {
  readonly db: Dexie;
  private readonly items: Table<ItemRow, number>;
  private readonly blobs: Table<BlobRow, string>;
  private readonly answers: Table<AnsweredRow, number>;
  private readonly meta: Table<MetaRow, string>;

  constructor(name: string = DEFAULT_DB_NAME, opts: DexieStoreOptions = {}) {
    this.db = new Dexie(name, {
      chromeTransactionDurability: 'strict',
      ...(opts.indexedDB ? { indexedDB: opts.indexedDB } : {}),
      ...(opts.IDBKeyRange ? { IDBKeyRange: opts.IDBKeyRange } : {}),
    });
    this.db.version(1).stores({ items: '++seq, &key, userId', blobs: 'key', answered: '++id, key', meta: 'id' });
    this.items = this.db.table('items');
    this.blobs = this.db.table('blobs');
    this.answers = this.db.table('answered');
    this.meta = this.db.table('meta');
  }

  async put(item: QueuedItem, blob?: Uint8Array): Promise<void> {
    if (isBlobKind(item.kind) !== (blob !== undefined)) {
      throw new StoreWriteError(isBlobKind(item.kind) ? `a ${item.kind} is kept with its bytes` : `a ${item.kind} carries no bytes`);
    }
    if (blob !== undefined && blob.byteLength === 0) throw new StoreWriteError(`the ${item.kind} has no bytes`);
    try {
      await this.db.transaction('rw', this.items, this.blobs, async () => {
        await this.items.add({ ...item });
        if (blob !== undefined) await this.blobs.put({ key: item.key, bytes: blob });
      });
    } catch (e) {
      throw new StoreWriteError(`item ${item.key} was not saved: ${(e as Error).name}`, { cause: e });
    }
  }

  async putBlob(key: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) throw new StoreWriteError('no bytes');
    await this.db.transaction('rw', this.items, this.blobs, async () => {
      const row = await this.items.where('key').equals(key).first();
      if (!row || !isBlobKind(row.kind)) throw new StoreWriteError(`no photo or signature ${key} waits`);
      await this.blobs.put({ key, bytes });
    });
  }

  async correctFinish(key: string, payload: FinishPayload): Promise<void> {
    await this.db.transaction('rw', this.items, async () => {
      const row = await this.items.where('key').equals(key).first();
      if (!row || row.kind !== 'finished' || row.lastTry?.outcome !== 'refused') throw new StoreWriteError(`no refused finish ${key} waits`);
      const next: ItemRow = { ...row, payload: { ...payload, parts: payload.parts.map((p) => ({ ...p })), workDone: [...payload.workDone] } };
      delete next.lastTry;
      await this.items.put(next);
    });
  }

  async waiting(): Promise<QueuedItem[]> {
    return (await this.items.orderBy('seq').toArray()).map(strip);
  }

  async markAnswered(key: string, result: ItemResult, answeredRealMs?: number): Promise<void> {
    await this.db.transaction('rw', this.items, this.blobs, this.answers, async () => {
      const row = await this.items.where('key').equals(key).first();
      if (!row) return; // I3: already answered (another tab's send, a replayed answer): nothing changes.
      await this.items.delete(row.seq as number);
      await this.blobs.delete(key);
      await this.answers.add({
        key, kind: row.kind, jobNumber: row.jobNumber, enteredRealMs: row.enteredRealMs, userId: row.userId,
        answeredRealMs: answeredRealMs ?? row.enteredRealMs,
        result: result.result, code: result.code, messageKey: result.messageKey, values: result.values,
      });
      const over = (await this.answers.count()) - ANSWERED_KEPT;
      if (over > 0) await this.answers.bulkDelete(await this.answers.orderBy('id').limit(over).primaryKeys());
    });
  }

  async recordTry(keys: readonly string[], t: LastTry): Promise<void> {
    if (keys.length === 0) return;
    await this.db.transaction('rw', this.items, async () => {
      await this.items.where('key').anyOf([...keys]).modify({ lastTry: t });
    });
  }

  async saveClockOffset(o: ClockOffset): Promise<void> {
    await this.meta.put({
      id: 'clock', demoMinusRealMs: o.demoMinusRealMs, worldEpoch: o.worldEpoch,
      savedServerRealMs: o.savedServerReal.epochMilliseconds, savedDeviceRealMs: o.savedDeviceReal.epochMilliseconds, zone: o.zone ?? null,
    });
  }

  async clockOffset(): Promise<ClockOffset | null> {
    const m = await this.meta.get('clock');
    if (!m || m.id !== 'clock') return null;
    return {
      demoMinusRealMs: m.demoMinusRealMs, worldEpoch: m.worldEpoch,
      savedServerReal: Temporal.Instant.fromEpochMilliseconds(m.savedServerRealMs),
      savedDeviceReal: Temporal.Instant.fromEpochMilliseconds(m.savedDeviceRealMs),
      ...(m.zone ? { zone: m.zone } : {}),
    };
  }

  async blob(key: string): Promise<Uint8Array | null> {
    return (await this.blobs.get(key))?.bytes ?? null;
  }

  async answered(limit = ANSWERED_KEPT): Promise<AnsweredItem[]> {
    return (await this.answers.orderBy('id').reverse().limit(limit).toArray()).map((row) => {
      const a = { ...row };
      delete a.id;
      return a as AnsweredItem;
    });
  }

  async saveUser(userId: string): Promise<void> {
    await this.meta.put({ id: 'user', userId });
  }

  async user(): Promise<string | null> {
    const m = await this.meta.get('user');
    return m && m.id === 'user' ? m.userId : null;
  }

  close(): void {
    this.db.close();
  }
}
