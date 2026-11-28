// SPDX-License-Identifier: AGPL-3.0-or-later
// The web app's item engine and transport (engine.ts, transport.ts; SPECIFICATIONS section 5.1 steps 1 and 2, SD-47;
// UI-SPECIFICATION 4.5) over the real store (DexieItemStore on fake-indexeddb) and the real typed @bw/api client, whose
// fetch is a scripted server answering the real contract shapes. The browsers and the real server run the same engine in
// ci/gates/G-CI1/client (the stack suite).
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createClient, PROBLEM_TYPE_PREFIX } from '@bw/api';
import { DexieItemStore, type QueuedItem } from '@bw/outbox/src/items/index.ts';
import { Temporal } from '@bw/time';
import { describe, expect, it } from 'vitest';
import { FinishLeave, signatureOwed, NotReadyError, TechOutbox, type EngineDeps } from './engine.ts';
import { webTransport, wireItem } from './transport.ts';

const ORIGIN = 'http://phone.test';
const meta = (contract: string) => ({ contract, worldEpoch: 2, demoNow: '2026-09-15T10:00:00-04:00[America/New_York]', viewer: { kind: 'public' }, labels: [] });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Server {
  calls: string[];
  down: boolean;
  status: Record<string, number>;
  /** A server that accepts and never answers (F-1482). */
  hang: boolean;
  /** F-1746: the next call of each of these accepts and never answers, whatever its signal says (the limit cannot lean on the abort). */
  hangOnce: Set<string>;
  /** F-1035: the proxy's body cap for an upload: a larger body is answered 413 by nginx (an HTML page) before the server reads it. */
  proxyCapBytes: number | null;
  /** The byte length of every upload body, in order. */
  uploads: number[];
  items: Map<string, unknown>;
}

function world(start = Temporal.Instant.from('2026-11-08T15:00:00Z'), joinLimitMs?: number, callLimitMs?: number, lock?: EngineDeps['lock']) {
  const server: Server = { calls: [], down: false, hang: false, hangOnce: new Set(), proxyCapBytes: null, uploads: [], status: {}, items: new Map() };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const what = `${init?.method ?? 'GET'} ${url.pathname}`;
    server.calls.push(what);
    if (server.down) throw new TypeError('fetch failed');
    if (server.hang) await new Promise<void>(() => undefined);
    if (server.hangOnce.delete(what)) await new Promise<void>(() => undefined);
    const forced = server.status[what];
    if (forced) {
      const code = forced === 401 ? 'unauthenticated' : 'server_error';
      return json(forced, { type: `${PROBLEM_TYPE_PREFIX}${code}`, title: `error.${code}`, status: forced, code, meta: { contract: 'API-102', worldEpoch: 2, demoNow: 'x' } });
    }
    switch (what) {
      case 'GET /api/v1/me':
        return json(200, { data: { userId: 'u-maria', name: 'Maria Santos', role: 'technician', skill: null, branch: 'columbus', employeeNumber: '1042', language: 'en', slashShortcut: 'on', permissions: [] }, meta: meta('API-07') });
      case 'GET /api/v1/clock':
        return json(200, { data: { demoNow: '2026-09-15T10:00:00-04:00[America/New_York]', realNow: '2026-11-08T15:00:00Z[UTC]', rate: 1, paused: false, worldEpoch: 2, lastMove: null, replay: { running: false, done: 0, total: 0 }, resetAvailableInSeconds: 0 }, meta: meta('API-10') });
      case 'POST /api/v1/tech/sync-reports':
        server.items.set('report', JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      case 'POST /api/v1/tech/items': {
        const sent = (JSON.parse(String(init?.body)) as { items: { key: string }[] }).items;
        const answers = sent.map((i) => {
          const dup = server.items.has(i.key);
          server.items.set(i.key, i);
          return { key: i.key, result: dup ? 'duplicate' : 'applied', code: null, messageKey: null, values: null };
        });
        return json(200, { data: { items: answers }, meta: meta('API-102') });
      }
    }
    if (what.startsWith('PUT /api/v1/tech/photos/')) {
      const key = url.pathname.split('/').at(-1)!;
      const size = (init?.body as Uint8Array).byteLength;
      server.uploads.push(size);
      if (server.proxyCapBytes !== null && size > server.proxyCapBytes) {
        return new Response('<html><head><title>413 Request Entity Too Large</title></head></html>', { status: 413, headers: { 'content-type': 'text/html' } });
      }
      if (size === 0) {
        // API-103 with no bytes: flagged validation_failed under the key, listed for the dispatcher (F-978).
        server.items.set(key, { query: Object.fromEntries(url.searchParams), bytes: 0, flagged: true });
        return json(200, { data: { key, result: 'flagged', code: 'validation_failed', messageKey: 'tech.item.flagged.validation_failed', values: { job: 24830 } }, meta: meta('API-103') });
      }
      server.items.set(key, { query: Object.fromEntries(url.searchParams), bytes: (init?.body as Uint8Array).byteLength, type: (init?.headers as Record<string, string>)['content-type'] });
      return json(200, { data: { key, result: 'applied', code: null, messageKey: null, values: null }, meta: meta('API-103') });
    }
    return json(404, {});
  };
  const limit = callLimitMs !== undefined ? { timeoutMs: callLimitMs } : {};
  const client = createClient({ baseUrl: ORIGIN, fetch, ...limit });
  const store = new DexieItemStore('engine', { indexedDB: new IDBFactory(), IDBKeyRange });
  let now = start;
  let online = true;
  const engine = new TechOutbox({
    store, client, transport: webTransport(client, { baseUrl: ORIGIN, fetch, ...(callLimitMs !== undefined ? { limitMs: () => callLimitMs } : {}) }),
    deviceNow: () => now, bannerNow: () => now.epochMilliseconds, isOnline: () => online, device: 'Web app',
    ...(joinLimitMs !== undefined ? { joinLimitMs } : {}), ...(lock ? { lock } : {}),
  });
  return {
    server, store, engine,
    advance: (minutes: number) => { now = now.add({ minutes }); },
    setOnline: (v: boolean) => { online = v; },
  };
}

