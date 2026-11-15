// SPDX-License-Identifier: AGPL-3.0-or-later
// The import runner on PostgreSQL 18 with the real generator output (seed 20260915), run as the web process's login
// bw_web (role app), the access wall setup's and the office's runs hit. 1 world per file: a dry run on the empty
// world, the real run, a dry run on the loaded world, then the refused second real run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../db/src/testing/fixture.ts';
import { PROBLEM_REASONS } from './model.ts';
import { ImportRefused, runImport, type RunOutcome } from './runner.ts';
import { databaseFingerprint, generatedWorld, SEEDED_TECHNICIAN, seedReference, stampClock, webPool, type TableFingerprint } from './testing/world.ts';

const db = useMigratedDatabase();
let pool: ReturnType<typeof webPool>;
const world = generatedWorld();
let before: Map<string, TableFingerprint>;
let dry: RunOutcome;
let afterDry: Map<string, TableFingerprint>;
let real: RunOutcome;
let loaded: Map<string, TableFingerprint>;
let dry2: RunOutcome;
let afterDry2: Map<string, TableFingerprint>;

const run = (kind: 'dry_run' | 'real') => runImport(pool, { kind, files: world.files, bySetup: true, byUser: null, clock: stampClock(kind) });
const n = async (sql: string, params: unknown[] = []) => Number((await db.admin().query<{ n: string }>(sql, params)).rows[0]?.n);

beforeAll(async () => {
  await seedReference(db.admin());
  pool = webPool(db.url());
  before = await databaseFingerprint(db.admin());
  dry = await run('dry_run');
  afterDry = await databaseFingerprint(db.admin(), dry.runId);
  real = await run('real');
  loaded = await databaseFingerprint(db.admin());
  dry2 = await run('dry_run');
  afterDry2 = await databaseFingerprint(db.admin(), dry2.runId);
});
afterAll(async () => {
  await pool?.end();
});

/** The tables whose fingerprint differs between 2 measurements. */
function changed(x: Map<string, TableFingerprint>, y: Map<string, TableFingerprint>): string[] {
  const names = new Set([...x.keys(), ...y.keys()]);
  return [...names].filter((t) => JSON.stringify(x.get(t)) !== JSON.stringify(y.get(t))).sort();
}

describe('the dry run (FR-IMP-1)', () => {
  // why: FR-IMP-1
  it('leaves every table of the database unchanged in row count and checksum, on an empty and on a loaded world', () => {
    expect(before.size).toBeGreaterThan(60); // every base table of every schema, read from pg_class
    expect(changed(before, afterDry)).toEqual([]);
    expect(changed(loaded, afterDry2)).toEqual([]);
    // the real run between them did change the domain tables, so the measure can see a change
    expect(changed(afterDry, loaded)).toEqual(expect.arrayContaining(['world.customer', 'world.past_visit', 'world.equipment', 'world.duplicate_pair', 'world.merge']));
  });

  // why: FR-IMP-1
  it('the fingerprint fails a single changed row (the measure is not blind)', async () => {
    const c = db.admin();
    await c.query('BEGIN');
    try {
      await c.query(`UPDATE world.customer SET getting_in = coalesce(getting_in, '') || '.' WHERE id = (SELECT id FROM world.customer ORDER BY id LIMIT 1)`);
      const mutated = await databaseFingerprint(c, dry2.runId);
      expect(changed(afterDry2, mutated)).toEqual(['world.customer']);
    } finally {
      await c.query('ROLLBACK');
    }
  });

  // why: FR-IMP-1
  it('keeps only its own run record and run-scoped problem list, and reports the counts the real run then loads', async () => {
    const r = await db.admin().query<{ kind: string; status: string; report: { customers: { total: number } } }>(
      'SELECT kind, status, report FROM world.import_run WHERE id = $1', [dry.runId]);
    expect(r.rows[0]).toMatchObject({ kind: 'dry_run', status: 'done' });
    expect(await n('SELECT count(*) AS n FROM world.import_problem_row WHERE run_id = $1', [dry.runId])).toBe(1184);
    expect(await n('SELECT count(*) AS n FROM world.import_problem_row WHERE run_id = $1 AND flagged_entity_id IS NOT NULL', [dry.runId])).toBe(0);
    const { pairs: dp, ...dryCounts } = dry.report;
    const { pairs: rp, ...realCounts } = real.report;
    expect(realCounts).toEqual(dryCounts);
    expect(rp).toEqual(dp);
  });
});

