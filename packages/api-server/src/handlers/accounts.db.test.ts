// SPDX-License-Identifier: AGPL-3.0-or-later
// The users page, Forgot password and the email pages (P4-ACCOUNTS: API-149 to API-154, API-165 to API-168, API-170) on the
// real database (PostgreSQL 18, the migrated schema), through the production kernel (createWebKernel: the real policy table,
// handlers, token checks, SQL sessions and clock) as the web process's own login bw_web. Run by gate G-CI7 step 3
// (ci/gates/G-CI7/vitest.db.config.ts). No token, link or password is printed: assertions compare them, never log them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { loadConfig } from '@bw/config';
import { hashPassword, samplePassword, type Queryable } from '@bw/db';
import { createLogger } from '@bw/log';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { createWebKernel, type WebKernel } from '../web.ts';
import { AREA_SCREENS, passwordRuleBroken, roleAreas } from './accounts.ts';

const db = useMigratedDatabase();
const ORIGIN = 'http://localhost:8080';
const SEED = 'test-sample-seed-0123456789';
const REVIEWER_PASSWORD = 'reviewer-example-26';
const asWeb = () => {
  const u = new URL(db.url());
  u.username = 'bw_web';
  return u.toString();
};

const kernels: WebKernel[] = [];
const lines: string[] = [];
const log = createLogger({ process: 'web', write: (l) => lines.push(l) });
async function kernel(o: { demo?: boolean; protection?: boolean } = {}): Promise<WebKernel> {
  const env: Record<string, string> = { DATABASE_URL: asWeb(), SAMPLE_PASSWORD_SEED: SEED };
  if (o.demo) env.DEMO_MODE = 'on';
  if (o.protection) env.RESET_PROTECTION = 'on';
  const k = createWebKernel({ settings: loadConfig(env), log });
  kernels.push(k);
  await k.router.handle(new Request('http://web:3000/api/v1/app-info'));
  return k;
}
afterAll(async () => {
  await Promise.all(kernels.map((k) => k.close()));
});

let n = 0;
const address = () => `203.0.113.${++n % 250}`;
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
const sessionOf = (r: Response) => r.headers.getSetCookie().find((c) => c.startsWith('bw_session='))?.split(';')[0];
const sha = (t: string) => createHash('sha256').update(t).digest();

const E = {
  dana: 'dana.ruiz@brightwater.example', pat: 'pat.kessler@brightwater.example', keisha: 'keisha.t@brightwater.example',
  ana: 'ana.gutierrez@brightwater.example', maria: 'maria.santos@brightwater.example', omar: 'omar.haddad@brightwater.example',
  reviewer: 'reviewer@brightwater.example', sam: 'sam.dunn@brightwater.example', vic: 'vic.lane@brightwater.example',
};
const sample = (email: string) => samplePassword(SEED, email);
const ids: Record<string, string> = {};

async function insertUser(a: Queryable, u: { email: string; name: string; role: string; employee?: string; title?: string; password: string | null; status?: string; sample?: boolean; reviewer?: boolean; language?: string; branch?: string }) {
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
  await a.query(`INSERT INTO system.demo_clock (id, demo_anchor, real_anchor, rate, paused, world_epoch, pbs_epoch, last_reset_real, last_write_real)
                 VALUES (1, '2026-09-15T14:28:00Z', now(), 1, true, 1, 1, now(), now())`);
  await insertUser(a, { email: E.dana, name: 'Dana Ruiz', role: 'manager', title: 'Director of Operations', password: sample(E.dana) });
  await insertUser(a, { email: E.pat, name: 'Pat Kessler', role: 'manager', title: 'Branch manager', password: sample(E.pat), language: 'es', branch: 'dayton' });
  await insertUser(a, { email: E.keisha, name: 'Keisha Thompson', role: 'office', title: 'Dispatcher', password: sample(E.keisha) });
  await insertUser(a, { email: E.ana, name: 'Ana Gutiérrez', role: 'office', title: 'Customer service (Spanish)', password: sample(E.ana), language: 'es' });
  await insertUser(a, { email: E.maria, name: 'Maria Santos', role: 'technician', employee: '40712', password: sample(E.maria) });
  await insertUser(a, { email: E.omar, name: 'Omar Haddad', role: 'office', password: sample(E.omar), status: 'turned_off' });
  await a.query(`UPDATE world."user" SET status_before_off = 'active' WHERE email = $1`, [E.omar]);
  await insertUser(a, { email: E.reviewer, name: 'App Reviewer', role: 'technician', password: REVIEWER_PASSWORD, sample: false, reviewer: true });
  // 2 people who are not sample people, for the turn off and role cases.
  await insertUser(a, { email: E.sam, name: 'Sam Dunn', role: 'office', password: 'sam-example-pass-1', sample: false });
  await insertUser(a, { email: E.vic, name: 'Vic Lane', role: 'office', password: 'vic-example-pass-1', sample: false, branch: 'springfield' });
}, 120_000);