/** A buffer that starts as a JPEG does (SOI and a marker): the send sends a JPEG's bytes as they are (job/photo.ts uploadBody). */
const jpegOf = (n: number) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };

describe('entry (section 5.1 step 1)', () => {
  // why: FR-TECH-4 an item is stamped from the offset of the last API-10 read with signal, and refused before any read when there is no signal
  it('refuses an entry before the first sync with no signal, then stamps it from the saved offset, keeps it, and sends it at once', async () => {
    const w = world();
    w.setOnline(false);
    await expect(w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'note', payload: { text: 'Flame sensor cleaned' } } })).rejects.toBeInstanceOf(NotReadyError);
    w.setOnline(true);
    await w.engine.sync();
    expect(w.server.calls).toEqual(['GET /api/v1/me', 'POST /api/v1/tech/sync-reports', 'GET /api/v1/clock']);
    w.advance(41);
    w.setOnline(false);
    const it1 = await w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'note', payload: { text: 'Flame sensor cleaned' } } });
    expect(it1).toMatchObject({ userId: 'u-maria', worldEpoch: 2, sinceSaveMs: 41 * 60_000, demoTime: '2026-09-15T10:41:00-04:00[America/New_York]' });
    expect((await w.store.waiting()).map((i) => i.key)).toEqual([it1.key]);
    expect(w.engine.snapshot.waiting).toHaveLength(1);
    w.setOnline(true);
    await w.engine.sync();
    expect(w.server.items.get(it1.key)).toEqual(wireItem(it1));
    expect([w.engine.snapshot.waiting.length, w.engine.snapshot.lastSent.map((a) => a.key)]).toEqual([0, [it1.key]]);
    expect(w.server.items.get('report')).toMatchObject({ app: 'web', waitingCount: 0, device: 'Web app' });
  });
  // why: F-1469, FR-TECH-4 a tap made online while the first sync still runs joins it and is kept once, stamped at the tap time
  it('joins the first sync when online with no offset, then keeps the item once under the tap time', async () => {
    const w = world();
    const first = w.engine.sync();
    w.advance(0);
    const entering = w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'note', payload: { text: 'On my way' } } });
    w.advance(1);
    const it1 = await entering;
    await first;
    expect(it1).toMatchObject({ userId: 'u-maria', worldEpoch: 2, enteredRealMs: Temporal.Instant.from('2026-11-08T15:00:00Z').epochMilliseconds });
    expect(w.server.calls.filter((c) => c === 'GET /api/v1/me').length).toBeGreaterThanOrEqual(1);
    await w.engine.sync();
    expect(w.engine.snapshot.waiting).toHaveLength(0);
    expect([...w.server.items.keys()].filter((k) => k === it1.key)).toEqual([it1.key]);
    expect(w.server.calls.filter((c) => c === 'POST /api/v1/tech/items')).toHaveLength(1);
  });
  // why: F-1469 when the joined first sync fails, the entry is still refused with no_clock and nothing is kept
  it('still refuses with no_clock when the joined first sync fails', async () => {
    const w = world();
    w.server.down = true;
    const first = w.engine.sync();
    await expect(w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'note', payload: { text: 'x' } } })).rejects.toMatchObject({ reason: 'no_clock' });
    await first;
    expect(await w.store.waiting()).toHaveLength(0);
  });
  // why: F-1482 a first sync that never answers does not hold the entry for ever: it is refused with no_clock after the limit, so the screen shows its Connect-once notice
  it('refuses with no_clock after the join limit when the first sync never answers', async () => {
    const w = world(undefined, 50);
    w.server.hang = true;
    await expect(w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'note', payload: { text: 'x' } } })).rejects.toMatchObject({ reason: 'no_clock' });
    expect(await w.store.waiting()).toHaveLength(0);
  });
  // why: FR-TECH-4 a photo travels by API-103 with its facts in the query and its bytes as the body, before any item
  it('uploads a photo with its facts and bytes before the note entered before it', async () => {
    const w = world();
    await w.engine.sync();
    w.setOnline(false);
    const nt = await w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'note', payload: { text: 'Hose cracked' } } });
    const ph = await w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'photo', contentType: 'image/jpeg' }, blob: jpegOf(2048) });
    expect(ph.baseVersion).toBeNull();
    w.server.calls.length = 0;
    w.setOnline(true);
    await w.engine.sync();
    expect(w.server.calls.filter((c) => c.includes('/tech/'))).toEqual([`PUT /api/v1/tech/photos/${ph.key}`, 'POST /api/v1/tech/items', 'POST /api/v1/tech/sync-reports']);
    expect(w.server.items.get(ph.key)).toEqual({
      query: { kind: 'photo', jobNumber: '24830', worldEpoch: '2', deviceTime: ph.deviceTime, offsetSavedReal: ph.offsetSavedReal, sinceSaveMs: String(ph.sinceSaveMs), demoTime: ph.demoTime },
      bytes: 2048, type: 'image/jpeg',
    });
    expect(w.server.items.has(nt.key)).toBe(true);
  });
});

