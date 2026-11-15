// SPDX-License-Identifier: AGPL-3.0-or-later
// The sign-in handlers (P2-AUTH: API-01 to API-06, API-15 and the access-code gate) on the real database (PostgreSQL 18, the
// migrated schema), through the production kernel (createWebKernel: the real policy table, handlers, SQL sessions and clock)
// as the web process's own login bw_web. The user rows are inserted here with real scrypt hashes. Run by gate G-CI7 step 3
// (ci/gates/G-CI7/vitest.db.config.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@bw/config';
import { hashPassword, samplePassword, showSamplePassword, type Queryable } from '@bw/db';
import { createLogger } from '@bw/log';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { createWebKernel, type WebKernel } from '../web.ts';

const db = useMigratedDatabase();
const ORIGIN = 'http://localhost:8080'; // APP_ORIGIN's default (section 11.1)
const SEED = 'test-sample-seed-0123456789';
const CODE = 'the-test-access-code';
const KEY = 'k'.repeat(43);
const REVIEWER_PASSWORD = 'reviewer-example-26';
const asWeb = () => {
  const u = new URL(db.url());
  u.username = 'bw_web';
  return u.toString();
};
const config = (o: Record<string, string> = {}) => loadConfig({ DATABASE_URL: asWeb(), SAMPLE_PASSWORD_SEED: SEED, ...o });

const kernels: WebKernel[] = [];
const lines: string[] = [];
const log = createLogger({ process: 'web', write: (l) => lines.push(l) });
/** The production kernel with the code and demo mode as given. */
async function kernel(o: { code?: boolean; demo?: boolean } = {}): Promise<WebKernel> {
  const env: Record<string, string> = {};
  if (o.code) Object.assign(env, { ACCESS_CODE_ON: 'on', ACCESS_CODE: CODE, ACCESS_COOKIE_KEY: KEY });
  if (o.demo) env.DEMO_MODE = 'on';
  const k = createWebKernel({ settings: config(env), log });
  kernels.push(k);
  // The first call waits for the access code to be stored; make it now so each test starts with the gate ready.
  await k.router.handle(new Request('http://web:3000/api/v1/app-info'));
  return k;
}
afterAll(async () => {
  await Promise.all(kernels.map((k) => k.close()));
});

