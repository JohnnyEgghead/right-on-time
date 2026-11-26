// SPDX-License-Identifier: AGPL-3.0-or-later
// The import area's calls (API-80 to API-88) on the real database (PostgreSQL 18, the migrated schema, P2-SEED's reference seed, the real
// generator output from seed 20260915), through the production kernel (createWebKernel: the real policy table,
// handlers, SQL sessions and clock) as the web process's login bw_web, with principals whose sessions the real session
// layer created. The worker's part of a run (SPECIFICATIONS section 2 "Import runner") is @bw/import runPendingImport,
// the function the worker calls, as the worker's login bw_worker with the demo clock. 1 world, in order: the dry run,
// the real run, a dry run on the loaded world, then the duplicate review, the merges and undo.
// Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts) with the other api-server database tests.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCursor, PROBLEM_LIST_COLUMNS, PROBLEM_REASON_KEYS } from '@bw/api';
import { loadConfig } from '@bw/config';
import { BUS_CHANNEL, createClient, createPool } from '@bw/db';
import { catalogs } from '@bw/i18n/src/catalog.ts';
import { runPendingImport } from '@bw/import';
import { createLogger } from '@bw/log';
import { DbClock, realNow, type RealTimeUse } from '@bw/time';
import { parseTargets } from '../../../../ci/gates/import-target-counts/targets.ts';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { databaseFingerprint, generatedWorld, seedReference, type TableFingerprint } from '../../../import/src/testing/world.ts';
import { sessionCookie, SqlSessionStore, startSession } from '../kernel/sessions.ts';
import type { Role } from '../types.ts';
import { createWebKernel, type WebKernel } from '../web.ts';
import { csvCell } from './import.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const TARGETS = parseTargets(readFileSync(path.join(ROOT, 'docs', 'REQUIREMENTS.md'), 'utf8'));
const db = useMigratedDatabase();
const files = generatedWorld().files;
const ORIGIN = 'http://localhost:8080'; // APP_ORIGIN's default (section 11.1)
const as = (login: string) => {
  const u = new URL(db.url());
  u.username = login;
  return u.toString();
};

let kernel: WebKernel;
let sessionPool: ReturnType<typeof createPool>;
let workerPool: ReturnType<typeof createPool>;
let worker: () => ReturnType<typeof runPendingImport>;
const users = {} as Record<Role, string>;
const cookies = {} as Record<Role, string>;

beforeAll(async () => {
  const a = db.admin();
  await seedReference(a);
  for (const role of ['manager', 'office', 'technician'] as const) {
    const r = await a.query<{ id: string }>(`SELECT id FROM world."user" WHERE role = $1 AND status = 'active' ORDER BY email LIMIT 1`, [role]);
    users[role] = r.rows[0]?.id ?? '';
    if (!users[role]) throw new Error(`the reference seed wrote no active ${role}`);
  }
  kernel = createWebKernel({ settings: loadConfig({ DATABASE_URL: as('bw_web'), ACCESS_CODE_ON: 'off' }), log: createLogger({ process: 'web', write: () => undefined }) });
  sessionPool = createPool({ connectionString: as('bw_web'), max: 1 });
  const store = new SqlSessionStore(sessionPool);
  const clock = { realNow: (use: RealTimeUse) => (use === 'session_idle' ? realNow('session_idle') : realNow('session_lifetime')) };
  for (const role of ['manager', 'office', 'technician'] as const) {
    const token = await startSession(store, clock, { userId: users[role], role }, { client: 'web', via: 'password', keepSignedIn: false });
    cookies[role] = sessionCookie(token, false, false).split(';')[0]!;
  }
  workerPool = createPool({ connectionString: as('bw_worker'), max: 4 });
  const demo = new DbClock(workerPool);
  worker = () => runPendingImport(workerPool, { files, clock: async () => new Date((await demo.demoNow()).epochMilliseconds) });
});
afterAll(async () => {
  await kernel?.close();
  await sessionPool?.end();
  await workerPool?.end();
});

const get = (p: string, role?: Role) =>
  kernel.router.handle(new Request(`http://web:3000/api/v1${p}`, { headers: role ? { cookie: cookies[role] } : {} }), { address: '203.0.113.9' });