describe('the real run (FR-IMP-1, FR-IMP-6)', () => {
  // why: FR-IMP-6
  it('loads exactly the import target table into the database', async () => {
    expect(await n(`SELECT count(*) AS n FROM world.customer WHERE source = 'import'`)).toBe(18_400);
    expect(await n(`SELECT count(*) AS n FROM world.customer WHERE status = 'merged'`)).toBe(812);
    expect(await n('SELECT count(*) AS n FROM world.past_visit')).toBe(95_870);
    expect(await n('SELECT count(*) AS n FROM world.equipment')).toBe(30_904);
    expect(await n('SELECT count(*) AS n FROM world.import_problem_row WHERE run_id = $1', [real.runId])).toBe(1184);
    expect(await n(`SELECT count(DISTINCT flagged_entity_id) AS n FROM world.import_problem_row WHERE run_id = $1`, [real.runId])).toBe(488);
    expect(await n(`SELECT count(*) AS n FROM world.duplicate_pair WHERE run_id = $1 AND kind = 'exact' AND status = 'merged'`, [real.runId])).toBe(812);
    expect(await n(`SELECT count(*) AS n FROM world.duplicate_pair WHERE run_id = $1 AND kind = 'likely' AND status = 'listed'`, [real.runId])).toBe(428);
    expect(await n(`SELECT count(*) AS n FROM world."merge" WHERE kind = 'exact' AND status = 'active'`)).toBe(812);
    // a merged record B owns nothing: every visit and piece of equipment of B moved to A
    expect(await n(`SELECT count(*) AS n FROM world.past_visit v JOIN world.customer c ON c.id = v.customer_id WHERE c.status = 'merged'`)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM world.equipment e JOIN world.customer c ON c.id = e.customer_id WHERE c.status = 'merged'`)).toBe(0);
  });

  // why: FR-IMP-1
  it('records the run as done by setup with SD-24 stamps and the export time copied at parse', async () => {
    const r = await db.admin().query<{ status: string; percent: number; by_setup: boolean; started_at: Date; finished_at: Date; source_exported_at: Date }>(
      'SELECT status, percent, by_setup, started_at, finished_at, source_exported_at FROM world.import_run WHERE id = $1', [real.runId]);
    const row = r.rows[0];
    expect(row).toMatchObject({ status: 'done', percent: 100, by_setup: true });
    expect(row?.started_at.toISOString()).toBe('2026-08-31T10:02:00.000Z');
    expect(row?.finished_at.toISOString()).toBe('2026-08-31T10:44:00.000Z');
    expect(row?.source_exported_at.toISOString()).toBe('2026-08-31T09:00:00.000Z');
  });

  // why: FR-IMP-1, F-206, F-257
  it('maps visits and customers as the layout says: the service column to service_text (F-257), an empty home type stays null, branch-zone instants', async () => {
    const v = await db.admin().query<{ service_text: string; work_done: string | null; technician_id: string | null; window_start: Date; zone: string; arrived_at: Date | null }>(
      `SELECT service_text, work_done, technician_id, window_start, zone, arrived_at FROM world.past_visit WHERE source_ref = 'V2000001'`);
    // visits.csv row V2000001: 2020-09-01, 08:00-12:00, arrived 08:01, Phil Mertz, service "Water heater repair",
    // work_done "Replaced the thermocouple." (F-673: stored in past_visit.work_done)
    expect(v.rows[0]).toMatchObject({ service_text: 'Water heater repair', technician_id: null, zone: 'America/New_York', work_done: 'Replaced the thermocouple.' });
    expect(v.rows[0]?.window_start.toISOString()).toBe('2020-09-01T12:00:00.000Z');
    expect(v.rows[0]?.arrived_at?.toISOString()).toBe('2020-09-01T12:01:00.000Z');
    expect(await n(`SELECT count(*) AS n FROM world.past_visit WHERE technician_name = $1 AND technician_id IS NULL`, [SEEDED_TECHNICIAN])).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM world.past_visit WHERE technician_name = $1`, [SEEDED_TECHNICIAN])).toBeGreaterThan(0);
    const emptyHomeType = world.files['customers.csv'].split('\n').slice(1).filter((l) => l !== '').length
      - real.model.customers.filter((c) => c.homeType !== null).length;
    expect(emptyHomeType).toBeGreaterThan(1000);
    expect(await n('SELECT count(*) AS n FROM world.customer WHERE home_type IS NULL')).toBe(emptyHomeType);
    expect(await n(`SELECT count(*) AS n FROM world.customer WHERE home_type = ''`)).toBe(0);
  });
});

