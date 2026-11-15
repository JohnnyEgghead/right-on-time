// SPDX-License-Identifier: AGPL-3.0-or-later
// P2-SEED: the reference seed on a real, empty, migrated PostgreSQL 18 database (the fixture applies every migration).
// Run by the database test set (vitest.db.config.ts). The sample seed below is a test value, not a deployed secret.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '../client.ts';
import { foldStreetName } from '../fold.ts';
import { samplePassword, verifyPassword } from '../passwords.ts';
import type { StreetListRow } from '../street-list.ts';
import { errorCode, insertJob, useMigratedDatabase } from '../testing/fixture.ts';
import { seedReference, type SeedResult } from './index.ts';
import { MOCKUP_PARTS, PARTS, PARTS_COUNT, PARTS_SEED, readRoster, SERVICES } from './reference-data.ts';

const SEED = 'test-seed-0123456789ab';
const REVIEWER_PW = 'reviewer-test-pw-9';
const NOW = new Date('2026-11-01T16:00:00Z');
const STREETS: StreetListRow[] = [
  { branch: 'columbus', name: 'High Street', city: 'Columbus', zip: '43215', points: [[-83.0, 39.96]] },
  { branch: 'dayton', name: "O'Brien-Miller Way", city: 'Dayton', zip: '45402', points: [[-84.19, 39.76]] },
];
const OPTS = { sampleSeed: SEED, anchorReal: NOW, streetList: STREETS };

const db = useMigratedDatabase();

/** Count and md5 of every row of every table in the 3 stores, so 2 states compare by value. */
async function snapshot(a: Queryable): Promise<Record<string, { n: number; sum: string }>> {
  const tables = await a.query<{ s: string; t: string }>(
    `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
      WHERE table_schema IN ('world', 'pbs', 'system') AND table_type = 'BASE TABLE' ORDER BY 1, 2`);
  const out: Record<string, { n: number; sum: string }> = {};
  for (const { s, t } of tables.rows) {
    const r = await a.query<{ n: string; sum: string }>(
      `SELECT count(*) AS n, coalesce(md5(string_agg(x::text, E'\\n' ORDER BY x::text)), '') AS sum FROM "${s}"."${t}" x`);
    out[`${s}.${t}`] = { n: Number(r.rows[0]?.n), sum: r.rows[0]?.sum ?? '' };
  }
  return out;
}

async function runSeed(opts: Parameters<typeof seedReference>[1] = OPTS): Promise<SeedResult> {
  const a = db.admin();
  await a.query('BEGIN');
  try {
    const r = await seedReference(a, opts);
    await a.query('COMMIT');
    return r;
  } catch (e) {
    await a.query('ROLLBACK');
    throw e;
  }
}

let first: SeedResult;
let second: SeedResult;
let afterFirst: Awaited<ReturnType<typeof snapshot>>;
let afterSecond: Awaited<ReturnType<typeof snapshot>>;
let beforeSeed: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
  beforeSeed = await snapshot(db.admin());
  first = await runSeed();
  afterFirst = await snapshot(db.admin());
  second = await runSeed();
  afterSecond = await snapshot(db.admin());
});

const rows = async <R>(sql: string, values?: unknown[]) => (await db.admin().query<R>(sql, values)).rows;

