// SPDX-License-Identifier: AGPL-3.0-or-later
// The 4 shell reads (owner ruling c025a9ec: API-07 who am I, API-08 save my settings, API-10 read the clock, API-130
// search) on the real database (PostgreSQL 18, the migrated schema), through the production kernel (createWebKernel:
// the real policy table, handlers, SQL sessions and clock) as the web process's own login bw_web. The fixture rows are
// inserted here; the full sample data arrives with P2-SEED. Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEARCH_GROUP_CAP } from '@bw/api';
import { loadConfig } from '@bw/config';
import { createPool, type Queryable } from '@bw/db';
import { createLogger } from '@bw/log';
import { realNow, Temporal, type RealTimeUse } from '@bw/time';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { sessionCookie, SqlSessionStore, startSession } from '../kernel/sessions.ts';
import type { Role } from '../types.ts';
import { createWebKernel, type WebKernel } from '../web.ts';

const db = useMigratedDatabase();
const lines: string[] = [];
const log = createLogger({ process: 'web', write: (l) => lines.push(l) });
const asWeb = () => {
  const u = new URL(db.url());
  u.username = 'bw_web';
  return u.toString();
};
// With the code on, the web process requires the code and its cookie key (F-218).
const settings = (codeOn: boolean) =>
  loadConfig({ DATABASE_URL: asWeb(), ACCESS_CODE_ON: codeOn ? 'on' : 'off', ...(codeOn ? { ACCESS_CODE: 'a-test-access-code', ACCESS_COOKIE_KEY: 'k'.repeat(43) } : {}) });
const ORIGIN = 'http://localhost:8080'; // APP_ORIGIN's default (section 11.1)

const kernels: WebKernel[] = [];
/** The production kernel; the access code is on unless a test needs a signed-out caller past it. */
const kernel = (codeOn = true) => {
  const k = createWebKernel({ settings: settings(codeOn), log });
  kernels.push(k);
  return k;
};
let sessionPool: ReturnType<typeof createPool> | undefined;
afterAll(async () => {
  await Promise.all(kernels.map((k) => k.close()));
  await sessionPool?.end();
});

let users: Record<'manager' | 'office' | 'technician', string>;
const cookies: Partial<Record<Role, string>> = {};

async function insertUser(a: Queryable, email: string, role: Role, extra: { employee?: string; lang?: string } = {}) {
  const r = await a.query<{ id: string }>(`INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, employee_number, sample, reviewer)
               VALUES ($1, 'Test User', 'test user', $2, 'columbus', $3, 'active', $4, true, false) RETURNING id`, [email, role, extra.lang ?? 'en', extra.employee ?? null]);
  return r.rows[0]!.id;
}

async function street(a: Queryable, name: string, fold: string, branch = 'columbus') {
  const r = await a.query<{ id: string }>(`INSERT INTO world.street (name, name_search, city, zip, branch_id, points)
               VALUES ($1, $2, 'Columbus', '43215', $3, '[[-83.0, 39.96]]') RETURNING id`, [name, fold, branch]);
  return r.rows[0]!.id;
}

async function customer(a: Queryable, name: string, fold: string, streetId: string, house: number, over: { branch?: string; status?: string } = {}) {
  const r = await a.query<{ id: string }>(`INSERT INTO world.customer (branch_id, name, name_search, texts_on, text_language, zone, street_id,
                 house_number, lon, lat, customer_since, source, status, inbox_token)
               VALUES ($1, $2, $3, true, 'en', 'America/New_York', $4, $5, -83.0, 39.96, '2020-05-01', 'office', $6, md5(random()::text)) RETURNING id`,
    [over.branch ?? 'columbus', name, fold, streetId, house, over.status ?? 'active']);
  return r.rows[0]!.id;
}

let fixture: { ann: string; anne: string; bob: string; windowId: string };

