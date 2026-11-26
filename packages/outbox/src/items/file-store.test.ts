// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-4, FR-IOS-1
// FileItemStore (the native app's item store; file-store.ts) over a real directory (node:fs), with a scripted transport and the shared
// send loop. A new FileItemStore on the same directory is the app terminated and opened again: it reads only what reached the disk.
// A faulty directory kills the store at every durable step of every write, and the reopened store must hold the state before the
// write or the state after it, never a third: the re-run semantics the file header states.
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Temporal } from '@bw/time';
import { FileItemStore, TEMP_PREFIX, type StoreDir } from './file-store.ts';
import { ANSWERED_KEPT, StoreWriteError, type ItemResult, type QueuedItem } from './model.ts';
import { sendWaiting, type CallFailure, type Transport, type WireAnswer } from './send.ts';
import { newItemKey, offsetFromClock, stampEntry } from './stamp.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** node:fs under the StoreDir contract: create writes a temporary file, then 1 rename. */
function nodeDir(root = mkdtempSync(path.join(tmpdir(), 'bw-file-store-'))): StoreDir & { root: string } {
  if (!dirs.includes(root)) dirs.push(root);
  let n = 0;
  return {
    root,
    list: () => readdirSync(root),
    readText: (name) => (existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), 'utf8') : null),
    readBytes: (name) => (existsSync(path.join(root, name)) ? new Uint8Array(readFileSync(path.join(root, name))) : null),
    create(name, content) {
      if (existsSync(path.join(root, name))) throw new Error(`${name} exists`);
      const tmp = path.join(root, `${TEMP_PREFIX}${process.pid}-${n++}`);
      writeFileSync(tmp, content);
      renameSync(tmp, path.join(root, name));
    },
    remove: (name) => {
      if (existsSync(path.join(root, name))) unlinkSync(path.join(root, name));
    },
    uri: (name) => `file://${path.join(root, name)}`,
  };
}

class Killed extends Error {}

/**
 * The app killed at its `at`-th durable step: a create killed mid-write leaves a half-written temporary file and no named file; a
 * remove killed leaves the file. Steps after the kill never run (the process is gone), so the faulty directory refuses them too.
 */
function killAt(inner: StoreDir & { root: string }, at: number): StoreDir & { steps: () => number } {
  let step = 0;
  const gate = () => {
    step += 1;
    if (step >= at) throw new Killed(`killed at step ${at}`);
  };
  return {
    ...inner,
    steps: () => step,
    create(name, content) {
      if (step + 1 >= at) {
        writeFileSync(path.join(inner.root, `${TEMP_PREFIX}killed-${at}`), typeof content === 'string' ? content.slice(0, 5) : content.slice(0, 1));
      }
      gate();
      inner.create(name, content);
    },
    remove(name) {
      gate();
      inner.remove(name);
    },
  };
}

const SAVED = Temporal.Instant.from('2026-11-08T15:00:00Z');
const offset = offsetFromClock({ demoNow: '2026-09-15T10:00:00-04:00[America/New_York]', realNow: '2026-11-08T15:00:01Z[UTC]', worldEpoch: 3 }, SAVED);
let n = 0;
const MARIA = 'user-maria';
const note = (o: Partial<QueuedItem> = {}): QueuedItem => ({
  ...stampEntry(offset, SAVED.add({ minutes: n++ }), newItemKey()), jobNumber: 24830, baseVersion: 3, userId: MARIA, kind: 'note', payload: { text: `note ${n}` }, ...o,
} as QueuedItem);
const photo = (): QueuedItem => ({ ...stampEntry(offset, SAVED.add({ minutes: n++ }), newItemKey()), jobNumber: 24830, baseVersion: null, userId: MARIA, kind: 'photo', contentType: 'image/jpeg' });
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const APPLIED: ItemResult = { result: 'applied', code: null, messageKey: null, values: null };
const keys = async (s: FileItemStore) => (await s.waiting()).map((i) => i.key);
const clock = () => SAVED.add({ hours: 1 }).epochMilliseconds;

