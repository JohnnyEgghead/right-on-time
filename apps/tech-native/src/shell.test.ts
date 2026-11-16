// SPDX-License-Identifier: AGPL-3.0-or-later
// The native shell's controller (core.ts) end to end on node:fs, an in-memory Keychain and scripted servers: the same store, engine,
// send loop and transport code the phone runs; only the platform services are doubles (testing.ts). The real-path proof is the
// XCUITest suite on the simulator against the Compose stack (xcuitest/ShellUITests.swift).
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileItemStore, sendWaiting, SYNC_CALL_LIMIT_MS } from '@bw/outbox/src/items/native.ts';
import { Temporal } from '@bw/time';
import { NativeApp, SIGN_OUT_WAIT_MS, type NativeDeps } from './core.ts';
import { SESSION_KEY } from './auth/session-store.ts';
import { DEFAULT_SERVER, parseOrigin, shownAddress } from './net/origin.ts';
import { checkServer } from './net/server-check.ts';
import { nativeTransport, uploadFetch, type UploadPort } from './net/transport.ts';
import { SettingsFile } from './store/settings.ts';
import { fakeNet, fakeServer, MARIA_ID, memoryKeychain, nodeDir, SAMPLE_TOKEN } from './testing.ts';

const LOCAL = 'http://192.168.1.20:8080';
const PASSWORD = 'b'.repeat(12);
let ms = Temporal.Instant.from('2026-11-08T15:30:00Z').epochMilliseconds;
const nowInstant = () => Temporal.Instant.fromEpochMilliseconds((ms += 1000));
let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;

function phone(net: { fetch: typeof fetch; upload: UploadPort }, dirs = { items: nodeDir(), settings: nodeDir(), jobs: nodeDir(), mapme: nodeDir(), person: nodeDir() }, secrets = memoryKeychain()) {
  const deps: NativeDeps = {
    itemsDir: dirs.items, settingsDir: dirs.settings, jobsDir: dirs.jobs, mapmeDir: dirs.mapme, personDir: dirs.person, secrets, upload: net.upload, fetch: net.fetch,
    deviceNow: nowInstant, bannerNow: () => ms, uuid, deviceLanguage: 'en-US', device: 'iPhone app (test)',
  };
  return { app: new NativeApp(deps), dirs, secrets, relaunch: () => phone(net, { items: nodeDir(dirs.items.root), settings: nodeDir(dirs.settings.root), jobs: nodeDir(dirs.jobs.root), mapme: nodeDir(dirs.mapme.root), person: nodeDir(dirs.person.root) }, secrets) };
}

