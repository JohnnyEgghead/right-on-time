// SPDX-License-Identifier: AGPL-3.0-or-later
// The worker's import runner job (P3-IMPORT-WORKER; F-258, F-323) through the worker as main.ts starts it: the real job
// registry, the bw_worker login, DbClock on the clock row, and the job's real export source (the generator's checked
// output from the verified street list). An office run requested in the handler's way (a running row, committed) is
// executed with no other call: one a dead executor left, at start-up; one requested later, within the poll; never while
// setup holds its lock; and after a real run the tables it filled carry fresh statistics (ANALYZE as bw_worker).
// Run by gate G-CI2 (ci/gates/G-CI2/vitest.db.config.ts includes apps/worker/src/*.db.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@bw/log';
import { requestImportRun, type RunKind } from '@bw/import';
import { SETUP_LOCK_KEYS, SetupError } from '@bw/setup';
import { DbClock, Temporal } from '@bw/time';
import { loadConfig } from '@bw/config';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { seedReference, webPool } from '../../../packages/import/src/testing/world.ts';
import { loginPool } from '../../../packages/outbox/src/testing/world.ts';
import { IMPORT_FILLED_TABLES, IMPORT_POLL_MS, startImportJob } from './import/index.ts';
import { startTestWorker, type TestWorker } from './testing/worker.ts';
import type { RunningJob, WorkerDeps } from './jobs.ts';

const db = useMigratedDatabase();
let web: ReturnType<typeof webPool>;
let worker: TestWorker | undefined;

/** A request as API-80 and API-84 make it: the running row, in its own committed transaction on the web login. */
async function request(kind: RunKind): Promise<string> {
  const c = await web.connect();
  try {
    await c.query('BEGIN');
    const id = await requestImportRun(c as never, { kind, bySetup: false, byUser: null, at: new Date('2026-09-15T14:00:00Z') });
    await c.query('COMMIT');
    return id;
  } finally {
    c.release();
  }
}
const row = async (id: string) => (await db.admin().query<{ status: string; percent: number; report: { customers?: { total: number }; error?: string } | null }>(
  'SELECT status, percent, report FROM world.import_run WHERE id = $1', [id])).rows[0];
/** Poll every 50 ms, at most `tries` times (no wall clock in a test: section 4.2). */
const until = async (ok: () => Promise<boolean>, what: string, tries = 1_800) => {
  for (let i = 0; !(await ok()); i++) {
    if (i >= tries) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const finished = (id: string) => until(async () => (await row(id))?.status !== 'running', `run ${id} to finish`);

beforeAll(async () => {
  await seedReference(db.admin());
  web = webPool(db.url());
});
afterAll(async () => {
  await worker?.stop();
  await web?.end();
});

describe('the worker executes the office import runs (F-258)', () => {
  // why: FR-IMP-1
  it('picks up at start-up a row a dead executor left running, and finishes it with no other call', async () => {
    const left = await db.admin().query<{ id: string }>(
      `INSERT INTO world.import_run (kind, status, stage, percent, started_at, by_setup, report)
       VALUES ('dry_run', 'running', 'write', 40, '2026-09-15T13:00:00Z', false, '{"attempts": 1}') RETURNING id`);
    const id = left.rows[0]?.id ?? '';
    worker = await startTestWorker(db.url());
    await finished(id);
    expect(await row(id)).toMatchObject({ status: 'done', percent: 100 });
    expect((await row(id))?.report?.customers?.total).toBe(18_400);
    // The row turns done inside the run, and executeOwed writes its line after the run returns (F-720): wait on the line, not the row.
    const started = worker;
    await until(async () => started.logs.some((l) => l.includes('"status":"import run done"')), 'the import run done log line');
  });

  // why: FR-IMP-1
  it('executes a run requested while it runs, within its poll, ending done with the dry-run counts', async () => {
    const id = await request('dry_run');
    await finished(id);
    expect(await row(id)).toMatchObject({ status: 'done', percent: 100 });
    expect((await row(id))?.report?.customers?.total).toBe(18_400);
  });

  // why: FR-IMP-10
  it('executes no office run while setup holds its lock, and executes it once the lock is released', async () => {
    // db.admin() is 1 session, so it holds the lock as setup's own session does
    const holder = db.admin();
    await holder.query('SELECT pg_advisory_lock($1, $2)', [...SETUP_LOCK_KEYS]);
    let id = '';
    try {
      id = await request('dry_run');
      await new Promise((r) => setTimeout(r, IMPORT_POLL_MS * 3));
      expect(await row(id)).toMatchObject({ status: 'running', percent: 0, report: null });
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1, $2)', [...SETUP_LOCK_KEYS]);
    }
    await finished(id);
    expect((await row(id))?.status).toBe('done');
  });

  // why: FR-IMP-10
  it('ends a run failed with the named error when its export is refused, and logs that code only', async () => {
    await worker?.stop();
    worker = undefined;
    const logs: string[] = [];
    const pool = loginPool(db.url(), 'bw_worker');
    const deps: WorkerDeps = {
      pool, settings: loadConfig({}), log: createLogger({ process: 'worker', write: (l) => logs.push(l) }),
      clock: new DbClock(pool, { cacheMs: 0, real: () => Temporal.Instant.from('2026-11-01T16:00:00Z') }),
    };
    const refused = new SetupError('generator_manifest', 'customers.csv: sha256 differs');
    let job: RunningJob | undefined;
    try {
      job = startImportJob(deps, { source: () => { throw refused; }, pollMs: 200 });
      const id = await request('dry_run');
      await finished(id);
      expect(await row(id)).toMatchObject({ status: 'failed', report: { error: 'generator_manifest', attempts: 1 } });
      await until(async () => logs.some((l) => l.includes('"status":"import run failed"')), 'the failure line');
      const line = JSON.parse(logs.find((l) => l.includes('import run failed')) ?? '{}') as Record<string, unknown>;
      expect(line).toMatchObject({ level: 'error', process: 'worker', errorCode: 'generator_manifest' });
      // the line names the code, never the error's text
      expect(logs.join('')).not.toContain('sha256 differs');
    } finally {
      await job?.stop();
      await pool.end();
    }
    worker = await startTestWorker(db.url());
  });

  // why: FR-IMP-10
  it('after an office real run, the tables it filled carry fresh statistics (ANALYZE as bw_worker; F-323)', async () => {
    const id = await request('real');
    await finished(id);
    expect((await row(id))?.status).toBe('done');
    expect(Number((await db.admin().query<{ n: string }>('SELECT count(*) AS n FROM world.customer')).rows[0]?.n)).toBe(18_400);
    // The test server runs autovacuum off, so last_analyze (a manual ANALYZE's stamp) can only be the job's.
    const names = IMPORT_FILLED_TABLES.map((t) => t.replace('world.', '').replaceAll('"', ''));
    await until(async () => {
      const s = await db.admin().query<{ relname: string }>(
        `SELECT relname FROM pg_stat_user_tables WHERE schemaname = 'world' AND relname = ANY($1) AND last_analyze IS NOT NULL`, [names]);
      return s.rows.length === names.length;
    }, 'ANALYZE of every filled table');
    const est = await db.admin().query<{ reltuples: number }>(`SELECT reltuples FROM pg_class WHERE oid = 'world.customer'::regclass`);
    expect(est.rows[0]?.reltuples).toBe(18_400);
  });
});