describe('sending and the connection state (section 5.1 step 2, SD-47; CTL-CMP-10-01)', () => {
  // why: FR-TECH-4, UC-03 with no signal nothing is called and everything waits; a failed call shows No signal; it sends once back
  it('calls nothing while offline, shows No signal after a network failure, and sends each item once when the signal returns', async () => {
    const w = world();
    await w.engine.sync();
    w.setOnline(false);
    const a = await w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'arrived' } });
    w.server.calls.length = 0;
    expect(await w.engine.sync()).toBeNull();
    expect([w.server.calls, w.engine.snapshot.online]).toEqual([[], false]);
    w.setOnline(true);
    w.server.down = true;
    await w.engine.sync();
    expect([w.engine.snapshot.online, w.engine.snapshot.waiting.length]).toEqual([false, 1]);
    w.server.down = false;
    await w.engine.sync();
    await w.engine.sync();
    expect([w.engine.snapshot.online, w.engine.snapshot.waiting.length, [...w.server.items.keys()].filter((k) => k === a.key)]).toEqual([true, 0, [a.key]]);
  });
  // why: FR-TECH-4 (UI-SPECIFICATION 4.5 rule 4) an idle sign-out keeps every item; they send once the technician signs in again
  it('keeps every item when the session is gone (401), says signed out, and sends them after the next sign-in', async () => {
    const w = world();
    await w.engine.sync();
    await w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'on_my_way' } });
    await w.engine.sync();
    w.setOnline(false);
    await w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'arrived' } });
    w.setOnline(true);
    w.server.status['POST /api/v1/tech/items'] = 401;
    await w.engine.sync();
    expect([w.engine.snapshot.signedOut, (await w.store.waiting()).length, (await w.store.waiting())[0]?.lastTry?.outcome]).toEqual([true, 1, 'signed_out']);
    delete w.server.status['POST /api/v1/tech/items'];
    await w.engine.sync();
    expect([w.engine.snapshot.signedOut, (await w.store.waiting()).length]).toEqual([false, 0]);
  });
  // why: FR-TECH-4 2 syncs asked at once run as 1 (a second call joins the running one), so nothing is sent twice by the page
  it('joins a second sync to the running one', async () => {
    const w = world();
    await w.engine.sync();
    w.server.calls.length = 0;
    const [x, y] = [w.engine.sync(), w.engine.sync()];
    expect(x).toBe(y);
    await x;
    expect(w.server.calls.filter((c) => c === 'GET /api/v1/me')).toHaveLength(1);
  });
  // why: F-1746 a sync call that never answers ends at the time limit as no signal: the screen leaves Sending, and the next sync sends the item once under its same key
  it('ends a sync whose API-102 call never answers at the time limit, then sends the item once under the same key', async () => {
    const w = world(undefined, undefined, 50);
    await w.engine.sync();
    w.setOnline(false);
    const a = await w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'note', payload: { text: 'Flame sensor cleaned' } } });
    w.setOnline(true);
    w.server.hangOnce.add('POST /api/v1/tech/items');
    const stalled = w.engine.sync();
    await new Promise((r) => setTimeout(r, 10));
    expect(w.engine.snapshot.sending).toBe(true);
    const report = await stalled;
    expect([report?.stopped, w.engine.snapshot.sending, w.engine.snapshot.online]).toEqual(['network', false, false]);
    expect((await w.store.waiting()).map((i) => [i.key, i.lastTry?.outcome])).toEqual([[a.key, 'network']]);
    await w.engine.sync();
    expect([w.engine.snapshot.sending, w.engine.snapshot.online, w.engine.snapshot.waiting.length]).toEqual([false, true, 0]);
    expect(w.server.items.get(a.key)).toEqual(wireItem(a));
    expect(w.server.calls.filter((c) => c === 'POST /api/v1/tech/items')).toHaveLength(2);
  });
  // why: F-1746 the sync's own reads have the limit too: an API-07 call that never answers ends the sync, and the next one sends
  it('ends a sync whose API-07 call never answers at the time limit, and the next sync sends', async () => {
    const w = world(undefined, undefined, 50);
    await w.engine.sync();
    w.setOnline(false);
    const a = await w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'arrived' } });
    w.setOnline(true);
    w.server.hangOnce.add('GET /api/v1/me');
    expect(await w.engine.sync()).toBeNull();
    expect([w.engine.snapshot.sending, w.engine.snapshot.online, w.engine.snapshot.waiting.length]).toEqual([false, false, 1]);
    await w.engine.sync();
    expect([w.engine.snapshot.online, w.engine.snapshot.waiting.length, [...w.server.items.keys()].filter((k) => k === a.key)]).toEqual([true, 0, [a.key]]);
  });
  // why: F-1746 a photo upload that never answers ends at its limit as no signal, and the next sync uploads it once under its key
  it('ends a sync whose photo upload never answers at the limit, and the next sync uploads it under the same key', async () => {
    const w = world(undefined, undefined, 50);
    await w.engine.sync();
    w.setOnline(false);
    const ph = await w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'photo', contentType: 'image/jpeg' }, blob: jpegOf(2048) });
    w.setOnline(true);
    w.server.hangOnce.add(`PUT /api/v1/tech/photos/${ph.key}`);
    const report = await w.engine.sync();
    expect([report?.stopped, w.engine.snapshot.sending, w.engine.snapshot.waiting.length]).toEqual(['network', false, 1]);
    await w.engine.sync();
    expect([w.engine.snapshot.waiting.length, w.server.items.get(ph.key)]).toEqual([0, expect.objectContaining({ bytes: 2048 })]);
  });
  // why: F-1035 nginx answers 413 for a body over its cap; the photo leaves flagged by the server's own answer to a no-bytes body, and its bytes are never uploaded again
  it('flags a photo the proxy refused with 413 through 1 no-bytes upload under its key, and never sends its bytes again', async () => {
    const w = world();
    await w.engine.sync();
    w.setOnline(false);
    const ph = await w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'photo', contentType: 'image/jpeg' }, blob: jpegOf(2048) });
    w.setOnline(true);
    w.server.proxyCapBytes = 1024;
    await w.engine.sync();
    await w.engine.sync();
    expect(w.server.uploads).toEqual([2048, 0]);
    expect(w.server.calls.filter((c) => c.startsWith('PUT ')).every((c) => c === `PUT /api/v1/tech/photos/${ph.key}`)).toBe(true);
    expect(w.engine.snapshot.waiting).toHaveLength(0);
    expect((await w.engine.answered()).map((x) => [x.key, x.result, x.code])).toEqual([[ph.key, 'flagged', 'validation_failed']]);
  });
});