let n = 0;
const address = () => `198.51.100.${++n % 250}`;
const call = (k: WebKernel, method: string, path: string, body?: unknown, cookie?: string) =>
  k.router.handle(
    new Request(`http://web:3000${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'GET' ? {} : { origin: ORIGIN }), ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { address: address() },
  );
const json = async <T>(r: Response) => (await r.json()) as T;
const data = async <T>(r: Response) => (await json<{ data: T }>(r)).data;
const code = async (r: Response) => (await json<{ code: string }>(r)).code;
const setCookies = (r: Response) => r.headers.getSetCookie();
/** The name=value pair of a Set-Cookie list, for the Cookie header of the next call. */
const pair = (r: Response, name: string) => setCookies(r).find((c) => c.startsWith(`${name}=`))?.split(';')[0];

const emails = {
  dana: 'dana.ruiz@brightwater.example', keisha: 'keisha.t@brightwater.example', ana: 'ana.gutierrez@brightwater.example', maria: 'maria.santos@brightwater.example',
  luis: 'luis.ortega@brightwater.example', derek: 'derek.simmons@brightwater.example', omar: 'omar.haddad@brightwater.example',
  reviewer: 'reviewer@brightwater.example',
  // F-283: the rest of the start page's curated 5 (Teresa has no technician row in the seed, F-270), and sample technicians
  // outside the 5 who can sign in (Greg, Ben) or are turned off (Nora).
  ryan: 'ryan.mitchell@brightwater.example', teresa: 'teresa.molina@brightwater.example',
  // F-281: seeded as an actor of the approved pages (F-272); in no Sign in as list.
  marco: 'marco.p@brightwater.example',
  greg: 'greg.hoffman@brightwater.example', ben: 'ben.adler@brightwater.example', nora: 'nora.quinn@brightwater.example',
};
const sample = (email: string) => samplePassword(SEED, email);
const ids: Record<string, string> = {};

async function insertUser(
  a: Queryable,
  u: { email: string; name: string; role: string; employee?: string; title?: string; password: string | null; status?: string; sample?: boolean; reviewer?: boolean; language?: string; branch?: string },
) {
  const r = await a.query<{ id: string }>(
    `INSERT INTO world."user" (email, name, name_search, password_hash, role, branch_id, language, status, employee_number, title, sample, reviewer)
     VALUES ($1, $2, lower($2), $3, $4, $11, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [u.email, u.name, u.password === null ? null : await hashPassword(u.password), u.role, u.language ?? 'en', u.status ?? 'active', u.employee ?? null, u.title ?? null, u.sample ?? true, u.reviewer ?? false, u.branch ?? 'columbus'],
  );
  ids[u.email] = r.rows[0]!.id;
}

beforeAll(async () => {
  const a = db.admin();
  await a.query(`INSERT INTO world.branch (id, name_key, zone, office_phone, depot_lon, depot_lat, map_file)
                 VALUES ('columbus', 'branch.columbus', 'America/New_York', '(614) 555-0100', -83.0, 39.96, 'x.pmtiles'),
                        ('dayton', 'branch.dayton', 'America/New_York', '(937) 555-0101', -84.19, 39.76, 'y.pmtiles'),
                        ('springfield', 'branch.springfield', 'America/New_York', '(937) 555-0102', -83.81, 39.92, 'z.pmtiles')`);
  await a.query(`INSERT INTO system.demo_clock (id, demo_anchor, real_anchor, rate, paused, world_epoch, pbs_epoch, last_move_by_name,
                   last_move_kind, last_move_to, last_move_real, last_reset_real, last_write_real)
                 VALUES (1, '2026-09-15T14:28:00Z', now(), 1, false, 3, 3, 'Dana Ruiz', 'jump', '2026-09-15T14:28:00Z', now(), now() - interval '100 seconds', now())`);
  await insertUser(a, { email: emails.dana, name: 'Dana Ruiz', role: 'manager', title: 'Director of Operations', password: sample(emails.dana) });
  await insertUser(a, { email: emails.keisha, name: 'Keisha Thompson', role: 'office', title: 'Dispatcher', password: sample(emails.keisha) });
  await insertUser(a, { email: emails.ana, name: 'Ana Gutierrez', role: 'office', title: 'Customer service', password: sample(emails.ana), language: 'es' });
  await insertUser(a, { email: emails.maria, name: 'Maria Santos', role: 'technician', employee: '40712', password: sample(emails.maria) });
  await insertUser(a, { email: emails.luis, name: 'Luis Ortega', role: 'technician', employee: '40708', password: sample(emails.luis), language: 'es' });
  await insertUser(a, { email: emails.derek, name: 'Derek Simmons', role: 'technician', password: null, status: 'invited' });
  await insertUser(a, { email: emails.omar, name: 'Omar Haddad', role: 'office', password: sample(emails.omar), status: 'turned_off' });
  await insertUser(a, { email: emails.reviewer, name: 'App Reviewer', role: 'technician', password: REVIEWER_PASSWORD, sample: false, reviewer: true });
  await insertUser(a, { email: emails.ryan, name: 'Ryan Mitchell', role: 'technician', password: sample(emails.ryan) });
  await insertUser(a, { email: emails.teresa, name: 'Teresa Molina', role: 'technician', password: sample(emails.teresa), language: 'es', branch: 'springfield' });
  await insertUser(a, { email: emails.greg, name: 'Greg Hoffman', role: 'technician', password: sample(emails.greg) });
  await insertUser(a, { email: emails.ben, name: 'Ben Adler', role: 'technician', password: sample(emails.ben), branch: 'dayton' });
  await insertUser(a, { email: emails.marco, name: 'Marco P.', role: 'office', title: 'Customer service', password: sample(emails.marco) });
  await insertUser(a, { email: emails.nora, name: 'Nora Quinn', role: 'technician', password: sample(emails.nora), status: 'turned_off' });
}, 120_000);

const signInBody = (login: string, password: string, extra: Record<string, unknown> = {}) => ({ login, password, client: 'web', ...extra });

describe('API-03 sign in', () => {
  // why: FR-AUTH-3 the password is checked against its scrypt hash and stored only as that hash
  it('signs in with the right password, refuses a wrong one, and the table holds only scrypt hashes', async () => {
    const k = await kernel();
    const ok = await call(k, 'POST', '/api/v1/sessions', signInBody(emails.dana, sample(emails.dana)));
    expect(ok.status).toBe(200);
    expect(await data<{ user: { name: string; role: string }; token: null }>(ok)).toMatchObject({ user: { name: 'Dana Ruiz', role: 'manager' }, token: null });
    expect(pair(ok, 'bw_session')).toMatch(/^bw_session=[A-Za-z0-9_-]{43}$/);
    const bad = await call(k, 'POST', '/api/v1/sessions', signInBody(emails.dana, 'not-the-password'));
    expect(bad.status).toBe(401);
    expect(await code(bad)).toBe('credentials_invalid');
    const hashes = await db.admin().query<{ password_hash: string }>('SELECT password_hash FROM world."user" WHERE password_hash IS NOT NULL');
    expect(hashes.rows.length).toBeGreaterThan(3);
    for (const h of hashes.rows) expect(h.password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    // The session row holds a SHA-256 of the token, never the token.
    const s = await db.admin().query<{ token_hash: Buffer }>('SELECT token_hash FROM system.session');
    expect(s.rows[0]!.token_hash.length).toBe(32);
  });

  // why: FR-AUTH-7 the manager ruling: the shown form xxxxx-xxxxx of a sample password signs in, with its hyphen stripped
  it('accepts the sample password in its shown form with the hyphen', async () => {
    const k = await kernel();
    const shown = showSamplePassword(sample(emails.maria));
    expect(shown).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect((await call(k, 'POST', '/api/v1/sessions', signInBody(emails.maria, shown))).status).toBe(200);
    expect((await call(k, 'POST', '/api/v1/sessions', signInBody(emails.maria, shown.toLowerCase()))).status).toBe(200);
    // The reviewer's password is not a sample password: it gets no hyphen rule.
    expect((await call(k, 'POST', '/api/v1/sessions', signInBody(emails.reviewer, REVIEWER_PASSWORD))).status).toBe(200);
  });

  // why: FR-AUTH-10 Keep me signed in lasts 90 days; without it the cookie is a browser-session cookie and the limits are SD-8's
  it('sets the Keep me signed in lifetimes in real time', async () => {
    const k = await kernel();
    const plain = await call(k, 'POST', '/api/v1/sessions', signInBody(emails.keisha, sample(emails.keisha)));
    expect(setCookies(plain)[0]).not.toMatch(/Max-Age/);
    expect(setCookies(plain)[0]).toMatch(/HttpOnly/);
    const keep = await call(k, 'POST', '/api/v1/sessions', signInBody(emails.keisha, sample(emails.keisha), { keepSignedIn: true }));
    expect(setCookies(keep)[0]).toMatch(`Max-Age=${90 * 24 * 3600}`);
    const rows = await db.admin().query<{ keep_signed_in: boolean; len: number }>(
      `SELECT keep_signed_in, extract(epoch FROM expires_real - created_real)::int AS len FROM system.session s JOIN world."user" u ON u.id = s.user_id
        WHERE u.email = $1 ORDER BY created_real DESC LIMIT 2`, [emails.keisha]);
    expect(rows.rows.map((r) => [r.keep_signed_in, r.len])).toEqual([[true, 90 * 86400], [false, 12 * 3600]]);
  });

  // why: FR-AUTH-11 a technician signs in by a 5-digit employee number or an email; a wrong one gets the wrong email's answer
  it('signs a technician in by employee number, and answers a wrong number as a wrong email', async () => {
    const k = await kernel();
    const ok = await call(k, 'POST', '/api/v1/sessions', signInBody('40712', sample(emails.maria), { client: 'native' }));
    expect(ok.status).toBe(200);
    const body = await data<{ user: { employeeNumber: string }; token: string }>(ok);
    expect(body.user.employeeNumber).toBe('40712');
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // native: a bearer token, and no cookie
    expect(setCookies(ok)).toEqual([]);
    const wrongNumber = await call(k, 'POST', '/api/v1/sessions', signInBody('99999', sample(emails.maria)));
    const wrongEmail = await call(k, 'POST', '/api/v1/sessions', signInBody('nobody@brightwater.example', sample(emails.maria)));
    expect([wrongNumber.status, await code(wrongNumber)]).toEqual([wrongEmail.status, await code(wrongEmail)]);
    expect(wrongNumber.status).toBe(401);
  });

  // why: FR-AUTH-3 an Invited user has no password and cannot sign in; a turned-off user is told so only with the right password
  it('refuses an Invited user and tells a turned-off user with the right password', async () => {
    const k = await kernel();
    expect(await code(await call(k, 'POST', '/api/v1/sessions', signInBody(emails.derek, 'whatever-it-is')))).toBe('credentials_invalid');
    const off = await call(k, 'POST', '/api/v1/sessions', signInBody(emails.omar, sample(emails.omar)));
    expect([off.status, await code(off)]).toEqual([403, 'account_turned_off']);
    expect(await code(await call(k, 'POST', '/api/v1/sessions', signInBody(emails.omar, 'wrong-password-1')))).toBe('credentials_invalid');
  });

  // why: FR-AUTH-1 the sign-in writes the last sign-in columns by the app that signed in (SPECIFICATIONS section 3 writer table)
  it('writes last_sign_in_at and last_sign_in_app by the web or native app', async () => {
    const k = await kernel();
    await call(k, 'POST', '/api/v1/sessions', signInBody(emails.maria, sample(emails.maria)));
    const web = await db.admin().query<{ app: string; at: Date }>('SELECT last_sign_in_app AS app, last_sign_in_at AS at FROM world."user" WHERE email = $1', [emails.maria]);
    expect(web.rows[0]!.app).toBe('tech_web');
    expect(web.rows[0]!.at.toISOString()).toMatch(/^2026-09-15T14:2\d:/); // demo time, not real time
    await call(k, 'POST', '/api/v1/sessions', signInBody(emails.maria, sample(emails.maria), { client: 'native' }));
    expect((await db.admin().query<{ app: string }>('SELECT last_sign_in_app AS app FROM world."user" WHERE email = $1', [emails.maria])).rows[0]!.app).toBe('tech_native');
    await call(k, 'POST', '/api/v1/sessions', signInBody(emails.keisha, sample(emails.keisha)));
    expect((await db.admin().query<{ app: string }>('SELECT last_sign_in_app AS app FROM world."user" WHERE email = $1', [emails.keisha])).rows[0]!.app).toBe('office');
  });
});

describe('the access-code gate (API-01)', () => {
  // why: FR-AUTH-6 with the code on every entry but the 5 answers access_code_required until the code is entered; a password sign-in works without it
  it('refuses every route before the code, lets the 5 through, and a named account signs in without the code', async () => {
    const k = await kernel({ code: true, demo: true });
    expect(await code(await call(k, 'GET', '/api/v1/demo/people?app=office'))).toBe('access_code_required');
    expect(await code(await call(k, 'GET', '/api/v1/demo/tech-sign-ins'))).toBe('access_code_required');
    expect(await code(await call(k, 'POST', '/api/v1/demo/sessions', { personId: ids[emails.dana] }))).toBe('access_code_required');
    expect(await code(await call(k, 'GET', '/api/v1/me'))).toBe('access_code_required');
    expect((await call(k, 'GET', '/api/v1/app-info')).status).toBe(200);
    expect((await call(k, 'GET', '/api/v1/clock')).status).toBe(200);
    // A named password account, Apple's reviewer among them, signs in with no code and is then past the gate.
    const rev = await call(k, 'POST', '/api/v1/sessions', signInBody(emails.reviewer, REVIEWER_PASSWORD));
    expect(rev.status).toBe(200);
    const me = await call(k, 'GET', '/api/v1/me', undefined, pair(rev, 'bw_session'));
    expect(me.status).toBe(200);
  });

  // why: F-288 (owner ruling cb5d1273 "Code required") a password session without the access code gets no Sign in as list from
  // API-04, API-05 or API-15, and the same session gets it once the code is entered
  it('lists the sample people to a password session only after the access code is entered', async () => {
    const k = await kernel({ code: true, demo: true });
    const dana = await call(k, 'POST', '/api/v1/sessions', signInBody(emails.dana, sample(emails.dana)));
    expect(dana.status).toBe(200);
    const session = pair(dana, 'bw_session')!;
    expect((await call(k, 'GET', '/api/v1/me', undefined, session)).status).toBe(200); // past the gate by SD-47 step 2
    const target = { personId: ids[emails.keisha] };
    for (const [method, path, body] of [['GET', '/api/v1/demo/people?app=office'], ['GET', '/api/v1/demo/tech-sign-ins'], ['POST', '/api/v1/demo/sessions', target]] as const) {
      const r = await call(k, method, path, body, session);
      expect([path, r.status, await code(r)]).toEqual([path, 403, 'access_code_required']);
    }
    const entered = pair(await call(k, 'POST', '/api/v1/access-code', { code: CODE }), 'bw_access')!;
    const both = `${entered}; ${session}`;
    expect((await data<{ people: unknown[] }>(await call(k, 'GET', '/api/v1/demo/people?app=office', undefined, both))).people.length).toBeGreaterThan(0);
    expect((await data<{ signIns: unknown[] }>(await call(k, 'GET', '/api/v1/demo/tech-sign-ins', undefined, both))).signIns.length).toBeGreaterThan(0);
    expect((await call(k, 'POST', '/api/v1/demo/sessions', target, both)).status).toBe(200);
  });

  // why: FR-AUTH-6 API-01 checks the code against the stored hash and sets bw_access: httpOnly, Secure, SameSite=Lax, 30 days
  it('sets a Secure httpOnly bw_access cookie for the right code and refuses a wrong one, the hash being all the table holds', async () => {
    const k = await kernel({ code: true, demo: true });
    const wrong = await call(k, 'POST', '/api/v1/access-code', { code: 'nope-not-it' });
    expect([wrong.status, await code(wrong)]).toEqual([403, 'code_invalid']);
    expect(setCookies(wrong).filter((c) => c.startsWith('bw_access'))).toEqual([]);
    const right = await call(k, 'POST', '/api/v1/access-code', { code: CODE });
    expect(right.status).toBe(204);
    const cookie = setCookies(right).find((c) => c.startsWith('bw_access='))!;
    expect(cookie).toMatch(/; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/); // plain http: not Secure (F-304)
    const viaHttps = await k.router.handle(
      new Request('http://web:3000/api/v1/access-code', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-proto': 'https' }, body: JSON.stringify({ code: CODE }) }),
      { address: address() },
    );
    expect(setCookies(viaHttps).find((c) => c.startsWith('bw_access='))).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
    const stored = await db.admin().query<{ code_hash: string; active: boolean }>('SELECT code_hash, active FROM system.access_code');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]!.code_hash).toMatch(/^scrypt\$/);
    expect(stored.rows[0]!.code_hash).not.toContain(CODE);
    // With the cookie the gated routes open.
    const people = await call(k, 'GET', '/api/v1/demo/people?app=office', undefined, pair(right, 'bw_access'));
    expect(people.status).toBe(200);
  });

  // why: FR-AUTH-6 F-218 the code and the cookie key are required when the code is on, so a restart never ends every visitor's code
  it('needs the access code and the cookie key when the gate is on, and keeps the stored code across a restart', async () => {
    expect(() => createWebKernel({ settings: config({ ACCESS_CODE_ON: 'on', ACCESS_CODE: CODE }), log })).toThrow(/ACCESS_COOKIE_KEY/);
    expect(() => createWebKernel({ settings: config({ ACCESS_CODE_ON: 'on', ACCESS_COOKIE_KEY: KEY }), log })).toThrow(/ACCESS_CODE/);
    const first = await kernel({ code: true });
    const entered = await call(first, 'POST', '/api/v1/access-code', { code: CODE });
    const cookie = pair(entered, 'bw_access')!;
    const before = (await db.admin().query<{ code_hash: string }>('SELECT code_hash FROM system.access_code')).rows[0]!.code_hash;
    const second = await kernel({ code: true }); // a restart: the same key, the same code
    expect((await call(second, 'GET', '/api/v1/me', undefined, cookie)).status).toBe(401); // past the gate, not signed in
    expect((await db.admin().query<{ code_hash: string }>('SELECT code_hash FROM system.access_code')).rows[0]!.code_hash).toBe(before);
  });
});

describe('Sign in as (API-04, API-05) and the sample sign-ins (API-15)', () => {
  // why: FR-AUTH-5 with DEMO_MODE off the list is absent and no demo log line is written; with it on the line is written at start
  it('is absent with demo mode off, and the demo mode line is logged only with it on', async () => {
    lines.length = 0;
    const off = await kernel();
    expect(await code(await call(off, 'GET', '/api/v1/demo/people?app=office'))).toBe('demo_mode_off');
    expect(await code(await call(off, 'POST', '/api/v1/demo/sessions', { personId: ids[emails.dana] }))).toBe('demo_mode_off');
    expect(await code(await call(off, 'GET', '/api/v1/demo/tech-sign-ins'))).toBe('demo_mode_off');
    expect(lines.some((l) => l.includes('demo mode on'))).toBe(false);
    await kernel({ demo: true });
    expect(lines.filter((l) => l.includes('demo mode on'))).toHaveLength(1);
    const info = await data<{ demoMode: boolean }>(await call(off, 'GET', '/api/v1/app-info'));
    expect(info.demoMode).toBe(false);
  });

  // why: F-1654 FR-AUTH-5 the list is the 5 people the approved sign-in frame shows, in its order, each only while they can sign in; Sign in as opens a Sign-in-as session
  it('lists the frame\'s 5 people who can sign in and signs in as one', async () => {
    const k = await kernel({ demo: true });
    const all = await data<{ people: { personId: string; name: string; job: string; role: string }[] }>(await call(k, 'GET', '/api/v1/demo/people?app=office'));
    // not Derek (Invited), Omar or Nora (off), the reviewer, Marco P., nor Ryan, Teresa, Greg or Ben (sample password-holders the frame does not show)
    expect(all.people.map((p) => p.name)).toEqual(['Dana Ruiz', 'Keisha Thompson', 'Ana Gutierrez', 'Maria Santos', 'Luis Ortega']);
    expect(all.people.map((p) => p.role)).toEqual(['manager', 'office', 'office', 'technician', 'technician']);
    expect(all.people[0]!.job).toBe('Director of Operations');
    expect(all.people[3]!.job).toBe('Technician');
    const tech = await data<{ people: { name: string }[] }>(await call(k, 'GET', '/api/v1/demo/people?app=tech'));
    expect(tech.people.map((p) => p.name)).toEqual(['Maria Santos', 'Luis Ortega']);
    const r = await call(k, 'POST', '/api/v1/demo/sessions', { personId: ids[emails.keisha], keepSignedIn: false });
    expect(r.status).toBe(200);
    expect(await data<{ user: { name: string } }>(r)).toMatchObject({ user: { name: 'Keisha Thompson' } });
    const via = await db.admin().query<{ via: string }>(`SELECT via FROM system.session s JOIN world."user" u ON u.id = s.user_id WHERE u.email = $1`, [emails.keisha]);
    expect(via.rows.map((x) => x.via)).toContain('sign_in_as');
    expect((await call(k, 'GET', '/api/v1/me', undefined, pair(r, 'bw_session'))).status).toBe(200);
    // Not a person who cannot sign in, and not a string that is no id.
    expect((await call(k, 'POST', '/api/v1/demo/sessions', { personId: ids[emails.derek] })).status).toBe(404);
    expect((await call(k, 'POST', '/api/v1/demo/sessions', { personId: ids[emails.reviewer] })).status).toBe(404);
    expect((await call(k, 'POST', '/api/v1/demo/sessions', { personId: ids[emails.marco] })).status).toBe(404);
    // a password-holding sample person the frame does not show cannot be signed in as either
    expect((await call(k, 'POST', '/api/v1/demo/sessions', { personId: ids[emails.ben] })).status).toBe(404);
    expect((await call(k, 'POST', '/api/v1/demo/sessions', { personId: 'not-an-id' })).status).toBe(404);
  });

  // why: FR-AUTH-5 a Sign in as session counts only with the access code entered (SD-8): without it the caller is anonymous
  it('does not honor a Sign in as session while the code is on and not entered', async () => {
    const k = await kernel({ code: true, demo: true });
    const entered = await call(k, 'POST', '/api/v1/access-code', { code: CODE });
    const cookieA = pair(entered, 'bw_access')!;
    const r = await call(k, 'POST', '/api/v1/demo/sessions', { personId: ids[emails.dana] }, cookieA);
    expect(r.status).toBe(200);
    const session = pair(r, 'bw_session')!;
    expect((await call(k, 'GET', '/api/v1/me', undefined, `${cookieA}; ${session}`)).status).toBe(200);
    expect(await code(await call(k, 'GET', '/api/v1/me', undefined, session))).toBe('access_code_required');
  });

  // why: FR-AUTH-7 API-15 lists the start page's short list (owner ruling b66aaae8, F-283): each of the frame's 5 technicians who can
  // sign in, in the frame's order, with the CTL-GATE-02-04 fields and the shown password; a sample technician outside the 5 is not
  // listed, even one who can sign in; the iPhone line is none while IOS_INSTALL_KIND is none
  it('lists each of the start page 5 who can sign in, with the CTL-GATE-02-04 fields, and no one outside the 5', async () => {
    const k = await kernel({ demo: true });
    const r = await data<{ signIns: { name: string; email: string; password: string; branch: string; language: string }[]; iosAppLink: string | null }>(await call(k, 'GET', '/api/v1/demo/tech-sign-ins'));
    expect(r.iosAppLink).toBeNull();
    const shown = (email: string) => showSamplePassword(sample(email));
    // The whole answer, so a list that stops filtering to the 5 fails here: Greg Hoffman and Ben Adler can sign in (API-04 lists
    // them above) and are outside the 5. Derek is in the 5 but Invited with no password (F-273); Nora is off; the reviewer is not sample.
    expect(r.signIns).toEqual([
      { name: 'Maria Santos', branch: 'columbus', language: 'en', email: emails.maria, password: shown(emails.maria) },
      { name: 'Luis Ortega', branch: 'columbus', language: 'es', email: emails.luis, password: shown(emails.luis) },
      { name: 'Ryan Mitchell', branch: 'columbus', language: 'en', email: emails.ryan, password: shown(emails.ryan) },
      { name: 'Teresa Molina', branch: 'springfield', language: 'es', email: emails.teresa, password: shown(emails.teresa) },
    ]);
    for (const s of r.signIns) expect((await call(k, 'POST', '/api/v1/sessions', signInBody(s.email, s.password))).status).toBe(200);
  });

  // why: FR-IOS-2 the unlisted link reaches API-15's answer only when the install kind is set
  it('answers the unlisted install link when IOS_INSTALL_KIND is unlisted', async () => {
    const link = 'https://apps.apple.com/us/app/right-on-time/id1234567890';
    const k = createWebKernel({ settings: config({ DEMO_MODE: 'on', IOS_INSTALL_KIND: 'unlisted', IOS_INSTALL_LINK: link }), log });
    kernels.push(k);
    expect((await data<{ iosAppLink: string }>(await call(k, 'GET', '/api/v1/demo/tech-sign-ins'))).iosAppLink).toBe(link);
  });
});

describe('API-06 sign out and API-02 app info', () => {
  // why: FR-AUTH-1 F-230 sign out ends the session and clears the httpOnly cookie in the answer, also when the call is refused
  it('ends the session and clears the cookie on success and on a refusal', async () => {
    const k = await kernel();
    const r = await call(k, 'POST', '/api/v1/sessions', signInBody(emails.dana, sample(emails.dana)));
    const session = pair(r, 'bw_session')!;
    const out = await call(k, 'DELETE', '/api/v1/sessions/current', undefined, session);
    expect(out.status).toBe(204);
    expect(setCookies(out)[0]).toMatch(/^bw_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
    expect(await code(await call(k, 'GET', '/api/v1/me', undefined, session))).toBe('unauthenticated'); // the session row is gone
    // No session: refused, and the answer still clears the cookie.
    const refused = await call(k, 'DELETE', '/api/v1/sessions/current', undefined, session);
    expect(refused.status).toBe(401);
    expect(setCookies(refused)[0]).toMatch(/^bw_session=; .*Max-Age=0/);
    // A foreign origin is refused too, and clears too.
    const foreign = await k.router.handle(new Request('http://web:3000/api/v1/sessions/current', { method: 'DELETE', headers: { cookie: session, origin: 'https://evil.example' } }), { address: address() });
    expect(foreign.status).toBe(403);
    expect(setCookies(foreign)[0]).toMatch(/Max-Age=0/);
  });

  // why: FR-AUTH-5 API-02 answers the demo marker, the code switch and the source link, with no session and no code
  it('answers app info before the code', async () => {
    const k = await kernel({ code: true, demo: true });
    const info = await data<{ demoMode: boolean; accessCodeOn: boolean; sourceUrl: string; sourceCommit: string }>(await call(k, 'GET', '/api/v1/app-info'));
    expect(info).toMatchObject({ demoMode: true, accessCodeOn: true, sourceCommit: 'unknown', sourceUrl: 'https://github.com/JohnnyEgghead/right-on-time' });
  });
});