describe('the reference seed on an empty migrated database', () => {
  // why: SD-24 the reference seed runs twice and leaves identical rows
  it('leaves identical rows, by count and checksum of every table, when run a second time', () => {
    // the database really was empty: every world table, and the clock (pbs and the other system tables hold what the migrations put there)
    const filled = Object.entries(beforeSeed).filter(([k, t]) => t.n > 0 && (k.startsWith('world.') || k === 'system.demo_clock'));
    expect(filled).toEqual([]);
    expect(afterFirst['world.technician']?.n).toBe(21);
    expect(afterSecond).toEqual(afterFirst);
    expect(second).toEqual({ streetsLoaded: 0, usersAdded: 0, clockWritten: false });
    expect(first.streetsLoaded).toBe(STREETS.length);
    expect(first.clockWritten).toBe(true);
  });

  // why: F-207 the 21 technicians of technicians.json are seeded with their employee numbers, names and branches
  it('seeds the generator roster: 21 technicians, numbers 40701 to 40721, names and branches as the file has them', async () => {
    const roster = readRoster();
    expect(roster).toHaveLength(21);
    const got = await rows<{ employee_number: string; name: string; branch_id: string; installer: boolean; role: string }>(
      `SELECT u.employee_number, t.name, t.branch_id, t.installer, u.role
         FROM world.technician t JOIN world."user" u ON u.id = t.user_id ORDER BY u.employee_number`);
    expect(got.map((g) => [g.employee_number, g.name, g.branch_id, g.installer])).toEqual(
      roster.map((r) => [r.employeeNumber, r.name, r.branch, r.installer]));
    expect(got.every((g) => g.role === 'technician')).toBe(true);
    expect(got[0]?.employee_number).toBe('40701');
  });

  // why: SD-29 Maria Santos is employee number 40712, in Columbus on Van 12
  it("gives Maria Santos employee number 40712", async () => {
    const m = await rows<{ employee_number: string; branch_id: string; van: string; since: string }>(
      `SELECT u.employee_number, t.branch_id, v.number AS van, extract(year FROM t.since)::text AS since
         FROM world.technician t JOIN world."user" u ON u.id = t.user_id JOIN world.van v ON v.id = t.van_id WHERE t.name = 'Maria Santos'`);
    expect(m).toEqual([{ employee_number: '40712', branch_id: 'columbus', van: '12', since: '2016' }]);
  });

  // why: F-250 the 12 Columbus technicians carry the approved technicians page's van, skill, phone, Saturdays, hours and state
  it("seeds the 12 Columbus technicians as the approved technicians page gives them", async () => {
    const t = await rows<{ name: string; van: string; skill: string; phone: string; sat: string; hours: string; days: string; status: string; language: string }>(
      `SELECT t.name, v.number AS van, t.primary_skill AS skill, t.phone, (t.saturdays <> 'none')::text AS sat,
              t.shift_start::text || '-' || t.shift_end::text AS hours, t.working_days::text AS days, u.status, u.language
         FROM world.technician t JOIN world."user" u ON u.id = t.user_id JOIN world.van v ON v.id = t.van_id
        WHERE t.branch_id = 'columbus' ORDER BY t.name`);
    const std = '08:00:00-17:30:00';
    const page: [string, string, string, string, string, string][] = [
      ['Ashley Nguyen', '24', 'heating_cooling', '0124', 'false', std], ['Brian Schaefer', '15', 'heating_cooling', '0115', 'false', std],
      ['Chris Yoder', '30', 'install', '0130', 'false', '07:30:00-18:00:00'], ['Dave Kowalski', '7', 'heating_cooling', '0107', 'false', std],
      ['Greg Hoffman', '5', 'plumbing', '0105', 'true', std], ['Jamal Carter', '9', 'plumbing', '0109', 'true', std],
      ['Kevin Doyle', '27', 'plumbing', '0127', 'false', std], ['Luis Ortega', '18', 'heating_cooling', '0118', 'true', std],
      ['Maria Santos', '12', 'heating_cooling', '0112', 'true', std], ['Marcus Bell', '21', 'plumbing', '0121', 'false', std],
      ['Ryan Mitchell', '11', 'heating_cooling', '0111', 'true', std], ['Tom Reinhart', '3', 'heating_cooling', '0103', 'false', std],
    ];
    expect(t.map((x) => [x.name, x.van, x.skill, x.phone.slice(-4), x.sat, x.hours]).sort((a, b) => a[0]!.localeCompare(b[0]!))).toEqual(page.sort((a, b) => a[0].localeCompare(b[0])));
    expect(t.every((x) => x.phone.startsWith('(614) 555-'))).toBe(true);
    for (const x of t) {
      expect(x.days, x.name).toBe(x.name === 'Chris Yoder' ? '{1,2,3,4}' : '{1,2,3,4,5}');
      expect(x.status, x.name).toBe(x.name === 'Chris Yoder' ? 'invited' : 'active');
      expect(x.language, x.name).toBe(x.name === 'Luis Ortega' ? 'es' : 'en');
    }
  });

  // why: F-254 the people and history the approved users page and sign-in list name are seeded; nothing that only the superseded additions files name
  it('seeds Derek Simmons (Invited), Teresa Molina (Spanish) and the users page Recent changes, and not Rebecca Lyons or Marco P.', async () => {
    const u = await rows<{ name: string; branch_id: string; language: string; status: string; hash: boolean; tech: boolean }>(
      `SELECT name, branch_id, language, status, password_hash IS NOT NULL AS hash,
              EXISTS (SELECT 1 FROM world.technician t WHERE t.user_id = u.id) AS tech
         FROM world."user" u WHERE name IN ('Derek Simmons', 'Teresa Molina', 'Rebecca Lyons', 'Marco P.') ORDER BY name`);
    expect(u).toEqual([
      { name: 'Derek Simmons', branch_id: 'dayton', language: 'en', status: 'invited', hash: false, tech: false },
      { name: 'Teresa Molina', branch_id: 'springfield', language: 'es', status: 'active', hash: true, tech: false },
    ]);
    const c = await rows<{ who: string; what: string; by: string; at: string }>(
      `SELECT u.name AS who, c.what, b.name AS by, to_char(c.at AT TIME ZONE 'America/New_York', 'Dy, Mon FMDD, FMHH12:MI PM') AS at
         FROM world.user_change c JOIN world."user" u ON u.id = c.user_id JOIN world."user" b ON b.id = c."by" ORDER BY c.at`);
    expect(c).toEqual([
      { who: 'Omar Haddad', what: 'turned_off', by: 'Pat Kessler', at: 'Fri, Sep 4, 5:02 PM' },
      { who: 'Derek Simmons', what: 'invited', by: 'Dana Ruiz', at: 'Mon, Sep 14, 2:10 PM' },
    ]);
  });

  // why: F-207 the services use the generator README's service ids, in SD-20's order and prices
  it("seeds SD-20's 9 services under the generator README's ids, with the $0.00 line where no price is shown", async () => {
    const readme = readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'generator', 'README.md'), 'utf8');
    const line = readme.slice(readme.indexOf('Service ids:'));
    const readmeIds = [...line.slice(0, line.indexOf('(SD-20')).matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    expect(readmeIds).toHaveLength(9);
    const got = await rows<{ id: string; invoice_price_cents: number; bookable_online: boolean }>(
      'SELECT id, invoice_price_cents, bookable_online FROM world.service_type');
    expect(got.map((g) => g.id).sort()).toEqual([...readmeIds].sort());
    expect(SERVICES.map((s) => s.id)).toEqual(readmeIds);
    const price = Object.fromEntries(got.map((g) => [g.id, g.invoice_price_cents]));
    expect([price['furnace_tune_up'], price['heating_or_ac_fix'], price['boiler_repair'], price['water_heater']]).toEqual([8900, 7900, 0, 0]);
    expect(got.filter((g) => g.bookable_online)).toHaveLength(6);
  });

  // why: F-339 the reference seed writes the disclosed count of parts (about 1,240), each with a unique code, a name and a list price; the 10 mockup parts keep their codes and prices; a second run leaves identical rows
  it('seeds the disclosed 1,240 parts, the 10 mockup parts unchanged', async () => {
    const parts = await rows<{ code: string; name: string; price_cents: number }>('SELECT code, name, price_cents FROM world.part');
    expect(parts).toHaveLength(PARTS_COUNT);
    expect(PARTS_COUNT).toBe(1240);
    expect(new Set(parts.map((p) => p.code)).size).toBe(PARTS_COUNT);
    expect(new Set(parts.map((p) => p.name)).size).toBe(PARTS_COUNT);
    expect(parts.every((p) => p.name.length > 0 && Number.isInteger(p.price_cents) && p.price_cents > 0)).toBe(true);
    const byCode = new Map(parts.map((p) => [p.code, p]));
    const mockups = [
      ['FLT-16254', 'Furnace filter 16x25x4 MERV 11', 2400], ['FLT-16251', 'Furnace filter 16x25x1 MERV 8', 950],
      ['FLT-20254', 'Furnace filter 20x25x4 MERV 11', 2700], ['FLT-20201', 'Furnace filter 20x20x1 MERV 8', 900],
      ['RCK-1625', 'Filter rack, 16x25, 4 in', 4600], ['WF-1010', 'Water filter cartridge, whole house', 3200],
      ['CAP-455', 'Run capacitor 45/5 MFD', 3800], ['CAP-355', 'Run capacitor 35/5 MFD', 3400],
      ['HOS-0750', 'Condensate hose, 3/4 in, per ft', 225], ['CLP-0750', 'Hose clamp, 3/4 in', 150],
    ] as const;
    for (const [code, name, cents] of mockups) expect(byCode.get(code)).toMatchObject({ name, price_cents: cents });
    expect(MOCKUP_PARTS.map((p) => [p.code, p.name, p.cents])).toEqual(mockups.map((m) => [...m]));
    // the rows are the generator's: the database equals the in-process list (the pins below guard the list itself)
    expect(PARTS.map((p) => [p.code, p.cents])).toEqual(parts.map((p) => [p.code, p.price_cents]).sort((a, b) => PARTS.findIndex((q) => q.code === a[0]) - PARTS.findIndex((q) => q.code === b[0])));
  });

  // why: F-429 the full generated catalog is pinned by a digest committed as a literal, so a swap to Math.random, a reordered list or a changed price turns this red
  // why: F-428 3 spot rows pin a noun, its spec and its price range
  it('pins the generated catalog: digest of every code, name and price in order, and 3 spot rows', () => {
    const digest = createHash('sha256').update(PARTS.map((p) => `${p.code}|${p.name}|${p.cents}`).join('\n')).digest('hex');
    expect(PARTS).toHaveLength(1240);
    expect(digest).toBe('8d4fbe9bbba973c304e75e30df3ec7fce28c682489e86c24583d939c72281777');
    expect(PARTS[10]).toEqual({ code: 'VLV-2000', name: 'Ball valve 1/4 in', cents: 1860 });
    expect(PARTS[11]).toEqual({ code: 'FIT-2000', name: 'Coupling 1/4 in', cents: 1560 });
    expect(PARTS[1239]).toEqual({ code: 'MSC-2122', name: 'Pipe insulation, 6 ft 1-1/2 in, 1/2 in wall', cents: 770 });
    expect(PARTS.every((p) => Number.isInteger(p.cents) && p.cents > 0 && p.cents % 5 === 0)).toBe(true);
  });

  // why: F-339 the seed file states the generator rule, its fixed seed and the count beside the list
  it('discloses the generator rule, its fixed seed and the count in the seed file', () => {
    const src = readFileSync(path.join(import.meta.dirname, 'reference-data.ts'), 'utf8');
    expect(src).toContain(`PARTS_SEED = '${PARTS_SEED}'`);
    expect(src).toContain('PARTS_COUNT = 1240');
    expect(src).toMatch(/generator rule, disclosed here/);
    expect(src).toMatch(/Fit to the job/);
    expect(src).toMatch(/brightwater-parts-v2/);
    expect(src).toMatch(/1,230 generated parts/);
  });

  // why: OA-54 the fixed parts list is seeded, searchable by folded name or code
  it('seeds the fixed parts list with unique codes and folded search text', async () => {
    const parts = await rows<{ code: string; name_search: string; price_cents: number }>('SELECT code, name_search, price_cents FROM world.part ORDER BY code');
    expect(parts.length).toBeGreaterThanOrEqual(10);
    expect(parts.find((p) => p.code === 'CAP-455')).toMatchObject({ price_cents: 3800 });
    expect(parts.every((p) => p.name_search === foldStreetName(p.name_search) && p.name_search.includes(p.code.toLowerCase().replace('-', ' ')))).toBe(true);
  });

  // why: FR-BOOK-6 Columbus's 2-hour windows take 12, 12, 11, 11, 10 (FR-BOOK-5: other branches 5 per technician); FR-BOOK-7 4 four-hour windows
  it('seeds the arrival windows with their per-window capacities', async () => {
    const w = await rows<{ branch_id: string; mode: string; start_local: string; capacity: number | null }>(
      'SELECT branch_id, mode, start_local::text, capacity FROM world.arrival_window ORDER BY branch_id, mode DESC, start_local');
    const cap = (b: string) => w.filter((x) => x.branch_id === b && x.mode === 'two_hour').map((x) => x.capacity);
    expect(cap('columbus')).toEqual([12, 12, 11, 11, 10]);
    expect(cap('dayton')).toEqual(Array(5).fill(30)); // 6 technicians
    expect(cap('springfield')).toEqual(Array(5).fill(15)); // 3 technicians
    const four = w.filter((x) => x.branch_id === 'columbus' && x.mode === 'four_hour');
    expect(four.map((x) => x.start_local)).toEqual(['08:00:00', '10:00:00', '12:00:00', '14:00:00']);
    expect(four.every((x) => x.capacity === null)).toBe(true);
  });

  // why: OA-29 row 18 the sample peak days Wed Sep 16 and Fri Sep 18 are 4-hour days at Columbus; F-250 the approved text is Heat advisory, switched by Dana R., Mon, Sep 14, 4:10 PM
  it('marks Sep 16 and Sep 18, 2026 as four-hour peak days at Columbus, Heat advisory, switched by Dana R. on Mon, Sep 14, 4:10 PM', async () => {
    const d = await rows<{ branch_id: string; date: string; mode: string; reason: string; by: string; at: string }>(
      `SELECT d.branch_id, d.date::text, d.mode, d.reason, u.name AS by,
              to_char(d.switched_at AT TIME ZONE 'America/New_York', 'Dy, Mon FMDD, FMHH12:MI PM') AS at
         FROM world.day_mode d JOIN world."user" u ON u.id = d.switched_by ORDER BY d.date`);
    expect(d).toEqual([
      { branch_id: 'columbus', date: '2026-09-16', mode: 'four_hour', reason: 'Heat advisory', by: 'Dana Ruiz', at: 'Mon, Sep 14, 4:10 PM' },
      { branch_id: 'columbus', date: '2026-09-18', mode: 'four_hour', reason: 'Heat advisory', by: 'Dana Ruiz', at: 'Mon, Sep 14, 4:10 PM' },
    ]);
  });

  // why: SD-23 the street list loads once, into an empty table only
  it('loads the street list once and leaves a later list out', async () => {
    const n = await rows<{ n: string }>('SELECT count(*) AS n FROM world.street');
    expect(Number(n[0]?.n)).toBe(STREETS.length);
  });

  // why: SD-24 setup writes the clock row at world epoch 1 only when it is absent
  it('writes the 1 clock row at world epoch 1, paused at Tue Sep 15 7:00 AM Eastern, and never overwrites it', async () => {
    const c = await rows<{ id: number; world_epoch: number; pbs_epoch: number; paused: boolean; demo: string }>(
      `SELECT id, world_epoch, pbs_epoch, paused, demo_anchor AT TIME ZONE 'America/New_York' AS demo FROM system.demo_clock`);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ id: 1, world_epoch: 1, pbs_epoch: 1, paused: true });
    await db.asRole('postgres', async (q) => {
      await q.query('UPDATE system.demo_clock SET world_epoch = 7');
      const r = await seedReference(q, OPTS);
      expect(r.clockWritten).toBe(false);
      const after = await q.query<{ world_epoch: number }>('SELECT world_epoch FROM system.demo_clock');
      expect(after.rows).toEqual([{ world_epoch: 7 }]);
    });
  });
});