beforeAll(async () => {
  const a = db.admin();
  for (const [id, zone] of [['columbus', 'America/New_York'], ['dayton', 'America/New_York']]) {
    await a.query(`INSERT INTO world.branch (id, name_key, zone, office_phone, depot_lon, depot_lat, map_file)
                   VALUES ($1, $2, $3, '(614) 555-0100', -83.0, 39.96, 'x.pmtiles')`, [id, `branch.${id}`, zone]);
  }
  users = {
    manager: await insertUser(a, 'dana@example.test', 'manager'),
    office: await insertUser(a, 'keisha@example.test', 'office', { lang: 'es' }),
    technician: await insertUser(a, 'maria@example.test', 'technician', { employee: '40217' }),
  };
  await a.query(`INSERT INTO world.technician (user_id, branch_id, name, name_in_texts, phone, primary_skill, skills, installer,
                   shift_start, shift_end, working_days, saturdays, since)
                 VALUES ($1, 'columbus', 'Maria Santos', 'Maria', '(614) 555-0142', 'heating_cooling', '{heating_cooling}', false,
                   '08:00', '17:00', '{1,2,3,4,5}', 'none', '2016-03-01')`, [users.technician]);
  const high = await street(a, 'High St', 'high st');
  const maple = await street(a, 'Maple Ave', 'maple ave');
  const oak = await street(a, 'Oak Ave', 'oak ave');
  const ann = await customer(a, 'Ann Lee', 'ann lee', high, 12);
  const anne = await customer(a, "Anne O'Brien", 'anne obrien', high, 40);
  const bob = await customer(a, 'Bob Hightower', 'bob hightower', oak, 7);
  for (let i = 1; i <= SEARCH_GROUP_CAP + 1; i++) await customer(a, `Maple Neighbor ${i}`, `maple neighbor ${i}`, maple, 100 + i);
  await customer(a, 'Ann Merged', 'ann merged', high, 14, { status: 'merged' });
  const dayton = await street(a, 'High St', 'high st', 'dayton');
  await customer(a, 'Ann Dayton', 'ann dayton', dayton, 12, { branch: 'dayton' });
  await a.query(`INSERT INTO world.membership (customer_id, since, renews, benefits_key) VALUES ($1, '2024-01-01', '2027-01-01', 'cc')`, [anne]);
  await a.query(`INSERT INTO world.service_type (id, screen_label_key, text_label_key, price_text_key, typical_length_key, invoice_price_cents,
                   job_type, expected_minutes, skill, bookable_online)
                 VALUES ('tune_up', 's.k', 't.k', 'p.k', 'l.k', 8900, 'maintenance', 60, 'heating_cooling', true)`);
  const w = await a.query<{ id: string }>(`INSERT INTO world.arrival_window (branch_id, mode, start_local, end_local, label_key, capacity)
                 VALUES ('columbus', 'two_hour', '08:00', '10:00', 'w.8', 12) RETURNING id`);
  fixture = { ann, anne, bob, windowId: w.rows[0]!.id };
  // Job numbers 24800 to 24806 for Ann Lee and 24810 for Bob: 248 matches all 8, 2481 only 24810.
  for (let n = 24800; n <= 24806; n++) await insertJobRow(a, n, ann);
  await insertJobRow(a, 24810, bob);
  await insertClock(a, { paused: false });
  sessionPool = createPool({ connectionString: asWeb(), max: 1 });
  const store = new SqlSessionStore(sessionPool);
  const clock = { realNow: (use: RealTimeUse) => (use === 'session_idle' ? realNow('session_idle') : realNow('session_lifetime')) };
  for (const role of ['manager', 'office', 'technician'] as const) {
    const token = await startSession(store, clock, { userId: users[role], role }, { client: 'web', via: 'password', keepSignedIn: false });
    cookies[role] = sessionCookie(token, false, false).split(';')[0]!;
  }
});

async function insertJobRow(a: Queryable, jobNumber: number, customerId: string) {
  await a.query(`INSERT INTO world.job (job_number, customer_id, branch_id, service_id, date, zone, window_id, window_start, window_end, status,
                   version, expected_minutes, booked_via, booked_at, billing_state, autopilot, touched_by_person, pilot)
                 VALUES ($1, $2, 'columbus', 'tune_up', '2026-09-15', 'America/New_York', $3, '2026-09-15T08:00:00-04:00',
                   '2026-09-15T10:00:00-04:00', 'scheduled', 1, 60, 'office', '2026-09-14T12:00:00Z', 'not_sent', false, false, false)`,
    [jobNumber, customerId, fixture.windowId]);
}

async function insertClock(a: Queryable, o: { paused: boolean }) {
  await a.query('DELETE FROM system.demo_clock');
  await a.query(`INSERT INTO system.demo_clock (id, demo_anchor, real_anchor, rate, paused, world_epoch, pbs_epoch, last_move_by_name,
                   last_move_kind, last_move_to, last_move_real, last_reset_real, last_write_real)
                 VALUES (1, '2026-09-15T14:28:00Z', now(), 1, $1, 3, 3, 'Dana Ruiz', 'jump', '2026-09-15T14:28:00Z', now(),
                   now() - interval '100 seconds', now())`, [o.paused]);
}

