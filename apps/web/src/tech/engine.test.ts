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
import { NotReadyError, TechOutbox } from './engine.ts';
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
  items: Map<string, unknown>;
}

function world(start = Temporal.Instant.from('2026-11-08T15:00:00Z'), joinLimitMs?: number) {
  const server: Server = { calls: [], down: false, hang: false, status: {}, items: new Map() };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const what = `${init?.method ?? 'GET'} ${url.pathname}`;
    server.calls.push(what);
    if (server.down) throw new TypeError('fetch failed');
    if (server.hang) await new Promise<void>(() => undefined);
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
      server.items.set(key, { query: Object.fromEntries(url.searchParams), bytes: (init?.body as Uint8Array).byteLength, type: (init?.headers as Record<string, string>)['content-type'] });
      return json(200, { data: { key, result: 'applied', code: null, messageKey: null, values: null }, meta: meta('API-103') });
    }
    return json(404, {});
  };
  const client = createClient({ baseUrl: ORIGIN, fetch });
  const store = new DexieItemStore('engine', { indexedDB: new IDBFactory(), IDBKeyRange });
  let now = start;
  let online = true;
  const engine = new TechOutbox({
    store, client, transport: webTransport(client, { baseUrl: ORIGIN, fetch }),
    deviceNow: () => now, bannerNow: () => now.epochMilliseconds, isOnline: () => online, device: 'Web app',
    ...(joinLimitMs !== undefined ? { joinLimitMs } : {}),
  });
  return {
    server, store, engine,
    advance: (minutes: number) => { now = now.add({ minutes }); },
    setOnline: (v: boolean) => { online = v; },
  };
}

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
  /** A buffer that starts as a JPEG does (SOI and a marker): the send sends a JPEG's bytes as they are (job/photo.ts uploadBody). */
const jpegOf = (n: number) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };

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