const signIn = async (k: WebKernel, login: string, password: string) => call(k, 'POST', '/api/v1/sessions', { login, password, client: 'web' });
async function as(k: WebKernel, email: string, password = sample(email)) {
  const r = await signIn(k, email, password);
  expect(r.status, email).toBe(200);
  return sessionOf(r)!;
}
const tokenOf = (link: string) => link.split('/').pop()!;
type User = { id: string; name: string; status: string; role: string; branch: string; statusSince: string | null };
type Email = { inboxFor: string; subject: string; body: string; language: string; links: { kind: string; href: string }[] };
const emailRows = async (to: string) => (await db.admin().query<{ n: string }>(`SELECT count(*) AS n FROM world.email_message WHERE to_address = $1`, [to])).rows[0]!.n;

describe('UC-18 and FR-AUTH-12: invite, set a password, sign in with the employee number', () => {
  // why: UC-18 a manager invites a technician, who opens the invite by the one-time link the manager is shown, sets a password and signs in with the employee number
  it('lists the invited technician as Invited, then Active after the invite link sets a password, and no email left the app', async () => {
    const k = await kernel();
    const dana = await as(k, E.dana);
    const inv = await call(k, 'POST', '/api/v1/users/invitations', { name: 'Derek Lane', email: 'derek.lane@brightwater.example', role: 'technician', branch: 'dayton' }, dana);
    expect(inv.status).toBe(201);
    const sent = await data<{ user: User; employeeNumber: string; emailLink: string }>(inv);
    expect(sent.user).toMatchObject({ name: 'Derek Lane', status: 'invited', role: 'technician', branch: 'dayton' });
    expect(sent.user.statusSince).toMatch(/^2026-09-15T10:28:00-04:00\[America\/New_York\]$/);
    // SD-29, OI-26: 1 above the highest employee number in the world (Maria Santos 40712), printed in the invite email.
    expect(sent.employeeNumber).toBe('40713');
    expect(sent.emailLink).toMatch(/^\/email\/[A-Za-z0-9_-]{43}$/);
    expect(await emailRows('derek.lane@brightwater.example')).toBe('1');

    // The email opens once, for whoever holds the link the manager was shown.
    const open = await call(k, 'GET', `/api/v1/emails/${tokenOf(sent.emailLink)}`);
    expect(open.status).toBe(200);
    const mail = await data<Email>(open);
    expect(mail).toMatchObject({ inboxFor: 'derek.lane@brightwater.example', subject: 'Welcome to Right On Time', language: 'en' });
    expect(mail.body).toContain('Your employee number is 40713.');
    expect(mail.body).toContain('{link}');
    expect(mail.links).toHaveLength(1);
    expect(mail.links[0]!.kind).toBe('invite');
    // No usable token is stored: the email body holds no link, and the password token is stored only as its SHA-256.
    const pw = tokenOf(mail.links[0]!.href);
    expect(mail.body).not.toContain(pw);
    const stored = await db.admin().query<{ token_hash: Buffer }>(`SELECT token_hash FROM world.password_token WHERE user_id = $1`, [sent.user.id]);
    expect(stored.rows.map((r) => r.token_hash.equals(sha(pw)))).toEqual([true]);

    const who = await call(k, 'GET', `/api/v1/password-tokens/${pw}`);
    expect(await data(who)).toEqual({ kind: 'invite', user: { name: 'Derek Lane', role: 'technician', branch: 'dayton' }, app: 'tech' });
    const set = await call(k, 'POST', `/api/v1/password-tokens/${pw}`, { password: 'lane-example-phrase' });
    expect(set.status).toBe(200);
    expect(await data(set)).toEqual({ app: 'tech' });

    // FR-AUTH-11: the employee number signs in; OI-43: the user is Active from the moment the password was set.
    expect((await signIn(k, '40713', 'lane-example-phrase')).status).toBe(200);
    const list = await data<{ users: User[] }>(await call(k, 'POST', '/api/v1/user-searches', { query: 'derek lane' }, dana));
    expect(list.users.map((u) => [u.name, u.status, u.role, u.statusSince])).toEqual([['Derek Lane', 'active', 'technician', null]]);
    // The link is spent: a second set answers gone.
    expect((await call(k, 'POST', `/api/v1/password-tokens/${pw}`, { password: 'another-example-phrase' })).status).toBe(410);
    // The recent changes name the manager.
    const changes = await data<{ changes: { userName: string; what: string; byName: string | null; branch: string; role: string }[] }>(await call(k, 'GET', '/api/v1/users/changes', undefined, dana));
    expect(changes.changes[0]).toMatchObject({ userName: 'Derek Lane', what: 'invited', byName: 'Dana Ruiz', role: 'technician', branch: 'dayton' });
    // FR-AUTH-8: no mail transport: nothing in the log names an address, a token or a link.
    const logText = lines.join('\n');
    expect(logText).not.toContain('derek.lane@');
    expect(logText).not.toContain(pw);
    expect(logText).not.toContain(tokenOf(sent.emailLink));
  });

  // why: FR-AUTH-12 an invited user's language starts as the inviting person's, so the invite email is written in it (OI-39)
  it('writes a Spanish-speaking manager\'s invite in Spanish and gives the new user Spanish', async () => {
    const k = await kernel();
    const pat = await as(k, E.pat);
    const inv = await data<{ user: User; employeeNumber: string | null; emailLink: string }>(
      await call(k, 'POST', '/api/v1/users/invitations', { name: 'Nadia Price', email: 'nadia.price@brightwater.example', role: 'office', branch: 'columbus' }, pat),
    );
    expect(inv.employeeNumber).toBeNull();
    const lang = await db.admin().query<{ language: string }>(`SELECT language FROM world."user" WHERE id = $1`, [inv.user.id]);
    expect(lang.rows[0]!.language).toBe('es');
    const mail = await data<Email>(await call(k, 'GET', `/api/v1/emails/${tokenOf(inv.emailLink)}`));
    expect(mail).toMatchObject({ language: 'es', subject: 'Bienvenido a Right On Time' });
  });

  // why: FR-AUTH-12 an address already in use is refused; only managers reach the users page's calls (FR-AUTH-1)
  it('refuses an address in use with already_a_user, and refuses office staff every users call', async () => {
    const k = await kernel();
    const dana = await as(k, E.dana);
    const again = await call(k, 'POST', '/api/v1/users/invitations', { name: 'Keisha T', email: E.keisha, role: 'office', branch: 'columbus' }, dana);
    expect([again.status, await code(again)]).toEqual([409, 'already_a_user']);
    const keisha = await as(k, E.keisha);
    for (const [m, p, b] of [['POST', '/api/v1/user-searches', {}], ['POST', '/api/v1/users/invitations', { name: 'X Y', email: 'xy@brightwater.example', role: 'office', branch: 'columbus' }], ['GET', '/api/v1/roles', undefined], ['GET', '/api/v1/users/changes', undefined]] as const) {
      expect((await call(k, m, p, b, keisha)).status, p).toBe(403);
    }
  });

  // why: FR-AUTH-12 find and filter by name or email, role, branch and status, with the counts by role and status
  it('finds by folded name or email and filters by role, branch and status', async () => {
    const k = await kernel();
    const dana = await as(k, E.dana);
    const find = async (b: Record<string, unknown>) => data<{ users: User[]; total: number; counts: { active: Record<string, number>; byStatus: Record<string, number> } }>(await call(k, 'POST', '/api/v1/user-searches', b, dana));
    expect((await find({ query: 'gutierrez' })).users.map((u) => u.name)).toEqual(['Ana Gutiérrez']);
    expect((await find({ query: 'keisha.t@' })).users.map((u) => u.name)).toEqual(['Keisha Thompson']);
    expect((await find({ query: "100%_'" })).users).toEqual([]);
    const off = await find({ status: 'turned_off', role: 'office' });
    expect(off.users.map((u) => u.name)).toContain('Omar Haddad');
    expect((await find({ branch: 'springfield', role: 'manager' })).users).toEqual([]);
    const all = await find({});
    expect(all.total).toBe(all.counts.byStatus.active! + all.counts.byStatus.invited! + all.counts.byStatus.turned_off!);
    // Managers first, then office, then technicians.
    expect(all.users.slice(0, 2).map((u) => u.role)).toEqual(['manager', 'manager']);
  });
});

