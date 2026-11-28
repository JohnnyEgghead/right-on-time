// SPDX-License-Identifier: AGPL-3.0-or-later
// The web process over real HTTP on a free port (F-212): API routes and the health check through the real kernel (the
// real policy table and handlers; the database is the kernel test kit's recording one, the real one is G-CI7's db test
// and the Compose stack), the page gate before every page, and the 11.5 headers on every answer, whatever its status
// (F-214). Next's request handler is a stand-in here that records what it was handed; the real Next.js pages behind
// this same process are proven by the stack suite (ci/shell-stack) and the page walkers.
import { spawnSync } from 'node:child_process';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_SECURITY_POLICY, handlers, pageGate, pageRequestVerdict, policyTable } from '@bw/api-server';
import { kit } from '@bw/api-server/src/testing.ts';
import { KEEP_ALIVE_MS, pageCsp, start, type NextHandler } from './server.ts';
import { PAGE_VERDICT_HEADER } from './shell/page-verdict.ts';

// F-529: the map-assets read can be made to throw for one test.
const mapRead = vi.hoisted(() => ({ fail: false }));
vi.mock('./map/map-assets.ts', async (orig) => {
  const m = await orig<typeof import('./map/map-assets.ts')>();
  return { ...m, readMapAsset: (file: string) => { if (mapRead.fail) throw new Error('EACCES'); return m.readMapAsset(file); } };
});

// F-2071: the technician shell asset read can be made to throw a coded error for one test.
const shellRead = vi.hoisted(() => ({ fail: false }));
vi.mock('./tech/shell-assets.ts', async (orig) => {
  const m = await orig<typeof import('./tech/shell-assets.ts')>();
  return { ...m, techShellAsset: (...a: Parameters<typeof m.techShellAsset>) => { if (shellRead.fail) throw Object.assign(new Error('no such file sw.js'), { code: 'ENOENT' }); return m.techShellAsset(...a); } };
});

interface Seen {
  url: string;
  csp: string | undefined;
  verdict: string | undefined;
}

const k = kit(policyTable, { ...handlers });
const seen: Seen[] = [];
/** The stand-in's answer for the next request: a page, a 500 page, its own CSP header, or a throw. */
let mode: 'page' | 'error-page' | 'own-csp' | 'throw' | 'throw-coded' = 'page';
const fakeNext: NextHandler = async (req: IncomingMessage, res: ServerResponse) => {
  seen.push({ url: req.url ?? '', csp: req.headers['content-security-policy'] as string | undefined, verdict: req.headers[PAGE_VERDICT_HEADER] as string | undefined });
  if (mode === 'throw') throw new Error('render failed');
  if (mode === 'throw-coded') throw Object.assign(new Error('render exploded'), { code: 'ERR_RENDER' });
  if (mode === 'own-csp') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src *" });
    res.end('<!doctype html><p>page</p>');
    return;
  }
  res.statusCode = mode === 'error-page' ? 500 : 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<!doctype html><p>page</p>');
};

const servers: Server[] = [];
let base = '';
let harnessBase = '';
const listen = async (harness: boolean) => {
  const pageVerdict = pageRequestVerdict(pageGate(policyTable), { sessions: k.sessions, clock: k.clock, codeOn: false, accessKey: k.deps.accessKey });
  const s = start(0, { router: k.router, pageVerdict, next: fakeNext, log: k.log, harness }, '127.0.0.1');
  servers.push(s);
  await new Promise<void>((resolve) => s.once('listening', () => resolve()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

let cookies: Record<'manager' | 'office' | 'technician', string>;
beforeAll(async () => {
  base = await listen(false);
  harnessBase = await listen(true);
  cookies = {
    manager: (await k.signIn('manager')).cookie,
    office: (await k.signIn('office')).cookie,
    technician: (await k.signIn('technician')).cookie,
  };
});
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())))));
beforeEach(() => {
  seen.length = 0;
  mode = 'page';
});

/** A GET with the path exactly as written (fetch would resolve dot segments itself): the status and Location. */
function rawGet(origin: string, target: string): Promise<{ status: number; location: string | undefined }> {
  const port = Number(new URL(origin).port);
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => (buf += String(d)));
    s.on('end', () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1]), location: /\r\nlocation: ([^\r]*)/i.exec(buf)?.[1] }));
    s.on('error', reject);
  });
}

const at = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { redirect: 'manual', ...init });