describe('FR-IOS-3 the hosted demo by default, and a server address setting', () => {
  // why: FR-IOS-3 a fresh install signs in to the hosted demo: its address is https://bw.j7l.io, and the sign-in goes there
  it('a fresh install targets https://bw.j7l.io: its sign-in and its every call after go to the hosted demo', async () => {
    const hosted = fakeServer(DEFAULT_SERVER);
    const p = phone(fakeNet(hosted));
    expect(DEFAULT_SERVER).toBe('https://bw.j7l.io');
    await p.app.open();
    expect(p.app.snapshot.server).toBe('https://bw.j7l.io');
    expect(hosted.calls).toEqual([]); // signed out, the app calls nothing on its own
    expect(await p.app.signIn('40712', PASSWORD, true)).toEqual({ ok: true });
    await p.app.sync();
    expect(hosted.calls.length).toBeGreaterThan(1);
    for (const c of hosted.calls) expect(c.url.startsWith('https://bw.j7l.io/api/v1/')).toBe(true);
    const signIn = hosted.calls.find((c) => c.url.endsWith('/api/v1/sessions'));
    expect(signIn?.body).toMatchObject({ login: '40712', client: 'native', keepSignedIn: true });
    expect(hosted.calls.filter((c) => c.url.endsWith('/api/v1/me')).every((c) => c.auth === `Bearer ${SAMPLE_TOKEN}`)).toBe(true);
  });

  // why: FR-IOS-3 changing the setting connects it to a local copy, and the setting survives a relaunch
  it('a checked local address, saved, is the target after a relaunch; the hosted session is not sent to it', async () => {
    const hosted = fakeServer(DEFAULT_SERVER);
    const local = fakeServer(LOCAL);
    const net = fakeNet(hosted, local);
    const p = phone(net);
    await p.app.open();
    expect(await p.app.check(LOCAL)).toEqual({ kind: 'reachable', version: '1.0' });
    expect(await p.app.saveServer(LOCAL)).toEqual({ ok: true });
    const again = p.relaunch();
    await again.app.open();
    expect(again.app.snapshot.server).toBe(LOCAL);
    expect(await again.app.signIn('maria.santos@brightwater.example', PASSWORD, false)).toEqual({ ok: true });
    await again.app.sync();
    expect(local.calls.map((c) => c.url.split('?')[0])).toContain(`${LOCAL}/api/v1/sessions`);
    expect(hosted.calls).toEqual([]);
    // Back to the hosted demo: the local copy's Keychain entry is no session there (sign out first, as Me says).
    expect(await again.app.signOut()).toEqual({ ok: true });
    expect(await again.app.saveServer(DEFAULT_SERVER)).toEqual({ ok: true });
    expect(again.secrets.data.has(SESSION_KEY)).toBe(false);
  });

  // why: FR-IOS-3 only a checked address is stored; a session cannot change the server under it
  it('refuses to change the server while signed in', async () => {
    const p = phone(fakeNet(fakeServer(DEFAULT_SERVER)));
    await p.app.open();
    await p.app.signIn('40712', PASSWORD, true);
    expect(() => p.app.saveServer(LOCAL)).toThrow(/sign out/);
  });

  // why: FR-IOS-3 CTL-TEC-12-01 takes a web address: an origin, http or https
  it.each([
    ['https://bw.j7l.io', 'https://bw.j7l.io'], ['https://bw.j7l.io/', 'https://bw.j7l.io'], ['HTTP://192.168.1.20:8080', 'http://192.168.1.20:8080'],
    ['https://bw.j7l.io:443', 'https://bw.j7l.io'], ['http://localhost:8794', 'http://localhost:8794'], ['  https://copy.example.org  ', 'https://copy.example.org'],
    ['192.168.1', null], ['192.168.1.20:8080', null], ['https://192.168.1', null], ['https://999.1.1.1', null], ['ftp://bw.j7l.io', null],
    ['https://bw.j7l.io/path', null], ['https://bw', null], ['https://bw.j7l.io:0', null], ['', null],
  ])('reads %j as %j', (text, origin) => {
    expect(parseOrigin(text)).toBe(origin);
  });

  // why: FR-IOS-3 the Server row shows the address without its scheme, as the frame does
  it('shows the saved address without its scheme', () => {
    expect(shownAddress('http://192.168.1.20:8080')).toBe('192.168.1.20:8080');
    expect(shownAddress(DEFAULT_SERVER)).toBe('bw.j7l.io');
  });

  // why: FR-IOS-3 Check connection: Reachable, Not this product, Unreachable (SCR-TEC-12 states)
  it('checks an address: a Right On Time answer, another server, no answer, and no answer in time', async () => {
    expect(await checkServer(LOCAL, fakeServer(LOCAL).fetch)).toEqual({ kind: 'reachable', version: '1.0' });
    expect(await checkServer(LOCAL, fakeServer(LOCAL, 'Other Product').fetch)).toEqual({ kind: 'not_this_product' });
    expect(await checkServer(LOCAL, async () => new Response('<html>nginx</html>', { status: 200 }))).toEqual({ kind: 'not_this_product' });
    expect(await checkServer(LOCAL, async () => new Response('{"data":{}}', { status: 404 }))).toEqual({ kind: 'not_this_product' });
    expect(await checkServer(LOCAL, async () => Promise.reject(new TypeError('Network request failed')))).toEqual({ kind: 'unreachable' });
    const never: typeof fetch = (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    expect(await checkServer(LOCAL, never, 30)).toEqual({ kind: 'unreachable' });
  });

  // why: FR-IOS-3 the setting is kept by the file rule: a damaged newer record falls back, a leftover temporary goes
  it('keeps the settings record whole across a damaged newer record and a leftover temporary file', () => {
    const d = nodeDir();
    const f = new SettingsFile(d);
    expect(f.read()).toEqual({ server: DEFAULT_SERVER, language: null, opened: false });
    f.write({ server: LOCAL });
    d.create('s-000099.json', '{"server":');
    d.create('tmp-leftover', 'x');
    const again = new SettingsFile(nodeDir(d.root));
    expect(again.read().server).toBe(LOCAL);
    expect(d.list()).not.toContain('tmp-leftover');
  });
});

describe('the bearer token in the Keychain (SD-47), bound to its server', () => {
  // why: FR-IOS-1, FR-AUTH-10 the token survives a relaunch in the Keychain, never in a file; another server's entry is no session
  it('keeps the token in the Keychain only, for its own origin, and drops it on sign-out', async () => {
    const p = phone(fakeNet(fakeServer(DEFAULT_SERVER)));
    await p.app.open();
    await p.app.signIn('40712', PASSWORD, true);
    const kept = JSON.parse(p.secrets.data.get(SESSION_KEY) as string) as Record<string, unknown>;
    expect(kept).toMatchObject({ origin: DEFAULT_SERVER, token: SAMPLE_TOKEN, userId: MARIA_ID, staySignedIn: true });
    for (const d of [p.dirs.items, p.dirs.settings]) {
      for (const n of d.list()) expect(d.readText(n) ?? '').not.toContain(SAMPLE_TOKEN);
    }
    const again = p.relaunch();
    await again.app.open();
    expect(again.app.snapshot.session?.userId).toBe(MARIA_ID);
    expect(await again.app.signOut()).toEqual({ ok: true });
    expect(again.secrets.data.has(SESSION_KEY)).toBe(false);
  });

  // why: FR-AUTH-7 a wrong password is refused with its code, and nothing is kept
  it('answers a wrong password with credentials_invalid and keeps no session', async () => {
    const p = phone(fakeNet(fakeServer(DEFAULT_SERVER)));
    await p.app.open();
    expect(await p.app.signIn('40712', 'c'.repeat(12), false)).toEqual({ ok: false, code: 'credentials_invalid' });
    expect(p.secrets.data.size).toBe(0);
  });
});

describe('FR-TECH-4 natively: a note entered with no signal survives terminate and relaunch, and is sent once (D17 item 4)', () => {
  // why: FR-TECH-4, FR-IOS-1, FR-TECH-4 kept and resent on relaunch only: the waiting list converges to the server's ledger
  it('keeps the note through a terminate with no signal, and sends it exactly once after the relaunch, from a file', async () => {
    const server = fakeServer(DEFAULT_SERVER);
    const p = phone(fakeNet(server));
    await p.app.open();
    await p.app.signIn('40712', PASSWORD, true);
    await p.app.sync(); // with signal: the user and the clock offset are saved (an entry needs both)
    server.setSignal(false);
    const item = await p.app.enter({ jobNumber: 24830, baseVersion: 1, body: { kind: 'note', payload: { text: 'Side gate, dog in yard.' } } });
    await p.app.sync();
    expect(p.app.snapshot.outbox.waiting.map((i) => i.key)).toEqual([item.key]);
    expect(p.app.snapshot.outbox.online).toBe(false);
    expect(server.ledger.size).toBe(0);
    // terminated: a new process over the same files and Keychain, still no signal
    const relaunched = p.relaunch();
    await relaunched.app.open();
    await relaunched.app.sync();
    expect((await relaunched.app.store.waiting()).map((i) => i.key)).toEqual([item.key]);
    // the signal returns: the next trigger sends it, by a background upload of a file
    server.setSignal(true);
    await relaunched.app.sync();
    expect(await relaunched.app.store.waiting()).toEqual([]);
    expect([...server.ledger.keys()]).toEqual([item.key]);
    const sends = server.calls.filter((c) => c.url.endsWith('/api/v1/tech/items') && c.via === 'upload');
    expect(sends.map((c) => (c.body as { items: { key: string }[] }).items.map((i) => i.key))).toEqual([[item.key]]);
    expect(sends.every((c) => c.auth === `Bearer ${SAMPLE_TOKEN}`)).toBe(true);
    await relaunched.app.sync();
    expect(server.calls.filter((c) => c.url.endsWith('/api/v1/tech/items')).length).toBe(1); // nothing more to send
    expect((await relaunched.app.store.answered()).map((a) => [a.key, a.result])).toEqual([[item.key, 'applied']]);
  });

  // why: FR-TECH-4, UD-20 sign-out is refused while an item waits, and the item stays
  it('refuses sign-out while the note waits', async () => {
    const server = fakeServer(DEFAULT_SERVER);
    const p = phone(fakeNet(server));
    await p.app.open();
    await p.app.signIn('40712', PASSWORD, true);
    await p.app.sync();
    server.setSignal(false);
    await p.app.enter({ jobNumber: 24830, baseVersion: 1, body: { kind: 'note', payload: { text: 'x' } } });
    expect(await p.app.signOut()).toEqual({ ok: false, waiting: 1, damaged: false });
    expect(p.secrets.data.has(SESSION_KEY)).toBe(true);
  });
});

describe('F-984 / F-985 / F-986 the store is read before any verdict, and a waiting item holds the sign-out and the address', () => {
  // why: FR-TECH-4, F-984 the header reads the store at open: ready, and the waiting item, before the first sync answers
  it('has read the store (outbox.ready, the item waiting) when open() resolves, before any send', async () => {
    const server = fakeServer(DEFAULT_SERVER);
    const p = phone(fakeNet(server));
    await p.app.open();
    await p.app.signIn('40712', PASSWORD, true);
    await p.app.sync();
    server.setSignal(false);
    const item = await p.app.enter({ jobNumber: 24830, baseVersion: 1, body: { kind: 'note', payload: { text: 'x' } } });
    const again = p.relaunch();
    expect(again.app.snapshot.outbox.ready).toBe(false);
    await again.app.open();
    expect(again.app.snapshot.outbox.ready).toBe(true);
    expect(again.app.snapshot.outbox.waiting.map((i) => i.key)).toEqual([item.key]);
  });

  // why: FR-TECH-4, F-986 the address is not moved to another server while an item waits (UD-20)
  it('refuses to save a server address while an item waits, signed out after a 401', async () => {
    const server = fakeServer(DEFAULT_SERVER);
    const p = phone(fakeNet(server));
    await p.app.open();
    await p.app.signIn('40712', PASSWORD, true);
    await p.app.sync();
    server.setSignal(false);
    await p.app.enter({ jobNumber: 24830, baseVersion: 1, body: { kind: 'note', payload: { text: 'x' } } });
    p.secrets.data.delete(SESSION_KEY);
    const again = p.relaunch();
    await again.app.open();
    expect(await again.app.saveServer(LOCAL)).toEqual({ ok: false, waiting: 1, damaged: false });
    expect(again.app.snapshot.server).toBe(DEFAULT_SERVER);
  });

  // why: FR-TECH-4, F-985 an item file that no longer parses still counts as waiting for the sign-out guard
  it('counts a damaged item file as waiting: sign-out is refused', async () => {
    const server = fakeServer(DEFAULT_SERVER);
    const p = phone(fakeNet(server));
    await p.app.open();
    await p.app.signIn('40712', PASSWORD, true);
    await p.app.sync();
    server.setSignal(false);
    const item = await p.app.enter({ jobNumber: 24830, baseVersion: 1, body: { kind: 'note', payload: { text: 'x' } } });
    const f = readdirSync(p.dirs.items.root).find((x) => x.includes(item.key)) as string;
    writeFileSync(path.join(p.dirs.items.root, f), '{"key":');
    const again = p.relaunch();
    await again.app.open();
    expect(again.app.store.damaged()).toEqual([item.key]);
    // F-1093 (owner ruling "Allow sign-out, warn"): refused once with the warning, and the address stays refused with its own line
    expect(await again.app.signOut()).toEqual({ ok: false, waiting: 1, damaged: true });
  });

  // why: F-1093 signed out with only a damaged item left, the address stays refused and its refusal says the damaged case, not Send now
  it('refuses the server address with the damaged case when only a damaged item is left', async () => {
    const p = phone(fakeNet(fakeServer(DEFAULT_SERVER)));
    writeFileSync(path.join(p.dirs.items.root, `i-${'9'.repeat(12)}-00000000-0000-4000-8000-0000000d0d0e-000001.json`), 'not json');
    await p.app.open();
    expect(await p.app.saveServer(LOCAL)).toEqual({ ok: false, waiting: 1, damaged: true });
  });
});

describe('F-1368 Sign out with a server that never answers (CTL-TEC-10-04: the local session is cleared anyway)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The deleted copy behind a live address: every call to the server is accepted and never settled; it records each call and its signal. */
  function silentServer() {
    const up = fakeServer(DEFAULT_SERVER);
    let silent = false;
    const held: { method: string; url: string; signal: AbortSignal | null }[] = [];
    const net = fakeNet(up);
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (!silent) return net.fetch(input, init);
      held.push({ method: init?.method ?? 'GET', url: String(input), signal: init?.signal ?? null });
      return new Promise<Response>(() => undefined); // never settles, and ignores its signal: the bound cannot lean on the abort
    };
    return { up, held, net: { fetch, upload: net.upload }, goSilent: () => (silent = true), goLoud: () => (silent = false) };
  }

  // why: F-1368 the owner's build 4 case: signed in to a server that never answers, Sign out clears the phone within 5 s and says ok
  it('clears the session within 5 s when API-06 never answers, and cancels the call', async () => {
    const srv = silentServer();
    const p = phone(srv.net);
    await p.app.open();
    expect(await p.app.signIn('40712', PASSWORD, true)).toEqual({ ok: true });
    await p.app.sync();
    srv.goSilent();
    vi.useFakeTimers();
    let result: unknown = 'pending';
    void p.app.signOut().then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result).toEqual({ ok: true });
    expect(p.app.snapshot.session).toBeNull();
    expect(p.secrets.data.has(SESSION_KEY)).toBe(false);
    // the call was still sent (once), and cancelled at the limit
    const sent = srv.held.filter((c) => c.method === 'DELETE' && c.url.endsWith('/api/v1/sessions/current'));
    expect(sent.length).toBe(1);
    expect(sent[0]?.signal?.aborted).toBe(true);
    expect(SIGN_OUT_WAIT_MS).toBeLessThan(5_000);
    // a relaunch opens signed out: nothing of the session is left behind
    const again = p.relaunch();
    await again.app.open();
    expect(again.app.snapshot.session).toBeNull();
  });

  // why: F-1368 with the server up, 1 Sign out sends API-06 once, with the session's token, and does not wait out the limit
  it('sends API-06 once with the server up, and is done before the limit', async () => {
    const server = fakeServer(DEFAULT_SERVER);
    const p = phone(fakeNet(server));
    await p.app.open();
    await p.app.signIn('40712', PASSWORD, true);
    await p.app.sync();
    vi.useFakeTimers();
    let result: unknown = 'pending';
    void p.app.signOut().then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toEqual({ ok: true });
    const deletes = server.calls.filter((c) => c.method === 'DELETE' && c.url.endsWith('/api/v1/sessions/current'));
    expect(deletes.map((c) => c.auth)).toEqual([`Bearer ${SAMPLE_TOKEN}`]);
    expect(vi.getTimerCount()).toBe(0); // the limit's timer is cleared once the answer came
  });

  // why: F-1746 a sync whose API-07 call never answers ends at the call limit: the header leaves Sending, and the next sync sends the note once under its key
  it('ends a sync at the call limit when API-07 never answers, then the next sync sends the note once', async () => {
    const srv = silentServer();
    const p = phone(srv.net);
    await p.app.open();
    await p.app.signIn('40712', PASSWORD, true);
    await p.app.sync();
    srv.up.setSignal(false);
    const it1 = await p.app.enter({ jobNumber: 24830, baseVersion: 1, body: { kind: 'note', payload: { text: 'Flame sensor cleaned' } } });
    await p.app.sync(); // the entry's own send, with no signal, is over
    srv.up.setSignal(true);
    srv.goSilent();
    vi.useFakeTimers();
    let done = false;
    void p.app.sync().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(SYNC_CALL_LIMIT_MS - 1);
    expect([done, p.app.snapshot.outbox.sending]).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(1);
    expect([done, p.app.snapshot.outbox.sending, p.app.snapshot.outbox.waiting.length]).toEqual([true, false, 1]);
    expect(srv.held.filter((c) => c.url.endsWith('/api/v1/me')).every((c) => c.signal?.aborted)).toBe(true);
    vi.useRealTimers();
    srv.goLoud();
    await p.app.sync();
    expect(p.app.snapshot.outbox.waiting).toHaveLength(0);
    expect([...srv.up.ledger.keys()].filter((k) => k === it1.key)).toEqual([it1.key]);
    expect(srv.up.calls.filter((c) => c.via === 'upload' && c.url.endsWith('/api/v1/tech/items'))).toHaveLength(1);
  });

  // why: F-1368, UD-20 a server that never answers changes nothing about the refusal while an item waits: refused at once, nothing sent, still signed in
  it('still refuses at once while a note waits, with the server silent, and sends nothing', async () => {
    const srv = silentServer();
    const p = phone(srv.net);
    await p.app.open();
    await p.app.signIn('40712', PASSWORD, true);
    await p.app.sync();
    srv.goSilent();
    srv.up.setSignal(false); // the item uploads go nowhere either, so the note waits
    await p.app.enter({ jobNumber: 24830, baseVersion: 1, body: { kind: 'note', payload: { text: 'x' } } });
    const before = srv.held.length;
    expect(await p.app.signOut()).toEqual({ ok: false, waiting: 1, damaged: false });
    expect(srv.held.slice(before).some((c) => c.method === 'DELETE')).toBe(false);
    expect(p.secrets.data.has(SESSION_KEY)).toBe(true);
  });
});

