// SPDX-License-Identifier: AGPL-3.0-or-later
// The handler kernel (SPECIFICATIONS 4.1, SD-6, SD-7, SD-8, SD-47, 7.1, 7.2, 11.5) through its real entry point,
// router.handle, with real sessions resolved by the real session layer (only the store is in memory; the SQL store
// is proved on PostgreSQL 18 in sessions.db.test.ts).
import { addressField, checkAnswer, defineContract, emailByLink, z, type ContractRow } from '@bw/api';
import { describe, expect, it } from 'vitest';
import { issueAccessCookie } from './kernel/access-code.ts';
import { CONTENT_SECURITY_POLICY } from './kernel/headers.ts';
import { checkTable, mount, MountError } from './kernel/mount.ts';
import { pageGate } from './kernel/pages.ts';
import { hashToken, lifetimes } from './kernel/sessions.ts';
import { handlers as realHandlers, tokenChecks } from './handlers/index.ts';
import { api, MANAGER, OFFICE, ONE_TIME, page, PUBLIC, TECHNICIAN, token } from './policy/entry.ts';
import { policyTable } from './policy.ts';
import { ACCESS_KEY, kit, ORIGIN } from './testing.ts';
import type { ApiRequest, Handler, PolicyEntry } from './types.ts';

const row = (id: `API-${number}`, method: ContractRow['method'], path: string, extra: Partial<ContractRow> = {}): ContractRow =>
  defineContract({ id, name: id, method, path, request: z.object({}), response: z.object({ ok: z.boolean() }), errors: [], labels: [], examples: [], ...extra });

const okHandler: Handler<unknown> = async () => ({ ok: true, status: 200, data: { ok: true } });

/** A spy handler: records each call, so a refused request is proved never to reach the handler. */
function spy(result: Handler<unknown> = okHandler) {
  const calls: ApiRequest[] = [];
  const fn: Handler<unknown> = async (req, tx, ctx) => {
    calls.push(req);
    return result(req, tx, ctx);
  };
  return { fn, calls };
}

const reports = row('API-50', 'GET', '/reports');
const enter = row('API-01', 'POST', '/access-code', { successStatus: [204], response: z.undefined() });
const board = row('API-20', 'GET', '/board');
const job = row('API-27', 'PATCH', '/jobs/{jobNumber}', { request: z.object({ jobNumber: z.coerce.number().int(), note: z.string().max(5) }), errors: ['version_conflict'] });
const inbox = row('API-120', 'GET', '/inbox/{inboxToken}/messages');

const json = async (r: Response) => JSON.parse(await r.text()) as Record<string, unknown>;

describe('mount refuses an incomplete table', () => {
  // why: FR-AUTH-1, SD-7
  it('refuses a handler with no entry, an entry with no handler, 2 entries on 1 route and a token entry with no check', () => {
    const table = [api(reports, MANAGER)];
    expect(() => mount(table, { 'API-50': okHandler, 'API-51': okHandler }, kit([], {}).deps)).toThrow(/handler API-51 has no policy entry/);
    expect(() => mount(table, {}, kit([], {}).deps)).toThrow(/policy entry API-50 \(GET \/api\/v1\/reports\) has no handler/);
    const twin = api(row('API-52', 'GET', '/reports'), MANAGER);
    expect(() => checkTable([...table, twin], { 'API-50': okHandler, 'API-52': okHandler })).toThrow(/API-52 and API-50 claim the same route/);
    expect(() => checkTable([api(inbox, token('inbox'))], { 'API-120': okHandler })).toThrow(/API-120 needs a inbox token check/);
    expect(() => checkTable([api(inbox, token('inbox'))], { 'API-120': okHandler }, { inbox: async () => true })).not.toThrow();
    // F-613: a one_time entry needs its link check as a token entry needs its own.
    expect(() => checkTable([api(emailByLink, ONE_TIME)], { 'API-166': okHandler })).toThrow(/API-166 needs a one_time link check/);
    expect(() => checkTable([api(emailByLink, ONE_TIME)], { 'API-166': okHandler }, { one_time: async () => true })).not.toThrow();
    expect(() => mount([api(reports, MANAGER)], { 'API-50': okHandler }, kit([], {}).deps)).not.toThrow(MountError);
  });

  // why: FR-AUTH-1, SD-7
  it('mounts the real policy table with the real handlers, serving exactly the table API entries', () => {
    const k = kit(policyTable, { ...realHandlers });
    expect(k.router.routes.map((r) => r.contract).sort()).toEqual(policyTable.filter((e) => e.kind === 'api').map((e) => (e.kind === 'api' ? e.contract : '')).sort());
  });
});

