// SPDX-License-Identifier: AGPL-3.0-or-later
// Re-run semantics of the import runner on PostgreSQL 18 (as bw_web): a run that fails mid-write leaves no rows and
// a failed record, and a retry converges to the target counts with 1 durable completion record; a requested or live
// run refuses a second request; a setup run row left running by a dead setup is closed as failed, and an office run row
// left running (never picked up, or its executor died) is executed again from the start to 1 done record.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '@bw/db';
import { useMigratedDatabase } from '../../db/src/testing/fixture.ts';
import { ImportRefused, requestImportRun, runImport, runPendingImport, type RunKind } from './runner.ts';
import { generatedWorld, seedReference, stampClock, webPool } from './testing/world.ts';

const db = useMigratedDatabase();
let pool: ReturnType<typeof webPool>;
const files = generatedWorld().files;
const opts = (kind: RunKind) => ({ kind, files, bySetup: false, byUser: null, clock: stampClock(kind) });
const n = async (sql: string, params: unknown[] = []) => Number((await db.admin().query<{ n: string }>(sql, params)).rows[0]?.n);
const domainRows = () => n(`SELECT (SELECT count(*) FROM world.customer) + (SELECT count(*) FROM world.past_visit)
  + (SELECT count(*) FROM world.equipment) + (SELECT count(*) FROM world.duplicate_pair) + (SELECT count(*) FROM world."merge") AS n`);
const demoClock = () => new Date('2026-09-15T14:00:00Z');
/** A request in its own transaction on the web login, as API-80 and API-84 make it in the handler's transaction. */
async function request(kind: RunKind): Promise<string> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const id = await requestImportRun(c as unknown as Queryable, { kind, bySetup: false, byUser: null, at: demoClock() });
    await c.query('COMMIT');
    return id;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
const statusOf = async (id: string) => (await db.admin().query<{ status: string }>('SELECT status FROM world.import_run WHERE id = $1', [id])).rows[0]?.status;
const percentOf = async (id: string) => (await db.admin().query<{ percent: number }>('SELECT percent FROM world.import_run WHERE id = $1', [id])).rows[0]?.percent;

beforeAll(async () => {
  await seedReference(db.admin());
  pool = webPool(db.url());
});
afterAll(async () => {
  await pool?.end();
});

