// SPDX-License-Identifier: AGPL-3.0-or-later
// The import runner (SPECIFICATIONS section 6.7 "Import with a dry run", SD-24; FR-IMP-1, FR-IMP-10). 1 code path
// for setup's runs and the office's (API-80, API-84): parse, validate, match and write inside 1 transaction; a dry run
// runs every stage and rolls that transaction back.
//
// Who runs what. The office asks for a run with API-80 or API-84: the handler's own transaction (SD-6: 1 per call) only
// REQUESTS it (requestImportRun: the import_run row, status running, stage parse, 0 percent), commits, and answers 202
// with its id. The worker's import runner (SPECIFICATIONS section 2: "Import runner | API-80, API-84, setup") EXECUTES
// it (runPendingImport) in transactions of its own, after the answer, as section 6.7 already places the run. Setup
// requests and executes its own 2 runs in its process (runImport).
//
// The run lock. 1 session advisory lock on the executor's record connection, held from pick-up to finish; it ends with
// that connection, so "a running row with no live executor" is decidable by whoever holds the lock next.
//
// Run record and replay semantics, at each durable write:
//   1. Request (the caller's transaction, under the start lock, a transaction advisory lock): refused with
//      run_in_progress while any run row is running (requested, or being executed), and a real run with
//      real_run_exists once a real run is done in this world (FR-IMP-10). Else the running row is inserted; it is
//      durable when the caller commits, so the history and API-81 show it at once. A refused request writes nothing.
//   2. Pick-up (holding the run lock): a running row of setup's that no live setup process holds (setup holds the lock
//      from before its request to its finish) is closed as failed: setup re-runs its own pipeline, and its rows carry
//      setup's fixed stamps, which no other executor has. An office row still running is owed work: it is executed
//      from the start, whether it was never picked up or its executor died mid-run; a crashed attempt left no rows
//      (step 4), so the re-execution converges to the same counts and ends in 1 done record. Each pick-up is 1 attempt,
//      counted in the running row's report ({"attempts": n}, durable before the attempt starts); a row picked up
//      MAX_RUN_ATTEMPTS times already ends failed (attempts_exhausted) with no further attempt (owner ruling dc73cb08,
//      F-266: "3 tries, then fail").
//   3. Progress: stage and percent are updated on the record connection, outside the data transaction, so a reader
//      sees them while the run works. Each change, and the finish (done or failed), sends EVT-08 import.run.changed
//      with the run id only (UI-SPECIFICATION 12.3; CTL-OFC-13-05): a progress change at its own commit, a finish in
//      the transaction that writes it.
//   4. Real run: the rows, the problem rows, the pairs, the exact merges AND the run row's finish (status done, report,
//      finished_at) commit in 1 data transaction. Either all of it is durable or none. A done real run is the durable
//      completion record, and its presence refuses every later real run.
//   5. Dry run: the data transaction is rolled back; then the run row's finish and its run-scoped problem list commit
//      together in 1 record transaction (section 6.7: outside the dry-run check's table set).
//   6. Failure inside the run (an error the executor sees, the export source's included): the data transaction rolls
//      back, the run row is set failed with finished_at and report {"error": <code>, "attempts": n}, and the error is
//      rethrown; a failed run is no completion record, so it refuses nothing. A failure the executor cannot see (its
//      process dies) is step 2's case.
import { publishEvent, type Queryable } from '@bw/db';
import { parseExport, type ExportFiles } from './layout.ts';
import { buildModel, type ImportCounts, type ImportModel, type ImportReference } from './model.ts';
import { writeModel, writeProblems } from './write.ts';

/** Advisory lock keys (int4 pairs; migrate.ts uses a bigint key, which cannot collide with the 2-key form). */
const LOCK_CLASS = 0x6277; // "bw"
const START_LOCK = 1;
const RUN_LOCK = 2;

/** Executions of 1 office run, its crashed ones included: after the 3rd the run ends failed (owner ruling dc73cb08, F-266). */
export const MAX_RUN_ATTEMPTS = 3;

export type RunKind = 'dry_run' | 'real';

/** A pooled connection (pg.PoolClient satisfies it). */
export interface Connection extends Queryable {
  release(err?: Error | boolean): void;
}
/** Where the executor gets its 2 connections (pg.Pool satisfies it). */
export interface Connector {
  connect(): Promise<Connection>;
}