const get = (k: WebKernel, path: string, cookie?: string) =>
  k.router.handle(new Request(`http://web:3000${path}`, { headers: cookie ? { cookie } : {} }), { address: '203.0.113.9' });
const send = (k: WebKernel, method: string, path: string, body: unknown, cookie?: string) =>
  k.router.handle(new Request(`http://web:3000${path}`, {
    method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) },
  }), { address: '203.0.113.9' });
const data = async <T>(r: Response) => ((await r.json()) as { data: T }).data;
const code = async (r: Response) => ((await r.json()) as { code: string }).code;

describe('API-10 read the clock', () => {
  // why: FR-DEMO-1, FR-DEMO-2 the header clock comes from the clock row, before the access code
  it('answers the demo time of the clock row, with the access code on and not entered', async () => {
    const k = kernel();
    const before = realNow('record_stamp').epochMilliseconds;
    const r = await get(k, '/api/v1/clock');
    expect(r.status).toBe(200);
    const raw = await r.text();
    const c = (JSON.parse(raw) as { data: { demoNow: string; rate: number; paused: boolean; worldEpoch: number; lastMove: unknown; replay: unknown; resetAvailableInSeconds: number } }).data;
    expect(c).toMatchObject({ rate: 1, paused: false, worldEpoch: 3, replay: { running: false, done: 0, total: 0 } });
    expect(c.lastMove).toEqual({ by: 'Dana Ruiz', kind: 'jump', toDemo: '2026-09-15T10:28:00-04:00[America/New_York]' });
    expect(c.demoNow).toMatch(/^2026-09-15T10:28:\d{2}(\.\d+)?-04:00\[America\/New_York\]$/);
    // The answer's real instant, read from the wire text (the realNow listing, G-CI4, counts only the seam's calls).
    const real = Temporal.ZonedDateTime.from(/"realNow":"([^"]+)"/.exec(raw)![1]!).epochMilliseconds;
    expect(real).toBeGreaterThanOrEqual(before - 2_000);
    expect(real).toBeLessThanOrEqual(realNow('record_stamp').epochMilliseconds + 2_000);
    // demoNow - anchor equals realNow - real_anchor at rate 1: the pair is consistent within the test's run time
    const demoMs = Temporal.ZonedDateTime.from(c.demoNow).epochMilliseconds - Date.parse('2026-09-15T14:28:00Z');
    expect(demoMs).toBeGreaterThanOrEqual(0);
    expect(demoMs).toBeLessThan(10_000);
    expect(c.resetAvailableInSeconds).toBeGreaterThan(180);
    expect(c.resetAvailableInSeconds).toBeLessThanOrEqual(200);
  });

  // why: FR-DEMO-1 a paused clock shows its anchor time; FR-DEMO-6 the cool-down ends at 0
  it('holds the demo time while paused and reports no cool-down after 5 real minutes', async () => {
    const a = db.admin();
    await insertClock(a, { paused: true });
    await a.query(`UPDATE system.demo_clock SET last_reset_real = now() - interval '1 hour'`);
    const c = await data<{ demoNow: string; paused: boolean; resetAvailableInSeconds: number }>(await get(kernel(), '/api/v1/clock'));
    expect(c).toEqual(expect.objectContaining({ demoNow: '2026-09-15T10:28:00-04:00[America/New_York]', paused: true, resetAvailableInSeconds: 0 }));
    await insertClock(a, { paused: false });
  });

  // why: FR-DEMO-1 no invented time: before setup writes the clock row, the read fails and the strip shows its failure state
  it('answers server_error when the clock row is absent', async () => {
    const a = db.admin();
    await a.query('DELETE FROM system.demo_clock');
    const r = await get(kernel(), '/api/v1/clock');
    expect(r.status).toBe(500);
    expect(await code(r)).toBe('server_error');
    await insertClock(a, { paused: false });
  });
});

