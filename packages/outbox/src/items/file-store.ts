// SPDX-License-Identifier: AGPL-3.0-or-later
// FileItemStore: the native technician app's item store (SPECIFICATIONS section 4.6 SD-16, UI-SPECIFICATION 4.5; R4 sections 1.1 to
// 1.3; the invariants are model.ts's I1 to I5). Files in 1 app directory, through a small port (StoreDir) so the rules below run the
// same over expo-file-system on the phone (apps/tech-native/src/store/expo-dir.ts) and over node:fs in the tests.
//
// Why files: iOS uploads in the background only from a file (R4 section 1.2), and Expo's upload task is not restored after the app
// is terminated (R4-23), so the queue's truth must be on disk, never in JavaScript memory. A photo's or signature's bytes are kept as
// their own file and uploaded from it.
//
// The only primitive the store trusts is create(name): the content is written to a temporary name and 1 rename makes it appear, so a
// named file is always complete (an app killed mid-write leaves only a temporary, removed at the next open). No file is ever
// rewritten: a change is a new file with a higher revision, and the old one is removed after. Names:
//   i-<seq>-<key>-<rev>.json   a waiting item (seq: entry order, I4; rev: its last-try record, the highest rev wins)
//   b-<key>-<rev>.bin          a photo's or signature's bytes (putBlob writes a higher rev)
//   a-<aseq>-<key>.json        an answered item (the last ANSWERED_KEPT are kept)
//   m-<name>-<rev>.json        the clock offset and the technician last signed in with signal
//
// Each durable write, and what a re-run or a kill at any point leaves (the scan reads only what is named, so it converges):
//   put           bytes file first, then the item file: the item file is the commit point (I1: put resolves after it exists).
//                 Killed before it: no item, and the open removes the bytes nobody owns. A key already held is refused.
//   markAnswered  the answer file first (the commit point: the key leaves waiting the moment it exists), then the item's and bytes'
//                 files are removed. Killed between: the open rolls the removal forward. A key no longer waiting changes nothing (I3).
//   recordTry     a higher rev of the item, then the lower ones removed. Killed between: the highest rev wins; the open removes the rest.
//   correctFinish the same rev rule: a higher rev with the new payload and no last try.
//   meta          the same rev rule.
// Durability (I1) here is the operating system's: a renamed file survives the app being terminated, crashing or being relaunched.
// expo-file-system 58 exposes no fsync, so a sudden power loss right after Saved is not covered (P6-NATIVE-SHELL report).
import { Temporal } from '@bw/time';
import {
  ANSWERED_KEPT, isBlobKind, StoreWriteError,
  type AnsweredItem, type ClockOffset, type FinishPayload, type ItemResult, type ItemStore, type LastTry, type QueuedItem,
} from './model.ts';

/** The store's view of its 1 directory. Every call is synchronous, so a store method runs whole between JavaScript turns. */
export interface StoreDir {
  /** The names of the files in the directory. */
  list(): string[];
  /** The file's text, or null when it does not exist. */
  readText(name: string): string | null;
  readBytes(name: string): Uint8Array | null;
  /** Makes a complete new file: content to a temporary name, then 1 rename. Throws when `name` exists or the write fails. */
  create(name: string, content: string | Uint8Array): void;
  /** Removes the file; a missing file is fine. */
  remove(name: string): void;
  /** The file's location, for an upload task that reads it (file:// on the phone). */
  uri(name: string): string;
}

/** The prefix of create()'s temporary files; the store's open removes any it finds (a write the app never finished). */
export const TEMP_PREFIX = 'tmp-';

const pad = (n: number, w: number) => String(n).padStart(w, '0');
const KEY = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ITEM = new RegExp(`^i-(\\d{12,})-(${KEY})-(\\d{6,})\\.json$`);
const BLOB = new RegExp(`^b-(${KEY})-(\\d{6,})\\.bin$`);
const ANSWER = new RegExp(`^a-(\\d{12,})-(${KEY})\\.json$`);
const META = /^m-(clock|user)-(\d{6,})\.json$/;

const itemName = (seq: number, key: string, rev: number) => `i-${pad(seq, 12)}-${key}-${pad(rev, 6)}.json`;
const blobName = (key: string, rev: number) => `b-${key}-${pad(rev, 6)}.bin`;
const answerName = (aseq: number, key: string) => `a-${pad(aseq, 12)}-${key}.json`;
const metaName = (m: 'clock' | 'user', rev: number) => `m-${m}-${pad(rev, 6)}.json`;