describe('the problem list (FR-IMP-2)', () => {
  // why: FR-IMP-2
  it('holds 1,184 rows, each with 1 of the 6 reasons in the target table counts and its example', async () => {
    const r = await db.admin().query<{ reason: string; n: string }>(
      'SELECT reason, count(*) AS n FROM world.import_problem_row WHERE run_id = $1 GROUP BY reason ORDER BY reason', [real.runId]);
    expect(Object.fromEntries(r.rows.map((x) => [x.reason, Number(x.n)]))).toEqual({
      visit_no_customer: 418, missing_zip: 214, bad_phone: 187, visit_date_unreadable: 124, equipment_no_address: 154, customer_name_blank: 87,
    });
    expect(r.rows.every((x) => (PROBLEM_REASONS as readonly string[]).includes(x.reason))).toBe(true);
    // flagged rows point at the imported customer; rows not imported point at nothing
    expect(await n(`SELECT count(*) AS n FROM world.import_problem_row p JOIN world.customer c ON c.id = p.flagged_entity_id
                     WHERE p.run_id = $1 AND p.reason IN ('missing_zip', 'bad_phone', 'customer_name_blank')`, [real.runId])).toBe(488);
    expect(await n(`SELECT count(*) AS n FROM world.import_problem_row WHERE run_id = $1 AND flagged_entity_id IS NOT NULL
                     AND reason IN ('visit_no_customer', 'visit_date_unreadable', 'equipment_no_address')`, [real.runId])).toBe(0);
    // examples: the row's name (or its old record reference when it has none), a colon, the offending value as the file holds it
    const ex = await db.admin().query<{ reason: string; example: string; file: string }>(
      'SELECT DISTINCT ON (reason) reason, example, file FROM world.import_problem_row WHERE run_id = $1 ORDER BY reason, row_number', [real.runId]);
    const by = Object.fromEntries(ex.rows.map((x) => [x.reason, x]));
    expect(by['bad_phone']?.example).toMatch(/^[A-Z][^:]+: \(\d{3}\) 555-\d{1,3}$/);
    expect(by['missing_zip']?.example).toMatch(/^[^:]+: $/);
    expect(by['customer_name_blank']?.example).toMatch(/^\d{5}: $/);
    expect(by['visit_no_customer']?.example).toMatch(/^V\d{7}: \d{5}$/);
    expect(by['equipment_no_address']?.example).toMatch(/^E\d{7}: $/);
    expect(by['visit_date_unreadable']?.example).toMatch(/^V\d{7}: .+$/);
  });
});