describe('API-07 who am I', () => {
  // why: FR-DISP-10, FR-AUTH-1 the menu shows the sections the role may open, from the policy table
  it('answers each role with its own fields and the screen keys the policy table gives it', async () => {
    const k = kernel();
    const mgr = await data<{ role: string; permissions: string[]; slashShortcut: string; language: string; name: string }>(await get(k, '/api/v1/me', cookies.manager));
    expect(mgr).toMatchObject({ role: 'manager', slashShortcut: 'on', language: 'en', name: 'Test User' });
    expect(mgr.permissions).toEqual(expect.arrayContaining(['SCR-OFC-02', 'SCR-OFC-11', 'SCR-OFC-16', 'SCR-OFC-17', 'SCR-OFC-43']));
    const office = await data<{ role: string; permissions: string[]; language: string }>(await get(k, '/api/v1/me', cookies.office));
    expect(office).toMatchObject({ role: 'office', language: 'es' });
    expect(office.permissions).toContain('SCR-OFC-02');
    expect(office.permissions).not.toContain('SCR-OFC-11');
    expect(office.permissions).not.toContain('SCR-OFC-17');
    expect(office.permissions).not.toContain('SCR-TEC-02');
    const tech = await data<Record<string, unknown>>(await get(k, '/api/v1/me', cookies.technician));
    expect(tech).toMatchObject({ userId: users.technician, name: 'Test User', role: 'technician', skill: 'heating_cooling', branch: 'columbus', employeeNumber: '40217' });
    expect(tech.permissions).toContain('SCR-TEC-02');
    expect(tech.permissions).not.toContain('SCR-OFC-02');
  });

  // why: FR-AUTH-1 deny by default: no session, no answer
  it('refuses a signed-out caller with unauthenticated', async () => {
    const r = await get(kernel(false), '/api/v1/me');
    expect(r.status).toBe(401);
    expect(await code(r)).toBe('unauthenticated');
  });
});

describe('API-08 save my settings', () => {
  // why: FR-DISP-11, OI-30 the "/" switch is kept with the user, so a new kernel session reads it back
  it('saves the "/" switch and the language to the user row, read back by a fresh kernel', async () => {
    const k = kernel();
    const saved = await send(k, 'PATCH', '/api/v1/me', { slashShortcut: 'off' }, cookies.office);
    expect(saved.status).toBe(200);
    expect(await data(saved)).toEqual({ language: 'es', slashShortcut: 'off' });
    const lang = await send(k, 'PATCH', '/api/v1/me', { language: 'en' }, cookies.office);
    expect(await data(lang)).toEqual({ language: 'en', slashShortcut: 'off' });
    await k.close();
    kernels.splice(kernels.indexOf(k), 1);
    const fresh = kernel();
    expect(await data(await get(fresh, '/api/v1/me', cookies.office))).toMatchObject({ slashShortcut: 'off', language: 'en' });
    const row = await db.admin().query<{ slash_shortcut: boolean; language: string }>('SELECT slash_shortcut, language FROM world."user" WHERE id = $1', [users.office]);
    expect(row.rows[0]).toEqual({ slash_shortcut: false, language: 'en' });
    // the other users keep theirs
    expect(await data(await get(fresh, '/api/v1/me', cookies.manager))).toMatchObject({ slashShortcut: 'on' });
    await send(fresh, 'PATCH', '/api/v1/me', { slashShortcut: 'on', language: 'es' }, cookies.office);
  });

  // why: FR-LANG-1 signed out, the choice stays in the browser: answered back, nothing stored
  it('answers a signed-out caller back and stores nothing; an empty change is refused', async () => {
    const k = kernel(false);
    const before = await db.admin().query('SELECT id, language, slash_shortcut FROM world."user" ORDER BY id');
    const r = await send(k, 'PATCH', '/api/v1/me', { language: 'es' });
    expect(r.status).toBe(200);
    expect(await data(r)).toEqual({ language: 'es', slashShortcut: 'on' });
    expect((await db.admin().query('SELECT id, language, slash_shortcut FROM world."user" ORDER BY id')).rows).toEqual(before.rows);
    const empty = await send(k, 'PATCH', '/api/v1/me', {}, cookies.office);
    expect(empty.status).toBe(422);
    expect(await code(empty)).toBe('validation_failed');
    const bad = await send(k, 'PATCH', '/api/v1/me', { language: 'fr' }, cookies.office);
    expect(await code(bad)).toBe('validation_failed');
  });
});

type Found = {
  jobs: { jobNumber: number; customer: string; day: string; window: { start: string; end: string }; status: string }[];
  customers: { id: string; name: string; area: string; plan: string | null }[];
  addresses: { customerId: string; address: string }[];
  more: { jobs: boolean; customers: boolean; addresses: boolean };
};