interface Held {
  seq: number;
  /** The item's files, highest rev first. */
  revs: { rev: number; name: string }[];
}
interface Scan {
  /** Every key with item files, answered or not. */
  items: Map<string, Held>;
  blobs: Map<string, { rev: number; name: string }[]>;
  answers: { aseq: number; key: string; name: string }[];
  answeredKeys: Set<string>;
  meta: Record<'clock' | 'user', { rev: number; name: string }[]>;
  temps: string[];
  maxSeq: number;
}

type ClockRecord = { demoMinusRealMs: number; worldEpoch: number; savedServerRealMs: number; savedDeviceRealMs: number; zone: string | null };

export class FileItemStore implements ItemStore {
  private readonly dir: StoreDir;

  constructor(dir: StoreDir) {
    this.dir = dir;
    this.recover();
  }

  // ---- reads ------------------------------------------------------------------------------------------------------------

  private scan(): Scan {
    const s: Scan = { items: new Map(), blobs: new Map(), answers: [], answeredKeys: new Set(), meta: { clock: [], user: [] }, temps: [], maxSeq: 0 };
    for (const name of this.dir.list()) {
      let m: RegExpExecArray | null;
      if (name.startsWith(TEMP_PREFIX)) s.temps.push(name);
      else if ((m = ITEM.exec(name))) {
        const [seq, key, rev] = [Number(m[1]), m[2] as string, Number(m[3])];
        const h = s.items.get(key) ?? { seq, revs: [] };
        h.revs.push({ rev, name });
        s.items.set(key, h);
        s.maxSeq = Math.max(s.maxSeq, seq);
      } else if ((m = BLOB.exec(name))) {
        const key = m[1] as string;
        s.blobs.set(key, [...(s.blobs.get(key) ?? []), { rev: Number(m[2]), name }]);
      } else if ((m = ANSWER.exec(name))) {
        s.answers.push({ aseq: Number(m[1]), key: m[2] as string, name });
        s.answeredKeys.add(m[2] as string);
      } else if ((m = META.exec(name))) {
        s.meta[m[1] as 'clock' | 'user'].push({ rev: Number(m[2]), name });
      }
    }
    for (const h of s.items.values()) h.revs.sort((a, b) => b.rev - a.rev);
    for (const b of s.blobs.values()) b.sort((x, y) => y.rev - x.rev);
    s.meta.clock.sort((a, b) => b.rev - a.rev);
    s.meta.user.sort((a, b) => b.rev - a.rev);
    s.answers.sort((a, b) => a.aseq - b.aseq);
    return s;
  }

  /** The item a key's files hold: the highest rev that parses (a lower one stands in for a damaged higher one). */
  private readItem(h: Held): { item: QueuedItem; rev: number } | null {
    for (const r of h.revs) {
      const text = this.dir.readText(r.name);
      if (text === null) continue;
      try {
        return { item: JSON.parse(text) as QueuedItem, rev: r.rev };
      } catch {
        // a damaged file is kept on disk (I2: only an answer removes an item) and the next rev down is read
      }
    }
    return null;
  }