describe('F-987 a Keychain session outliving a deleted install', () => {
  // why: FR-IOS-3 a fresh install signs in to the hosted demo: a session left in the Keychain by a deleted install is not restored
  it('opens signed out when the Keychain holds a session but the app has no first-run marker', async () => {
    const net = fakeNet(fakeServer(DEFAULT_SERVER));
    const p = phone(net);
    await p.app.open();
    await p.app.signIn('40712', PASSWORD, true);
    expect(p.secrets.data.has(SESSION_KEY)).toBe(true);
    const kept = phone(net, { items: nodeDir(p.dirs.items.root), settings: nodeDir(p.dirs.settings.root), jobs: nodeDir(p.dirs.jobs.root), mapme: nodeDir(p.dirs.mapme.root), person: nodeDir(p.dirs.person.root) }, p.secrets);
    await kept.app.open();
    expect(kept.app.snapshot.session).not.toBeNull(); // a relaunch keeps the session
    const reinstalled = phone(net, { items: nodeDir(), settings: nodeDir(), jobs: nodeDir(), mapme: nodeDir(), person: nodeDir() }, p.secrets); // the Documents folder is new, the Keychain is not
    await reinstalled.app.open();
    expect(reinstalled.app.snapshot.session).toBeNull();
    expect(p.secrets.data.has(SESSION_KEY)).toBe(false);
  });
});