describe('FR-AUTH-12: turn off, turn back on, change role', () => {
  // why: FR-AUTH-12 turning a user off refuses their next sign-in and their reset; turning them back on lists them Active and they sign in again
  it('turns an Active user off and back on, with both changes named in the recent changes', async () => {
    const k = await kernel();
    const dana = await as(k, E.dana);
    const sam = await as(k, E.sam, 'sam-example-pass-1');
    const off = await call(k, 'POST', `/api/v1/users/${ids[E.sam]}/turn-off`, {}, dana);
    expect((await data<{ user: User }>(off)).user.status).toBe('turned_off');
    // The session ends with it, and the next sign-in is refused.
    expect((await call(k, 'GET', '/api/v1/me', undefined, sam)).status).toBe(401);
    const refused = await signIn(k, E.sam, 'sam-example-pass-1');
    expect([refused.status, await code(refused)]).toEqual([403, 'account_turned_off']);
    // OI-45: no reset email for a turned-off user.
    const reset = await data<{ sent: boolean; reason: string }>(await call(k, 'POST', '/api/v1/password-resets', { email: E.sam, app: 'office' }));
    expect(reset).toEqual({ sent: false, reason: 'account_turned_off', emailLink: null });
    expect(await emailRows(E.sam)).toBe('0');
    // Turned off twice is no change.
    expect((await call(k, 'POST', `/api/v1/users/${ids[E.sam]}/turn-off`, {}, dana)).status).toBe(409);
    const on = await data<{ user: User }>(await call(k, 'POST', `/api/v1/users/${ids[E.sam]}/turn-on`, {}, dana));
    expect(on.user.status).toBe('active');
    expect((await signIn(k, E.sam, 'sam-example-pass-1')).status).toBe(200);
    const changes = await data<{ changes: { userName: string; what: string; byName: string }[] }>(await call(k, 'GET', '/api/v1/users/changes?limit=2', undefined, dana));
    expect(changes.changes.map((c) => [c.userName, c.what, c.byName])).toEqual([['Sam Dunn', 'turned_back_on', 'Dana Ruiz'], ['Sam Dunn', 'turned_off', 'Dana Ruiz']]);
  });

  // why: FR-AUTH-12 an Invited user who is turned off cannot set a password with the invite link; turned back on, they are Invited and the link works
  it('refuses the invite link of a turned-off invited user without spending it, and lets it work once turned back on', async () => {
    const k = await kernel();
    const dana = await as(k, E.dana);
    const inv = await data<{ user: User; emailLink: string }>(
      await call(k, 'POST', '/api/v1/users/invitations', { name: 'Tess Wu', email: 'tess.wu@brightwater.example', role: 'office', branch: 'dayton' }, dana),
    );
    const pw = tokenOf((await data<Email>(await call(k, 'GET', `/api/v1/emails/${tokenOf(inv.emailLink)}`))).links[0]!.href);
    await call(k, 'POST', `/api/v1/users/${inv.user.id}/turn-off`, {}, dana);
    expect(await code(await call(k, 'GET', `/api/v1/password-tokens/${pw}`))).toBe('account_turned_off');
    const blocked = await call(k, 'POST', `/api/v1/password-tokens/${pw}`, { password: 'tess-example-phrase' });
    expect([blocked.status, await code(blocked)]).toEqual([403, 'account_turned_off']);
    const on = await data<{ user: User }>(await call(k, 'POST', `/api/v1/users/${inv.user.id}/turn-on`, {}, dana));
    expect(on.user.status).toBe('invited');
    expect((await call(k, 'POST', `/api/v1/password-tokens/${pw}`, { password: 'tess-example-phrase' })).status).toBe(200);
    expect((await signIn(k, 'tess.wu@brightwater.example', 'tess-example-phrase')).status).toBe(200);
  });

  // why: FR-AUTH-12 a manager sets a user's role; never their own row; the change joins the recent changes
  it('sets a role, refuses the same role and the manager\'s own row', async () => {
    const k = await kernel();
    const dana = await as(k, E.dana);
    const r = await data<{ user: User }>(await call(k, 'PUT', `/api/v1/users/${ids[E.vic]}/role`, { role: 'manager' }, dana));
    expect(r.user.role).toBe('manager');
    expect((await call(k, 'PUT', `/api/v1/users/${ids[E.vic]}/role`, { role: 'manager' }, dana)).status).toBe(409);
    expect((await call(k, 'PUT', `/api/v1/users/${ids[E.dana]}/role`, { role: 'office' }, dana)).status).toBe(409);
    expect((await call(k, 'POST', `/api/v1/users/${ids[E.dana]}/turn-off`, {}, dana)).status).toBe(409);
    expect((await call(k, 'PUT', '/api/v1/users/0192f000-0000-7000-8000-00000000abcd/role', { role: 'office' }, dana)).status).toBe(404);
    const c = await data<{ changes: { userName: string; what: string }[] }>(await call(k, 'GET', '/api/v1/users/changes?limit=1', undefined, dana));
    expect(c.changes[0]).toMatchObject({ userName: 'Vic Lane', what: 'role_set' });
  });

  // why: FR-AUTH-12 the role table is read from the policy table the server enforces (FR-AUTH-1)
  it('answers what each role can see from the policy table', async () => {
    const k = await kernel();
    const dana = await as(k, E.dana);
    const areas = (await data<{ areas: { area: string; office: boolean; technician: boolean; manager: boolean }[] }>(await call(k, 'GET', '/api/v1/roles', undefined, dana))).areas;
    const by = Object.fromEntries(areas.map((a) => [a.area, [a.office, a.technician, a.manager]]));
    expect(by).toEqual({
      board: [true, false, true], jobs_customers: [true, false, true], technicians: [true, false, true], messages: [true, false, true],
      reports: [false, false, true], admin: [false, false, true], phone_app: [false, true, false], customer_phones: [true, true, true],
    });
    // A screen named in an area that the table does not hold would read No silently: every one is in the table.
    expect(roleAreas(() => Object.values(AREA_SCREENS).flatMap((a) => a.screens)).every((a) => a.office && a.technician && a.manager)).toBe(true);
  });
});