/** The 11.5 headers, with the page CSP's nonce read back (null for an API or asset answer: the policy unchanged, SPECIFICATIONS 11.5, F-774). */
function expectSecurityHeaders(r: Response, where: string, kind: 'page' | 'api' | 'asset'): string | null {
  expect(r.headers.get('x-content-type-options'), where).toBe('nosniff');
  expect(r.headers.get('referrer-policy'), where).toBe('no-referrer');
  const csp = r.headers.get('content-security-policy');
  if (kind !== 'page') {
    expect(csp, where).toBe(CONTENT_SECURITY_POLICY);
    return null;
  }
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp ?? '')?.[1];
  expect(nonce, `${where}: ${csp}`).toBeTruthy();
  expect(csp, where).toBe(pageCsp(nonce!));
  return nonce!;
}

describe('the web process: the kernel serves the API and the health check (F-212 a)', () => {
  // why: F-212, NFR-11 /healthz is the kernel's API-171, never a page route of its own
  it('answers GET /healthz through the kernel after a database round trip, and never asks Next', async () => {
    const before = k.db.log.length;
    const r = await at('/healthz');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"status":"ok"}');
    expect(k.db.log.slice(before)).toEqual(['BEGIN', 'SELECT beat_real FROM system.worker_heartbeat WHERE id = 1', 'COMMIT']);
    expect(seen).toEqual([]);
  });

  // why: F-212, FR-AUTH-1, F-344 every /api/v1 path is the kernel's: a known route answers its contract, an unknown one 404
  it('sends every /api path to the kernel: the 4 shell reads answer their contracts, an unknown route a 404 Problem', async () => {
    const me = await at('/api/v1/me');
    expect([me.status, ((await me.json()) as { code: string }).code]).toEqual([401, 'unauthenticated']);
    const clock = await at('/api/v1/clock'); // the recording database holds no clock row
    expect([clock.status, ((await clock.json()) as { code: string }).code]).toEqual([500, 'server_error']);
    const office = await at('/api/v1/me', { headers: { cookie: cookies.office } });
    expect(office.status).toBe(404); // the recording database holds no user row: not this caller any more
    // API-09 is a contract row with a policy entry now (F-344): signed out, the kernel answers it unauthenticated, as any row.
    const events = await at('/api/v1/events');
    expect([events.status, events.headers.get('content-type'), ((await events.json()) as { code: string }).code])
      .toEqual([401, 'application/problem+json', 'unauthenticated']);
    for (const p of ['/api', '/api/v2/clock']) {
      const r = await at(p);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type'), p).toBe('application/problem+json');
    }
    expect(seen).toEqual([]);
  });
});

