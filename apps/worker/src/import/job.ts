// SPDX-License-Identifier: AGPL-3.0-or-later
// The worker's import runner job (SPECIFICATIONS section 2 background-work table: "Import runner | API-80, API-84,
// setup"; section 6.7; F-258). API-80 and API-84 only REQUEST a run (a row marked running, committed by the handler);
// this job EXECUTES it with @bw/import runPendingImport, whose run lock and pick-up rules belong to @bw/import (P2-IMPORT):
//   - at start-up, so a row a dead executor left running is picked up (its next attempt; 3 in all, then failed:
//     owner ruling dc73cb08, counted by runPendingImport);
//   - then whenever a request is waiting (a cheap read every IMPORT_POLL_MS real milliseconds), 1 run at a time;
//   - with demo time from @bw/time (the worker's DbClock) for started_at, finished_at and the merges' at;
//   - with the export setup imports: the generator's checked output, made in process per attempt from the inputs setup
//     reads (./source.ts; F-340: no folder of export files);
//   - never while setup holds its lock, so setup's import and an office import never run at once (the worker's memory
//     cap is sized for 1 import: infra/compose.yaml);
//   - on its own pool of 2 connections (the run holds both, its record connection and its data transaction, from
//     pick-up to finish), so a run never starves the dispatcher's lanes of the worker's main pool (F-382);
//   - after a real run commits, ANALYZE of the tables it filled (F-323; migration 0013 grants bw_worker MAINTAIN).
// Every run's progress and finish send EVT-08 import.run.changed (runPendingImport; UI-SPECIFICATION 12.3).
import type pg from 'pg';
import { createPool } from '@bw/db';
import { failureCode, runPendingImport, type ExportFiles } from '@bw/import';
import { SETUP_LOCK_KEYS } from '@bw/setup';
import type { RunningJob, WorkerDeps } from '../jobs.ts';
import { officeExport } from './source.ts';

export const IMPORT_POLL_MS = 2_000;
/** The run's 2 connections: the record connection (lock, stage, percent) and the data transaction. */
export const IMPORT_POOL_MAX = 2;
/** The tables a real run fills, as setup ANALYZEs them after its real run (packages/setup/src/pipeline.ts, F-314). */
export const IMPORT_FILLED_TABLES = [
  'world.customer', 'world.past_visit', 'world.equipment', 'world.import_problem_row', 'world.duplicate_pair', 'world."merge"', 'world.import_run',
] as const;

export interface ImportJobOptions {
  /** The export; default the generator's checked output (./source.ts). A test passes its own. */
  source?: () => ExportFiles | Promise<ExportFiles>;
  pollMs?: number;
}

/** The import job's own pool: the worker pool's login and settings, 2 connections. */
function importPool(main: pg.Pool): pg.Pool {
  // createPool sets the type parsers itself
  const { types, ...options } = main.options;
  void types;
  return createPool({ ...options, max: IMPORT_POOL_MAX, application_name: 'bw-worker-import' });
}

/** What 1 pass needs, so its end paths can be run with stand-ins (the job passes the real ones). */
export interface PassSteps {
  owed(): Promise<boolean>;
  run(): Promise<{ kind: string } | null>;
  analyze(): Promise<void>;
  log: Pick<WorkerDeps['log'], 'info' | 'warn' | 'error'>;
  stopped(): boolean;
}

/**
 * Execute every owed office run, 1 at a time. Each end path writes its own line (F-531): a run that ended failed logs
 * 'import run failed' with its code and ENDS the pass, so the next try waits the poll (a persistent error before the attempt is
 * counted cannot spin the loop and flood the log); a real run that ended done logs 'import run done', and an ANALYZE that then
 * fails is its own warn line, never a failed run.
 */
export async function executeOwed(s: PassSteps): Promise<void> {
  while (!s.stopped() && (await s.owed())) {
    let out: { kind: string } | null;
    try {
      out = await s.run();
    } catch (e) {
      // The run row is already failed with this code when the run began (runPendingImport); the line names it, never the error's text.
      s.log.error({ status: 'import run failed', errorCode: failureCode(e) });
      return;
    }
    if (!out) return;
    let analyzed = true;
    if (out.kind === 'real') {
      try {
        await s.analyze();
      } catch {
        analyzed = false;
      }
    }
    s.log.info({ status: 'import run done' });
    if (!analyzed) s.log.warn({ status: 'import run done', errorCode: 'analyze_failed' });
  }
}

export function startImportJob(d: WorkerDeps, opts: ImportJobOptions = {}): RunningJob {
  const pool = importPool(d.pool);
  pool.on('error', () => d.log.error({ status: 'unhandled error', errorCode: 'server_error' }));
  // A run holds its 2 clients for minutes; a connection lost meanwhile fails the run's next query (the run ends failed
  // or, with the record connection gone, is picked up again), and the client's own error event must not end the worker.
  pool.on('connect', (c) => c.on('error', () => undefined));
  const source = opts.source ?? (() => officeExport());
  const clock = async () => new Date((await d.clock.demoNow()).epochMilliseconds);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> = Promise.resolve();

  const owed = async (): Promise<boolean> => {
    const r = await pool.query<{ owed: boolean; setup: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM world.import_run WHERE status = 'running' AND NOT by_setup) AS owed,
              EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = $1 AND objid = $2 AND objsubid = 2) AS setup`,
      [...SETUP_LOCK_KEYS]);
    const row = r.rows[0];
    return Boolean(row?.owed && !row.setup);
  };

  // Execute every owed office run, 1 at a time, until none is owed (or another executor holds the run lock).
  const pass = (): Promise<void> => executeOwed({
    owed,
    run: () => runPendingImport(pool, { files: source, clock }),
    analyze: async () => void (await pool.query(`ANALYZE ${IMPORT_FILLED_TABLES.join(', ')}`)),
    log: d.log,
    stopped: () => stopped,
  });

  const tick = (): void => {
    current = pass()
      .catch(() => d.log.error({ status: 'unhandled error', errorCode: 'import_job_failed' }))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, opts.pollMs ?? IMPORT_POLL_MS);
      });
  };
  tick();

  return {
    name: 'import runner',
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      // A run in progress finishes first (a stop the platform cuts short is a crashed attempt, picked up at next start).
      await current;
      await pool.end();
    },
  };
}