describe('the 24-hour banner (FR-TECH-7, CTL-CMP-10-03)', () => {
  // why: FR-TECH-7 moving the device clock 25 hours with 1 item unsent shows the banner; the demo clock is not read
  it('counts an item as old only after 24 hours of the device\'s real time since entry', async () => {
    const w = world();
    await w.engine.sync();
    w.setOnline(false);
    await w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'note', payload: { text: 'x' } } });
    expect(w.engine.snapshot.oldCount).toBe(0);
    w.advance(24 * 60);
    await w.engine.refresh();
    expect(w.engine.snapshot.oldCount).toBe(0);
    w.advance(60);
    await w.engine.refresh();
    expect([w.engine.snapshot.oldCount, (w.engine.snapshot.waiting as QueuedItem[]).length]).toEqual([1, 1]);
  });
});

describe('a sync never rejects (F-1849)', () => {
  const quota = () => new DOMException('the store is full', 'QuotaExceededError');
  const states = (w: ReturnType<typeof world>) => {
    const seen: boolean[] = [];
    w.engine.subscribe((s) => { seen.push(s.sending); });
    return seen;
  };

  // why: F-1849: a store that threw inside a sync rejected the sync, so the page's void sync() was an unhandled rejection and Sending could stay on.
  it('resolves null when the store throws mid-send, leaves Sending, keeps the item waiting, and sends it once on the next sync', async () => {
    const w = world();
    await w.engine.sync();
    w.setOnline(false);
    const a = await w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'arrived' } });
    w.setOnline(true);
    const markAnswered = w.store.markAnswered.bind(w.store);
    const waiting = w.store.waiting.bind(w.store);
    let failWaiting = 0;
    w.store.markAnswered = async () => { failWaiting = 1; throw quota(); };
    w.store.waiting = async () => { if (failWaiting > 0 && --failWaiting === 0) throw quota(); return waiting(); };
    const seen = states(w);
    await expect(w.engine.sync()).resolves.toBeNull();
    expect(w.engine.snapshot.sending).toBe(false);
    expect(seen.at(-1)).toBe(false);
    expect((await waiting()).map((i) => i.key)).toEqual([a.key]);
    w.store.markAnswered = markAnswered;
    await w.engine.sync();
    expect([w.engine.snapshot.waiting.length, [...w.server.items.keys()].filter((k) => k === a.key)]).toEqual([0, [a.key]]);
  });

  // why: F-1849: a lock or a user read that threw rejected the sync; it now ends like a sync with no signal, with no new screen state.
  it('resolves null when the user write or the cross-tab lock throws, keeps the item waiting, and sends it on the next sync', async () => {
    const w = world();
    await w.engine.sync();
    w.setOnline(false);
    const a = await w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'on_my_way' } });
    w.setOnline(true);
    const saveUser = w.store.saveUser.bind(w.store);
    w.store.saveUser = async () => { throw quota(); };
    await expect(w.engine.sync()).resolves.toBeNull();
    expect([w.engine.snapshot.sending, w.engine.snapshot.waiting.map((i) => i.key)]).toEqual([false, [a.key]]);
    w.store.saveUser = saveUser;
    await w.engine.sync();
    expect(w.engine.snapshot.waiting).toHaveLength(0);
    expect([...w.server.items.keys()].filter((k) => k === a.key)).toEqual([a.key]);
    const locked = world(undefined, undefined, undefined, async () => { throw new DOMException('aborted', 'AbortError'); });
    await expect(locked.engine.sync()).resolves.toBeNull();
    expect([locked.engine.snapshot.sending, locked.server.calls]).toEqual([false, []]);
  });

  // why: F-2006 K-10.5 the catch set no state, so a sync that threw left the banner online although nothing was sent
  it('a sync that throws leaves the no-signal state (online false), and the next sync that answers sets online again', async () => {
    const w = world();
    await w.engine.sync();
    expect(w.engine.snapshot.online).toBe(true);
    const saveUser = w.store.saveUser.bind(w.store);
    w.store.saveUser = async () => { throw quota(); };
    await expect(w.engine.sync()).resolves.toBeNull();
    expect([w.engine.snapshot.online, w.engine.snapshot.sending]).toEqual([false, false]);
    w.store.saveUser = saveUser;
    await w.engine.sync();
    expect(w.engine.snapshot.online).toBe(true);
  });
});