/** The run's report (import_run.report): the FR-IMP-6 counts and the pairs by old record reference (FR-IMP-3). */
export interface ImportReport extends ImportCounts {
  /** customers.csv customer_ref of record A and record B of every pair: the sets the truth file is compared with. */
  pairs: { exact: { a: string; b: string }[]; likely: { a: string; b: string }[] };
}

/** import_run.report of a running office row (its attempts so far) and of a failed row (the failure's code too). */
export interface RunAttempts {
  attempts: number;
  error?: string;
}

/** An office run the executor closed as failed without executing it: every attempt it is owed is spent. */
export class ImportRunFailed extends Error {
  readonly code = 'attempts_exhausted';
  readonly runId: string;
  constructor(runId: string, attempts: number) {
    super(`the import run was started ${attempts} times and never finished; it is closed as failed`);
    this.runId = runId;
    this.name = 'ImportRunFailed';
  }
}

/**
 * The failure's name, as the run row and the worker's log line record it: the error's own code when it is a word
 * (SetupError generator_manifest, ImportRunFailed attempts_exhausted), else import_failed (a database or other error,
 * whose text may hold row values and is never recorded).
 */
export function failureCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{2,39}$/.test(code) ? code : 'import_failed';
}

export class ImportRefused extends Error {
  readonly code: 'run_in_progress' | 'real_run_exists';
  constructor(code: 'run_in_progress' | 'real_run_exists', what: string) {
    super(what);
    this.code = code;
    this.name = 'ImportRefused';
  }
}

/** The demo time for started_at, finished_at and the merges' at: setup passes its own fixed stamps of Aug 31, 2026 (SD-24), the office the demo clock. */
export type RunClock = () => Date | Promise<Date>;

export interface RunRequest {
  kind: RunKind;
  /** True for the dry run and the real run that setup makes when it seeds the world (FR-IMP-10). */
  bySetup: boolean;
  byUser: string | null;
  /** started_at. */
  at: Date;
}

export interface RunOptions {
  kind: RunKind;
  files: ExportFiles;
  bySetup: boolean;
  byUser: string | null;
  clock: RunClock;
}

export interface RunOutcome {
  runId: string;
  kind: RunKind;
  report: ImportReport;
  model: ImportModel;
  /** The new customers' ids in customers.csv order: a real run's (null for a dry run, whose rows were rolled back). */
  customerIds: string[] | null;
}

export function reportOf(model: ImportModel): ImportReport {
  const refs = model.customers.map((c) => c.ref);
  const by = (kind: 'exact' | 'likely') => model.pairs.filter((p) => p.kind === kind).map((p) => ({ a: refs[p.a] as string, b: refs[p.b] as string }));
  return { ...model.counts, pairs: { exact: by('exact'), likely: by('likely') } };
}

/**
 * Request a run (step 1), in the caller's transaction: API-80 and API-84 call it in the handler's transaction, setup on
 * its record connection. Returns the new run's id; throws ImportRefused (and writes nothing) when refused.
 */
export async function requestImportRun(tx: Queryable, req: RunRequest): Promise<string> {
  await tx.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_CLASS, START_LOCK]);
  if (req.kind === 'real') {
    const done = await tx.query(`SELECT 1 FROM world.import_run WHERE kind = 'real' AND status = 'done' LIMIT 1`);
    if (done.rows.length > 0) throw new ImportRefused('real_run_exists', 'the real import already ran in this world; it runs once per world');
  }
  const running = await tx.query(`SELECT 1 FROM world.import_run WHERE status = 'running' LIMIT 1`);
  if (running.rows.length > 0) throw new ImportRefused('run_in_progress', 'an import run is in progress');
  const r = await tx.query<{ id: string }>(
    `INSERT INTO world.import_run (kind, status, stage, percent, started_at, by_user, by_setup)
     VALUES ($1, 'running', 'parse', 0, $2, $3, $4) RETURNING id`,
    [req.kind, req.at, req.byUser, req.bySetup]);
  return (r.rows[0] as { id: string }).id;
}

export async function loadReference(tx: Queryable): Promise<ImportReference> {
  const streets = await tx.query<{ id: string; name: string; city: string; zip: string; branch_id: string; points: [number, number][] }>(
    'SELECT id, name, city, zip, branch_id, points FROM world.street');
  const branches = await tx.query<{ id: string; zone: string }>('SELECT id, zone FROM world.branch');
  const techs = await tx.query<{ id: string; name: string }>('SELECT id, name FROM world.technician');
  return {
    streets: streets.rows.map((s) => ({ id: s.id, name: s.name, city: s.city, zip: s.zip, branchId: s.branch_id, points: s.points })),
    branchZones: new Map(branches.rows.map((b) => [b.id, b.zone])),
    technicianIds: new Map(techs.rows.map((t) => [t.name, t.id])),
  };
}