describe('what the seed does not write', () => {
  // why: SD-24 it writes 0 rows to any table that references a customer: by a customer_id column or by any foreign key to world.customer (F-255)
  it('leaves every table that references a customer empty, by customer_id column and by foreign key from the catalog', async () => {
    const byColumn = await rows<{ t: string }>(
      `SELECT format('%I.%I', c.table_schema, c.table_name) AS t FROM information_schema.columns c
         JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
        WHERE c.column_name = 'customer_id' AND c.table_schema IN ('world', 'pbs', 'system')`);
    // every foreign key whose target is world.customer, whatever the referencing column is called (record_a, record_b, merged_into)
    const byForeignKey = await rows<{ t: string }>(
      `SELECT DISTINCT conrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'f' AND confrelid = 'world.customer'::regclass`);
    const tables = [...new Set([...byColumn, ...byForeignKey].map((x) => x.t.replaceAll('"', '')))].sort();
    expect(tables).toEqual(expect.arrayContaining(['world.job', 'world.membership', 'world.equipment', 'world.duplicate_pair', 'world.customer']));
    expect(byForeignKey.length).toBeGreaterThanOrEqual(10);
    for (const name of [...tables, 'world.customer']) {
      const [s, t] = name.split('.');
      const n = await rows<{ n: string }>(`SELECT count(*) AS n FROM "${s}"."${t}"`);
      expect(Number(n[0]?.n), name).toBe(0);
    }
  });
});