/** The server: a ledger keyed by item key (section 5.1 step 3). A key it holds answers duplicate. It can lose its answers. */
function server() {
  const ledger = new Map<string, number>();
  let loseAnswers = false;
  const answer = (key: string): WireAnswer => {
    const seen = ledger.has(key);
    ledger.set(key, (ledger.get(key) ?? 0) + (seen ? 0 : 1));
    return { key, result: seen ? 'duplicate' : 'applied', code: null, messageKey: null, values: null };
  };
  const lost: CallFailure = { ok: false, stop: 'network' };
  const t: Transport = {
    async uploadBlob(i) {
      const a = answer(i.key);
      return loseAnswers ? lost : { ok: true, answer: a };
    },
    async sendItems(batch) {
      const answers = batch.map((i) => answer(i.key));
      return loseAnswers ? lost : { ok: true, answers };
    },
  };
  return { t, ledger, loseAnswers: (v: boolean) => (loseAnswers = v) };
}

describe('I1 durable before Saved, across terminate and relaunch', () => {
  it('keeps a note and a photo with its bytes, in entry order, with the clock offset and the technician, for a new store on the directory', async () => {
    const d = nodeDir();
    const s = new FileItemStore(d);
    const [a, p, b] = [note(), photo(), note()];
    await s.put(a!);
    await s.put(p, BYTES);
    await s.put(b!);
    await s.saveClockOffset(offset);
    await s.saveUser(MARIA);
    const again = new FileItemStore(nodeDir(d.root)); // the app was terminated and opened again
    expect(await keys(again)).toEqual([a!.key, p.key, b!.key]);
    expect(await again.waiting()).toEqual([a, p, b]);
    expect(await again.blob(p.key)).toEqual(BYTES);
    expect(again.blobUri(p.key)).toMatch(/^file:\/\/.*\.bin$/);
    expect(readFileSync(new URL(again.blobUri(p.key) as string))).toEqual(Buffer.from(BYTES)); // the upload reads this file
    expect(await again.clockOffset()).toEqual(offset);
    expect(await again.user()).toBe(MARIA);
  });

  it('refuses a photo without bytes, bytes for a note, empty bytes, bytes with no waiting photo, and a second item under a key', async () => {
    const s = new FileItemStore(nodeDir());
    const p = photo();
    await expect(s.put(p)).rejects.toBeInstanceOf(StoreWriteError);
    await expect(s.put(note(), BYTES)).rejects.toBeInstanceOf(StoreWriteError);
    await expect(s.put(p, new Uint8Array())).rejects.toBeInstanceOf(StoreWriteError);
    await expect(s.putBlob(p.key, BYTES)).rejects.toBeInstanceOf(StoreWriteError);
    const a = note();
    await s.put(a);
    await expect(s.put(a)).rejects.toBeInstanceOf(StoreWriteError);
    await s.markAnswered(a.key, APPLIED);
    await expect(s.put(a)).rejects.toBeInstanceOf(StoreWriteError); // an answered key is never taken again
    expect(await keys(s)).toEqual([]);
  });

  it('a put that cannot write says so (StoreWriteError) and keeps no bytes', async () => {
    const d = nodeDir();
    const s = new FileItemStore({ ...d, create: (name, c) => (name.startsWith('i-') ? (() => { throw new Error('disk full'); })() : d.create(name, c)) });
    await expect(s.put(photo(), BYTES)).rejects.toBeInstanceOf(StoreWriteError);
    expect(readdirSync(d.root)).toEqual([]);
  });
});

