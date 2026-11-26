// SPDX-License-Identifier: AGPL-3.0-or-later
// The phone item store and its send loop (SPECIFICATIONS section 4.6, section 5.1 steps 1, 2 and 10; UI-SPECIFICATION
// 4.5; model.ts invariants I1 to I5) on DexieItemStore over fake-indexeddb, with a scripted transport. Reopening the
// store under the same database name is the page reload and the closed app: a fresh Dexie instance reads only what
// committed. The real browsers (WebKit and Chromium, a closed context) run the same store in ci/gates/G-CI1/client.
import { IDBFactory, IDBKeyRange, IDBTransaction } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ITEMS_PER_BATCH } from '../../../api/src/contracts/tech.ts';
import { fromWire, Temporal } from '@bw/time';
import { DexieItemStore } from './dexie-store.ts';
import { hasOldItem, ITEMS_PER_SEND, OLD_ITEM_MS, StoreWriteError, type QueuedItem } from './model.ts';
import { SYNC_CALL_LIMIT_MS, uploadLimitMs } from './engine.ts';
import { sendWaiting, type CallFailure, type Transport, type WireAnswer } from './send.ts';
import { uploadAnswer } from './wire.ts';
import { newItemKey, offsetFromClock, stampEntry } from './stamp.ts';

let factory = new IDBFactory();
const open: DexieItemStore[] = [];
const store = (name = 'items') => {
  const s = new DexieItemStore(name, { indexedDB: factory, IDBKeyRange });
  open.push(s);
  return s;
};
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  factory = new IDBFactory();
});

const SAVED = Temporal.Instant.from('2026-11-08T15:00:00Z');
const offset = offsetFromClock(
  { demoNow: '2026-09-15T10:00:00-04:00[America/New_York]', realNow: '2026-11-08T15:00:01Z[UTC]', worldEpoch: 3 }, SAVED);
let n = 0;
const MARIA = 'user-maria';
const note = (o: Partial<QueuedItem> = {}, minutes = n++): QueuedItem => ({
  ...stampEntry(offset, SAVED.add({ minutes }), newItemKey()),
  jobNumber: 24830, baseVersion: 3, userId: MARIA, kind: 'note', payload: { text: `note ${minutes}` }, ...o,
} as QueuedItem);
const photo = (): QueuedItem => ({ ...stampEntry(offset, SAVED.add({ minutes: n++ }), newItemKey()), jobNumber: 24830, baseVersion: null, userId: MARIA, kind: 'photo', contentType: 'image/jpeg' });
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

type Script = (items: readonly QueuedItem[]) => { ok: true; answers: WireAnswer[] } | CallFailure;
const ok = (key: string, result = 'applied', extra: Partial<WireAnswer> = {}): WireAnswer => ({ key, result, code: null, messageKey: null, values: null, ...extra });
function transport(items: Script, blob: (i: QueuedItem) => { ok: true; answer: WireAnswer } | CallFailure = (i) => ({ ok: true, answer: ok(i.key) })) {
  const calls: string[] = [];
  const t: Transport = {
    async uploadBlob(i, bytes) {
      calls.push(`blob ${i.key} ${bytes.byteLength}`);
      return blob(i);
    },
    async sendItems(batch) {
      calls.push(`items ${batch.map((b) => b.key).join(',')}`);
      return items(batch);
    },
  };
  return { t, calls };
}
const all: Script = (b) => ({ ok: true, answers: b.map((i) => ok(i.key)) });
const clock = () => SAVED.add({ hours: 1 }).epochMilliseconds;

describe('the stamp of an entry (section 5.1 step 1, FR-DEMO-9)', () => {
  // why: FR-TECH-4 every item carries the key, the world epoch and the 3 times the server re-bases it from
  it('stamps the device time, the save time, the time since the save and the derived demo time from 1 API-10 read', () => {
    const s = stampEntry(offset, SAVED.add({ minutes: 41 }), newItemKey(() => '0E8B5B5C-6C7D-4F1A-9B2C-3D4E5F607182'));
    expect(s).toEqual({
      key: '0e8b5b5c-6c7d-4f1a-9b2c-3d4e5f607182', worldEpoch: 3,
      deviceTime: '2026-11-08T10:41:00-05:00[America/New_York]', offsetSavedReal: '2026-11-08T10:00:01-05:00[America/New_York]',
      sinceSaveMs: 41 * 60_000, demoTime: '2026-09-15T10:41:00-04:00[America/New_York]', enteredRealMs: SAVED.add({ minutes: 41 }).epochMilliseconds,
    });
    expect(fromWire(s.demoTime).epochMilliseconds - fromWire(s.deviceTime).epochMilliseconds).toBe(offset.demoMinusRealMs);
    expect(() => newItemKey(() => 'not-a-uuid')).toThrow(/UUID v4/);
  });
  // why: SD-16 the batch size is the contract's
  it('sends at most the contract\'s 50 items per call', () => {
    expect(ITEMS_PER_SEND).toBe(MAX_ITEMS_PER_BATCH);
  });
});