describe('F-1932 the finish and its signature leave as 2 entries', () => {
  const payload = { parts: [], noPartsUsed: true, laborMinutes: 30, workDone: ['Tune-up'] };
  const input = { jobNumber: 24831, baseVersion: 3, payload, refusedKey: null, signature: jpegOf(64) };

  // why: FR-TECH-14, F-1932 a signature that is not kept after its finish was is not lost: the retry enters the signature and no second finish
  it('enters only the signature again when the signature was not kept', async () => {
    const w = world();
    await w.engine.sync();
    w.setOnline(false);
    const put = w.store.put.bind(w.store);
    let puts = 0;
    w.store.put = (item, blob) => ((puts += 1) === 2 ? Promise.reject(new Error('no space left')) : put(item, blob));
    const leaving = new FinishLeave(w.engine);
    await expect(leaving.leave(input)).rejects.toThrow('no space left');
    expect((await w.store.waiting()).map((i) => i.kind)).toEqual(['finished']);
    expect(leaving.owed).toBe(true);
    await leaving.leave(input);
    expect((await w.store.waiting()).map((i) => i.kind)).toEqual(['finished', 'signature']);
    expect(leaving.owed).toBe(false);
  });

  // why: F-1025, F-1932 a refused finish is corrected under its own key on every try that finds it refused, and never entered beside it
  it('corrects a refused finish under its key and then enters the signature', async () => {
    const calls: string[] = [];
    let refuse = 1;
    const leaving = new FinishLeave({
      enter: async (i) => {
        calls.push(i.body.kind);
        if (refuse-- > 0) throw new Error('no space left');
        return {} as QueuedItem;
      },
      correctFinish: async (key) => {
        calls.push(`correct ${key}`);
        return {} as QueuedItem;
      },
    });
    await expect(leaving.leave({ ...input, refusedKey: 'k1' })).rejects.toThrow('no space left');
    await leaving.leave(input);
    expect(calls).toEqual(['correct k1', 'signature', 'signature']);
  });
});