describe('the web process: the page gate before every page (F-212 b)', () => {
  // why: F-212, FR-AUTH-1 a signed-out person on a staff page is sent to sign in, and Next renders nothing
  it('redirects a signed-out person on a staff page to its sign-in page with the return path', async () => {
    const office = await at('/office/board?branch=columbus');
    expect(office.status).toBe(303);
    expect(office.headers.get('location')).toBe('/sign-in?return=%2Foffice%2Fboard');
    const tech = await at('/tech/jobs/24811');
    expect(tech.headers.get('location')).toBe('/tech/sign-in?return=%2Ftech%2Fjobs%2F24811');
    expect(seen).toEqual([]);
  });

  // why: F-212, FR-AUTH-1 a refused page renders the shared page with the gate's status, never the route
  it('hands Next the verdict for a page the gate refuses, with its status: no entry 404, another role 403', async () => {
    const none = await at('/no-such-page');
    expect(none.status).toBe(404);
    const tech = await at('/office/reports', { headers: { cookie: cookies.technician } });
    expect(tech.status).toBe(403);
    const office = await at('/office/reports', { headers: { cookie: cookies.office } });
    expect(office.status).toBe(403);
    expect(seen.map((s) => [s.url, s.verdict])).toEqual([['/no-such-page', 'not_found'], ['/office/reports', 'forbidden'], ['/office/reports', 'forbidden']]);
  });

  // why: F-212, FR-AUTH-1 a page the role may open renders, and a forged verdict header is dropped
  it('renders a page the gate admits, with no verdict, even when the request carries a forged one', async () => {
    const r = await at('/office/reports', { headers: { cookie: cookies.manager, [PAGE_VERDICT_HEADER]: 'forbidden' } });
    expect(r.status).toBe(200);
    const book = await at('/book', { headers: { [PAGE_VERDICT_HEADER]: 'not_found' } });
    expect(book.status).toBe(200);
    expect(seen.map((s) => [s.url, s.verdict])).toEqual([['/office/reports', undefined], ['/book', undefined]]);
  });

  // why: F-212, FR-AUTH-1 a client-side navigation the gate refuses gets no page data: the browser reloads it as a page
  it('answers a refused client-side navigation (RSC) with a plain status, never Next', async () => {
    const r = await at('/office/reports', { headers: { cookie: cookies.technician, rsc: '1' } });
    expect(r.status).toBe(403);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const prefetch = await at('/no-such-page', { headers: { rsc: '1', 'next-router-prefetch': '1' } });
    expect(prefetch.status).toBe(404);
    const ok = await at('/office/reports', { headers: { cookie: cookies.manager, rsc: '1' } });
    expect(ok.status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual(['/office/reports']);
  });

  // why: F-212 the shell preview routes skip the gate only in the harness build, never in the release one
  it('lets the preview routes skip the gate only when serving the harness build', async () => {
    const release = await at('/shell-preview/surface/office');
    expect(release.status).toBe(404);
    const harness = await fetch(`${harnessBase}/shell-preview/surface/office`);
    expect(harness.status).toBe(200);
    expect(seen.map((s) => s.verdict)).toEqual(['not_found', undefined]);
    const gated = await fetch(`${harnessBase}/office/board`, { redirect: 'manual' });
    expect(gated.status).toBe(303); // every other path is still gated in the harness build
  });

  // why: F-227 no request reaches a page render without the gate's verdict, whatever way its path is written
  it('gives /_next/ paths that resolve to a gated page the gate verdict, never a Next render', async () => {
    const shapes = [
      '/_next/../office/board',
      '/_next/%2e%2e/office/board',
      '/_next/%2E%2E/office/board',
      '/_next/%252e%252e/office/board', // double-encoded
      '/_next/%25252e%25252e/office/board', // triple-encoded
      '/_next/static/../../office/board',
      '/_next/static/%2e%2e/%2e%2e/office/board',
      '/_next/..%2foffice/board',
      '/_next/..%5coffice/board',
      '/_next/..\\office/board',
      '/_next/./../office/board',
      '//_next//..//office/board',
      '/%6f%66fice/board',
    ];
    for (const target of shapes) {
      const r = await rawGet(base, target);
      expect([target, r.status, r.location]).toEqual([target, 303, '/sign-in?return=%2Foffice%2Fboard']);
    }
    expect(seen).toEqual([]); // Next rendered nothing
    // the same shapes toward a page the gate refuses for this role keep the gate's refusal, with the page verdict for Next
    const forbidden = await fetch(`${base}/_next/x/%2e%2e/%2e%2e/office/reports`, { headers: { cookie: cookies.technician } });
    expect(forbidden.status).toBe(403);
    expect(seen.map((s) => [s.url, s.verdict])).toEqual([['/office/reports', 'forbidden']]);
  });

  // why: F-227 the harness build's preview prefix is decided on the resolved path too
  it('does not let a dot segment carry a gated page past the harness build preview prefix', async () => {
    for (const target of ['/shell-preview/../office/board', '/shell-preview/%2e%2e/office/board', '/shell-preview/%252e%252e/office/board']) {
      const r = await rawGet(harnessBase, target);
      expect([target, r.status]).toEqual([target, 303]);
    }
    expect(seen).toEqual([]);
  });

  // why: F-227 a path that cannot be read is refused, and a real static asset still goes straight to Next
  it('answers 400 to an unreadable path and still serves a static asset from Next', async () => {
    expect((await rawGet(base, '/_next/%zz/office/board')).status).toBe(400);
    expect((await rawGet(base, '/_next/static/chunks/a%00b.js')).status).toBe(400);
    expect(seen).toEqual([]);
    const asset = await rawGet(base, '/_next/static/chunks/x.js');
    expect(asset.status).toBe(200);
    expect(seen.map((s) => [s.url, s.verdict])).toEqual([['/_next/static/chunks/x.js', undefined]]);
  });

  // why: F-452, FR-MAP-1 the map's glyph and sprite files are answered by this process on the app origin, with no sign-in and never by Next
  it('serves a bundled glyph range and the sprite sheet with their types, and 404 for a file outside the set', async () => {
    const glyph = await at('/map-assets/fonts/Noto%20Sans%20Regular/0-255.pbf');
    expect(glyph.status).toBe(200);
    expect(glyph.headers.get('content-type')).toBe('application/x-protobuf');
    expect((await glyph.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    expectSecurityHeaders(glyph, 'glyph', 'asset');
    const sheet = await at('/map-assets/sprites/light.json');
    expect(sheet.status).toBe(200);
    expect(Object.keys((await sheet.json()) as object)).toContain('arrow');
    expect((await at('/map-assets/sprites/light@2x.png')).headers.get('content-type')).toBe('image/png');
    expect((await at('/map-assets/fonts/Noto%20Sans%20Regular/99999-100000.pbf')).status).toBe(404);
    expect((await rawGet(base, '/map-assets/../server.ts')).status).not.toBe(200);
    expect(seen.filter((s) => s.url.startsWith('/map-assets')).map((s) => s.url)).toEqual([]);
  });

  // why: NFR-09, SD-47 the technician app's manifest and service worker are answered by this process with no sign-in, never by Next or the page gate
  it('serves the technician app\'s manifest and service worker before the page gate', async () => {
    const sw = await at('/tech/sw.js');
    expect([sw.status, sw.headers.get('content-type'), sw.headers.get('service-worker-allowed'), sw.headers.get('cache-control')])
      .toEqual([200, 'text/javascript; charset=utf-8', '/tech', 'no-cache']);
    expect(await sw.text()).toContain("self.addEventListener('fetch'");
    expectSecurityHeaders(sw, 'service worker', 'asset');
    const m = await at('/tech/manifest.webmanifest');
    expect([m.status, ((await m.json()) as { start_url: string }).start_url]).toEqual([200, '/tech']);
    expect(seen.filter((s) => s.url.startsWith('/tech/sw.js') || s.url.startsWith('/tech/manifest')).map((s) => s.url)).toEqual([]);
  });

  // why: F-529 a map-assets read that throws answers that request 500 and the process keeps answering (it was an uncaught exception)
  it('answers 500 when the read of a bundled map file throws, and keeps serving', async () => {
    mapRead.fail = true;
    try {
      const bad = await at('/map-assets/fonts/Noto%20Sans%20Regular/0-255.pbf');
      expect(bad.status).toBe(500);
      expectSecurityHeaders(bad, 'glyph read error', 'asset');
    } finally {
      mapRead.fail = false;
    }
    expect((await at('/map-assets/fonts/Noto%20Sans%20Regular/0-255.pbf')).status).toBe(200);
  });

  // why: K-10 (row K-10.7) a page that throws is logged with its cause code (never its message), not the anonymous server_error
  it('logs the cause code of a page that throws', async () => {
    mode = 'throw-coded';
    k.lines.length = 0;
    const r = await at('/book');
    expect(r.status).toBe(500);
    const errors = k.lines.filter((l) => l['status'] === 'unhandled error');
    expect(errors.map((l) => l['errorCode'])).toEqual(['ERR_RENDER']);
    expect(JSON.stringify(k.lines)).not.toContain('render exploded');
  });

  // why: F-2071 the service worker's failed read is logged with its cause code, not the anonymous server_error, and never its message
  it('logs the cause code of a technician shell asset that fails to read', async () => {
    shellRead.fail = true;
    k.lines.length = 0;
    try {
      const r = await at('/tech/sw.js');
      expect(r.status).toBe(500);
    } finally {
      shellRead.fail = false;
    }
    const errors = k.lines.filter((l) => l['status'] === 'unhandled error');
    expect(errors.map((l) => l['errorCode'])).toEqual(['ENOENT']);
    expect(JSON.stringify(k.lines)).not.toContain('no such file');
  });

  // why: SD-40, F-214 a write to a page is refused before the gate or Next
  it('refuses a write to a page route with 405 and Allow', async () => {
    const r = await at('/office/board', { method: 'POST', body: 'x' });
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET, HEAD');
    expect(seen).toEqual([]);
  });
});

describe('the web process: the 11.5 headers on every answer (F-212 c, F-214)', () => {
  // why: NFR-12, F-214 every page answer carries them, whatever its status, and Next gets the same nonce
  it('puts the CSP, nosniff and no-referrer on page answers of status 200, 303, 403, 404, 405 and 500', async () => {
    const cases: [string, RequestInit, number][] = [
      ['/book', {}, 200],
      ['/office/board', {}, 303],
      ['/office/reports', { headers: { cookie: cookies.technician } }, 403],
      ['/office/reports', { headers: { cookie: cookies.technician, rsc: '1' } }, 403],
      ['/no-such-page', {}, 404],
      ['/office/board', { method: 'POST', body: 'x' }, 405],
    ];
    for (const [p, init, status] of cases) {
      seen.length = 0;
      const r = await at(p, init);
      const where = `${init.method ?? 'GET'} ${p} ${status}`;
      expect(r.status, where).toBe(status);
      const nonce = expectSecurityHeaders(r, where, 'page');
      if (seen[0]) expect(seen[0].csp, where).toBe(pageCsp(nonce!)); // Next reads the nonce from this
    }
    mode = 'error-page';
    const errorPage = await at('/book');
    expect(errorPage.status).toBe(500);
    expectSecurityHeaders(errorPage, 'a 500 page from Next', 'page');
    mode = 'throw';
    const thrown = await at('/book');
    expect(thrown.status).toBe(500);
    expectSecurityHeaders(thrown, 'a render that throws', 'page');
    mode = 'own-csp';
    const own = await at('/book');
    expectSecurityHeaders(own, 'a page that sets its own CSP', 'page');
    const asset = await at('/_next/static/chunks/x.js');
    expectSecurityHeaders(asset, "Next's assets", 'asset');
  });

  // why: NFR-12, F-214 every API answer carries the 11.5 policy unchanged, whatever its status
  it('puts the exact 11.5 headers on API answers of status 200, 401, 403, 404, 422 and 500', async () => {
    const json = { 'content-type': 'application/json', origin: k.deps.settings.APP_ORIGIN };
    const cases: [string, RequestInit, number][] = [
      ['/healthz', {}, 200],
      ['/api/v1/me', {}, 401],
      ['/api/v1/searches', { method: 'POST', headers: { ...json, cookie: cookies.technician }, body: '{"query":"high","branch":"columbus"}' }, 403],
      ['/api/v1/nothing', {}, 404],
      ['/api/v1/me', { method: 'PATCH', headers: { ...json, cookie: cookies.office }, body: '{}' }, 422],
      ['/api/v1/clock', {}, 500],
    ];
    for (const [p, init, status] of cases) {
      const r = await at(p, init);
      const where = `${init.method ?? 'GET'} ${p} ${status}`;
      expect(r.status, where).toBe(status);
      expectSecurityHeaders(r, where, 'api');
    }
  });
});

describe('the web process keeps idle connections longer than nginx does (F-884)', () => {
  // why: F-884; Node closed an idle connection after its default 5 s while nginx kept it for reuse, so a few POSTs per load run answered 502
  it('holds a connection open longer than the proxy\'s upstream keepalive_timeout', () => {
    const conf = readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'infra', 'nginx', 'http.conf'), 'utf8');
    const upstream = /upstream bw_web \{[^}]*\}/.exec(conf)?.[0] ?? '';
    const proxy = /keepalive_timeout\s+(\d+)s;/.exec(upstream);
    expect(proxy, 'the upstream block sets keepalive_timeout').not.toBeNull();
    const server = servers[0]!;
    expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_MS);
    expect(server.keepAliveTimeout).toBeGreaterThan(Number(proxy![1]) * 1000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });
});