describe('I2 leaves only on its key\'s answer; I3 an answer replayed changes nothing; I4 entry order', () => {
  it('a try record never removes an item and keeps the order; the answer removes the item and its bytes and is listed', async () => {
    const d = nodeDir();
    const s = new FileItemStore(d);
    const [a, p] = [note(), photo()];
    await s.put(a);
    await s.put(p, BYTES);
    await s.recordTry([a.key, p.key], { atRealMs: 1, outcome: 'network' });
    await s.recordTry([a.key], { atRealMs: 2, outcome: 'refused', code: 'parts_required' });
    expect((await s.waiting()).map((i) => [i.key, i.lastTry?.outcome])).toEqual([[a.key, 'refused'], [p.key, 'network']]);
    expect(readdirSync(d.root).filter((f) => f.startsWith('i-'))).toHaveLength(2); // 1 file per item: the old revs went
    await s.markAnswered(p.key, APPLIED, 99);
    await s.markAnswered(p.key, { ...APPLIED, result: 'duplicate' }, 100); // I3
    expect(await keys(s)).toEqual([a.key]);
    expect(await s.blob(p.key)).toBeNull();
    expect(readdirSync(d.root).some((f) => f.startsWith('b-'))).toBe(false);
    expect((await s.answered()).map((x) => [x.key, x.result, x.answeredRealMs])).toEqual([[p.key, 'applied', 99]]);
    expect(await keys(new FileItemStore(nodeDir(d.root)))).toEqual([a.key]);
  });

  it('putBlob replaces the bytes of a waiting photo and keeps 1 bytes file', async () => {
    const d = nodeDir();
    const s = new FileItemStore(d);
    const p = photo();
    await s.put(p, BYTES);
    await s.putBlob(p.key, new Uint8Array([1, 2, 3]));
    expect(await new FileItemStore(nodeDir(d.root)).blob(p.key)).toEqual(new Uint8Array([1, 2, 3]));
    expect(readdirSync(d.root).filter((f) => f.startsWith('b-'))).toHaveLength(1);
  });

  // why: FR-BILL-3, F-1025 a refused finish is corrected in place under its key: 1 item file, the same place, the new payload, across a relaunch
  it('correctFinish rewrites a refused finish as a higher rev in its place, and refuses an item that is not a refused finish', async () => {
    const d = nodeDir();
    const s = new FileItemStore(d);
    const fin = { ...note(), kind: 'finished', payload: { parts: [], noPartsUsed: false, laborMinutes: 60, workDone: [] } } as QueuedItem;
    const [a, b] = [note(), note()];
    for (const i of [a, fin, b]) await s.put(i);
    const fixed = { parts: [{ partId: 'p-1', quantity: 2 }], noPartsUsed: false, laborMinutes: 60, workDone: ['Replaced the filter'] };
    await expect(s.correctFinish(fin.key, fixed)).rejects.toBeInstanceOf(StoreWriteError); // no refusal recorded yet
    await s.recordTry([a.key, fin.key], { atRealMs: 2, outcome: 'refused', code: 'parts_required' });
    await expect(s.correctFinish(a.key, fixed)).rejects.toBeInstanceOf(StoreWriteError); // a note is not a finish
    await s.correctFinish(fin.key, fixed);
    expect(readdirSync(d.root).filter((f) => f.startsWith('i-'))).toHaveLength(3);
    const w = await new FileItemStore(nodeDir(d.root)).waiting(); // the app was terminated and opened again
    expect(w.map((i) => i.key)).toEqual([a.key, fin.key, b.key]);
    const kept = w[1] as QueuedItem & { payload: unknown };
    expect([kept.payload, kept.lastTry, kept.deviceTime]).toEqual([fixed, undefined, fin.deviceTime]);
  });

  it('keeps the last ANSWERED_KEPT answers, newest first', async () => {
    const s = new FileItemStore(nodeDir());
    const all: string[] = [];
    for (let i = 0; i < ANSWERED_KEPT + 5; i++) {
      const a = note();
      all.push(a.key);
      await s.put(a);
      await s.markAnswered(a.key, APPLIED, i);
    }
    const kept = await s.answered();
    expect(kept).toHaveLength(ANSWERED_KEPT);
    expect(kept[0]?.key).toBe(all.at(-1));
    expect(kept.at(-1)?.key).toBe(all[5]);
  });

  it('keeps a damaged item file on disk, never sends it, and names it', async () => {
    const d = nodeDir();
    const s = new FileItemStore(d);
    const [a, b] = [note(), note()];
    await s.put(a);
    await s.put(b);
    const f = readdirSync(d.root).find((x) => x.includes(a.key)) as string;
    writeFileSync(path.join(d.root, f), '{"key":');
    const again = new FileItemStore(nodeDir(d.root));
    expect(await keys(again)).toEqual([b.key]);
    expect(again.damaged()).toEqual([a.key]);
    expect(existsSync(path.join(d.root, f))).toBe(true);
  });

  // why: F-1093 (owner ruling "Allow sign-out, warn") the sign-out the person confirmed removes the damaged item's files and nothing that parses
  it('discardDamaged removes only the damaged item and its files', async () => {
    const d = nodeDir();
    const s = new FileItemStore(d);
    const [a, b] = [note(), note()];
    await s.put(a);
    await s.put(b);
    const f = readdirSync(d.root).find((x) => x.includes(a.key)) as string;
    writeFileSync(path.join(d.root, f), '{"key":');
    const again = new FileItemStore(nodeDir(d.root));
    expect(again.discardDamaged()).toEqual([a.key]);
    expect(existsSync(path.join(d.root, f))).toBe(false);
    expect([again.damaged(), await keys(again)]).toEqual([[], [b.key]]);
  });

  // why: F-1093 the sync report the office reads (API-162 waitingCount) counts what the phone holds, a damaged item included
  it('a send reports the damaged item in waitingAfter', async () => {
    const d = nodeDir();
    const s = new FileItemStore(d);
    const [a, b] = [note(), note()];
    await s.put(a);
    await s.put(b);
    const f = readdirSync(d.root).find((x) => x.includes(a.key)) as string;
    writeFileSync(path.join(d.root, f), '{"key":');
    const again = new FileItemStore(nodeDir(d.root));
    const r = await sendWaiting(again, server().t, { userId: MARIA, nowMs: clock });
    expect([r.answered.map((x) => x.key), r.waitingAfter]).toEqual([[b.key], 1]);
  });
});