const post = (p: string, body: unknown, role?: Role) =>
  kernel.router.handle(new Request(`http://web:3000/api/v1${p}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: ORIGIN, ...(role ? { cookie: cookies[role] } : {}) },
  }), { address: '203.0.113.9' });
async function data<T>(r: Response): Promise<T> {
  const body = (await r.json()) as { data: T };
  return body.data;
}
const code = async (r: Response) => ((await r.json()) as { code: string }).code;
const n = async (sql: string, params: unknown[] = []) => Number((await db.admin().query<{ n: string }>(sql, params)).rows[0]?.n);

/**
 * The tables whose fingerprint differs between 2 measurements, leaving out the session rows a signed-in call may touch.
 * The clock row stays in: its fingerprint leaves out only last_write_real, which the kernel stamps on every successful write
 * (SPECIFICATIONS SD-12, the idle reset; P3-REPLAY; F-541). A dry run's own writes are its run rows, which the callers compare apart.
 */
function changed(x: Map<string, TableFingerprint>, y: Map<string, TableFingerprint>): string[] {
  const names = new Set([...x.keys(), ...y.keys()]);
  const kernelStamps = new Set(['system.session']);
  return [...names].filter((t) => !kernelStamps.has(t) && JSON.stringify(x.get(t)) !== JSON.stringify(y.get(t))).sort();
}

interface Report {
  customers: { total: number; clean: number; flagged: number };
  visits: { total: number; imported: number; notImported: number };
  equipment: { total: number; imported: number; notImported: number };
  problems: { total: number; byReason: { reason: string; count: number; examples: { file: string; rowNumber: number; example: string; words: string }[] }[] };
  duplicates: { total: number; exact: number; likely: number };
}
interface Run { kind: string; status: string; stage: string; percent: number; report: Report | null; failure: string | null }

/** The report's numbers in the shape of the import target table (FR-IMP-6), read from REQUIREMENTS (ci/gates/import-target-counts/targets.ts). */
const asTargets = (r: Report) => ({
  ...r, problems: { total: r.problems.total, byReason: Object.fromEntries(r.problems.byReason.map((x) => [x.reason, x.count])) },
});

let dryRunId = '';
let realRunId = '';

describe('API-80 start a dry run, API-81 import run (FR-IMP-1, FR-IMP-2, FR-IMP-6)', () => {
  // why: FR-IMP-1, FR-IMP-6
  it('answers 202 and the run id, shows the run running, refuses a second start, and the worker takes it to done with the FR-IMP-6 counts, changing nothing', async () => {
    const before = await databaseFingerprint(db.admin());
    const started = await post('/import/runs', { kind: 'dry_run' }, 'office');
    expect(started.status).toBe(202);
    const body = (await started.json()) as { data: { runId: string }; meta: { contract: string } };
    expect(body.meta.contract).toBe('API-80');
    dryRunId = body.data.runId;

    const running = await get(`/import/runs/${dryRunId}`, 'office');
    expect(running.status).toBe(200);
    expect(await data<Run>(running)).toEqual({ kind: 'dry_run', status: 'running', stage: 'parse', percent: 0, report: null, failure: null });

    // run_in_progress while the run is requested: API-80 and API-84 alike, and the refusal writes no run row
    const runs = await n('SELECT count(*) AS n FROM world.import_run');
    const again = await post('/import/runs', { kind: 'dry_run' }, 'manager');
    expect([again.status, await code(again)]).toEqual([409, 'run_in_progress']);
    const real = await post('/import/runs', { kind: 'real' }, 'manager');
    expect([real.status, await code(real)]).toEqual([409, 'run_in_progress']);
    expect(await n('SELECT count(*) AS n FROM world.import_run')).toBe(runs);

    // the worker's import runner executes the requested run after the answer
    expect((await worker())?.runId).toBe(dryRunId);
    const done = await data<Run>(await get(`/import/runs/${dryRunId}`, 'office'));
    expect(done).toMatchObject({ kind: 'dry_run', status: 'done', stage: 'write', percent: 100 });
    expect(asTargets(done.report as Report)).toEqual(TARGETS);
    expect(changed(before, await databaseFingerprint(db.admin(), dryRunId))).toEqual([]);
  });

  // why: FR-IMP-2, FR-IMP-6
  it("gives each of the 6 reasons its first 2 problem rows by row number as the report's examples", async () => {
    const { report } = await data<Run>(await get(`/import/runs/${dryRunId}`, 'manager'));
    expect(report?.problems.byReason.map((x) => x.reason)).toEqual([...PROBLEM_REASON_KEYS]);
    for (const r of report?.problems.byReason ?? []) {
      const want = await db.admin().query<{ file: string; row_number: number; example: string }>(
        'SELECT file, row_number, example FROM world.import_problem_row WHERE run_id = $1 AND reason = $2 ORDER BY row_number, file LIMIT 2', [dryRunId, r.reason]);
      expect(r.examples).toEqual(want.rows.map((w) => ({ file: w.file, rowNumber: w.row_number, example: w.example, words: expect.any(String) })));
      expect(r.examples).toHaveLength(2);
    }
  });

  // why: F-259 each example carries the reason's catalog words in the caller's language, English for an English user and Spanish for a Spanish one, so no stored English reaches a Spanish page
  it("adds the reason's catalog words to each example in the language of the person asking", async () => {
    const words = async () => (await data<Run>(await get(`/import/runs/${dryRunId}`, 'office'))).report!.problems.byReason.map((r) => [r.reason, r.examples[0]!.words]);
    const own = (await db.admin().query<{ language: string }>('SELECT language FROM world."user" WHERE id = $1', [users.office])).rows[0]!.language;
    const speak = (l: 'en' | 'es') => db.admin().query('UPDATE world."user" SET language = $2 WHERE id = $1', [users.office, l]);
    try {
      for (const l of ['en', 'es'] as const) {
        await speak(l);
        expect(Object.fromEntries(await words())).toEqual(Object.fromEntries(PROBLEM_REASON_KEYS.map((k) => [k, catalogs[l][`admin.import.words.${k}`]])));
      }
    } finally {
      await speak(own as 'en' | 'es');
    }
  });

  // why: F-521 a failed run answers its failure code (tried 3 times, the export refused, an error), and no other run answers one
  it('answers the failure code of a failed run on API-81, and null for a run that did not fail', async () => {
    const row = async (error: object | null) =>
      (await db.admin().query<{ id: string }>(
        `INSERT INTO world.import_run (kind, status, stage, percent, started_at, finished_at, by_setup, report) VALUES ('dry_run', 'failed', 'parse', 41, now(), now(), true, $1) RETURNING id`,
        [error === null ? null : JSON.stringify(error)])).rows[0]!.id;
    const ids = [await row({ error: 'attempts_exhausted', attempts: 3 }), await row({ error: 'generator_manifest', attempts: 1 }), await row(null)];
    try {
      const got = [] as unknown[];
      for (const id of ids) got.push(await data<Run>(await get(`/import/runs/${id}`, 'office')));
      expect(got).toEqual([
        { kind: 'dry_run', status: 'failed', stage: 'parse', percent: 41, report: null, failure: 'attempts_exhausted' },
        { kind: 'dry_run', status: 'failed', stage: 'parse', percent: 41, report: null, failure: 'generator_manifest' },
        { kind: 'dry_run', status: 'failed', stage: 'parse', percent: 41, report: null, failure: 'import_failed' },
      ]);
      expect((await data<Run>(await get(`/import/runs/${dryRunId}`, 'office'))).failure).toBeNull();
    } finally {
      await db.admin().query('DELETE FROM world.import_run WHERE id = ANY($1::uuid[])', [ids]);
    }
  });

  // why: FR-IMP-1
  it('answers not_found for a run id that does not exist and validation_failed for one that is not an id', async () => {
    const missing = await get('/import/runs/0192f000-0000-7000-8000-000000000000', 'office');
    expect([missing.status, await code(missing)]).toEqual([404, 'not_found']);
    const bad = await get('/import/runs/not-a-run', 'office');
    expect([bad.status, await code(bad)]).toEqual([422, 'validation_failed']);
  });
});

describe('API-83 problem list (FR-IMP-2)', () => {
  // why: FR-IMP-2
  it('downloads every problem row of the run with its reason as a CSV spreadsheet file', async () => {
    const r = await get(`/import/runs/${dryRunId}/problems`, 'office');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="problem-list.csv"');
    const lines = (await r.text()).split('\r\n');
    expect(lines.at(-1)).toBe('');
    expect(lines[0]).toBe(PROBLEM_LIST_COLUMNS.join(','));
    const rows = lines.slice(1, -1);
    expect(rows).toHaveLength(TARGETS.problems.total);
    // every row names 1 of the 6 reasons, and each reason's count equals the import target table (FR-IMP-6)
    const reasons = rows.map((l) => (/^(?:customers|visits|equipment)\.csv,\d+,([a-z_]+),/.exec(l) ?? [])[1]);
    for (const [reason, count] of Object.entries(TARGETS.problems.byReason)) expect(reasons.filter((x) => x === reason).length, reason).toBe(count);
    // the first row is the first stored problem of customers.csv, with its example as stored
    const first = await db.admin().query<{ row_number: number; reason: string; example: string }>(
      `SELECT row_number, reason, example FROM world.import_problem_row WHERE run_id = $1 AND file = 'customers.csv' ORDER BY row_number LIMIT 1`, [dryRunId]);
    const f = first.rows[0]!;
    expect(rows[0]).toBe(['customers.csv', f.row_number, f.reason, f.example].map(csvCell).join(','));
  });

  // why: FR-IMP-2
  it('quotes a cell with a comma, quote or line break, and keeps a cell that starts like a formula as text', () => {
    expect(csvCell('Earl Mott: (614) 555-01')).toBe('Earl Mott: (614) 555-01');
    expect(csvCell('Mott, Earl: ')).toBe('"Mott, Earl: "');
    expect(csvCell('Bob "B" Kerr')).toBe('"Bob ""B"" Kerr"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell(42)).toBe('42');
  });

  // why: FR-IMP-2
  it('answers not_found for a run that does not exist', async () => {
    const r = await get('/import/runs/0192f000-0000-7000-8000-000000000000/problems', 'office');
    expect([r.status, await code(r)]).toEqual([404, 'not_found']);
  });
});

describe('API-84 start the real run, API-82 import runs (FR-IMP-1, FR-IMP-10)', () => {
  // why: FR-IMP-10
  it('lists the dry run with who ran it, its export time and counts, and no real run yet (Run the import is offered)', async () => {
    const list = await data<{ runs: Record<string, unknown>[]; realRun: unknown }>(await get('/import/runs', 'office'));
    expect(list.realRun).toBeNull();
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]).toMatchObject({
      runId: dryRunId, kind: 'dry_run', status: 'done', by: { kind: 'user', userId: users.office },
      sourceExportedAt: '2026-08-31T05:00:00-04:00[America/New_York]',
      counts: { customers: TARGETS.customers, problems: TARGETS.problems.total, duplicates: TARGETS.duplicates },
    });
    expect(list.runs[0]?.finishedAt).toEqual(expect.stringMatching(/\[America\/New_York\]$/));
  });

  // why: FR-IMP-1, FR-IMP-10
  it('answers 202 for the real run; the worker loads the FR-IMP-6 counts; the run shows as the realRun', async () => {
    const started = await post('/import/runs', { kind: 'real' }, 'manager');
    expect(started.status).toBe(202);
    const body = (await started.json()) as { data: { runId: string }; meta: { contract: string } };
    expect(body.meta.contract).toBe('API-84');
    realRunId = body.data.runId;
    expect(await data<Run>(await get(`/import/runs/${realRunId}`, 'office'))).toMatchObject({ kind: 'real', status: 'running' });
    expect((await worker())?.runId).toBe(realRunId);
    const done = await data<Run>(await get(`/import/runs/${realRunId}`, 'office'));
    expect(done.status).toBe('done');
    expect(asTargets(done.report as Report)).toEqual(TARGETS);
    expect(await n('SELECT count(*) AS n FROM world.customer')).toBe(TARGETS.customers.total);
    expect(await n('SELECT count(*) AS n FROM world.past_visit')).toBe(TARGETS.visits.imported);
    expect(await n('SELECT count(*) AS n FROM world.equipment')).toBe(TARGETS.equipment.imported);
    expect(await n(`SELECT count(*) AS n FROM world."merge" WHERE kind = 'exact'`)).toBe(TARGETS.duplicates.exact);
    const list = await data<{ realRun: { runId: string; by: unknown } }>(await get('/import/runs', 'office'));
    expect(list.realRun).toMatchObject({ runId: realRunId, by: { kind: 'user', userId: users.manager } });
  });

  // why: FR-IMP-10
  it('answers real_run_exists to a second real run and writes nothing; the dry run stays usable', async () => {
    const before = await databaseFingerprint(db.admin());
    const again = await post('/import/runs', { kind: 'real' }, 'manager');
    expect([again.status, await code(again)]).toEqual([409, 'real_run_exists']);
    expect(await worker()).toBeNull();
    expect(changed(before, await databaseFingerprint(db.admin()))).toEqual([]);

    const dry = await post('/import/runs', { kind: 'dry_run' }, 'office');
    expect(dry.status).toBe(202);
    const { runId } = await data<{ runId: string }>(dry);
    expect((await worker())?.runId).toBe(runId);
    // a dry run on the loaded world (OI-11) changes nothing but its own run record and problem list
    expect((await data<Run>(await get(`/import/runs/${runId}`, 'office'))).status).toBe('done');
    expect(changed(before, await databaseFingerprint(db.admin(), runId))).toEqual([]);
  });
});

interface PairRecord {
  customerId: string; oldCustomerNumber: string | null; name: string; street: string; city: string; state: string; zip: string;
  phones: { number: string; kind: 'mobile' | 'home' }[]; textLanguage: string; customerSince: string; branchId: string;
  plan: 'comfort_club' | 'none'; notes: string | null; equipment: { type: string; year: number | null; details: string | null }[];
  visits: { count: number; first: string | null; last: string | null; lastVisit: { date: string; service: string; serviceId: string | null } | null };
}
interface Pair {
  pairId: string; recordA: PairRecord; recordB: PairRecord; whyListed: string; status: string;
  decidedBy: { userId: string; name: string } | null; mergePreview: { keptName: string; visits: number; equipment: number };
}
interface Dupes { progress: Record<string, number>; pairs: Pair[]; next: string | null }

/** Every pair of a Show choice, page by page through the cursors. */
async function allPairs(status: string): Promise<Pair[]> {
  const out: Pair[] = [];
  let cursor: string | null = null;
  do {
    const q: string = `/import/duplicates?status=${status}&limit=200${cursor ? `&cursor=${cursor}` : ''}`;
    const page: Dupes = await data<Dupes>(await get(q, 'office'));
    out.push(...page.pairs);
    cursor = page.next;
  } while (cursor);
  return out;
}

let pairs: Pair[] = [];

describe('API-85 likely duplicates (FR-IMP-3, FR-IMP-9, FR-IMP-11)', () => {
  // why: FR-IMP-3, FR-IMP-9
  it('lists the 428 likely pairs page by page, with progress, why each was listed, and the merge preview', async () => {
    const first = await data<Dupes>(await get('/import/duplicates', 'office'));
    expect(first.progress).toEqual({ listed: TARGETS.duplicates.likely, checked: 0, left: TARGETS.duplicates.likely, merged: 0, keptSeparate: 0, skipped: 0 });
    expect(first.pairs).toHaveLength(50); // the default page of 50 rows of the To check list (SPECIFICATIONS 7.1)
    expect(first.next).not.toBeNull();
    pairs = await allPairs('all');
    expect(pairs).toHaveLength(TARGETS.duplicates.likely);
    expect(new Set(pairs.map((p) => p.pairId)).size).toBe(pairs.length);
    expect(pairs.every((p) => p.status === 'listed' && p.decidedBy === null && p.whyListed !== '')).toBe(true);
    // the named sample likely pair (FR-IMP-9): Kathy OBrien and Kathleen O'Brien-Miller
    expect(pairs.some((p) => [p.recordA.name, p.recordB.name].sort().join(' / ') === "Kathleen O'Brien-Miller / Kathy OBrien")).toBe(true);
    for (const p of pairs) {
      expect(p.mergePreview).toEqual({
        keptName: p.recordA.name, visits: p.recordA.visits.count + p.recordB.visits.count, equipment: p.recordA.equipment.length + p.recordB.equipment.length,
      });
    }
    // the preview's counts are the records' own rows (past visits with done jobs; equipment), read here independently
    const p = pairs.find((x) => x.recordA.visits.count > 0 && x.recordB.visits.count > 0 && x.recordA.equipment.length + x.recordB.equipment.length > 0) ?? pairs[0]!;
    const ids = [p.recordA.customerId, p.recordB.customerId];
    expect(p.mergePreview.visits).toBe(await n(`SELECT (SELECT count(*) FROM world.past_visit WHERE customer_id = ANY($1::uuid[]))
      + (SELECT count(*) FROM world.job WHERE status = 'done' AND customer_id = ANY($1::uuid[])) AS n`, [ids]));
    expect(p.mergePreview.equipment).toBe(await n('SELECT count(*) AS n FROM world.equipment WHERE customer_id = ANY($1::uuid[])', [ids]));
  });

  // why: F-621, F-870, F-879 each record carries the UI-SPECIFICATION v0.13 API-85 fields the shown pair draws (owner ruling d9901466) and no email
  it("gives each record its v0.13 fields: old customer number, state, phones with their kind, plan, notes, equipment list, visit range and last visit, and no email", async () => {
    const keys = ['branchId', 'city', 'customerId', 'customerSince', 'equipment', 'name', 'notes', 'oldCustomerNumber', 'phones', 'plan', 'state', 'street', 'textLanguage', 'visits', 'zip'];
    // The import writes no membership (the world seed does, and this world has none): 1 record gets one, so the Plan row's member case is read.
    const member = pairs[0]!.recordA.customerId;
    await db.admin().query(`INSERT INTO world.membership (customer_id, since, renews, benefits_key) VALUES ($1, '2024-03-01', '2027-03-01', 'comfort_club')`, [member]);
    let recs: PairRecord[];
    try {
      recs = (await allPairs('all')).flatMap((x) => [x.recordA, x.recordB]);
    } finally {
      await db.admin().query('DELETE FROM world.membership WHERE customer_id = $1', [member]);
    }
    expect(recs.find((r) => r.customerId === member)?.plan).toBe('comfort_club');
    for (const r of recs) expect(Object.keys(r).sort()).toEqual(keys);
    expect(recs.some((r) => 'email' in r)).toBe(false);
    // Each field read here from the tables directly, never through the handler's query.
    const db0 = await db.admin().query<{
      id: string; old: string | null; mobile: string | null; home: string | null; getting_in: string | null; member: boolean;
      equipment: { type: string; year: number | null; details: string | null }[]; pv: string[]; jobs: string[];
      pv_services: { date: string; service: string }[]; job_services: { date: string; service: string }[];
    }>(
      `SELECT c.id, c.old_customer_number AS old, c.mobile, c.home_phone AS home, c.getting_in,
              EXISTS (SELECT 1 FROM world.membership m WHERE m.customer_id = c.id) AS member,
              coalesce((SELECT json_agg(json_build_object('type', e.type, 'year', e.year, 'details', e.details) ORDER BY e.id) FROM world.equipment e WHERE e.customer_id = c.id), '[]') AS equipment,
              coalesce((SELECT array_agg(v.date::text) FROM world.past_visit v WHERE v.customer_id = c.id), '{}') AS pv,
              coalesce((SELECT array_agg(j.date::text) FROM world.job j WHERE j.customer_id = c.id AND j.status = 'done'), '{}') AS jobs,
              coalesce((SELECT json_agg(json_build_object('date', v.date::text, 'service', v.service_text)) FROM world.past_visit v WHERE v.customer_id = c.id), '[]') AS pv_services,
              coalesce((SELECT json_agg(json_build_object('date', j.date::text, 'service', j.service_id)) FROM world.job j WHERE j.customer_id = c.id AND j.status = 'done'), '[]') AS job_services
         FROM world.customer c WHERE c.id = ANY($1::uuid[])`, [recs.map((r) => r.customerId)]);
    const byId = new Map(db0.rows.map((r) => [r.id, r]));
    for (const r of recs) {
      const d = byId.get(r.customerId)!;
      expect(r.oldCustomerNumber).toBe(d.old);
      expect(r.oldCustomerNumber).toMatch(/^\d{5}$/); // every record on the page is imported: its customers.csv customer_ref (generate.ts)
      expect(r.state).toBe('OH');
      expect(r.phones).toEqual([...(d.mobile ? [{ number: d.mobile, kind: 'mobile' }] : []), ...(d.home ? [{ number: d.home, kind: 'home' }] : [])]);
      expect([r.plan, r.notes]).toEqual([d.member || r.customerId === member ? 'comfort_club' : 'none', d.getting_in]); // member's row was read before its delete
      expect(r.equipment).toEqual(d.equipment);
      const dates = [...d.pv, ...d.jobs].sort();
      expect(r.visits.count).toBe(dates.length);
      expect([r.visits.first, r.visits.last]).toEqual([dates[0] ?? null, dates.at(-1) ?? null]);
      if (dates.length === 0) expect(r.visits.lastVisit).toBeNull();
      else {
        expect(r.visits.lastVisit?.date).toBe(dates.at(-1));
        const onLast = [...d.pv_services.map((x) => ({ ...x, id: null })), ...d.job_services.map((x) => ({ ...x, id: x.service }))].filter((x) => x.date === dates.at(-1));
        expect(onLast).toContainEqual({ date: r.visits.lastVisit!.date, service: r.visits.lastVisit!.service, id: r.visits.lastVisit!.serviceId });
      }
    }
    // The 2-line cells and the Notes row have data to show on this world: not every record is empty.
    expect(recs.some((r) => r.notes !== null)).toBe(true);
    expect(recs.some((r) => r.equipment.length > 1)).toBe(true);
    expect(recs.some((r) => r.visits.count > 2 && r.visits.first !== r.visits.last)).toBe(true);
  });

  // why: FR-IMP-3
  it('answers validation_failed for a cursor it did not issue', async () => {
    const r = await get('/import/duplicates?cursor=%%%', 'office');
    expect([r.status, await code(r)]).toEqual([422, 'validation_failed']);
  });

  // why: F-260 a forged cursor whose id is not a uuid answers validation_failed on API-85 and API-87, not 500 from the ::uuid bind
  it('answers validation_failed for a cursor that decodes but holds an id that is not a uuid', async () => {
    const forged = encodeURIComponent(encodeCursor('k', 'not-a-uuid'));
    for (const path of ['/import/duplicates', '/import/merges']) {
      const r = await get(`${path}?cursor=${forged}`, 'office');
      expect([path, r.status, await code(r)]).toEqual([path, 422, 'validation_failed']);
    }
  });
});

let officeMergeId = '';

describe('API-86 decide a pair (FR-IMP-3, FR-IMP-4, FR-IMP-11)', () => {
  // why: FR-IMP-3, FR-IMP-11
  it('merges a pair, keeping record A, and answers already_decided to the next decision on it', async () => {
    const p = pairs[0]!;
    const r = await post(`/import/duplicates/${p.pairId}/decision`, { decision: 'merge' }, 'office');
    expect(r.status).toBe(200);
    const out = await data<{ pair: Pair; mergeId: string | null }>(r);
    expect(out.pair).toMatchObject({ pairId: p.pairId, status: 'merged', decidedBy: { userId: users.office } });
    expect(out.mergeId).toEqual(expect.any(String));
    officeMergeId = out.mergeId as string;
    expect(out.pair.recordA).toMatchObject({ name: p.recordA.name, visits: { count: p.mergePreview.visits } });
    expect(out.pair.recordA.equipment).toHaveLength(p.mergePreview.equipment);
    expect(out.pair.recordB).toMatchObject({ visits: { count: 0, first: null, last: null, lastVisit: null }, equipment: [] });
    const b = await db.admin().query<{ status: string; merged_into: string }>('SELECT status, merged_into FROM world.customer WHERE id = $1', [p.recordB.customerId]);
    expect(b.rows[0]).toEqual({ status: 'merged', merged_into: p.recordA.customerId });
    const again = await post(`/import/duplicates/${p.pairId}/decision`, { decision: 'keep_separate' }, 'manager');
    expect([again.status, await code(again)]).toEqual([409, 'already_decided']);
  });

  // why: FR-IMP-11
  it('skips a pair for later (it stays in the queue, counted as skipped), then keeps it separate; a skip after that is already_decided', async () => {
    const p = pairs[1]!;
    const skipped = await data<{ pair: Pair; mergeId: string | null }>(await post(`/import/duplicates/${p.pairId}/decision`, { decision: 'skip' }, 'office'));
    expect(skipped).toMatchObject({ pair: { status: 'skipped' }, mergeId: null });
    expect((await allPairs('skipped')).map((x) => x.pairId)).toEqual([p.pairId]);
    const kept = await data<{ pair: Pair }>(await post(`/import/duplicates/${p.pairId}/decision`, { decision: 'keep_separate' }, 'manager'));
    expect(kept.pair).toMatchObject({ status: 'kept_separate', decidedBy: { userId: users.manager } });
    const again = await post(`/import/duplicates/${p.pairId}/decision`, { decision: 'skip' }, 'office');
    expect([again.status, await code(again)]).toEqual([409, 'already_decided']);
    const { progress } = await data<Dupes>(await get('/import/duplicates', 'office'));
    expect(progress).toEqual({ listed: 428, checked: 2, left: 426, merged: 1, keptSeparate: 1, skipped: 0 });
    expect((await allPairs('to_check')).length).toBe(426);
  });

  // why: FR-IMP-3, FR-IMP-11
  it('lets exactly 1 of 2 people decide a pair at the same moment; the other is told already_decided', async () => {
    const p = pairs[2]!;
    const [x, y] = await Promise.all([
      post(`/import/duplicates/${p.pairId}/decision`, { decision: 'merge' }, 'office'),
      post(`/import/duplicates/${p.pairId}/decision`, { decision: 'keep_separate' }, 'manager'),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(await code(x.status === 409 ? x : y)).toBe('already_decided');
    expect(await n(`SELECT count(*) AS n FROM world."merge" m JOIN world.duplicate_pair p ON p.id = m.pair_id WHERE p.id = $1`, [p.pairId]))
      .toBe(x.status === 200 ? 1 : 0);
  });

  // why: FR-IMP-11
  it('answers not_found for a pair that does not exist', async () => {
    const r = await post('/import/duplicates/0192f000-0000-7000-8000-000000000000/decision', { decision: 'skip' }, 'office');
    expect([r.status, await code(r)]).toEqual([404, 'not_found']);
  });
});

interface MergeItem { mergeId: string; records: { a: { customerId: string; name: string }; b: { customerId: string; name: string } }; address: string; kind: string; at: string; status: string }
interface MergesPage { merges: MergeItem[]; next: string | null; total: number }

describe('API-87 merges, API-88 undo a merge (FR-IMP-4)', () => {
  // why: FR-IMP-4
  it("lists every merge newest first, the office's above the run's exact matches, page by page, and finds one by a record's name", async () => {
    const all: MergeItem[] = [];
    let cursor: string | null = null;
    do {
      const page: { merges: MergeItem[]; next: string | null } = await data(await get(`/import/merges?limit=200${cursor ? `&cursor=${cursor}` : ''}`, 'office'));
      all.push(...page.merges);
      cursor = page.next;
    } while (cursor);
    const office = await n(`SELECT count(*) AS n FROM world."merge" WHERE kind = 'office'`);
    expect(all).toHaveLength(TARGETS.duplicates.exact + office);
    expect(all.slice(0, office).every((m) => m.kind === 'office')).toBe(true);
    expect(all.find((m) => m.mergeId === officeMergeId)).toMatchObject({ kind: 'office', status: 'active', records: { a: { name: pairs[0]!.recordA.name } } });
    const name = pairs[0]!.recordB.name;
    const found = await data<{ merges: MergeItem[] }>(await get(`/import/merges?name=${encodeURIComponent(name)}`, 'office'));
    expect(found.merges.map((m) => m.mergeId)).toContain(officeMergeId);
    expect(found.merges.every((m) => [m.records.a.name, m.records.b.name].some((x) => x.toLowerCase().includes(name.split(' ')[0]!.toLowerCase())))).toBe(true);
  });

  // why: F-621 each merge carries the kept record's address line and every page the total the search matches (owner ruling d9901466, UI-SPECIFICATION v0.13 API-87)
  it("gives each merge record A's house number, street and city, and the total of merges the name search matches on every page", async () => {
    const all: MergeItem[] = [];
    const totals: number[] = [];
    let cursor: string | null = null;
    do {
      const page: MergesPage = await data(await get(`/import/merges?limit=200${cursor ? `&cursor=${cursor}` : ''}`, 'office'));
      all.push(...page.merges);
      totals.push(page.total);
      cursor = page.next;
    } while (cursor);
    const every = await n(`SELECT count(*) AS n FROM world."merge"`);
    expect(totals.length).toBeGreaterThan(1);
    expect(new Set(totals)).toEqual(new Set([every]));
    expect(all).toHaveLength(every);
    // The address read here from the tables: the pair's record A (the kept record), its house number, street name and city.
    const want = await db.admin().query<{ id: string; address: string }>(
      `SELECT m.id, c.house_number || ' ' || s.name || ', ' || s.city AS address FROM world."merge" m JOIN world.duplicate_pair p ON p.id = m.pair_id
         JOIN world.customer c ON c.id = p.record_a JOIN world.street s ON s.id = c.street_id`);
    expect(new Map(all.map((m) => [m.mergeId, m.address]))).toEqual(new Map(want.rows.map((r) => [r.id, r.address])));
    // With a name, the total is the matching merges, not the page: a 1-row page of a search with more matches says how many.
    const name = all[0]!.records.a.name;
    const found: MergeItem[] = [];
    cursor = null;
    do {
      const page: MergesPage = await data(await get(`/import/merges?name=${encodeURIComponent(name)}&limit=200${cursor ? `&cursor=${cursor}` : ''}`, 'office'));
      found.push(...page.merges);
      cursor = page.next;
    } while (cursor);
    const one: MergesPage = await data(await get(`/import/merges?name=${encodeURIComponent(name)}&limit=1`, 'office'));
    expect(one.merges).toHaveLength(1);
    expect(one.total).toBe(found.length);
    const none: MergesPage = await data(await get('/import/merges?name=zzqqxxnobody', 'office'));
    expect([none.merges, none.total]).toEqual([[], 0]);
  });

  // why: FR-IMP-4
  // (an imported record owns no jobs; undo returning moved jobs to B is proved in packages/import/src/merge.db.test.ts)
  it('undoes an exact merge of the run: record B comes back with its past visits and equipment; a second undo is already_undone', async () => {
    const m = await db.admin().query<{ id: string; a: string; b: string; payload: { moved: { pastVisitIds: string[]; equipmentIds: string[] } } }>(
      `SELECT m.id, p.record_a AS a, p.record_b AS b, m.undo_payload AS payload FROM world."merge" m JOIN world.duplicate_pair p ON p.id = m.pair_id
        WHERE m.kind = 'exact' AND jsonb_array_length(m.undo_payload->'moved'->'pastVisitIds') > 0
          AND jsonb_array_length(m.undo_payload->'moved'->'equipmentIds') > 0 ORDER BY m.id LIMIT 1`);
    const merge = m.rows[0]!;
    const r = await post(`/import/merges/${merge.id}/undo`, {}, 'manager');
    expect(r.status).toBe(200);
    const out = await data<{ merge: MergeItem; restored: string[] }>(r);
    expect(out.merge).toMatchObject({ mergeId: merge.id, kind: 'exact', status: 'undone' });
    expect(out.restored).toEqual([merge.a, merge.b]);
    const b = await db.admin().query<{ status: string; merged_into: string | null }>('SELECT status, merged_into FROM world.customer WHERE id = $1', [merge.b]);
    expect(b.rows[0]).toEqual({ status: 'active', merged_into: null });
    const visits = await db.admin().query<{ id: string }>('SELECT id FROM world.past_visit WHERE customer_id = $1 ORDER BY id', [merge.b]);
    expect(visits.rows.map((x) => x.id)).toEqual([...merge.payload.moved.pastVisitIds].sort());
    const eq = await db.admin().query<{ id: string }>('SELECT id FROM world.equipment WHERE customer_id = $1 ORDER BY id', [merge.b]);
    expect(eq.rows.map((x) => x.id)).toEqual([...merge.payload.moved.equipmentIds].sort());
    const again = await post(`/import/merges/${merge.id}/undo`, {}, 'office');
    expect([again.status, await code(again)]).toEqual([409, 'already_undone']);
  });

  // why: F-265, FR-IMP-11
  it('shows an undone exact-match pair again on the review page, with the likely pairs (owner ruling ba125b81 "Show it again")', async () => {
    const undone = await db.admin().query<{ pair_id: string }>(
      `SELECT m.pair_id FROM world."merge" m WHERE m.kind = 'exact' AND m.status = 'undone'`);
    expect(undone.rows).toHaveLength(1);
    const pairId = undone.rows[0]!.pair_id;
    const queue = await allPairs('to_check');
    expect(queue.find((p) => p.pairId === pairId)).toMatchObject({ status: 'listed', whyListed: 'exact_match', decidedBy: null });
    expect(queue.some((p) => p.whyListed !== 'exact_match')).toBe(true); // the likely pairs are on the same page
    const all = await data<Dupes>(await get('/import/duplicates?status=all', 'office'));
    expect(all.progress.listed).toBe(TARGETS.duplicates.likely + 1);
    // Every likely pair's why spells the approved sentence's shape: what matches, then what differs (F-265).
    expect(queue.filter((p) => p.whyListed !== 'exact_match').every((p) => /^(\w+_match)?_?(\w+_differ)?$/.test(p.whyListed) && p.whyListed.includes('name'))).toBe(true);
  });

  // why: FR-IMP-4
  it("undoes the office's merge: both records come back with their own visits and equipment, and the pair is back in the queue", async () => {
    const p = pairs[0]!;
    const out = await data<{ merge: MergeItem; restored: string[] }>(await post(`/import/merges/${officeMergeId}/undo`, {}, 'office'));
    expect(out).toMatchObject({ merge: { status: 'undone', kind: 'office' }, restored: [p.recordA.customerId, p.recordB.customerId] });
    const back = (await allPairs('to_check')).find((x) => x.pairId === p.pairId);
    expect(back).toMatchObject({ status: 'listed', decidedBy: null, recordA: { visits: p.recordA.visits, equipment: p.recordA.equipment }, recordB: { visits: p.recordB.visits, equipment: p.recordB.equipment } });
  });

  // why: FR-IMP-4
  it('answers not_found for a merge that does not exist', async () => {
    const r = await post('/import/merges/0192f000-0000-7000-8000-000000000000/undo', {}, 'office');
    expect([r.status, await code(r)]).toEqual([404, 'not_found']);
  });
});

describe('a merge and its undo move record B jobs on the record (owner ruling a7cafbb1 "Show it", F-267)', () => {
  // why: F-267, FR-DISP-5, NFR-01
  it('writes a merged job_change row, bumps the version and sends job.changed for the job, at the merge and again at its undo', async () => {
    const listener = createClient({ connectionString: db.url() });
    await listener.connect();
    const notices: { name: string; ids: Record<string, unknown> }[] = [];
    listener.on('notification', (m) => { if (m.channel === BUS_CHANNEL) notices.push(JSON.parse(m.payload ?? '{}')); });
    await listener.query(`LISTEN ${BUS_CHANNEL}`);
    const settled = async (count: number) => {
      for (let i = 0; i < 100 && notices.length < count; i++) await new Promise((r) => setTimeout(r, 20));
      return notices.length;
    };
    try {
      const pair = (await allPairs('to_check')).filter((p) => p.whyListed !== 'exact_match')[10]!;
      const b = pair.recordB;
      const w = (await db.admin().query<{ id: string }>(
        `SELECT id FROM world.arrival_window WHERE branch_id = $1 AND mode = 'two_hour' ORDER BY start_local LIMIT 1`, [b.branchId])).rows[0]!;
      // The office books record B a visit through the real kernel (API-28), so B owns a job before the merge.
      const created = await post('/jobs', {
        customerId: b.customerId, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: '2026-09-17', windowId: w.id, technicianId: null,
      }, 'office');
      expect(created.status).toBe(201);
      const job = (await data<{ job: { jobNumber: number; version: number } }>(created)).job;
      // API-28 sends the confirmation text too (F-671), so its commit carries a text notice beside job.changed: those 2 are drained, then the merge and its undo are counted.
      expect(await settled(2)).toBe(2);
      notices.length = 0;
      const history = async () => (await db.admin().query<{ kind: string; from_version: number; to_version: number; actor_kind: string; actor_user_id: string | null; data: Record<string, unknown> }>(
        'SELECT kind, from_version, to_version, actor_kind, actor_user_id, data FROM world.job_change WHERE job_number = $1 ORDER BY to_version', [job.jobNumber])).rows;
      const jobRow = async () => (await db.admin().query<{ customer_id: string; version: number }>('SELECT customer_id, version FROM world.job WHERE job_number = $1', [job.jobNumber])).rows[0];

      const merged = await post(`/import/duplicates/${pair.pairId}/decision`, { decision: 'merge' }, 'manager');
      expect(merged.status).toBe(200);
      const mergeId = (await data<{ mergeId: string }>(merged)).mergeId;
      expect(await jobRow()).toEqual({ customer_id: pair.recordA.customerId, version: 2 });
      expect(await settled(1)).toBe(1);
      expect(notices[0]).toEqual({ name: 'job.changed', ids: { jobNumber: job.jobNumber, branch: b.branchId } });

      const undone = await post(`/import/merges/${mergeId}/undo`, {}, 'office');
      expect(undone.status).toBe(200);
      expect(await jobRow()).toEqual({ customer_id: b.customerId, version: 3 });
      expect(await settled(2)).toBe(2);
      expect(notices[1]).toEqual({ name: 'job.changed', ids: { jobNumber: job.jobNumber, branch: b.branchId } });

      expect(await history()).toEqual([
        expect.objectContaining({ kind: 'created', from_version: 0, to_version: 1, actor_kind: 'office', actor_user_id: users.office }),
        { kind: 'merged', from_version: 1, to_version: 2, actor_kind: 'office', actor_user_id: users.manager,
          data: { mergeId, step: 'merge', fromCustomerId: b.customerId, toCustomerId: pair.recordA.customerId } },
        { kind: 'merged', from_version: 2, to_version: 3, actor_kind: 'office', actor_user_id: users.office,
          data: { mergeId, step: 'undo', fromCustomerId: pair.recordA.customerId, toCustomerId: b.customerId } },
      ]);
      // The merge's undo payload names the moved job, so the undo moved exactly it back.
      const payload = await db.admin().query<{ jobs: number[] }>(`SELECT undo_payload->'moved'->'jobNumbers' AS jobs FROM world."merge" WHERE id = $1`, [mergeId]);
      expect(payload.rows[0]?.jobs).toEqual([job.jobNumber]);
    } finally {
      await listener.end();
    }
  });
});

describe('the import calls admit office staff and managers only (FR-AUTH-1, UI-SPECIFICATION 2.4)', () => {
  const calls: [string, () => Promise<Response>, () => Promise<Response>][] = [
    ['API-80', () => post('/import/runs', { kind: 'dry_run' }, 'technician'), () => post('/import/runs', { kind: 'dry_run' })],
    ['API-81', () => get(`/import/runs/${dryRunId}`, 'technician'), () => get(`/import/runs/${dryRunId}`)],
    ['API-82', () => get('/import/runs', 'technician'), () => get('/import/runs')],
    ['API-83', () => get(`/import/runs/${dryRunId}/problems`, 'technician'), () => get(`/import/runs/${dryRunId}/problems`)],
    ['API-84', () => post('/import/runs', { kind: 'real' }, 'technician'), () => post('/import/runs', { kind: 'real' })],
    ['API-85', () => get('/import/duplicates', 'technician'), () => get('/import/duplicates')],
    ['API-86', () => post(`/import/duplicates/${pairs[3]?.pairId}/decision`, { decision: 'skip' }, 'technician'), () => post(`/import/duplicates/${pairs[3]?.pairId}/decision`, { decision: 'skip' })],
    ['API-87', () => get('/import/merges', 'technician'), () => get('/import/merges')],
    ['API-88', () => post(`/import/merges/${officeMergeId}/undo`, {}, 'technician'), () => post(`/import/merges/${officeMergeId}/undo`, {})],
  ];

  // why: FR-AUTH-1, FR-IMP-1
  it('refuses a technician (forbidden) and a signed-out caller (unauthenticated) on each of API-80 to API-88, and writes nothing', async () => {
    const before = await databaseFingerprint(db.admin());
    for (const [id, asTech, signedOut] of calls) {
      const t = await asTech();
      expect([id, t.status, await code(t)]).toEqual([id, 403, 'forbidden']);
      const s = await signedOut();
      expect([id, s.status, await code(s)]).toEqual([id, 401, 'unauthenticated']);
    }
    expect(changed(before, await databaseFingerprint(db.admin()))).toEqual([]);
    expect(await n(`SELECT count(*) AS n FROM world.duplicate_pair WHERE id = $1 AND status = 'listed'`, [pairs[3]?.pairId])).toBe(1);
  });
});

describe('the dry-run fingerprint sees the clock row (F-541)', () => {
  // why: F-541 (FR-IMP-1) the fingerprint leaves out last_write_real only: a dry run that moved the clock's pause or anchor still shows
  it('ignores last_write_real and shows a changed pause', async () => {
    const a = db.admin();
    const before = await databaseFingerprint(a);
    await a.query(`UPDATE system.demo_clock SET last_write_real = last_write_real + interval '1 minute' WHERE id = 1`);
    expect(changed(before, await databaseFingerprint(a))).toEqual([]);
    await a.query('UPDATE system.demo_clock SET paused = NOT paused WHERE id = 1');
    expect(changed(before, await databaseFingerprint(a))).toEqual(['system.demo_clock']);
    await a.query('UPDATE system.demo_clock SET paused = NOT paused WHERE id = 1');
  });
});