describe('re-runs (FR-IMP-1, FR-IMP-10)', () => {
  // why: FR-IMP-10
  it('closes a setup run row left running by a setup that is gone, then runs', async () => {
    const stale = await db.admin().query<{ id: string }>(
      `INSERT INTO world.import_run (kind, status, stage, percent, started_at, by_setup) VALUES ('real', 'running', 'write', 40, '2026-09-01T12:00:00Z', true) RETURNING id`);
    const out = await runImport(pool, opts('dry_run'));
    const r = await db.admin().query<{ id: string; status: string; finished_at: Date | null }>(
      'SELECT id, status, finished_at FROM world.import_run WHERE id = ANY($1::uuid[])', [[stale.rows[0]?.id, out.runId]]);
    const by = new Map(r.rows.map((x) => [x.id, x]));
    expect(by.get(stale.rows[0]?.id ?? '')).toMatchObject({ status: 'failed', finished_at: expect.anything() });
    expect(by.get(out.runId)?.status).toBe('done');
  });

  // why: FR-IMP-1, FR-IMP-10
  it('executes an office dry run row whose executor died mid-run again from the start, to 1 done record with its started_at', async () => {
    const stale = await db.admin().query<{ id: string }>(
      `INSERT INTO world.import_run (kind, status, stage, percent, started_at, by_setup) VALUES ('dry_run', 'running', 'write', 40, '2026-09-14T12:00:00Z', false) RETURNING id`);
    const id = stale.rows[0]?.id ?? '';
    const out = await runPendingImport(pool, { files, clock: demoClock });
    expect(out?.runId).toBe(id);
    const r = await db.admin().query<{ status: string; started_at: Date; percent: number; report: { customers: { total: number } } }>(
      'SELECT status, started_at, percent, report FROM world.import_run WHERE id = $1', [id]);
    expect(r.rows[0]).toMatchObject({ status: 'done', percent: 100, started_at: new Date('2026-09-14T12:00:00Z') });
    expect(r.rows[0]?.report.customers.total).toBe(18_400);
    expect(await n('SELECT count(*) AS n FROM world.import_problem_row WHERE run_id = $1', [id])).toBe(1184);
    // nothing is owed now: a second call executes nothing and writes nothing
    const runs = await n('SELECT count(*) AS n FROM world.import_run');
    expect(await runPendingImport(pool, { files, clock: demoClock })).toBeNull();
    expect(await n('SELECT count(*) AS n FROM world.import_run')).toBe(runs);
    expect(await domainRows()).toBe(0);
  });

  // why: FR-IMP-10
  it('refuses a request with run_in_progress while a run is requested, and lets exactly 1 of 2 executors run it', async () => {
    const id = await request('dry_run');
    const second = await request('real').catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ImportRefused);
    expect((second as ImportRefused).code).toBe('run_in_progress');
    expect(await statusOf(id)).toBe('running');
    const [a, b] = await Promise.all([runPendingImport(pool, { files, clock: demoClock }), runPendingImport(pool, { files, clock: demoClock })]);
    expect([a, b].filter((x) => x !== null).map((x) => x?.runId)).toEqual([id]);
    expect(await statusOf(id)).toBe('done');
    // the refused real request wrote nothing (the only real row is the first test's closed setup orphan)
    expect(await n(`SELECT count(*) AS n FROM world.import_run WHERE kind = 'real' AND status <> 'failed'`)).toBe(0);
  });

  // why: FR-IMP-10
  it("refuses setup's in-process run with run_in_progress while an executor holds a run", async () => {
    const id = await request('dry_run');
    const live = runPendingImport(pool, { files, clock: demoClock });
    // wait until the executor has picked the run up (its percent moves past 0), then ask for setup's run
    for (let i = 0; i < 400 && (await percentOf(id)) === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(await percentOf(id)).toBeGreaterThan(0);
    const refused = await runImport(pool, opts('dry_run')).catch((e: unknown) => e);
    expect((refused as ImportRefused).code).toBe('run_in_progress');
    expect((await live)?.runId).toBe(id);
    expect(await statusOf(id)).toBe('done');
  });

  // why: FR-IMP-1
  it('a real run that fails in the write stage leaves no row and a failed record; the retry converges to the target counts', async () => {
    // a planted fault: the 50,000th past visit insert raises, after every customer row is written
    await db.admin().query(`CREATE SEQUENCE plant_n;
      CREATE FUNCTION plant_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF nextval('plant_n') = 50000 THEN RAISE EXCEPTION 'planted write fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER plant_fail BEFORE INSERT ON world.past_visit FOR EACH ROW EXECUTE FUNCTION plant_fail();
      GRANT USAGE ON SEQUENCE plant_n TO app;`);
    const earlier = await n(`SELECT count(*) AS n FROM world.import_run WHERE kind = 'real'`);
    const failed = await runImport(pool, opts('real')).catch((e: unknown) => e);
    expect(String(failed)).toMatch(/planted write fault/);
    expect(await domainRows()).toBe(0);
    const f = await db.admin().query<{ status: string; finished_at: Date | null; report: unknown }>(
      `SELECT status, finished_at, report FROM world.import_run WHERE kind = 'real' ORDER BY started_at DESC`);
    expect(f.rows.length).toBe(earlier + 1);
    expect(f.rows.every((x) => x.status === 'failed' && x.finished_at !== null)).toBe(true);
    // the failed attempt's record names its failure (no row values: a database error is import_failed), never counts
    // (the first test's closed setup orphan was never executed, so it carries none)
    expect(f.rows.map((x) => x.report).filter((r) => r !== null)).toEqual([{ error: 'import_failed', attempts: 1 }]);
    expect(await n(`SELECT count(*) AS n FROM world.import_problem_row p JOIN world.import_run r ON r.id = p.run_id WHERE r.kind = 'real'`)).toBe(0);

    await db.admin().query('DROP TRIGGER plant_fail ON world.past_visit; DROP FUNCTION plant_fail(); DROP SEQUENCE plant_n;');
    const retry = await runImport(pool, opts('real'));
    expect(retry.report.customers.total).toBe(18_400);
    expect(await n('SELECT count(*) AS n FROM world.customer')).toBe(18_400);
    expect(await n('SELECT count(*) AS n FROM world.past_visit')).toBe(95_870);
    expect(await n('SELECT count(*) AS n FROM world.equipment')).toBe(30_904);
    expect(await n(`SELECT count(*) AS n FROM world."merge"`)).toBe(812);
    const runs = await db.admin().query<{ status: string; n: string }>(`SELECT status, count(*) AS n FROM world.import_run WHERE kind = 'real' GROUP BY status`);
    expect(Object.fromEntries(runs.rows.map((x) => [x.status, Number(x.n)]))).toEqual({ done: 1, failed: earlier + 1 });
    // the done real run is the completion record: a third start is refused
    const third = await runImport(pool, opts('real')).catch((e: unknown) => e);
    expect((third as ImportRefused).code).toBe('real_run_exists');
  });
});