describe('the web process at start (F-212 d)', () => {
  // why: NFR-14, SD-3, F-212 a bad setting stops the real process before it listens, naming the setting, never its value
  it('stops with exit 78 and a ConfigError naming the setting for an invalid setting, before Next loads', () => {
    const entry = path.join(import.meta.dirname, 'server.ts');
    const run = (env: Record<string, string>) => spawnSync(process.execPath, [entry], { env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', PORT: '0', ...env }, encoding: 'utf8', timeout: 20_000 });
    const bad = run({ APP_ORIGIN: 'zq9-not-an-origin', DATABASE_URL: 'postgres://bw_web@127.0.0.1:1/brightwater' });
    expect(bad.status).toBe(78);
    expect(bad.stderr).toMatch(/^ConfigError: invalid setting APP_ORIGIN: /m);
    expect(bad.stderr).not.toContain('zq9-not-an-origin');
    expect(bad.stdout).not.toMatch(/listening/);
    const noDb = run({});
    expect(noDb.status).toBe(78);
    expect(noDb.stderr).toMatch(/invalid setting DATABASE_URL/);
    const noFile = run({ DATABASE_URL: 'postgres://bw_web@127.0.0.1:1/brightwater', DATABASE_PASSWORD_FILE: '/nonexistent/password' });
    expect(noFile.status).toBe(78);
    expect(noFile.stderr).toMatch(/^ConfigError: invalid setting DATABASE_PASSWORD_FILE: cannot be read \(ENOENT\)/m);
  }, 60_000); // F-303: 3 node starts, each spawned with a 20 s limit, so the test's own limit is 3 x 20 s, not vitest's 5 s
});