describe('a kill at any durable step leaves the state before or after the write (re-run semantics)', () => {
  /** Runs `write` on a fresh store over a directory killed at step `at`; returns the reopened store, or null once no step kills. */
  async function killedRun(seed: (s: FileItemStore) => Promise<void>, write: (s: FileItemStore) => Promise<void>, at: number) {
    const d = nodeDir();
    await seed(new FileItemStore(d));
    const k = killAt(d, at);
    const s = new FileItemStore({ ...k, ...{} }); // the open's own recovery is on a clean directory: no step taken
    let killed = false;
    try {
      await write(s);
    } catch (e) {
      if (!(e instanceof Killed) && !(e instanceof StoreWriteError && e.cause instanceof Killed)) throw e;
      killed = true;
    }
    const reopened = new FileItemStore(nodeDir(d.root));
    return { killed, reopened, root: d.root };
  }

  async function everyStep(seed: (s: FileItemStore) => Promise<void>, write: (s: FileItemStore) => Promise<void>, check: (s: FileItemStore, killed: boolean) => Promise<void>) {
    let runs = 0;
    for (let at = 1; at < 50; at++) {
      const { killed, reopened, root } = await killedRun(seed, write, at);
      await check(reopened, killed);
      // the reopened store converged on disk: no temporary file, no bytes nobody owns, 1 file per item
      const files = readdirSync(root);
      expect(files.filter((f) => f.startsWith(TEMP_PREFIX)), `step ${at}`).toEqual([]);
      const held = new Set((await reopened.waiting()).map((i) => i.key));
      for (const f of files.filter((x) => x.startsWith('b-'))) expect(held.has(f.slice(2, 38)), `${f} step ${at}`).toBe(true);
      const itemFiles = files.filter((x) => x.startsWith('i-'));
      expect(new Set(itemFiles.map((x) => x.slice(15, 51))).size, `step ${at}`).toBe(itemFiles.length);
      runs += 1;
      if (!killed) return runs;
    }
    throw new Error('the write never finished');
  }

  it('put of a photo: the item is there with its bytes, or not there at all', async () => {
    const p = photo();
    const runs = await everyStep(async () => undefined, (s) => s.put(p, BYTES), async (s, killed) => {
      const w = await s.waiting();
      if (w.length === 0) expect(killed).toBe(true);
      else {
        expect(w.map((i) => i.key)).toEqual([p.key]);
        expect(await s.blob(p.key)).toEqual(BYTES);
      }
    });
    expect(runs).toBeGreaterThan(2);
  });

  it('markAnswered: the item waits with its bytes, or it has left with its answer listed', async () => {
    const p = photo();
    await everyStep((s) => s.put(p, BYTES), (s) => s.markAnswered(p.key, APPLIED, 7), async (s) => {
      const waiting = await keys(s);
      const answered = (await s.answered()).map((a) => a.key);
      if (waiting.length === 1) {
        expect(answered).toEqual([]);
        expect(await s.blob(p.key)).toEqual(BYTES);
      } else {
        expect(waiting).toEqual([]);
        expect(answered).toEqual([p.key]);
        expect(await s.blob(p.key)).toBeNull();
      }
    });
  });

  it('recordTry: the item waits exactly once, with or without the new try record', async () => {
    const [a, b] = [note(), note()];
    await everyStep(async (s) => { await s.put(a); await s.put(b); }, (s) => s.recordTry([a.key, b.key], { atRealMs: 5, outcome: 'network' }), async (s) => {
      const w = await s.waiting();
      expect(w.map((i) => i.key)).toEqual([a.key, b.key]);
      for (const i of w) expect([undefined, 'network']).toContain(i.lastTry?.outcome);
    });
  });

  it('saveClockOffset and saveUser: the old value or the new one, never none', async () => {
    const newer = { ...offset, worldEpoch: 4 };
    await everyStep(async (s) => { await s.saveClockOffset(offset); await s.saveUser('a'); }, async (s) => { await s.saveClockOffset(newer); await s.saveUser('b'); }, async (s) => {
      expect([3, 4]).toContain((await s.clockOffset())?.worldEpoch);
      expect(['a', 'b']).toContain(await s.user());
    });
  });
});