async function inRecordTransaction<T>(record: Queryable, fn: () => Promise<T>): Promise<T> {
  await record.query('BEGIN');
  try {
    const out = await fn();
    await record.query('COMMIT');
    return out;
  } catch (e) {
    await record.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

const changed = (q: Queryable, runId: string) => publishEvent(q, 'import.run.changed', { runId });

/** 1 run row the caller has picked up under the run lock: its id, kind, this attempt's number and where it stands. */
interface PickedRun {
  id: string;
  kind: RunKind;
  attempt: number;
  stage: string;
  percent: number;
  /** The row's started_at: a failure's finished_at when the clock cannot be read (F-2006 J-26). */
  startedAt: Date;
}

/** Steps 3 to 6 for 1 run row the caller has picked up under the run lock. */
async function execute(pool: Connector, record: Queryable, run: PickedRun, source: () => ExportFiles | Promise<ExportFiles>, clock: RunClock): Promise<RunOutcome> {
  const runId = run.id;
  let at = `${run.stage}:${run.percent}`;
  // Only a change writes and sends EVT-08 (the write stage reports the same percent more than once on a small file).
  const stage = async (s: 'parse' | 'validate' | 'match' | 'write', percent: number): Promise<void> => {
    if (`${s}:${percent}` === at) return;
    at = `${s}:${percent}`;
    await record.query('UPDATE world.import_run SET stage = $2, percent = $3 WHERE id = $1', [runId, s, percent]);
    await changed(record, runId);
  };
  const finish = `UPDATE world.import_run SET status = 'done', stage = 'write', percent = 100, finished_at = $2, report = $3::jsonb WHERE id = $1`;

  let model: ImportModel;
  let report: ImportReport;
  let customerIds: string[] | null = null;
  try {
    const data = await pool.connect();
    try {
      await data.query('BEGIN');
      try {
        const parsed = parseExport(await source());
        await record.query('UPDATE world.import_run SET source_exported_at = $2 WHERE id = $1', [runId, parsed.exportedAt]);
        await stage('validate', 10);
        const ref = await loadReference(data);
        await stage('match', 20);
        model = buildModel(parsed, ref);
        report = reportOf(model);
        await stage('write', 30);
        const at = await clock();
        const written = await writeModel(data, model, { runId, at, onProgress: (f) => stage('write', 30 + Math.floor(f * 69)) });
        if (run.kind === 'real') {
          customerIds = written.customerIds;
          await data.query(finish, [runId, await clock(), JSON.stringify(report)]);
          await changed(data, runId);
          await data.query('COMMIT');
        } else {
          await data.query('ROLLBACK');
        }
      } catch (e) {
        await data.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    } finally {
      data.release();
    }
    if (run.kind === 'dry_run') {
      const done = await clock();
      await inRecordTransaction(record, async () => {
        await writeProblems(record, runId, model.problems, null);
        await record.query(finish, [runId, done, JSON.stringify(report)]);
        await changed(record, runId);
      });
    }
  } catch (e) {
    // F-2006 J-26: a clock that cannot be read (a rejection, or a throw before it returns) ends the run at its own
    // start, never at 1970 (a finish before its start), and the run's own failure is the one rethrown.
    const failedAt = await Promise.resolve().then(clock).catch(() => run.startedAt);
    await closeFailed(record, runId, failedAt, { error: failureCode(e), attempts: run.attempt }).catch(() => undefined);
    throw e;
  }
  return { runId, kind: run.kind, report, model, customerIds };
}

/** Close 1 running row as failed, with the failure's code and its attempts, and send EVT-08 in the same transaction. */
async function closeFailed(record: Queryable, runId: string, at: Date, report: RunAttempts): Promise<void> {
  await inRecordTransaction(record, async () => {
    const r = await record.query(`UPDATE world.import_run SET status = 'failed', finished_at = $2, report = $3::jsonb WHERE id = $1 AND status = 'running' RETURNING id`,
      [runId, at, JSON.stringify(report)]);
    if (r.rows.length > 0) await changed(record, runId);
  });
}

/**
 * Hold the run lock on 1 record connection for fn, after closing setup's orphaned running rows (step 2). Returns null
 * without calling fn when another executor holds the lock.
 */
async function underRunLock<T>(pool: Connector, clock: RunClock, fn: (record: Connection) => Promise<T>): Promise<T | null> {
  const record = await pool.connect();
  try {
    const got = await record.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_CLASS, RUN_LOCK]);
    if (!got.rows[0]?.ok) return null;
    try {
      // The clock is read only when there is an orphan to close, so setup's stamp sequence (SD-24) is not consumed here.
      const orphans = await record.query<{ id: string }>(`SELECT id FROM world.import_run WHERE status = 'running' AND by_setup`);
      if (orphans.rows.length > 0) {
        await record.query(`UPDATE world.import_run SET status = 'failed', finished_at = $2 WHERE id = ANY($1::uuid[])`,
          [orphans.rows.map((o) => o.id), await clock()]);
      }
      return await fn(record);
    } finally {
      await record.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_CLASS, RUN_LOCK]).catch(() => undefined);
    }
  } finally {
    record.release();
  }
}