describe('deny by default and authorize inside the wrapper', () => {
  // why: FR-AUTH-1, SD-6
  it('answers 404 not_found for a route with no entry and for a known path with another method', async () => {
    const k = kit([api(reports, MANAGER)], { 'API-50': okHandler });
    for (const [m, p] of [['GET', '/api/v1/nothing'], ['POST', '/api/v1/reports'], ['GET', '/office/reports'], ['DELETE', '/api/v1/reports']] as const) {
      const r = await k.call(m, p);
      expect(r.status, `${m} ${p}`).toBe(404);
      expect((await json(r)).code).toBe('not_found');
      expect(r.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    }
  });

  // why: FR-AUTH-1, SD-6
  it('gives each role its verdict, and a refused call never reaches the handler', async () => {
    const s = spy();
    const k = kit([api(reports, MANAGER)], { 'API-50': s.fn });
    const tech = await k.signIn('technician');
    const office = await k.signIn('office');
    const manager = await k.signIn('manager');
    expect((await k.call('GET', '/api/v1/reports')).status).toBe(401);
    expect((await k.call('GET', '/api/v1/reports', { headers: { cookie: tech.cookie } })).status).toBe(403);
    expect((await k.call('GET', '/api/v1/reports', { headers: { cookie: office.cookie } })).status).toBe(403);
    expect(s.calls).toHaveLength(0);
    const ok = await k.call('GET', '/api/v1/reports', { headers: { cookie: manager.cookie } });
    expect(ok.status).toBe(200);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.caller).toEqual({ kind: 'staff', userId: manager.userId, role: 'manager', client: 'web', via: 'password' });
  });

  // why: FR-AUTH-1, SD-6
  it('runs a refused handler result in a rolled-back transaction, and turns a code the row may not answer into server_error', async () => {
    const refusing = spy(async () => ({ ok: false, status: 409, code: 'version_conflict' }));
    const k = kit([api(job, OFFICE)], { 'API-27': refusing.fn });
    const o = await k.signIn('office');
    const h = { cookie: o.cookie, origin: ORIGIN };
    const r = await k.call('PATCH', '/api/v1/jobs/2481', { headers: h, body: { note: 'hi' } });
    expect(r.status).toBe(409);
    expect(checkAnswer(job, { status: r.status, body: await json(r) })).toEqual([]);
    expect(k.db.log.slice(-1)).toEqual(['ROLLBACK']);
    expect(refusing.calls[0]!.params).toEqual({ jobNumber: 2481, note: 'hi' });
    const wrong = kit([api(job, OFFICE)], { 'API-27': async () => ({ ok: false, status: 409, code: 'window_full' }) });
    const w = await wrong.signIn('office');
    const r2 = await wrong.call('PATCH', '/api/v1/jobs/1', { headers: { cookie: w.cookie, origin: ORIGIN }, body: { note: 'x' } });
    expect(r2.status).toBe(500);
    expect((await json(r2)).code).toBe('server_error');
  });
});

describe('the access-code gate in the SD-47 order', () => {
  const table: PolicyEntry[] = [api(enter, PUBLIC), api(board, OFFICE), api(reports, PUBLIC)];
  const hs = { 'API-01': (async () => ({ ok: true, status: 204, data: undefined })) as Handler<unknown>, 'API-20': okHandler, 'API-50': okHandler };

  // why: FR-AUTH-6, SD-47, OI-18
  it('lets the 5 before-the-code contracts and the health check through, and refuses every other call until the code', async () => {
    const k = kit(table, hs, { ACCESS_CODE_ON: true });
    expect((await k.call('POST', '/api/v1/access-code')).status).toBe(204);
    const pub = await k.call('GET', '/api/v1/reports');
    expect(pub.status).toBe(403);
    expect((await json(pub)).code).toBe('access_code_required');
    expect((await k.call('GET', '/api/v1/reports', { headers: { cookie: k.accessCookie() } })).status).toBe(200);
    const hk = kit(policyTable, { ...realHandlers }, { ACCESS_CODE_ON: true });
    expect((await hk.call('GET', '/healthz')).status).toBe(200);
  });

  // why: FR-AUTH-6, SD-8, OI-17
  it('lets a password session through without the code, but a sign-in-as session only with the access cookie', async () => {
    const k = kit(table, hs, { ACCESS_CODE_ON: true });
    const named = await k.signIn('office', { via: 'password' });
    expect((await k.call('GET', '/api/v1/board', { headers: { cookie: named.cookie } })).status).toBe(200);
    const demo = await k.signIn('office', { via: 'sign_in_as' });
    const noCode = await k.call('GET', '/api/v1/board', { headers: { cookie: demo.cookie } });
    expect((await json(noCode)).code).toBe('access_code_required');
    expect((await k.call('GET', '/api/v1/board', { headers: { cookie: `${demo.cookie}; ${k.accessCookie()}` } })).status).toBe(200);
  });

  // why: FR-AUTH-6, SD-8
  it('refuses a forged, foreign-key or 30-day-old access cookie, measured in real time, never demo time', async () => {
    const k = kit(table, hs, { ACCESS_CODE_ON: true });
    const good = k.accessCookie();
    const forged = good.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await json(await k.call('GET', '/api/v1/reports', { headers: { cookie: forged } }))).code).toBe('access_code_required');
    const foreign = issueAccessCookie('x'.repeat(43), k.clock, true).split(';')[0]!;
    expect((await json(await k.call('GET', '/api/v1/reports', { headers: { cookie: foreign } }))).code).toBe('access_code_required');
    k.clock.set('2027-03-01T00:00:00Z'); // a demo clock jump of months: the cookie still counts
    expect((await k.call('GET', '/api/v1/reports', { headers: { cookie: good } })).status).toBe(200);
    k.clock.setReal('2026-12-01T11:59:00Z'); // 29 days 23 h 59 min of real time
    expect((await k.call('GET', '/api/v1/reports', { headers: { cookie: good } })).status).toBe(200);
    k.clock.setReal('2026-12-01T12:00:00Z'); // 30 real days
    expect((await json(await k.call('GET', '/api/v1/reports', { headers: { cookie: good } }))).code).toBe('access_code_required');
    expect(k.deps.accessKey).toBe(ACCESS_KEY);
  });
});