describe('users, names and passwords', () => {
  // why: F-151 every seeded user has a name and a name_search folded by the shared fold (apostrophes dropped, hyphens split)
  it('gives every user a name, and a name_search equal to the shared fold of it', async () => {
    const u = await rows<{ name: string; name_search: string; role: string }>('SELECT name, name_search, role FROM world."user"');
    expect(u).toHaveLength(28); // 5 staff, 21 roster technicians, Derek Simmons and Teresa Molina
    expect(u.every((x) => x.name.length > 0 && x.name_search === foldStreetName(x.name))).toBe(true);
    expect(foldStreetName("Sean O'Brien-Miller")).toBe('sean obrien miller');
    const t = await rows<{ same: boolean }>(`SELECT u.name = t.name AS same FROM world.technician t JOIN world."user" u ON u.id = t.user_id`);
    expect(t.every((x) => x.same)).toBe(true);
  });

  // why: F-151 the staff users carry the roles, branches and titles the users page shows
  it('seeds the staff: 2 managers, 3 office users, 1 of them turned off', async () => {
    const s = await rows<{ name: string; role: string; status: string; title: string; before: string | null }>(
      `SELECT name, role, status, title, status_before_off AS before FROM world."user" WHERE role <> 'technician' ORDER BY name`);
    expect(s.map((x) => [x.name, x.role, x.status])).toEqual([
      ['Ana Gutierrez', 'office', 'active'], ['Dana Ruiz', 'manager', 'active'], ['Keisha Thompson', 'office', 'active'],
      ['Omar Haddad', 'office', 'turned_off'], ['Pat Kessler', 'manager', 'active'],
    ]);
    expect(s.find((x) => x.name === 'Dana Ruiz')?.title).toBe('Director of Operations');
    expect(s.find((x) => x.name === 'Omar Haddad')?.before).toBe('active');
  });

  // why: F-273 the Invited users had no open invite, so Resend invite had no link to retire (the users page says Invite sent Sep 14)
  it('gives each Invited user 1 unused invite token good until Sep 21, 2:10 PM EDT, and no other user one', async () => {
    const t = await rows<{ email: string; kind: string; used_at: Date | null; expires: string }>(
      `SELECT u.email::text AS email, t.kind, t.used_at, to_char(t.expires_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS expires
         FROM world.password_token t JOIN world."user" u ON u.id = t.user_id ORDER BY u.email`);
    expect(t).toEqual([
      { email: 'chris.yoder@brightwater.example', kind: 'invite', used_at: null, expires: '2026-09-21 14:10' },
      { email: 'derek.simmons@brightwater.example', kind: 'invite', used_at: null, expires: '2026-09-21 14:10' },
    ]);
  });

  // why: SD-9 each sample password verifies against its scrypt hash
  it("verifies every sample person's derived password against the stored scrypt hash, and no other", async () => {
    const all = await rows<{ email: string; password_hash: string | null; status: string }>('SELECT email::text AS email, password_hash, status FROM world."user" ORDER BY email');
    // an Invited user has no hash (SPECIFICATIONS: null while Invited): Chris Yoder and Derek Simmons, and only them
    expect(all.filter((x) => x.password_hash === null).map((x) => [x.email, x.status])).toEqual([
      ['chris.yoder@brightwater.example', 'invited'], ['derek.simmons@brightwater.example', 'invited'],
    ]);
    const u = all.filter((x): x is { email: string; password_hash: string; status: string } => x.password_hash !== null);
    expect(u).toHaveLength(26);
    expect(u.every((x) => x.password_hash.startsWith('scrypt$32768$8$1$'))).toBe(true);
    for (const x of u) {
      expect(await verifyPassword(samplePassword(SEED, x.email), x.password_hash), x.email).toBe(true);
      expect(await verifyPassword(samplePassword('another-seed-0123456', x.email), x.password_hash), x.email).toBe(false);
    }
  });

  // why: SD-9 no plain password is stored anywhere: no column of any type, in any table, holds a sample password or the reviewer password (F-255)
  it('finds no sample or reviewer password in any column of any table, with the reviewer row present', async () => {
    await db.asRole('postgres', async (q) => {
      await seedReference(q, { ...OPTS, reviewerPassword: REVIEWER_PW }); // adds the reviewer row inside this rolled-back transaction
      const reviewer = await q.query<{ n: string }>('SELECT count(*) AS n FROM world."user" WHERE reviewer');
      expect(reviewer.rows[0]?.n).toBe('1');
      const emails = (await q.query<{ email: string }>('SELECT email::text AS email FROM world."user"')).rows.map((x) => x.email);
      const plain = [...emails.map((e) => samplePassword(SEED, e)), REVIEWER_PW];
      expect(plain).toHaveLength(emails.length + 1);
      // every column of every base table, whatever its type: each is read as text (arrays, enums, jsonb included); a bytea
      // column is read through encode(escape), because its ::text cast is hex and would hide a plain value (F-274)
      const asText = (col: string, type: string): string => (type === 'bytea' ? `encode("${col}", 'escape')` : `"${col}"::text`);
      const control = await q.query<{ n: string }>(
        `SELECT strpos(${asText('v', 'bytea')}, $1) AS n FROM (SELECT convert_to($1::text, 'UTF8') AS v) x`, [REVIEWER_PW]);
      expect(Number(control.rows[0]?.n)).toBeGreaterThan(0); // control: a plain password stored in a bytea is found
      const cols = (await q.query<{ s: string; t: string; c: string; type: string }>(
        `SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c, c.data_type AS type FROM information_schema.columns c
           JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name AND x.table_type = 'BASE TABLE'
          WHERE c.table_schema IN ('world', 'pbs', 'system')`)).rows;
      expect(cols.length).toBeGreaterThan(100);
      expect(new Set(cols.map((x) => x.type))).toContain('ARRAY');
      for (const { s, t, c, type } of cols) {
        const r = await q.query<{ n: string }>(
          `SELECT count(*) AS n FROM "${s}"."${t}" WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) p WHERE strpos(${asText(c, type)}, p) > 0)`, [plain]);
        expect(Number(r.rows[0]?.n), `${s}.${t}.${c}`).toBe(0);
      }
    });
  });

  // why: HC-05 the reviewer account exists only when REVIEWER_PASSWORD is set, and signs in with it
  it('has no reviewer account without REVIEWER_PASSWORD, and adds 1 that verifies when it is set', async () => {
    expect((await rows<{ n: string }>('SELECT count(*) AS n FROM world."user" WHERE reviewer')).at(0)?.n).toBe('0');
    await db.asRole('postgres', async (q) => {
      const r = await seedReference(q, { ...OPTS, reviewerPassword: REVIEWER_PW });
      expect(r.usersAdded).toBe(1);
      const u = await q.query<{ password_hash: string; sample: boolean }>('SELECT password_hash, sample FROM world."user" WHERE reviewer');
      expect(u.rows).toHaveLength(1);
      expect(u.rows[0]?.sample).toBe(false);
      expect(await verifyPassword(REVIEWER_PW, u.rows[0]?.password_hash ?? null)).toBe(true);
      expect(u.rows[0]?.password_hash).not.toContain(REVIEWER_PW);
    });
  });
});