describe('duplicates (FR-IMP-3, FR-IMP-9)', () => {
  /** The database's pairs of the real run as customer_ref pairs (A, B), through the run's id order. */
  async function dbPairs(kind: 'exact' | 'likely'): Promise<string[]> {
    const refOf = new Map((real.customerIds ?? []).map((id, i) => [id, real.model.customers[i]?.ref]));
    const r = await db.admin().query<{ record_a: string; record_b: string }>(
      'SELECT record_a, record_b FROM world.duplicate_pair WHERE run_id = $1 AND kind = $2', [real.runId, kind]);
    return r.rows.map((p) => `${refOf.get(p.record_a)}:${refOf.get(p.record_b)}`).sort();
  }

  // why: FR-IMP-3
  it('merges 812 exact pairs and lists 428 likely pairs, both sets equal to the committed planted-truth file', async () => {
    // the id-to-row mapping is checked against the stored rows themselves, so the comparison cannot pass on a shifted id
    const rows = await db.admin().query<{ id: string; name: string; customer_since: string }>('SELECT id, name, customer_since FROM world.customer');
    const stored = new Map(rows.rows.map((c) => [c.id, c]));
    real.customerIds?.forEach((id, i) => {
      const m = real.model.customers[i];
      expect(stored.get(id)).toMatchObject({ name: m?.name, customer_since: m?.customerSince });
    });
    const truth = (k: 'exact' | 'likely') => world.truth[k].map((p) => `${p.a}:${p.b}`).sort();
    expect(await dbPairs('exact')).toEqual(truth('exact'));
    expect(await dbPairs('likely')).toEqual(truth('likely'));
    expect(world.truth.counts).toEqual({ exact: 812, likely: 428 });
  });

  // why: FR-IMP-3
  it('keeps record A, the customer whose row comes first in customers.csv, with its own name (OI-50)', async () => {
    const r = await db.admin().query<{ a_status: string; b_status: string; merged_into: string; a: string }>(
      `SELECT a.status AS a_status, b.status AS b_status, b.merged_into, a.id AS a
         FROM world.duplicate_pair p JOIN world.customer a ON a.id = p.record_a JOIN world.customer b ON b.id = p.record_b
        WHERE p.run_id = $1 AND p.kind = 'exact'`, [real.runId]);
    expect(r.rows.length).toBe(812);
    expect(r.rows.every((x) => x.a_status === 'active' && x.b_status === 'merged' && x.merged_into === x.a)).toBe(true);
    const index = new Map((real.customerIds ?? []).map((id, i) => [id, i]));
    const p = await db.admin().query<{ record_a: string; record_b: string }>('SELECT record_a, record_b FROM world.duplicate_pair WHERE run_id = $1', [real.runId]);
    expect(p.rows.every((x) => (index.get(x.record_a) ?? -1) < (index.get(x.record_b) ?? -1))).toBe(true);
  });

  // why: FR-IMP-9
  it("lists Kathy OBrien as a likely duplicate of Kathleen O'Brien-Miller (the apostrophe-dropping, hyphen-splitting fold)", async () => {
    const r = await db.admin().query<{ a: string; b: string; status: string; kind: string }>(
      `SELECT a.name AS a, b.name AS b, p.status, p.kind FROM world.duplicate_pair p
         JOIN world.customer a ON a.id = p.record_a JOIN world.customer b ON b.id = p.record_b
        WHERE p.run_id = $1 AND (a.name = 'Kathy OBrien' OR b.name = 'Kathy OBrien')`, [real.runId]);
    expect(r.rows).toEqual([{ a: "Kathleen O'Brien-Miller", b: 'Kathy OBrien', status: 'listed', kind: 'likely' }]);
    const k = await db.admin().query<{ name_search: string }>(`SELECT name_search FROM world.customer WHERE name IN ('Kathy OBrien', 'Kathleen O''Brien-Miller') ORDER BY name`);
    expect(k.rows.map((x) => x.name_search)).toEqual(['kathleen obrien miller', 'kathy obrien']);
  });
});

describe('link tokens (F-153 (3))', () => {
  // why: F-153
  it('gives every imported customer a distinct 22-character random inbox token', async () => {
    const r = await db.admin().query<{ total: string; distinct_: string; bad: string }>(
      `SELECT count(*) AS total, count(DISTINCT inbox_token) AS distinct_, count(*) FILTER (WHERE inbox_token !~ '^[A-Za-z0-9_-]{22}$') AS bad FROM world.customer`);
    expect(r.rows[0]).toEqual({ total: '18400', distinct_: '18400', bad: '0' });
    expect(await n(`SELECT count(*) AS n FROM (SELECT inbox_token FROM world.customer GROUP BY inbox_token HAVING count(*) > 1) d`)).toBe(0);
  });
});

describe('once per world (FR-IMP-10)', () => {
  // why: FR-IMP-10
  it('refuses a second real run with real_run_exists and writes nothing, while a dry run still works', async () => {
    const pre = await databaseFingerprint(db.admin());
    const err = await run('real').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportRefused);
    expect((err as ImportRefused).code).toBe('real_run_exists');
    expect(changed(pre, await databaseFingerprint(db.admin()))).toEqual([]);
    expect(dry2.report.customers.total).toBe(18_400);
    expect(await n(`SELECT count(*) AS n FROM world.import_run WHERE kind = 'real'`)).toBe(1);
  });
});