describe('UC-19, FR-AUTH-9 and FR-AUTH-8: Forgot password and the one-time email link', () => {
  // why: UC-19 on a copy with reset protection off, Keisha T. resets her password from the on-screen email inbox; the new password works and the old one is refused
  // why: FR-AUTH-9 an unknown address gets no email and no link
  it('resets a password by the request page\'s link, refuses the old password, and sends nothing to an unknown address', async () => {
    const k = await kernel();
    const r = await call(k, 'POST', '/api/v1/password-resets', { email: E.keisha, app: 'office' });
    expect(r.status).toBe(202);
    const sent = await data<{ sent: boolean; reason: null; emailLink: string }>(r);
    expect(sent.sent).toBe(true);
    const mail = await data<Email>(await call(k, 'GET', `/api/v1/emails/${tokenOf(sent.emailLink)}`));
    expect(mail).toMatchObject({ inboxFor: E.keisha, subject: 'Choose a new password' });
    expect(mail.links[0]!.kind).toBe('reset');
    const pw = tokenOf(mail.links[0]!.href);
    expect(await data(await call(k, 'GET', `/api/v1/password-tokens/${pw}`))).toMatchObject({ kind: 'reset', app: 'office' });
    expect((await call(k, 'POST', `/api/v1/password-tokens/${pw}`, { password: 'keisha-new-example' })).status).toBe(200);
    expect((await signIn(k, E.keisha, sample(E.keisha))).status).toBe(401);
    expect((await signIn(k, E.keisha, 'keisha-new-example')).status).toBe(200);
    const none = await data(await call(k, 'POST', '/api/v1/password-resets', { email: 'nobody@brightwater.example', app: 'office' }));
    expect(none).toEqual({ sent: false, reason: 'no_account', emailLink: null });
    expect(await emailRows('nobody@brightwater.example')).toBe('0');
  });

  // why: FR-AUTH-8 the email goes only to the on-screen inbox for its address, opens by the one-time link once, and a second use or another session cannot open it
  it('opens an email once: a second use answers gone, an unknown link not found', async () => {
    const k = await kernel();
    const sent = await data<{ emailLink: string }>(await call(k, 'POST', '/api/v1/password-resets', { email: E.ana, app: 'office' }));
    const link = tokenOf(sent.emailLink);
    const first = await call(k, 'GET', `/api/v1/emails/${link}`);
    expect(first.status).toBe(200);
    expect((await data<Email>(first)).language).toBe('es');
    const second = await call(k, 'GET', `/api/v1/emails/${link}`);
    expect([second.status, await code(second)]).toEqual([410, 'gone']);
    expect((await call(k, 'GET', `/api/v1/emails/${'B'.repeat(43)}`)).status).toBe(404);
    // Only the hash of the link is stored, and the 1 email is to Ana's address only.
    const links = await db.admin().query<{ token_hash: Buffer }>(`SELECT l.token_hash FROM world.email_link l JOIN world.email_message m ON m.id = l.email_id WHERE m.to_address = $1`, [E.ana]);
    expect(links.rows.map((x) => x.token_hash.equals(sha(link)))).toEqual([true]);
  });

  // why: FR-AUTH-9 with reset protection on, no named account resets, the reviewer included, and every address gets the same answer
  it('answers protection_on for the reviewer, Keisha T. and an unknown address, writes nothing, and their passwords still work', async () => {
    const k = await kernel({ protection: true });
    const before = (await db.admin().query<{ n: string }>(`SELECT count(*) AS n FROM world.email_message`)).rows[0]!.n;
    for (const email of [E.reviewer, E.keisha, 'nobody@brightwater.example']) {
      expect(await data(await call(k, 'POST', '/api/v1/password-resets', { email, app: 'tech' })), email).toEqual({ sent: false, reason: 'protection_on', emailLink: null });
    }
    expect((await db.admin().query<{ n: string }>(`SELECT count(*) AS n FROM world.email_message`)).rows[0]!.n).toBe(before);
    expect((await signIn(k, E.reviewer, REVIEWER_PASSWORD)).status).toBe(200);
    expect((await signIn(k, E.keisha, 'keisha-new-example')).status).toBe(200);
  });

  // why: F-333 owner ruling 5a554f12 (Nov 2, 2026, "Block their reset"): with demo mode on and reset protection off, a sample person's reset is refused and the listed sample password still signs in
  it('refuses a sample person\'s reset whenever demo mode is on', async () => {
    const k = await kernel({ demo: true });
    expect(await data(await call(k, 'POST', '/api/v1/password-resets', { email: E.maria, app: 'tech' }))).toEqual({ sent: false, reason: 'protection_on', emailLink: null });
    expect(await emailRows(E.maria)).toBe('0');
    expect((await signIn(k, E.maria, sample(E.maria))).status).toBe(200);
  });

  // why: FR-AUTH-3 the password rules of SD-29: 10 to 128 characters, not the email, not 1 repeated character
  it('refuses a password that breaks a rule, and keeps the link usable', async () => {
    const k = await kernel();
    const sent = await data<{ emailLink: string }>(await call(k, 'POST', '/api/v1/password-resets', { email: E.vic, app: 'office' }));
    const pw = tokenOf((await data<Email>(await call(k, 'GET', `/api/v1/emails/${tokenOf(sent.emailLink)}`))).links[0]!.href);
    for (const password of ['short-one', E.vic, 'a'.repeat(12), 'x'.repeat(129)]) {
      expect((await call(k, 'POST', `/api/v1/password-tokens/${pw}`, { password })).status, password.slice(0, 4)).toBe(422);
    }
    expect((await call(k, 'POST', `/api/v1/password-tokens/${pw}`, { password: 'vic-good-example' })).status).toBe(200);
    expect(passwordRuleBroken('VIC.LANE@brightwater.example', E.vic)).toBe('is_email');
  });

  // why: F-612 two reset emails written at one demo instant (the clock paused) map to one token each way: the newer link supersedes the older, whichever opens first
  it('lets the newer of 2 reset emails written at one demo instant open a working link, and the older one none', async () => {
    const k = await kernel();
    await insertUser(db.admin(), { email: 'tess.twin@brightwater.example', name: 'Tess Twin', role: 'office', password: 'tess-example-pass-1', sample: false });
    const older = await data<{ emailLink: string }>(await call(k, 'POST', '/api/v1/password-resets', { email: 'tess.twin@brightwater.example', app: 'office' }));
    const newer = await data<{ emailLink: string }>(await call(k, 'POST', '/api/v1/password-resets', { email: 'tess.twin@brightwater.example', app: 'office' }));
    const oldMail = await data<Email>(await call(k, 'GET', `/api/v1/emails/${tokenOf(older.emailLink)}`));
    const newMail = await data<Email>(await call(k, 'GET', `/api/v1/emails/${tokenOf(newer.emailLink)}`));
    expect(oldMail.links).toEqual([]);
    expect(newMail.links).toHaveLength(1);
    expect((await call(k, 'POST', `/api/v1/password-tokens/${tokenOf(newMail.links[0]!.href)}`, { password: 'tess-new-example-1' })).status).toBe(200);
  });

  // why: F-613 Set a password ends the user's sessions (CTL-EML-02-04) and spends every other unused link of the user
  it('ends a live session and spends the user\'s other unused link when a password is set', async () => {
    const k = await kernel();
    const email = 'tess.sets@brightwater.example';
    await insertUser(db.admin(), { email, name: 'Tess Sets', role: 'office', password: 'tess-example-pass-2', sample: false });
    const userId = ids[email]!;
    const live = await signIn(k, email, 'tess-example-pass-2');
    expect(live.status).toBe(200);
    const sessions = async () => Number((await db.admin().query<{ n: string }>('SELECT count(*) AS n FROM system.session WHERE user_id = $1', [userId])).rows[0]!.n);
    expect(await sessions()).toBe(1);
    // A second unused link of another kind, known to the test.
    await db.admin().query(`INSERT INTO world.password_token (token_hash, user_id, kind, expires_at) VALUES ($1, $2, 'invite', '2026-12-31T00:00:00Z')`, [sha('B'.repeat(43)), userId]);
    const sent = await data<{ emailLink: string }>(await call(k, 'POST', '/api/v1/password-resets', { email, app: 'office' }));
    const pw = tokenOf((await data<Email>(await call(k, 'GET', `/api/v1/emails/${tokenOf(sent.emailLink)}`))).links[0]!.href);
    expect((await call(k, 'POST', `/api/v1/password-tokens/${pw}`, { password: 'tess-new-example-2' })).status).toBe(200);
    expect(await sessions()).toBe(0);
    expect((await call(k, 'POST', `/api/v1/password-tokens/${'B'.repeat(43)}`, { password: 'tess-third-example-3' })).status).toBe(410);
  });

  // why: FR-AUTH-8 K-07 F-2013 a link past its expiry answers gone on the page and on the password write, and one with time left opens (the demo clock is paused at 14:28:00Z)
  it('answers gone for a link that has run out, on read and on write, and opens one that has not', async () => {
    const k = await kernel();
    const email = 'tess.expiry@brightwater.example';
    await insertUser(db.admin(), { email, name: 'Tess Expiry', role: 'office', password: 'tess-example-pass-9', sample: false });
    const userId = ids[email]!;
    const [ranOut, open] = ['E'.repeat(43), 'F'.repeat(43)];
    for (const [t, expires] of [[ranOut, '2026-09-15T14:28:00Z'], [open, '2026-09-15T14:28:01Z']] as const) {
      await db.admin().query(`INSERT INTO world.password_token (token_hash, user_id, kind, expires_at) VALUES ($1, $2, 'reset', $3)`, [sha(t), userId, expires]);
    }
    const gone = await call(k, 'GET', `/api/v1/password-tokens/${ranOut}`);
    expect([gone.status, await code(gone)]).toEqual([410, 'gone']);
    const goneWrite = await call(k, 'POST', `/api/v1/password-tokens/${ranOut}`, { password: 'tess-late-example-1' });
    expect([goneWrite.status, await code(goneWrite)]).toEqual([410, 'gone']);
    expect((await call(k, 'GET', `/api/v1/password-tokens/${open}`)).status).toBe(200);
  });
});