describe('I1 durable before Saved: the store keeps what it said it kept (FR-TECH-4)', () => {
  // why: F-954 I1's timing: put() resolves only after its transaction has committed, so a screen that waits for it says Saved only for a kept item
  it('holds put() pending while its transaction has not completed, and resolves it once the transaction completes', async () => {
    const s = store();
    await s.waiting(); // the database is open before the gate goes on
    const proto = IDBTransaction.prototype as unknown as { dispatchEvent(e: Event): boolean };
    const real = proto.dispatchEvent;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let held = 0;
    proto.dispatchEvent = function (this: unknown, e: Event) {
      if (e.type !== 'complete') return real.call(this, e);
      held += 1;
      void gate.then(() => real.call(this, e));
      return true;
    };
    try {
      const nt = note();
      let done = false;
      const put = s.put(nt).then(() => { done = true; });
      await new Promise((r) => setTimeout(r, 50));
      // the write is in a transaction that has not completed (Dexie may hold more than 1): put() still waits
      expect([held > 0, done]).toEqual([true, false]);
      release();
      await put;
      expect(done).toBe(true);
      expect((await s.waiting()).map((i) => i.key)).toEqual([nt.key]);
    } finally {
      proto.dispatchEvent = real;
    }
  });

  // why: FR-TECH-4, UC-03 a note and a photo saved with no signal are there after the app closes and opens again
  it('keeps a note and a photo with its bytes across a close and a reopen, in entry order, with the clock offset', async () => {
    const a = store();
    const nt = note();
    const ph = photo();
    await a.put(nt);
    await a.put(ph, BYTES);
    await a.saveClockOffset(offset);
    await a.saveUser(MARIA);
    a.close();
    const b = store();
    expect((await b.waiting()).map((i) => i.key)).toEqual([nt.key, ph.key]);
    expect(await b.blob(ph.key)).toEqual(BYTES);
    expect(await b.clockOffset()).toEqual(offset);
    expect(await b.user()).toBe(MARIA);
  });
  // why: FR-TECH-4 a photo is never kept without its bytes, nor bytes without their item; a key is kept once
  it('refuses a photo without bytes, bytes for a note, bytes with no waiting item, and a second item under a key', async () => {
    const s = store();
    await expect(s.put(photo())).rejects.toBeInstanceOf(StoreWriteError);
    await expect(s.put(note(), BYTES)).rejects.toBeInstanceOf(StoreWriteError);
    await expect(s.putBlob(newItemKey(), BYTES)).rejects.toBeInstanceOf(StoreWriteError);
    const nt = note();
    await s.put(nt);
    await expect(s.put({ ...nt, payload: { text: 'other' } } as QueuedItem)).rejects.toBeInstanceOf(StoreWriteError);
    expect((await s.waiting()).map((i) => i.key)).toEqual([nt.key]);
    const ph = photo();
    await s.put(ph, BYTES);
    await s.putBlob(ph.key, new Uint8Array([1, 2, 3]));
    expect(await s.blob(ph.key)).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('I2 an item leaves only on its key\'s answer (UI-SPECIFICATION 4.5 rules 1 and 10)', () => {
  // why: FR-TECH-4, F-562 applied, duplicate, flagged (validation_failed, not_found), history_only and world_reset remove; refused stays
  it('removes the 5 answered results with their messages kept, and keeps a refused finish with its code', async () => {
    const s = store();
    const items = [note(), note(), note(), note(), note(), note(), note()];
    for (const i of items) await s.put(i);
    const results: WireAnswer[] = [
      ok(items[0]!.key), ok(items[1]!.key, 'duplicate'),
      ok(items[2]!.key, 'flagged', { code: 'validation_failed', messageKey: 'tech.item.flagged.validation_failed', values: { job: 24830 } }),
      ok(items[3]!.key, 'flagged', { code: 'not_found', messageKey: 'tech.item.flagged.not_found', values: { job: 999999 } }),
      ok(items[4]!.key, 'history_only', { messageKey: 'tech.item.historyOnly' }), ok(items[5]!.key, 'world_reset', { messageKey: 'tech.item.worldReset' }),
      ok(items[6]!.key, 'refused', { code: 'parts_required', messageKey: 'error.parts_required' }),
    ];
    const { t } = transport(() => ({ ok: true, answers: results }));
    const r = await sendWaiting(s, t, { userId: MARIA, nowMs: clock });
    expect(r.answered.map((a) => a.result)).toEqual(['applied', 'duplicate', 'flagged', 'flagged', 'history_only', 'world_reset']);
    expect(r.waitingAfter).toBe(1);
    const [left] = await s.waiting();
    expect([left?.key, left?.lastTry]).toEqual([items[6]!.key, { atRealMs: clock(), outcome: 'refused', code: 'parts_required', messageKey: 'error.parts_required' }]);
    expect((await s.answered()).map((a) => [a.code, a.messageKey]).slice(2, 4)).toEqual([['not_found', 'tech.item.flagged.not_found'], ['validation_failed', 'tech.item.flagged.validation_failed']]);
  });
  // why: FR-BILL-3, F-1025 a finish the server refused (parts_required) is corrected in place under its key: it never leaves, keeps its
  // place in entry order across a reopen, and the corrected payload is what the next send carries and the answer removes
  it('corrects a refused finish under its key, in its place, and the next send carries the correction', async () => {
    const s = store('fix');
    const first = note();
    const fin = { ...note(), kind: 'finished', payload: { parts: [], noPartsUsed: false, laborMinutes: 60, workDone: [] } } as QueuedItem;
    const last = note();
    for (const i of [first, fin, last]) await s.put(i);
    const fixed = { parts: [{ partId: 'p-1', quantity: 2 }], noPartsUsed: false, laborMinutes: 60, workDone: ['Replaced the filter'] };
    // Not refused yet: nothing to correct.
    await expect(s.correctFinish(fin.key, fixed)).rejects.toBeInstanceOf(StoreWriteError);
    await sendWaiting(s, transport((b) => ({ ok: true, answers: b.map((i) => (i.key === fin.key ? ok(i.key, 'refused', { code: 'parts_required', messageKey: 'error.parts_required' }) : ok(i.key, 'refused', { code: 'validation_failed' }))) })).t, { userId: MARIA, nowMs: clock });
    await expect(s.correctFinish(first.key, fixed)).rejects.toBeInstanceOf(StoreWriteError); // a note is not a finish
    await expect(s.correctFinish(newItemKey(), fixed)).rejects.toBeInstanceOf(StoreWriteError); // no such item waits
    await s.correctFinish(fin.key, fixed);
    const again = store('fix'); // the page reloaded
    const w = await again.waiting();
    expect(w.map((i) => i.key)).toEqual([first.key, fin.key, last.key]);
    const kept = w[1] as QueuedItem & { payload: unknown };
    expect([kept.payload, kept.lastTry, kept.deviceTime]).toEqual([fixed, undefined, fin.deviceTime]);
    const sent: unknown[] = [];
    await sendWaiting(again, transport((b) => {
      sent.push(...b.filter((i) => i.key === fin.key).map((i) => (i as QueuedItem & { payload: unknown }).payload));
      return { ok: true, answers: b.map((i) => ok(i.key)) };
    }).t, { userId: MARIA, nowMs: clock });
    expect(sent).toEqual([fixed]);
    expect(await again.waiting()).toEqual([]);
  });
  // why: F-995 (F-931) API-103 answers a photo the phone cannot fix flagged with its code; the wire mapping passes both through and the photo leaves the queue flagged
  it('uploadAnswer passes a 200 flagged answer and its code through, and the shared send loop removes the photo as flagged with that code', async () => {
    const s = store();
    const p = photo();
    await s.put(p, BYTES);
    const body = { data: { key: p.key, result: 'flagged', code: 'validation_failed', messageKey: 'tech.item.flagged.validation_failed', values: { job: 24830 } } };
    const got = uploadAnswer(200, body);
    expect(got).toEqual({ ok: true, answer: body.data });
    const { t } = transport(() => ({ ok: true, answers: [] }), () => uploadAnswer(200, body));
    const r = await sendWaiting(s, t, { userId: MARIA, nowMs: clock });
    expect(r.waitingAfter).toBe(0);
    expect(r.answered.map((a) => [a.key, a.result, a.code])).toEqual([[p.key, 'flagged', 'validation_failed']]);
    expect((await s.answered()).map((a) => [a.result, a.code])).toEqual([['flagged', 'validation_failed']]);
  });
  // why: FR-TECH-4, UC-03 no signal, a 5xx or a lost session leaves every item waiting for the next send
  it('keeps every item through a network error, a 5xx and a signed-out answer, and stops the send at the first', async () => {
    for (const stop of ['server_error', 'signed_out', 'forbidden'] as const) {
      const s = store(`stop-${stop}`);
      const ph = photo();
      await s.put(ph, BYTES);
      await s.put(note());
      const { t, calls } = transport(all, () => ({ ok: false, stop }));
      const r = await sendWaiting(s, t, { userId: MARIA, nowMs: clock });
      expect([r.stopped, r.answered, r.waitingAfter, calls.length]).toEqual([stop, [], 2, 1]);
      expect((await s.waiting()).map((i) => i.lastTry?.outcome)).toEqual([stop, stop]);
    }
  });
  // why: FR-TECH-4 an item the server did not answer, and an upload refused whole, wait; the send goes on past them
  it('keeps a key the batch did not answer and a photo refused with a 4xx, and still sends the rest', async () => {
    const s = store();
    const ph = photo();
    const [a, b] = [note(), note()];
    await s.put(ph, BYTES);
    await s.put(a);
    await s.put(b);
    const { t } = transport((batch) => ({ ok: true, answers: [ok(batch[0]!.key)] }), () => ({ ok: false, stop: null, status: 404, code: 'not_found' }));
    const r = await sendWaiting(s, t, { userId: MARIA, nowMs: clock });
    expect(r.answered.map((x) => x.key)).toEqual([a.key]);
    expect((await s.waiting()).map((i) => [i.key, i.lastTry?.outcome, i.lastTry?.code])).toEqual([[ph.key, 'refused', 'not_found'], [b.key, 'unanswered', undefined]]);
  });
  // why: F-1035 a photo the proxy refused for its size (413) is sent once more with no bytes under its key, leaves with the server's flagged answer, and its bytes are never sent again
  it('answers a photo refused with 413 by 1 no-bytes upload under its key, and never sends its bytes again', async () => {
    const s = store();
    const ph = photo();
    await s.put(ph, BYTES);
    const { t, calls } = transport(all, (i) => ({ ok: true, answer: ok(i.key, 'flagged', { code: 'validation_failed', messageKey: 'tech.item.flagged.validation_failed' }) }));
    const sized: Transport = { ...t, uploadBlob: async (i, bytes) => (bytes.byteLength > 0 ? (calls.push(`blob ${i.key} ${bytes.byteLength}`), { ok: false, stop: null, status: 413, code: 'http_413' }) : t.uploadBlob(i, bytes)) };
    const r = await sendWaiting(s, sized, { userId: MARIA, nowMs: clock });
    await sendWaiting(s, sized, { userId: MARIA, nowMs: clock });
    expect(calls).toEqual([`blob ${ph.key} ${BYTES.byteLength}`, `blob ${ph.key} 0`]);
    expect(r.answered.map((x) => [x.key, x.result, x.code])).toEqual([[ph.key, 'flagged', 'validation_failed']]);
    expect(await s.waiting()).toHaveLength(0);
  });
  // why: F-1746 an upload's time limit grows with its bytes, so a 10 MB photo on a slow line (32 KB/s) still finishes and an empty body ends like a read
  it('limits an upload to the call limit plus its bytes at 32 KB/s', () => {
    expect([uploadLimitMs(0), uploadLimitMs(10 * 1024 * 1024)]).toEqual([SYNC_CALL_LIMIT_MS, SYNC_CALL_LIMIT_MS + 327_680]);
  });
  // why: F-1764 a photo with no answer must not hold the notes behind it, and it stays waiting under its key for the next send
  it('sends the notes and statuses past a photo that got no answer, keeps the photo, and stops for the network only when they fail too', async () => {
    const s = store();
    const ph = photo();
    const [a, b] = [note(), note()];
    for (const i of [ph, a, b]) await s.put(i, i === ph ? BYTES : undefined);
    const { t, calls } = transport(all, () => ({ ok: false, stop: 'network' }));
    const r = await sendWaiting(s, t, { userId: MARIA, nowMs: clock });
    expect(calls).toEqual([`blob ${ph.key} ${BYTES.byteLength}`, `items ${a.key},${b.key}`]);
    expect([r.stopped, r.answered.map((x) => x.key)]).toEqual([null, [a.key, b.key]]);
    expect((await s.waiting()).map((i) => [i.key, i.lastTry?.outcome])).toEqual([[ph.key, 'network']]);
    const down = transport(() => ({ ok: false, stop: 'network' }), () => ({ ok: false, stop: 'network' }));
    const s2 = store('down');
    for (const i of [ph, a, b]) await s2.put(i, i === ph ? BYTES : undefined);
    const r2 = await sendWaiting(s2, down.t, { userId: MARIA, nowMs: clock });
    expect([r2.stopped, r2.waitingAfter, (await s2.waiting()).map((i) => i.lastTry?.outcome)]).toEqual(['network', 3, ['network', 'network', 'network']]);
  });
  // why: F-1764 a photo alone with no answer still ends the send for the network, so the screen says No signal
  it('stops for the network when the only waiting item is a photo with no answer', async () => {
    const s = store();
    await s.put(photo(), BYTES);
    const { t } = transport(all, () => ({ ok: false, stop: 'network' }));
    expect((await sendWaiting(s, t, { userId: MARIA, nowMs: clock })).stopped).toBe('network');
  });
  // why: F-1765 a 413 whose no-bytes follow-up got no answer stays on the photo, so the next send sends no bytes at once and the bytes never go again
  it('keeps a 413 across a network stop of the no-bytes try and sends no bytes at once on the next send', async () => {
    const s = store();
    const ph = photo();
    await s.put(ph, BYTES);
    const calls: string[] = [];
    let line: 'up' | 'down' = 'down';
    const t: Transport = {
      sendItems: async () => ({ ok: true, answers: [] }),
      uploadBlob: async (i, bytes) => {
        calls.push(`blob ${bytes.byteLength}`);
        if (bytes.byteLength > 0) return { ok: false, stop: null, status: 413, code: 'http_413' };
        return line === 'down' ? { ok: false, stop: 'network' } : { ok: true, answer: ok(i.key, 'flagged', { code: 'validation_failed' }) };
      },
    };
    await sendWaiting(s, t, { userId: MARIA, nowMs: clock });
    expect((await s.waiting()).map((i) => [i.lastTry?.outcome, i.lastTry?.code])).toEqual([['network', 'http_413']]);
    await sendWaiting(s, t, { userId: MARIA, nowMs: clock }); // still down: no bytes again, the 413 stays
    expect((await s.waiting()).map((i) => i.lastTry?.code)).toEqual(['http_413']);
    line = 'up';
    const r = await sendWaiting(s, t, { userId: MARIA, nowMs: clock });
    expect(calls).toEqual([`blob ${BYTES.byteLength}`, 'blob 0', 'blob 0', 'blob 0']);
    expect(r.answered.map((x) => x.key)).toEqual([ph.key]);
  });
  // why: F-1765 an item stored by the shape before this change still opens and sends, and one stored refused with the 413 sends no bytes at once
  it('opens an item stored with the earlier last-try shape and sends bytes first, or no bytes when it holds the 413', async () => {
    const s = store('old-shape');
    const [plain, big] = [photo(), photo()];
    await s.put({ ...plain, lastTry: { atRealMs: 1, outcome: 'network' } }, BYTES);
    await s.put({ ...big, lastTry: { atRealMs: 1, outcome: 'refused', code: 'http_413' } }, BYTES);
    const again = store('old-shape');
    expect((await again.waiting()).map((i) => i.lastTry?.outcome)).toEqual(['network', 'refused']);
    const { t, calls } = transport(all);
    await sendWaiting(again, t, { userId: MARIA, nowMs: clock });
    expect(calls).toEqual([`blob ${plain.key} ${BYTES.byteLength}`, `blob ${big.key} 0`]);
  });
  // why: F-1035 the no-bytes try is made once: when it fails too the photo waits with that failure, and the next send starts over
  it('keeps a photo refused with 413 when its no-bytes upload fails too, with that failure as its last try', async () => {
    const s = store();
    const ph = photo();
    await s.put(ph, BYTES);
    const { t, calls } = transport(all, () => ({ ok: false, stop: null, status: 413, code: 'http_413' }));
    const r = await sendWaiting(s, t, { userId: MARIA, nowMs: clock });
    expect([calls, r.answered]).toEqual([[`blob ${ph.key} ${BYTES.byteLength}`, `blob ${ph.key} 0`], []]);
    expect((await s.waiting()).map((i) => [i.key, i.lastTry?.outcome, i.lastTry?.code])).toEqual([[ph.key, 'refused', 'http_413']]);
  });
});

describe('I3 replay is idempotent, I4 entry order, I5 own items only (section 5.1 steps 2 and 3)', () => {
  // why: UC-03 a send whose answer was lost is sent again under the same keys and answered duplicate; the store converges
  it('resends after a lost answer, removes on the duplicate answer, and ignores an answer for a key no longer waiting', async () => {
    const s = store();
    const items = [note(), note()];
    for (const i of items) await s.put(i);
    const server = new Set<string>();
    let lose = true;
    const { t, calls } = transport((batch) => {
      const answers = batch.map((i) => ok(i.key, server.has(i.key) ? 'duplicate' : 'applied'));
      for (const i of batch) server.add(i.key);
      if (lose) { lose = false; return { ok: false, stop: 'network' }; }
      return { ok: true, answers };
    });
    expect((await sendWaiting(s, t, { userId: MARIA, nowMs: clock })).waitingAfter).toBe(2);
    const second = await sendWaiting(s, t, { userId: MARIA, nowMs: clock });
    expect([second.answered.map((a) => a.result), second.waitingAfter, server.size]).toEqual([['duplicate', 'duplicate'], 0, 2]);
    await s.markAnswered(items[0]!.key, { result: 'applied', code: null, messageKey: null, values: null });
    expect((await s.answered()).length).toBe(2);
    expect((await sendWaiting(s, t, { userId: MARIA, nowMs: clock })).answered).toEqual([]);
    expect(calls).toHaveLength(2);
  });
  // why: FR-TECH-4 blobs go first by API-103, then the items in entry order, at most 50 per call
  it('uploads photos first, then sends 120 notes in entry order as 50, 50 and 20', async () => {
    const s = store();
    const notes = Array.from({ length: 120 }, () => note());
    const ph = photo();
    await s.put(notes[0]!);
    await s.put(ph, BYTES);
    for (const i of notes.slice(1)) await s.put(i);
    const { t, calls } = transport(all);
    const r = await sendWaiting(s, t, { userId: MARIA, nowMs: clock });
    expect(calls.map((c) => (c.startsWith('blob') ? c : c.split(',').length))).toEqual([`blob ${ph.key} 4`, 50, 50, 20]);
    expect(r.answered.slice(1).map((a) => a.key)).toEqual(notes.map((i) => i.key));
    expect(r.waitingAfter).toBe(0);
  });
  // why: FR-TECH-4 (UI-SPECIFICATION 4.5 rule 4) another technician's items are never sent under this session; they wait for theirs
  it('sends only the signed-in technician\'s items and keeps another technician\'s waiting', async () => {
    const s = store();
    const mine = note();
    const theirs = note({ userId: 'user-kevin' });
    await s.put(theirs);
    await s.put(mine);
    const { t, calls } = transport(all);
    const r = await sendWaiting(s, t, { userId: MARIA, nowMs: clock });
    expect([calls, r.waitingAfter]).toEqual([[`items ${mine.key}`], 1]);
    expect((await s.waiting())[0]?.key).toBe(theirs.key);
  });
});

describe('the waiting count and the 24-hour banner (FR-TECH-7)', () => {
  // why: FR-TECH-7 3 offline items show 3 waiting; the banner follows the device's real time since entry, never the demo clock
  it('counts 3 waiting, and shows the banner only once an item has waited over 24 hours of device time', async () => {
    const s = store();
    for (let i = 0; i < 3; i++) await s.put(note({}, 0));
    const w = await s.waiting();
    expect(w).toHaveLength(3);
    const entered = w[0]!.enteredRealMs;
    expect(hasOldItem(w, entered + OLD_ITEM_MS)).toBe(false);
    expect(hasOldItem(w, entered + 25 * 60 * 60 * 1000)).toBe(true);
    // The demo time is not read: the same items under an offset 2 days ahead are judged the same.
    expect(hasOldItem(w.map((x) => ({ ...x, demoTime: '2026-09-17T10:00:00-04:00[America/New_York]' })), entered + OLD_ITEM_MS)).toBe(false);
  });
});