describe('the uniqueness migration 0009', () => {
  // why: F-153 at most 1 technician per user
  it('refuses a second technician for the same user', async () => {
    const code = await db.asRole('postgres', async (q) => {
      const t = await q.query<{ user_id: string }>('SELECT user_id FROM world.technician LIMIT 1');
      return errorCode(q.query(
        `INSERT INTO world.technician (user_id, branch_id, name, name_in_texts, phone, primary_skill, skills, installer, shift_start, shift_end, working_days, saturdays, since)
         VALUES ($1, 'columbus', 'Twin', 'Twin', '(614) 555-0199', 'plumbing', '{plumbing}', false, '08:00', '17:00', '{1}', 'none', '2020-01-06')`, [t.rows[0]?.user_id]));
    });
    expect(code).toBe('23505');
  });

  // why: F-153 customer.inbox_token and job.booking_token (where set) are unique; many jobs may have none
  it('refuses a repeated inbox token and a repeated booking token, and allows many null booking tokens', async () => {
    const make = async (q: Queryable, token: string) => {
      const street = (await q.query<{ id: string }>('SELECT id FROM world.street LIMIT 1')).rows[0]?.id;
      return q.query<{ id: string }>(
        `INSERT INTO world.customer (branch_id, name, name_search, texts_on, text_language, zone, street_id, house_number, lon, lat, customer_since, source, status, inbox_token)
         VALUES ('columbus', 'Ann Lee', 'ann lee', true, 'en', 'America/New_York', $1, 12, -83.0, 39.96, '2020-05-01', 'office', 'active', $2) RETURNING id`, [street, token]);
    };
    expect(await db.asRole('postgres', async (q) => {
      await make(q, 'abcdefghijklmnopqrstuv');
      return errorCode(make(q, 'abcdefghijklmnopqrstuv'));
    })).toBe('23505');
    expect(await db.asRole('postgres', async (q) => {
      const c = (await make(q, 'abcdefghijklmnopqrstuv')).rows[0]?.id ?? '';
      const w = (await q.query<{ id: string }>(`SELECT id FROM world.arrival_window WHERE branch_id = 'columbus' AND mode = 'two_hour' LIMIT 1`)).rows[0]?.id ?? '';
      const ref = { customerId: c, windowId: w };
      const over = { service_id: 'furnace_tune_up' };
      await insertJob(q, ref, { ...over, booking_token: null });
      await insertJob(q, ref, { ...over, booking_token: null });
      await insertJob(q, ref, { ...over, booking_token: 'x'.repeat(22) });
      return errorCode(insertJob(q, ref, { ...over, booking_token: 'x'.repeat(22) }));
    })).toBe('23505');
  });
});