describe('F-1975 a kept entry is not reported as lost when only the list read after it fails', () => {
  const payload = { parts: [], noPartsUsed: true, laborMinutes: 30, workDone: ['Tune-up'] };

  // why: FR-TECH-14, F-1975 an entry the store kept resolves with that entry when the list read after it fails, so the screen does not enter it twice
  it('enter resolves with the kept item when the waiting list read fails, and the item stays kept', async () => {
    const w = world();
    await w.engine.sync();
    w.setOnline(false);
    const waiting = w.store.waiting.bind(w.store);
    w.store.waiting = async () => { throw new DOMException('the store is full', 'QuotaExceededError'); };
    const item = await w.engine.enter({ jobNumber: 24830, baseVersion: 3, body: { kind: 'arrived' } });
    w.store.waiting = waiting;
    expect((await w.store.waiting()).map((i) => i.key)).toEqual([item.key]);
  });

  // why: F-1025, F-1975 a refused finish corrected in the store resolves with the corrected item when the list read after it fails
  it('correctFinish resolves with the corrected item when the waiting list read fails', async () => {
    const w = world();
    await w.engine.sync();
    w.setOnline(false);
    const finish = await w.engine.enter({ jobNumber: 24831, baseVersion: 3, body: { kind: 'finished', payload } });
    await w.store.recordTry([finish.key], { atRealMs: 1, outcome: 'refused', code: 'parts_required' });
    await w.engine.refresh();
    const waiting = w.store.waiting.bind(w.store);
    w.store.waiting = async () => { throw new DOMException('the store is full', 'QuotaExceededError'); };
    const fixed = { ...payload, laborMinutes: 45 };
    const item = await w.engine.correctFinish(finish.key, fixed);
    w.store.waiting = waiting;
    expect([item.key, ((item as { payload?: typeof payload }).payload as typeof payload).laborMinutes]).toEqual([finish.key, 45]);
    expect((((await w.store.waiting())[0] as { payload?: typeof payload }).payload as typeof payload).laborMinutes).toBe(45);
  });
});