describe('the send loop over the file store converges to the server\'s ledger (I3, FR-TECH-4 "exactly once")', () => {
  it('a send whose answers were lost resends after a relaunch, the server answers duplicate, and each key is held once', async () => {
    const d = nodeDir();
    const srv = server();
    const s = new FileItemStore(d);
    const items = [note(), photo(), note()];
    for (const i of items) await s.put(i, i.kind === 'photo' ? BYTES : undefined);
    srv.loseAnswers(true); // the calls commit on the server, the phone never hears
    const first = await sendWaiting(s, srv.t, { userId: MARIA, nowMs: clock });
    expect(first.stopped).toBe('network');
    expect(await keys(s)).toHaveLength(3);
    srv.loseAnswers(false);
    const relaunched = new FileItemStore(nodeDir(d.root));
    const second = await sendWaiting(relaunched, srv.t, { userId: MARIA, nowMs: clock });
    expect(second.stopped).toBeNull();
    expect(await keys(relaunched)).toEqual([]);
    // The photo went first and committed, its answer lost; it stepped aside, so the 2 notes were sent and committed too: all 3 answer duplicate now.
    expect(second.answered.map((a) => [a.key, a.result])).toEqual([[items[1]!.key, 'duplicate'], [items[0]!.key, 'duplicate'], [items[2]!.key, 'duplicate']]);
    expect([...srv.ledger.values()]).toEqual([1, 1, 1]);
    // a third send has nothing to send: the waiting list equals the ledger's complement (empty)
    const third = await sendWaiting(new FileItemStore(nodeDir(d.root)), srv.t, { userId: MARIA, nowMs: clock });
    expect(third.answered).toEqual([]);
  });
});