describe('API-130 search', () => {
  const find = async (query: string, branch = 'columbus', who: Role = 'office') => {
    const r = await send(kernel(), 'POST', '/api/v1/searches', { query, branch }, cookies[who]);
    expect(r.status, query).toBe(200);
    return data<Found>(r);
  };

  // why: FR-DISP-11 jobs by number, capped at 5 with a more flag, the exact number first
  it('finds jobs by number: a prefix lists up to 5 with more, an exact number comes first', async () => {
    const all = await find('248');
    expect(all.jobs.map((j) => j.jobNumber)).toEqual([24800, 24801, 24802, 24803, 24804]);
    expect(all.more.jobs).toBe(true);
    expect(all.jobs[0]).toEqual({ jobNumber: 24800, customer: 'Ann Lee', day: '2026-09-15', status: 'scheduled',
      window: { start: '2026-09-15T08:00:00-04:00[America/New_York]', end: '2026-09-15T10:00:00-04:00[America/New_York]' } });
    const one = await find('24810');
    expect(one.jobs.map((j) => j.jobNumber)).toEqual([24810]);
    expect(one.more.jobs).toBe(false);
    expect(one.customers).toEqual([]);
    expect((await find('2481')).jobs.map((j) => j.jobNumber)).toEqual([24810]);
  });

  // why: FR-DISP-7 customers by folded name, apostrophes and accents included; merged customers are left out
  it('finds customers by folded name, with straight or curly apostrophes, and leaves merged ones out', async () => {
    for (const q of ["O'Brien", 'O’Brien', 'obrien', 'OBRIEN']) {
      const f = await find(q);
      expect(f.customers, q).toEqual([{ id: fixture.anne, name: "Anne O'Brien", area: 'Columbus', plan: 'comfort_club' }]);
    }
    const ann = await find('ann');
    expect(ann.customers.map((c) => c.name)).toEqual(['Ann Lee', "Anne O'Brien"]);
    expect(ann.customers.find((c) => c.name === 'Ann Lee')?.plan).toBeNull();
  });

  // why: FR-DISP-11 addresses by street name and house number, each group capped at 5
  it('finds addresses by street name, and by house number and street', async () => {
    const high = await find('high');
    expect(high.addresses).toEqual([
      { customerId: fixture.ann, address: '12 High St, Columbus' },
      { customerId: fixture.anne, address: '40 High St, Columbus' },
    ]);
    expect(high.customers.map((c) => c.name)).toEqual(['Bob Hightower']); // the name holds "high"
    const house = await find('12 High');
    expect(house.addresses).toEqual([{ customerId: fixture.ann, address: '12 High St, Columbus' }]);
    expect(house.customers).toEqual([]);
    const maple = await find('maple ave');
    expect(maple.addresses).toHaveLength(SEARCH_GROUP_CAP);
    expect(maple.more.addresses).toBe(true);
    const neighbors = await find('maple neighbor');
    expect(neighbors.customers).toHaveLength(SEARCH_GROUP_CAP);
    expect(neighbors.more.customers).toBe(true);
  });

  // why: FR-DISP-11 the search is the chosen branch's
  it('searches only the branch it is given', async () => {
    const dayton = await find('ann', 'dayton');
    expect(dayton.customers.map((c) => c.name)).toEqual(['Ann Dayton']);
    expect(dayton.jobs).toEqual([]);
    expect((await find('nobody here')).customers).toEqual([]);
  });

  // why: FR-AUTH-1 office and managers only; NFR-05 the query never reaches a URL or a log line
  it('refuses a technician and a signed-out caller, and never logs the query', async () => {
    const k = kernel(false);
    const tech = await send(k, 'POST', '/api/v1/searches', { query: 'zz-secret-street', branch: 'columbus' }, cookies.technician);
    expect(tech.status).toBe(403);
    const out = await send(k, 'POST', '/api/v1/searches', { query: 'zz-secret-street', branch: 'columbus' });
    expect(out.status).toBe(401);
    const short = await send(k, 'POST', '/api/v1/searches', { query: ' a ', branch: 'columbus' }, cookies.office);
    expect(await code(short)).toBe('validation_failed');
    await find('zz-secret-street');
    const searched = lines.filter((l) => l.includes('"API-130"'));
    expect(searched.length).toBeGreaterThanOrEqual(4);
    expect(lines.join('\n')).not.toMatch(/zz-secret|secret street|O.Brien|obrien|maple neighbor/i);
    for (const l of searched) expect(JSON.parse(l)).toMatchObject({ route: '/api/v1/searches' });
  });
});