describe('F-1976 a screen opened again still owes the signature of a kept finish', () => {
  const payload = { parts: [], noPartsUsed: true, laborMinutes: 30, workDone: ['Tune-up'] };
  const input = { jobNumber: 24831, baseVersion: 3, payload, refusedKey: null, signature: jpegOf(64) };

  // why: FR-TECH-14, F-1976 a finish waits and its signature does not: the new screen enters only the signature and no second finish
  it('signatureOwed reads the outbox, and a resumed FinishLeave enters only the signature', async () => {
    const w = world();
    await w.engine.sync();
    w.setOnline(false);
    const put = w.store.put.bind(w.store);
    let puts = 0;
    w.store.put = (item, blob) => ((puts += 1) === 2 ? Promise.reject(new Error('no space left')) : put(item, blob));
    await expect(new FinishLeave(w.engine).leave(input)).rejects.toThrow('no space left');
    const waiting = await w.store.waiting();
    expect(signatureOwed(waiting, 24831, true)).toBe(true);
    expect(signatureOwed(waiting, 24831, false)).toBe(false);
    expect(signatureOwed(waiting, 24830, true)).toBe(false);
    const again = new FinishLeave(w.engine);
    again.resume();
    expect(again.owed).toBe(true);
    await again.leave(input);
    expect((await w.store.waiting()).map((i) => i.kind)).toEqual(['finished', 'signature']);
    expect(signatureOwed(await w.store.waiting(), 24831, true)).toBe(false);
  });
});