export interface PendingOptions {
  /**
   * The old system's export. The worker passes a function (the generator's checked output, made per attempt): it is
   * called inside the attempt, so a refusal (generator_manifest) ends the run failed with that code, never running.
   */
  files: ExportFiles | (() => ExportFiles | Promise<ExportFiles>);
  /** The demo clock. */
  clock: RunClock;
}

/**
 * The worker's import runner job (SPECIFICATIONS section 2; triggered by API-80 and API-84): execute the oldest office
 * run row that is running, if any, to its end. Returns its outcome, or null when no office run is owed or another
 * executor holds the run lock (that executor will finish it). Safe to call again at any time: a run is executed only
 * under the run lock, and a done or failed row is never picked up.
 */
export async function runPendingImport(pool: Connector, opts: PendingOptions): Promise<RunOutcome | null> {
  return underRunLock(pool, opts.clock, async (record) => {
    const r = await record.query<{ id: string; kind: RunKind; stage: string; percent: number; report: RunAttempts | null; started_at: Date }>(
      `SELECT id, kind, stage, percent, report, started_at FROM world.import_run WHERE status = 'running' AND NOT by_setup ORDER BY started_at, id LIMIT 1`);
    const run = r.rows[0];
    if (!run) return null;
    const before = typeof run.report?.attempts === 'number' ? run.report.attempts : 0;
    if (before >= MAX_RUN_ATTEMPTS) {
      await closeFailed(record, run.id, await opts.clock(), { error: 'attempts_exhausted', attempts: before });
      throw new ImportRunFailed(run.id, before);
    }
    // This attempt is counted before it starts, so a process that dies during it has spent it. A re-execution starts
    // over at parse, 0 percent (the import progress event, EVT-08, says so when that is a change).
    const attempt = before + 1;
    await record.query(`UPDATE world.import_run SET stage = 'parse', percent = 0, report = $2::jsonb WHERE id = $1`,
      [run.id, JSON.stringify({ attempts: attempt } satisfies RunAttempts)]);
    if (run.stage !== 'parse' || run.percent !== 0) await changed(record, run.id);
    const files = opts.files;
    const source = typeof files === 'function' ? files : () => files;
    return execute(pool, record, { id: run.id, kind: run.kind, attempt, stage: 'parse', percent: 0, startedAt: run.started_at }, source, opts.clock);
  });
}

/**
 * Request and execute 1 run in this process, to its end (setup's path, D-3; and the tests'). Refused with
 * run_in_progress while another executor holds the run lock or any run is running, and with real_run_exists as step 1
 * says.
 */
export async function runImport(pool: Connector, opts: RunOptions): Promise<RunOutcome> {
  const out = await underRunLock(pool, opts.clock, async (record) => {
    const at = await opts.clock();
    const runId = await inRecordTransaction(record, () =>
      requestImportRun(record, { kind: opts.kind, bySetup: opts.bySetup, byUser: opts.byUser, at }));
    return execute(pool, record, { id: runId, kind: opts.kind, attempt: 1, stage: 'parse', percent: 0, startedAt: at }, () => opts.files, opts.clock);
  });
  if (!out) throw new ImportRefused('run_in_progress', 'an import run is in progress');
  return out;
}