describe('the native transport: every item call uploads from a file (R4 sections 1.1 to 1.3)', () => {
  // why: FR-TECH-4, FR-IOS-1 a rejected upload is no answer: the loop's "network", never a server error
  it('maps an upload with no answer to network, a 5xx to server_error, and reads a photo from its own file', async () => {
    const seen: { uri: string; url: string; method: string }[] = [];
    let mode: 'down' | '503' | 'ok' = 'down';
    const port: UploadPort = {
      async upload(uri, url, init) {
        seen.push({ uri, url, method: init.method });
        if (mode === 'down') throw new Error('offline');
        if (mode === '503') return { status: 503, body: '<html>busy</html>', headers: {} };
        return { status: 200, body: JSON.stringify({ data: { key: '00000000-0000-4000-8000-000000000009', result: 'applied', code: null, messageKey: null, values: null }, meta: {} }), headers: {} };
      },
      bodyFile: () => ({ uri: 'file:///body.json', done: () => undefined }),
    };
    const photo = { key: '00000000-0000-4000-8000-000000000009', kind: 'photo', contentType: 'image/jpeg', jobNumber: 24830, worldEpoch: 1, deviceTime: 'd', offsetSavedReal: 'o', sinceSaveMs: 0, demoTime: 't' } as never;
    const t = nativeTransport({ origin: LOCAL, token: SAMPLE_TOKEN, blobUri: () => 'file:///items/b-x-000001.bin', port });
    expect(await t.uploadBlob(photo, new Uint8Array([1]))).toEqual({ ok: false, stop: 'network' });
    mode = '503';
    expect(await t.uploadBlob(photo, new Uint8Array([1]))).toEqual({ ok: false, stop: 'server_error' });
    mode = 'ok';
    expect(await t.uploadBlob(photo, new Uint8Array([1]))).toMatchObject({ ok: true, answer: { result: 'applied' } });
    expect(seen.every((s) => s.uri === 'file:///items/b-x-000001.bin' && s.method === 'PUT' && s.url.startsWith(`${LOCAL}/api/v1/tech/photos/`))).toBe(true);
    mode = 'down';
    expect(await t.sendItems([{ key: '00000000-0000-4000-8000-00000000000a' } as never])).toEqual({ ok: false, stop: 'network' });
    await expect(uploadFetch(port)(`${LOCAL}/x`, { method: 'GET' })).rejects.toThrow(/only a POST or PUT/);
  });

  // why: F-1035 nginx answers 413 for a photo over its cap; on the phone's path the photo leaves flagged by the server's answer to 1 empty body file, and its file is never uploaded again
  it('answers a photo refused with 413 by 1 empty-body upload under its key, flagged, and never uploads its file again', async () => {
    const store = new FileItemStore(nodeDir());
    const key = '00000000-0000-4000-8000-00000000000b';
    await store.put({ key, kind: 'photo', contentType: 'image/jpeg', jobNumber: 24830, baseVersion: null, userId: MARIA_ID, worldEpoch: 1, deviceTime: 'd', offsetSavedReal: 'o', sinceSaveMs: 0, demoTime: 't', enteredRealMs: ms } as never, new Uint8Array(4096));
    const blobFile = store.blobUri(key);
    const uploads: string[] = [];
    const bodies: { text: string; done: boolean }[] = [];
    const port: UploadPort = {
      async upload(uri, url) {
        const empty = bodies.find((b) => `file:///body-${bodies.indexOf(b)}.json` === uri);
        uploads.push(empty ? `empty ${empty.text.length}` : uri === blobFile ? 'photo file' : uri);
        expect(url).toContain(`/api/v1/tech/photos/${key}?`);
        if (!empty) return { status: 413, body: '<html><head><title>413 Request Entity Too Large</title></head></html>', headers: {} };
        return { status: 200, body: JSON.stringify({ data: { key, result: 'flagged', code: 'validation_failed', messageKey: 'tech.item.flagged.validation_failed', values: { job: 24830 } }, meta: {} }), headers: {} };
      },
      bodyFile(text) {
        const b = { text, done: false };
        bodies.push(b);
        return { uri: `file:///body-${bodies.length - 1}.json`, done: () => (b.done = true) };
      },
    };
    const t = nativeTransport({ origin: LOCAL, token: SAMPLE_TOKEN, blobUri: (k) => store.blobUri(k), port });
    const r = await sendWaiting(store, t, { userId: MARIA_ID, nowMs: () => ms });
    await sendWaiting(store, t, { userId: MARIA_ID, nowMs: () => ms });
    expect(uploads).toEqual(['photo file', 'empty 0']);
    expect(bodies).toEqual([{ text: '', done: true }]);
    expect(r.answered.map((x) => [x.key, x.result, x.code])).toEqual([[key, 'flagged', 'validation_failed']]);
    expect(await store.waiting()).toHaveLength(0);
  });
});