describe('sessions (SD-8)', () => {
  // why: FR-AUTH-10, SD-8
  it('has the SD-8 lifetimes', () => {
    const h = (d: { total(u: 'hours'): number }) => d.total('hours');
    expect([h(lifetimes('office', false).idle), h(lifetimes('office', false).length)]).toEqual([0.5, 12]);
    expect([h(lifetimes('manager', false).idle), h(lifetimes('manager', false).length)]).toEqual([0.5, 12]);
    expect([h(lifetimes('technician', false).idle), h(lifetimes('technician', false).length)]).toEqual([8, 14]);
    expect([h(lifetimes('office', true).idle), h(lifetimes('technician', true).length)]).toEqual([720, 2160]);
  });

  // why: FR-AUTH-10, SD-8
  it('ends an office session after 30 idle real minutes, never on a demo clock jump, and removes it', async () => {
    const k = kit([api(board, OFFICE)], { 'API-20': okHandler });
    const o = await k.signIn('office');
    const call = () => k.call('GET', '/api/v1/board', { headers: { cookie: o.cookie } });
    k.clock.set('2026-12-25T09:00:00Z');
    expect((await call()).status).toBe(200);
    k.clock.advance({ minutes: 29 });
    expect((await call()).status).toBe(200); // seen again: the idle limit restarts
    k.clock.advance({ minutes: 29 });
    expect((await call()).status).toBe(200);
    k.clock.advance({ minutes: 31 });
    expect((await call()).status).toBe(401);
    expect(k.sessions.sessions.has(hashToken(o.token).toString('hex'))).toBe(false);
  });

  // why: FR-AUTH-10, SD-8
  it('ends a session at its length even when it is never idle, and keeps a Keep me signed in session for 30 idle days', async () => {
    const k = kit([api(board, OFFICE)], { 'API-20': okHandler });
    const o = await k.signIn('office');
    const kept = await k.signIn('manager', { keep: true });
    for (let i = 0; i < 24; i++) {
      expect((await k.call('GET', '/api/v1/board', { headers: { cookie: o.cookie } })).status, `step ${i}`).toBe(200);
      k.clock.advance({ minutes: 29 });
    }
    expect((await k.call('GET', '/api/v1/board', { headers: { cookie: o.cookie } })).status).toBe(200); // 11 h 36 min, seen every 29 min
    k.clock.advance({ minutes: 25 });
    expect((await k.call('GET', '/api/v1/board', { headers: { cookie: o.cookie } })).status).toBe(401); // 12 h 01 min: the length ends it
    k.clock.advance({ hours: 29 * 24 });
    expect((await k.call('GET', '/api/v1/board', { headers: { cookie: kept.cookie } })).status).toBe(200);
  });

  // why: SD-8, FR-AUTH-12
  it('takes a bearer token only for a native session and a cookie only for a web one, and no session of a user who is not active', async () => {
    const k = kit([api(board, OFFICE)], { 'API-20': okHandler });
    const native = await k.signIn('office', { client: 'native' });
    const web = await k.signIn('office');
    const off = await k.signIn('office', { status: 'turned_off' });
    expect((await k.call('GET', '/api/v1/board', { headers: { authorization: `Bearer ${native.token}` } })).status).toBe(200);
    expect((await k.call('GET', '/api/v1/board', { headers: { cookie: native.cookie } })).status).toBe(401);
    expect((await k.call('GET', '/api/v1/board', { headers: { authorization: `Bearer ${web.token}` } })).status).toBe(401);
    expect((await k.call('GET', '/api/v1/board', { headers: { cookie: off.cookie } })).status).toBe(401);
    expect((await k.call('GET', '/api/v1/board', { headers: { cookie: 'bw_session=not-a-token' } })).status).toBe(401);
  });
});