  /** The waiting items: keys with item files and no answer file, in entry order. */
  private waitingNow(s: Scan): { key: string; seq: number; item: QueuedItem; rev: number }[] {
    const out: { key: string; seq: number; item: QueuedItem; rev: number }[] = [];
    for (const [key, h] of s.items) {
      if (s.answeredKeys.has(key)) continue;
      const r = this.readItem(h);
      if (r) out.push({ key, seq: h.seq, ...r });
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  /** The keys whose every item file is damaged: never sent, never removed, so a person can still recover them from the phone. */
  damaged(): string[] {
    const s = this.scan();
    return [...s.items].filter(([k, h]) => !s.answeredKeys.has(k) && this.readItem(h) === null).map(([k]) => k);
  }

  /**
   * F-1093 (owner ruling "Allow sign-out, warn"): removes the damaged items' files (and any bytes they own), only at a sign-out the person
   * confirmed after the warning; it never touches an item that parses, so I2 holds for every item the phone can read. Returns the keys removed.
   */
  discardDamaged(): string[] {
    const keys = this.damaged();
    const s = this.scan();
    for (const k of keys) this.removeHeld(s, k);
    return keys;
  }

  async waiting(): Promise<QueuedItem[]> {
    return this.waitingNow(this.scan()).map((w) => w.item);
  }

  async blob(key: string): Promise<Uint8Array | null> {
    const name = this.blobFile(key);
    return name === null ? null : this.dir.readBytes(name);
  }

  /** The location of a waiting photo's or signature's bytes, which the native transport uploads from (R4 section 1.2). */
  blobUri(key: string): string | null {
    const name = this.blobFile(key);
    return name === null ? null : this.dir.uri(name);
  }

  private blobFile(key: string): string | null {
    const s = this.scan();
    if (s.answeredKeys.has(key) || !s.items.has(key)) return null;
    return s.blobs.get(key)?.[0]?.name ?? null;
  }

  async answered(limit = ANSWERED_KEPT): Promise<AnsweredItem[]> {
    const out: AnsweredItem[] = [];
    for (const a of [...this.scan().answers].reverse()) {
      if (out.length >= limit) break;
      const text = this.dir.readText(a.name);
      if (text === null) continue;
      try {
        out.push(JSON.parse(text) as AnsweredItem);
      } catch {
        // a damaged answer record still marks its key answered; it is just not listed
      }
    }
    return out;
  }

  async clockOffset(): Promise<ClockOffset | null> {
    const m = this.readMeta<ClockRecord>('clock');
    if (!m) return null;
    return {
      demoMinusRealMs: m.demoMinusRealMs, worldEpoch: m.worldEpoch,
      savedServerReal: Temporal.Instant.fromEpochMilliseconds(m.savedServerRealMs),
      savedDeviceReal: Temporal.Instant.fromEpochMilliseconds(m.savedDeviceRealMs),
      ...(m.zone ? { zone: m.zone } : {}),
    };
  }

  async user(): Promise<string | null> {
    return this.readMeta<{ userId: string }>('user')?.userId ?? null;
  }

  private readMeta<T>(m: 'clock' | 'user'): T | null {
    for (const r of this.scan().meta[m]) {
      const text = this.dir.readText(r.name);
      if (text === null) continue;
      try {
        return JSON.parse(text) as T;
      } catch {
        // a damaged record: the rev below it is the last good one
      }
    }
    return null;
  }

  // ---- writes -----------------------------------------------------------------------------------------------------------

  async put(item: QueuedItem, blob?: Uint8Array): Promise<void> {
    if (isBlobKind(item.kind) !== (blob !== undefined)) {
      throw new StoreWriteError(isBlobKind(item.kind) ? `a ${item.kind} is kept with its bytes` : `a ${item.kind} carries no bytes`);
    }
    if (blob !== undefined && blob.byteLength === 0) throw new StoreWriteError(`the ${item.kind} has no bytes`);
    const s = this.scan();
    if (s.items.has(item.key) || s.answeredKeys.has(item.key)) throw new StoreWriteError(`item ${item.key} was not saved: the key is already held`);
    const bytesName = blob !== undefined ? blobName(item.key, 1) : null;
    try {
      if (bytesName !== null) {
        this.dir.remove(bytesName); // an orphan of a put killed before its commit point (the open removes those too)
        this.dir.create(bytesName, blob as Uint8Array);
      }
      this.dir.create(itemName(s.maxSeq + 1, item.key, 1), JSON.stringify(item));
    } catch (e) {
      if (bytesName !== null) this.dir.remove(bytesName);
      throw new StoreWriteError(`item ${item.key} was not saved: ${(e as Error).message}`, { cause: e });
    }
  }

  async putBlob(key: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) throw new StoreWriteError('no bytes');
    const s = this.scan();
    const held = s.items.get(key);
    const r = held && !s.answeredKeys.has(key) ? this.readItem(held) : null;
    if (!r || !isBlobKind(r.item.kind)) throw new StoreWriteError(`no photo or signature ${key} waits`);
    const old = s.blobs.get(key) ?? [];
    this.dir.create(blobName(key, (old[0]?.rev ?? 0) + 1), bytes);
    for (const o of old) this.dir.remove(o.name);
  }

  async markAnswered(key: string, result: ItemResult, answeredRealMs?: number): Promise<void> {
    const s = this.scan();
    const w = this.waitingNow(s).find((x) => x.key === key);
    if (!w) return; // I3: already answered (a replayed answer, a second sender): nothing changes.
    const answer: AnsweredItem = {
      key, kind: w.item.kind, jobNumber: w.item.jobNumber, enteredRealMs: w.item.enteredRealMs, userId: w.item.userId,
      answeredRealMs: answeredRealMs ?? w.item.enteredRealMs,
      result: result.result, code: result.code, messageKey: result.messageKey, values: result.values,
    };
    const aseq = (s.answers.at(-1)?.aseq ?? 0) + 1;
    this.dir.create(answerName(aseq, key), JSON.stringify(answer)); // the commit point
    this.removeHeld(s, key);
    s.answers.push({ aseq, key, name: answerName(aseq, key) });
    s.answeredKeys.add(key);
    this.prune(s);
  }

  async recordTry(keys: readonly string[], t: LastTry): Promise<void> {
    if (keys.length === 0) return;
    const s = this.scan();
    const want = new Set(keys);
    for (const w of this.waitingNow(s)) {
      if (!want.has(w.key)) continue;
      const h = s.items.get(w.key) as Held;
      this.dir.create(itemName(w.seq, w.key, (h.revs[0]?.rev ?? w.rev) + 1), JSON.stringify({ ...w.item, lastTry: t }));
      for (const r of h.revs) this.dir.remove(r.name);
    }
  }

  async correctFinish(key: string, payload: FinishPayload): Promise<void> {
    const s = this.scan();
    const w = this.waitingNow(s).find((x) => x.key === key);
    if (!w || w.item.kind !== 'finished' || w.item.lastTry?.outcome !== 'refused') throw new StoreWriteError(`no refused finish ${key} waits`);
    const next = { ...w.item, payload: { ...payload, parts: payload.parts.map((p) => ({ ...p })), workDone: [...payload.workDone] } } as QueuedItem;
    delete next.lastTry;
    const h = s.items.get(key) as Held;
    this.dir.create(itemName(w.seq, key, (h.revs[0]?.rev ?? w.rev) + 1), JSON.stringify(next));
    for (const r of h.revs) this.dir.remove(r.name);
  }

  async saveClockOffset(o: ClockOffset): Promise<void> {
    const rec: ClockRecord = {
      demoMinusRealMs: o.demoMinusRealMs, worldEpoch: o.worldEpoch,
      savedServerRealMs: o.savedServerReal.epochMilliseconds, savedDeviceRealMs: o.savedDeviceReal.epochMilliseconds, zone: o.zone ?? null,
    };
    this.writeMeta('clock', rec);
  }

  async saveUser(userId: string): Promise<void> {
    this.writeMeta('user', { userId });
  }

  private writeMeta(m: 'clock' | 'user', value: unknown): void {
    const old = this.scan().meta[m];
    this.dir.create(metaName(m, (old[0]?.rev ?? 0) + 1), JSON.stringify(value));
    for (const o of old) this.dir.remove(o.name);
  }

  // ---- recovery ---------------------------------------------------------------------------------------------------------

  /** Removes an answered key's item and bytes files. */
  private removeHeld(s: Scan, key: string): void {
    for (const r of s.items.get(key)?.revs ?? []) this.dir.remove(r.name);
    for (const b of s.blobs.get(key) ?? []) this.dir.remove(b.name);
    s.items.delete(key);
    s.blobs.delete(key);
  }

  /** Keeps the newest ANSWERED_KEPT answers; an answer whose item files still exist is kept, so the key stays answered. */
  private prune(s: Scan): void {
    let over = s.answers.length - ANSWERED_KEPT;
    for (const a of s.answers) {
      if (over <= 0) break;
      if (s.items.has(a.key) || s.blobs.has(a.key)) continue;
      this.dir.remove(a.name);
      over -= 1;
    }
  }

  /**
   * The open's roll-forward, so what is on disk converges to what the scan says: unfinished writes go, answered keys lose their
   * item and bytes files, lower revs go, and bytes no waiting item owns go (a put killed before its commit point). Damaged item
   * files are kept.
   */
  private recover(): void {
    const s = this.scan();
    for (const t of s.temps) this.dir.remove(t);
    for (const key of [...s.items.keys(), ...s.blobs.keys()]) if (s.answeredKeys.has(key)) this.removeHeld(s, key);
    for (const [key, h] of s.items) {
      const r = this.readItem(h);
      if (!r) continue;
      for (const x of h.revs) if (x.rev !== r.rev && x.rev < r.rev) this.dir.remove(x.name);
      if (!isBlobKind(r.item.kind)) for (const b of s.blobs.get(key) ?? []) this.dir.remove(b.name);
    }
    for (const [key, revs] of s.blobs) {
      if (!s.items.has(key)) for (const b of revs) this.dir.remove(b.name);
      else for (const b of revs.slice(1)) this.dir.remove(b.name);
    }
    for (const m of ['clock', 'user'] as const) {
      // The lower revs go only once the highest reads back: a damaged highest rev falls back to the one below it.
      const top = s.meta[m][0];
      const good = top ? this.dir.readText(top.name) : null;
      let parses = false;
      try {
        parses = good !== null && JSON.parse(good) !== undefined;
      } catch {
        parses = false;
      }
      if (parses) for (const o of s.meta[m].slice(1)) this.dir.remove(o.name);
    }
    this.prune(s);
  }
}