describe('Origin check, rate limits and validation', () => {
  // why: SD-8
  it('refuses a cookie-carrying write without the app origin, and lets a bearer write through', async () => {
    const k = kit([api(job, OFFICE)], { 'API-27': okHandler });
    const o = await k.signIn('office');
    const n = await k.signIn('office', { client: 'native' });
    const body = { note: 'ok' };
    expect((await json(await k.call('PATCH', '/api/v1/jobs/1', { headers: { cookie: o.cookie }, body }))).code).toBe('forbidden');
    expect((await k.call('PATCH', '/api/v1/jobs/1', { headers: { cookie: o.cookie, origin: 'https://evil.example' }, body })).status).toBe(403);
    expect((await k.call('PATCH', '/api/v1/jobs/1', { headers: { cookie: o.cookie, origin: ORIGIN }, body })).status).toBe(200);
    expect((await k.call('PATCH', '/api/v1/jobs/1', { headers: { authorization: `Bearer ${n.token}` }, body })).status).toBe(200);
  });

  // why: SD-4, FR-AUTH-6
  it('limits API-01 to 10 a minute per address in real time, which a demo clock jump never resets', async () => {
    const k = kit([api(enter, PUBLIC)], { 'API-01': async () => ({ ok: true, status: 204, data: undefined }) });
    for (let i = 0; i < 10; i++) expect((await k.call('POST', '/api/v1/access-code')).status).toBe(204);
    k.clock.set('2027-01-01T00:00:00Z');
    const r = await k.call('POST', '/api/v1/access-code');
    expect(r.status).toBe(429);
    expect((await json(r)).code).toBe('rate_limited');
    const other = await k.router.handle(new Request('http://web:3000/api/v1/access-code', { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.9' } }));
    expect(other.status).toBe(204);
    k.clock.advance({ seconds: 61 });
    expect((await k.call('POST', '/api/v1/access-code')).status).toBe(204);
  });

  // why: SD-4, FR-AUTH-11
  it('limits sign-in to 20 an hour per login across addresses', async () => {
    const signIn = row('API-03', 'POST', '/sessions', { request: z.object({ login: z.string() }), successStatus: [200] });
    const k = kit([api(signIn, PUBLIC)], { 'API-03': okHandler });
    const from = (i: number, login: string) => k.router.handle(new Request('http://web:3000/api/v1/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i}` }, body: JSON.stringify({ login }),
    }));
    for (let i = 0; i < 20; i++) expect((await from(i, 'maria@example.test')).status, `try ${i}`).toBe(200);
    expect((await from(99, 'Maria@Example.test')).status).toBe(429);
    expect((await from(98, 'kim@example.test')).status).toBe(200);
  });

  // why: SD-6, SD-5
  it('answers validation_failed with the fields for a bad body, a non-JSON body and a bad path parameter', async () => {
    const k = kit([api(job, OFFICE)], { 'API-27': okHandler });
    const o = await k.signIn('office');
    const h = { cookie: o.cookie, origin: ORIGIN };
    const tooLong = await json(await k.call('PATCH', '/api/v1/jobs/1', { headers: h, body: { note: 'far too long' } }));
    expect(tooLong.code).toBe('validation_failed');
    expect(tooLong.fields).toEqual([{ field: 'note', problem: 'too_big' }]);
    expect((await json(await k.call('PATCH', '/api/v1/jobs/1', { headers: { ...h, 'content-type': 'text/plain' }, body: 'note=x' }))).fields).toEqual([{ field: '$', problem: 'not_json' }]);
    expect((await json(await k.call('PATCH', '/api/v1/jobs/abc', { headers: h, body: { note: 'x' } }))).fields).toEqual([{ field: 'jobNumber', problem: 'invalid_type' }]);
  });
});

describe('the answer: envelope, labels, headers, log', () => {
  const homes = row('API-23', 'GET', '/jobs/{jobNumber}', {
    request: z.object({ jobNumber: z.coerce.number() }), response: z.object({ home: addressField() }), labels: ['simulated_pilot_data'],
  });

  // why: SD-5, SD-6
  it('wraps the answer in the envelope with the row labels, fictional_addresses for an address field, and demo_mode on the web only', async () => {
    const k = kit([api(homes, OFFICE)], { 'API-23': async () => ({ ok: true, status: 200, data: { home: '12 Elm St' }, labels: ['entered_offline', 'demo_mode'] }) }, { DEMO_MODE: true });
    const web = await k.signIn('office');
    const r = await k.call('GET', '/api/v1/jobs/2481', { headers: { cookie: web.cookie } });
    const body = await json(r);
    expect(checkAnswer(homes, { status: r.status, body })).toEqual([]);
    expect(body.meta).toEqual({
      contract: 'API-23', worldEpoch: 3, demoNow: '2026-09-15T10:28:00-04:00[America/New_York]',
      viewer: { kind: 'staff', userId: web.userId, role: 'office' }, labels: ['simulated_pilot_data', 'fictional_addresses', 'entered_offline', 'demo_mode'],
    });
    const native = await k.signIn('office', { client: 'native' });
    const n = await json(await k.call('GET', '/api/v1/jobs/2481', { headers: { authorization: `Bearer ${native.token}` } }));
    expect((n.meta as { labels: string[] }).labels).not.toContain('demo_mode');
  });

  // why: SD-5
  it('answers server_error when the handler throws, breaks the response schema or answers an undeclared status', async () => {
    for (const h of [
      (async () => { throw new Error('6145550100 at 12 Elm St'); }) as Handler<unknown>,
      (async () => ({ ok: true, status: 200, data: { ok: 'yes' } })) as Handler<unknown>,
      (async () => ({ ok: true, status: 201, data: { ok: true } })) as Handler<unknown>,
    ]) {
      const k = kit([api(board, PUBLIC)], { 'API-20': h });
      const r = await k.call('GET', '/api/v1/board');
      expect(r.status).toBe(500);
      expect(checkAnswer(board, { status: 500, body: await json(r) })).toEqual([]);
      expect(JSON.stringify(k.lines)).not.toMatch(/6145550100|Elm/);
    }
  });

  // why: SD-8, FR-AUTH-1 (F-289: only the sign-in rows may set a cookie, and only theirs)
  it('answers server_error for a Set-Cookie from a row outside the allow-list or a name the row may not set, and hands API-20 no key or token', async () => {
    const seen: unknown[] = [];
    const cookie = (c: string) => (async (_r, _t, ctx) => { seen.push(ctx.accessKey, ctx.presented); return { ok: true, status: 200, data: { ok: true }, cookies: [c] }; }) as Handler<unknown>;
    const stray = kit([api(board, PUBLIC)], { 'API-20': cookie('bw_session=abc; Path=/') });
    const r = await stray.call('GET', '/api/v1/board');
    expect(r.status).toBe(500);
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(seen).toEqual([null, null]);
    const wrongName = kit([api(enter, PUBLIC)], { 'API-01': (async () => ({ ok: true, status: 204, data: undefined, cookies: ['bw_session=abc'] })) as Handler<unknown> });
    expect((await wrongName.call('POST', '/api/v1/access-code')).status).toBe(500);
  });

  // why: NFR-12, SD-6
  it('puts the 11.5 headers and no-store on every answer: success, Problem, 204 and 404', async () => {
    const k = kit([api(enter, PUBLIC), api(board, PUBLIC)], { 'API-01': (async () => ({ ok: true, status: 204, data: undefined })) as Handler<unknown>, 'API-20': okHandler });
    for (const r of [await k.call('GET', '/api/v1/board'), await k.call('POST', '/api/v1/access-code'), await k.call('GET', '/api/v1/x'), await k.call('POST', '/api/v1/access-code', { body: '[' })]) {
      expect(r.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
  });

  // why: NFR-05, SD-42
  it('logs 1 line per call with the route template, never the filled path, and the user id of a staff caller', async () => {
    const k = kit([api(homes, OFFICE)], { 'API-23': async () => ({ ok: true, status: 200, data: { home: '12 Elm St' } }) });
    const o = await k.signIn('office');
    await k.call('GET', '/api/v1/jobs/2481?phone=6145550100', { headers: { cookie: o.cookie } });
    expect(k.lines).toHaveLength(1);
    const line = k.lines[0]!;
    expect(line).toMatchObject({ level: 'info', process: 'web', contract: 'API-23', route: '/api/v1/jobs/{jobNumber}', status: 200, userId: o.userId });
    expect(Object.keys(line).sort()).toEqual(['contract', 'demoTime', 'durationMs', 'level', 'process', 'realTime', 'route', 'status', 'userId']);
    expect(JSON.stringify(k.lines)).not.toMatch(/2481|6145550100|Elm/);
  });
});

describe('link tokens and the health check', () => {
  // why: FR-AUTH-2, NFR-05
  it('answers a link-token route only for a valid token, inside the call transaction, with a token viewer', async () => {
    const seen: string[] = [];
    const k = kit([api(inbox, token('inbox'))], { 'API-120': okHandler }, {}, { inbox: async (t) => (seen.push(t), t === 'good-token') });
    const bad = await k.call('GET', '/api/v1/inbox/bad-token/messages');
    expect(bad.status).toBe(404);
    const good = await json(await k.call('GET', '/api/v1/inbox/good-token/messages'));
    expect((good.meta as { viewer: unknown }).viewer).toEqual({ kind: 'token', tokenKind: 'inbox' });
    expect(seen).toEqual(['bad-token', 'good-token']);
  });

  // why: NFR-11, SD-40, F-215
  it('answers the health check with the plain 7.4 body after a database round trip, and 503 server_error when the database is down', async () => {
    const k = kit(policyTable, { ...realHandlers });
    const r = await k.call('GET', '/healthz');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"status":"ok"}');
    expect(k.db.log).toEqual(['BEGIN', 'SELECT beat_real FROM system.worker_heartbeat WHERE id = 1', 'COMMIT']);
    k.db.fail = true;
    const down = await k.call('GET', '/healthz');
    expect(down.status).toBe(503);
    expect((await json(down)).code).toBe('server_error');
  });

  // why: NFR-11, F-99
  it('answers 503 with no product data when the worker heartbeat is missing or 60 s old, and 200 at 59 s', async () => {
    const k = kit(policyTable, { ...realHandlers });
    k.db.heartbeat = new Date('2026-11-01T11:59:01Z');
    expect((await k.call('GET', '/healthz')).status).toBe(200);
    k.db.heartbeat = new Date('2026-11-01T11:59:00Z');
    const stale = await k.call('GET', '/healthz');
    expect(stale.status).toBe(503);
    expect(await json(stale)).toMatchObject({ status: 503, code: 'server_error' });
    k.db.heartbeat = null;
    expect((await k.call('GET', '/healthz')).status).toBe(503);
  });
});

describe('page gate (2.4, 4.2, SD-47)', () => {
  const gate = pageGate([
    page('SCR-OFC-01', '/sign-in', PUBLIC, true), page('SCR-TEC-01', '/tech/sign-in', PUBLIC, true), page('SCR-TEC-11', '/tech/install', PUBLIC),
    page('SCR-GATE-02', '/', PUBLIC), page('SCR-OFC-11', '/office/reports', MANAGER), page('SCR-TEC-02', '/tech', TECHNICIAN),
    page('SCR-OFC-04', '/office/jobs/new', OFFICE), page('SCR-OFC-03', '/office/jobs/{jobNumber}', OFFICE),
  ]);
  const anon = { kind: 'anonymous' } as const;
  const tech = { kind: 'staff', userId: 't', role: 'technician', client: 'web', via: 'password' } as const;
  const off = { codeOn: false, codeEntered: false };
  const on = { codeOn: true, codeEntered: false };

  // why: FR-AUTH-1, F-4
  it('refuses a technician the reports page, sends a signed-out person to sign in with a return path, and 404s an unknown route', () => {
    expect(gate.verdict('/office/reports', tech, off)).toEqual({ kind: 'forbidden', screen: 'SCR-SHR-01', status: 403 });
    expect(gate.verdict('/office/reports', anon, off)).toEqual({ kind: 'redirect', to: '/sign-in?return=%2Foffice%2Freports', status: 303 });
    expect(gate.verdict('/office/nothing', tech, off)).toEqual({ kind: 'not_found', screen: 'SCR-SHR-02', status: 404 });
    expect(gate.verdict('/office/jobs/new', anon, off)).toMatchObject({ kind: 'redirect' });
    expect(gate.match('/office/jobs/new')?.screen).toBe('SCR-OFC-04');
    expect(gate.match('/office/jobs/2481')?.screen).toBe('SCR-OFC-03');
  });

  // why: OI-18, SD-47, FR-AUTH-6
  it('follows the SD-47 order: sign-in pages without the code, the gate before any other page, and the technician app straight to its sign-in', () => {
    expect(gate.verdict('/sign-in', anon, on)).toEqual({ kind: 'render', screen: 'SCR-OFC-01', status: 200 });
    expect(gate.verdict('/tech/sign-in', anon, on)).toEqual({ kind: 'render', screen: 'SCR-TEC-01', status: 200 });
    expect(gate.verdict('/', anon, on)).toEqual({ kind: 'gate', screen: 'SCR-GATE-01', status: 403 });
    expect(gate.verdict('/office/reports', anon, on)).toEqual({ kind: 'gate', screen: 'SCR-GATE-01', status: 403 });
    expect(gate.verdict('/tech/install', anon, on)).toEqual({ kind: 'gate', screen: 'SCR-GATE-01', status: 403 });
    expect(gate.verdict('/tech', anon, on)).toEqual({ kind: 'redirect', to: '/tech/sign-in?return=%2Ftech', status: 303 });
    expect(gate.verdict('/', anon, { codeOn: true, codeEntered: true })).toEqual({ kind: 'render', screen: 'SCR-GATE-02', status: 200 });
    expect(gate.verdict('/office/reports', { ...tech, role: 'manager' }, on)).toEqual({ kind: 'render', screen: 'SCR-OFC-11', status: 200 });
  });
});

describe('a missing clock row (a fresh database before setup)', () => {
  const noClockRow = (k: ReturnType<typeof kit>) => {
    const gone = async (): Promise<never> => { throw new Error('system.demo_clock has no row'); };
    k.clock.demoNow = gone;
    k.clock.worldEpoch = gone;
  };

  // why: F-244 the clock row was read before the auth check, so with no row every enveloped row answered 500 instead of its contract's answer
  it('answers a signed-out GET /me 401, PATCH /me 200 and POST /searches 401, and API-10 stays 500', async () => {
    const k = kit(policyTable, { ...realHandlers });
    noClockRow(k);
    expect((await k.call('GET', '/api/v1/me')).status).toBe(401);
    const patch = await k.call('PATCH', '/api/v1/me', { body: { language: 'es' } });
    expect(patch.status).toBe(200);
    expect((await json(patch)).data).toEqual({ language: 'es', slashShortcut: 'on' });
    expect((await k.call('POST', '/api/v1/searches', { body: {} })).status).toBe(401);
    expect((await k.call('GET', '/api/v1/clock')).status).toBe(500);
  });
});

describe('POST /board-delay-samples through the real kernel (F-450)', () => {
  // why: F-450 (FR-HLTH-3, SD-43) the kernel hands the bus to API-172 and the route stores the sample: an office caller's post inserts and
  // prunes, a technician's is 403 and stores nothing (the handler's own test calls the handler and skips the route)
  it('hands the bus to the handler for an office caller, and refuses a technician and a signed-out caller', async () => {
    const emit = Date.parse('2026-11-01T11:59:58.000Z'); // the kit's real clock is 2026-11-01T12:00:00Z
    const k = kit(policyTable, { ...realHandlers }, {}, tokenChecks, { events: { emitTime: (seq: number) => (seq === 7 ? emit : undefined) } as never });
    const office = await k.signIn('office');
    const post = (cookie?: string, seq = 7) => k.call('POST', '/api/v1/board-delay-samples', { body: { seq }, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
    const inserts = () => k.db.log.filter((q) => q.includes('INSERT INTO system.delay_sample')).length;
    const ok = await post(office.cookie);
    expect(ok.status).toBe(204);
    expect(inserts()).toBe(1);
    expect(k.db.log.some((q) => q.includes('DELETE FROM system.delay_sample'))).toBe(true);
    expect((await post(office.cookie, 8)).status).toBe(204); // a seq the process does not hold: 204, stores nothing
    expect(inserts()).toBe(1);
    const tech = await k.signIn('technician');
    expect((await post(tech.cookie)).status).toBe(403);
    expect((await post()).status).toBe(401);
    expect(inserts()).toBe(1);
  });
});

describe('the clock row a request is stamped from (F-543)', () => {
  // why: F-543 (SPECIFICATIONS 4.2) a write drops the process's cached clock row before it reads demo time, so a clock moved by another
  // process (the worker ends a replay) is in the time the write runs at; a read keeps the cache
  it('reads the clock row fresh for a write and not for a read', async () => {
    const k = kit(policyTable, { ...realHandlers });
    const order: string[] = [];
    const clock = k.clock as unknown as { invalidate: () => void; demoNow: () => Promise<unknown> };
    const demoNow = clock.demoNow.bind(k.clock);
    clock.invalidate = () => { order.push('invalidate'); };
    clock.demoNow = () => { order.push('demoNow'); return demoNow() as Promise<unknown>; };
    await k.call('GET', '/api/v1/me');
    expect(order).not.toContain('invalidate');
    order.length = 0;
    await k.call('PATCH', '/api/v1/me', { body: { language: 'es' } });
    expect(order.slice(0, 2)).toEqual(['invalidate', 'demoNow']);
  });
});

describe('the 1 shared route of 12.2 (API-80 and API-84 on POST /import/runs) and a file answer (API-83)', () => {
  const dry = row('API-80', 'POST', '/import/runs', {
    request: z.object({ kind: z.literal('dry_run') }), response: z.object({ runId: z.string() }), successStatus: [202],
    selector: { field: 'kind', value: 'dry_run' }, errors: ['run_in_progress'],
  });
  const real = row('API-84', 'POST', '/import/runs', {
    request: z.object({ kind: z.literal('real') }), response: z.object({ runId: z.string() }), successStatus: [202],
    selector: { field: 'kind', value: 'real' }, errors: ['run_in_progress', 'real_run_exists'],
  });
  const answer = (runId: string): Handler<unknown> => async () => ({ ok: true, status: 202, data: { runId } });

  // why: SD-7, FR-IMP-1, FR-IMP-10
  it('serves both rows on 1 route, each request to the row its kind selects, and refuses a table whose shared rows cannot be told apart', async () => {
    const a = spy(answer('dry'));
    const b = spy(answer('real'));
    const k = kit([api(dry, OFFICE), api(real, OFFICE)], { 'API-80': a.fn, 'API-84': b.fn });
    const office = await k.signIn('office');
    const post = (body: unknown) => k.call('POST', '/api/v1/import/runs', { headers: { cookie: office.cookie, origin: ORIGIN }, body });
    const r1 = await post({ kind: 'dry_run' });
    expect(r1.status).toBe(202);
    expect(await json(r1)).toMatchObject({ data: { runId: 'dry' }, meta: { contract: 'API-80' } });
    const r2 = await post({ kind: 'real' });
    expect(await json(r2)).toMatchObject({ data: { runId: 'real' }, meta: { contract: 'API-84' } });
    // no kind, another kind, not JSON: the first row's own pipeline answers validation_failed, and no handler runs again
    for (const body of [{}, { kind: 'nightly' }, 'not json']) {
      const r = await post(body);
      expect(r.status).toBe(422);
      expect((await json(r)).code).toBe('validation_failed');
    }
    expect([a.calls.length, b.calls.length]).toEqual([1, 1]);
    // authorization still comes first on a shared route: signed out is 401, a technician 403, before any body is acted on
    expect((await k.call('POST', '/api/v1/import/runs', { body: { kind: 'real' } })).status).toBe(401);
    const tech = await k.signIn('technician');
    expect((await k.call('POST', '/api/v1/import/runs', { headers: { cookie: tech.cookie, origin: ORIGIN }, body: { kind: 'real' } })).status).toBe(403);
    expect([a.calls.length, b.calls.length]).toEqual([1, 1]);

    const h = { 'API-80': okHandler, 'API-84': okHandler };
    const plain = row('API-84', 'POST', '/import/runs');
    expect(() => checkTable([api(dry, OFFICE), api(plain, OFFICE)], h)).toThrow(/API-84 and API-80 claim the same route/);
    const same = row('API-84', 'POST', '/import/runs', { selector: { field: 'kind', value: 'dry_run' } });
    expect(() => checkTable([api(dry, OFFICE), api(same, OFFICE)], h)).toThrow(/claim the same route|repeat a selector value/);
    const otherField = row('API-84', 'POST', '/import/runs', { selector: { field: 'mode', value: 'real' } });
    expect(() => checkTable([api(dry, OFFICE), api(otherField, OFFICE)], h)).toThrow(/claim the same route/);
    expect(() => checkTable([api(dry, OFFICE), api(real, OFFICE)], h)).not.toThrow();
  });

  // why: FR-IMP-2, SD-5
  it("writes a file row's text as the body with its media type as an attachment, and still answers its errors as a Problem", async () => {
    const file = row('API-83', 'GET', '/import/runs/{runId}/problems', {
      request: z.object({ runId: z.string() }), response: z.string(), envelope: false,
      file: { contentType: 'text/csv', name: 'problem-list.csv' },
    });
    const k = kit([api(file, OFFICE)], { 'API-83': async () => ({ ok: true, status: 200, data: 'file,row_number\r\ncustomers.csv,2\r\n' }) });
    const office = await k.signIn('office');
    const r = await k.call('GET', '/api/v1/import/runs/r1/problems', { headers: { cookie: office.cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="problem-list.csv"');
    expect(r.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(await r.text()).toBe('file,row_number\r\ncustomers.csv,2\r\n');
    const out = await k.call('GET', '/api/v1/import/runs/r1/problems');
    expect(out.status).toBe(401);
    expect(out.headers.get('content-type')).toBe('application/problem+json');
    expect(checkAnswer(file, { status: 401, body: await json(out) })).toEqual([]);
  });
});
