// SPDX-License-Identifier: AGPL-3.0-or-later
// `pnpm run setup` (BUILD_PLAN P2-SETUP; section 3 D-3, the 1 statement of setup's order; OI-57): the 6 steps in
// foreign-key order, every foreign key's target written before the row that points at it.
//   1. the reference seed (P2-SEED): no row that references a customer
//   2. the generator: the 3 CSVs and the world seed's fixture, in memory, checked against the committed manifest
//   3. the import dry run    } through the import's own code path (@bw/import runImport, by_setup), stamped with the
//   4. the real import       } approved import history page's demo times (SD-24); the only writer of customers and visits
//   5. the world seed        } 1 transaction: a named error in step 5 leaves no world-seed row and no snapshot
//   6. the snapshot (SD-12)  }
//
// Setup's role (F-150, setup half): setup runs as the schema owner, the login the migrate step uses. It creates the
// snapshot tables (role app has nothing on world_snapshot or pbs_snapshot, migration 0007) and writes memberships (app
// holds SELECT only). The reset has no role of its own: the web process and the worker (role app) call
// system.restore_world, which runs as the schema owner (migration 0014; P3-REPLAY).
//
// A fresh world only. Setup holds a session advisory lock for its whole run (a second setup stops with setup_running).
// Before step 3 it stops with import_run_running while an office import run is marked running (requested through
// API-80 or API-84, owed to the worker's runner): setup neither fails nor waits for the office's run, and taking the
// world from under it would make its counts lie; it stops with world_not_fresh once any import run, customer or
// snapshot exists. A failed setup is not resumed: recreate the database and run it again.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createPool, type Queryable } from '@bw/db';
import { checkManifest, generate, loadInputs, type Output } from '@bw/generator';
import { readManifest } from '../../generator/src/io.ts';
import { runImport, type RunKind, type RunOutcome } from '@bw/import';
import type { ProcessState } from '@bw/log';
import { loadVanTracks, MapError, parseTracks, verifyMaps, type TrackRow } from '../../maps/src/index.ts';
import { DATA_DIR } from '../../db/src/data-asset.ts';
import { seedReference } from '../../db/src/seed/index.ts';
import type { StreetListRow } from '../../db/src/street-list.ts';
import { SetupError } from './errors.ts';
import { parseFixture } from './fixture.ts';
import { writeSnapshot, type SnapshotResult } from './snapshot.ts';
import { seedWorld, type WorldSeedResult } from './world-seed.ts';

/** SD-24: setup's 2 runs carry the approved import history page's demo times, Mon, Aug 31, 2026, America/New_York. */
export const SETUP_STAMPS: Readonly<Record<RunKind, { start: string; end: string }>> = {
  dry_run: { start: '2026-08-31T05:38:00-04:00', end: '2026-08-31T05:59:00-04:00' },
  real: { start: '2026-08-31T06:02:00-04:00', end: '2026-08-31T06:44:00-04:00' },
};

/** The run clock for 1 of setup's runs: its start for the request, its end for every later read (the write and the finish). */
export function stampClock(kind: RunKind): () => Date {
  const s = SETUP_STAMPS[kind];
  let calls = 0;
  return () => new Date(calls++ === 0 ? s.start : s.end);
}

const LOCK_CLASS = 0x6277; // "bw", as @bw/import's run locks (keys 1 and 2)
const SETUP_LOCK = 3;
/**
 * The setup lock's 2 keys (pg_try_advisory_lock(int4, int4)), held from setup's start to its end. The worker's import
 * job executes no office run while it is held, so setup's import and an office import never run at once (P3-IMPORT-WORKER).
 */
export const SETUP_LOCK_KEYS: readonly [number, number] = [LOCK_CLASS, SETUP_LOCK];

/**
 * The verified street list the generator reads (D-3 step 2): BW_STREET_LIST, else .build/data/street-list.json. Setup's
 * CLI and the worker's import job read it by this 1 rule, so both make the same export.
 */
export function streetListFile(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.BW_STREET_LIST || path.join(DATA_DIR, 'street-list.json');
}

/** 1 line per step for the log (the CLI writes them through @bw/log: fixed states, real time stamped as log_stamp). */
export interface SetupEvent {
  status: ProcessState;
  durationMs?: number;
  errorCode?: string;
}

export interface SetupOptions {
  /** The schema owner's database URL (the password, when any, is in PGPASSWORD or the URL). */
  databaseUrl: string;
  /** The seed the sample users' passwords derive from (the value of SAMPLE_PASSWORD_SEED; SD-9). */
  sampleSeed: string;
  reviewerPassword?: string | undefined;
  /** The verified bundled street list. */
  streetList: readonly StreetListRow[];
  /** The street list's file, for the generator's inputs. */
  streetListFile: string;
  /** Real time for the clock row's anchors and the clock_move row (use clock_anchor) and day_snapshot (record_stamp). */
  realNow: (use: 'clock_anchor' | 'record_stamp' | 'log_stamp') => Date;
  /**
   * FR-MAP-4, FR-MAP-5: the folder of the downloaded map files and track set. When set, setup first checks every file against
   * packages/maps/MANIFEST.json and stops (map_hash_mismatch, MAP_HASH_MISMATCH <file>) on a difference, then loads the verified
   * tracks as world.van_track rows in step 5's transaction. The CLI sets it from MAPS_DIR.
   */
  maps?: { dir: string; /** F-1297: the rows readVerifiedMaps already returned for this folder; a caller that verified it passes them, and the files are not hashed again. */ verified?: TrackRow[] };
  /** Step 2. Default: the real generator from seed 20260915, checked against packages/generator/MANIFEST.json. */
  generate?: () => Output;
  onEvent?: (e: SetupEvent) => void;
}

export interface SetupResult {
  dryRun: RunOutcome;
  realRun: RunOutcome;
  world: WorldSeedResult;
  snapshot: SnapshotResult;
  /** world.van_track rows loaded from the verified track set (0 when no maps folder was given). */
  vanTracks: number;
  /** Real milliseconds from the real run's start to its commit (the import run time, SPECIFICATIONS section 14). */
  realRunMs: number;
}

/**
 * FR-MAP-4: check the map folder against the committed manifest and return the verified track rows; a difference is a named stop.
 * The routing files (SD-49) are checked when present and passed over when absent: setup never reads them, and a stack with no routing
 * files starts and answers baked and approximate legs (P6-ROUTE-BAKE); a present routing file with 1 changed byte still stops setup.
 */
export function readVerifiedMaps(dir: string): TrackRow[] {
  try {
    verifyMaps(dir, undefined, 'if-present');
  } catch (e) {
    if (e instanceof MapError) throw new SetupError(e.code === 'MAP_HASH_MISMATCH' ? 'map_hash_mismatch' : e.code === 'MAP_MISSING' ? 'map_missing' : 'map_size_gate', e.message);
    throw e;
  }
  return parseTracks(readFileSync(path.join(dir, 'tracks.ndjson'), 'utf8'));
}

/** Step 2's default: generate from the shipped inputs and refuse any byte that differs from the committed manifest. */
export function generateChecked(streetListFile: string): Output {
  const out = generate(loadInputs({ streetList: streetListFile }));
  const fails = checkManifest(readManifest(), out);
  if (fails.length > 0) throw new SetupError('generator_manifest', fails.slice(0, 3).join('; '));
  return out;
}

async function inTx<T>(c: Queryable, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  try {
    const v = await fn();
    await c.query('COMMIT');
    return v;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

/** Stop unless the world is fresh: no import run (an office run marked running is named on its own), customer or snapshot. */
export async function assertFresh(q: Queryable): Promise<void> {
  const r = await q.query<{ running: number; runs: number; customers: number; snapshots: number }>(
    `SELECT (SELECT count(*)::int FROM world.import_run WHERE status = 'running' AND NOT by_setup) AS running,
            (SELECT count(*)::int FROM world.import_run) AS runs,
            (SELECT count(*)::int FROM world.customer) AS customers,
            (SELECT count(*)::int FROM system.day_snapshot) AS snapshots`);
  const s = r.rows[0] as { running: number; runs: number; customers: number; snapshots: number };
  if (s.running > 0) throw new SetupError('import_run_running', `${s.running} office run(s) marked running; let the worker finish them, or recreate the database`);
  if (s.runs > 0 || s.customers > 0 || s.snapshots > 0) {
    throw new SetupError('world_not_fresh', `${s.runs} import run(s), ${s.customers} customer(s), ${s.snapshots} snapshot(s); recreate the database to set it up again`);
  }
}

export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const emit = (e: SetupEvent): void => opts.onEvent?.(e);
  const since = (t0: Date): number => opts.realNow('log_stamp').getTime() - t0.getTime();
  const pool = createPool({ connectionString: opts.databaseUrl, max: 4, application_name: 'bw-setup' });
  const lock = await pool.connect();
  try {
    const got = await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_CLASS, SETUP_LOCK]);
    if (!got.rows[0]?.ok) throw new SetupError('setup_running', 'the setup lock is held');
    emit({ status: 'setup started' });
    // F-557: a run with no maps folder says so, so its 'setup done' is never read as a run that checked the maps and loaded the van tracks.
    if (!opts.maps) emit({ status: 'maps not checked' });
    const tracks = opts.maps ? (opts.maps.verified ?? readVerifiedMaps(opts.maps.dir)) : [];
    await assertFresh(lock);

    // 1. The reference seed (idempotent; it writes the clock row only when absent).
    let t0 = opts.realNow('log_stamp');
    await inTx(lock, () => seedReference(lock, {
      sampleSeed: opts.sampleSeed, reviewerPassword: opts.reviewerPassword, anchorReal: opts.realNow('clock_anchor'), streetList: opts.streetList,
    }));
    emit({ status: 'reference seed written', durationMs: since(t0) });

    // 2. The generator: no database row.
    t0 = opts.realNow('log_stamp');
    const out = opts.generate ? opts.generate() : generateChecked(opts.streetListFile);
    const fixture = parseFixture(out['fixture.json']);
    const files = { 'customers.csv': out['customers.csv'], 'visits.csv': out['visits.csv'], 'equipment.csv': out['equipment.csv'] };
    emit({ status: 'export generated', durationMs: since(t0) });

    // 3 and 4. The import's own runner; re-check freshness first, since an office run may have been requested meanwhile.
    await assertFresh(lock);
    t0 = opts.realNow('log_stamp');
    const dryRun = await runImport(pool, { kind: 'dry_run', files, bySetup: true, byUser: null, clock: stampClock('dry_run') });
    emit({ status: 'dry run done', durationMs: since(t0) });
    const realStart = opts.realNow('log_stamp');
    emit({ status: 'import started' });
    const realRun = await runImport(pool, { kind: 'real', files, bySetup: true, byUser: null, clock: stampClock('real') });
    const realRunMs = since(realStart);
    emit({ status: 'import committed', durationMs: realRunMs });
    // F-314: fresh statistics for the tables the real run just filled, before step 5 reads them. Until autoanalyze
    // reaches them the planner may still hold the counts of an autovacuum that ran while the import's transaction was
    // open (0 rows over hundreds of pages), and the world seed's joins of customers and past visits then run as
    // nested loops over every pair (190 s instead of 1 s in wave run 9bcc8a5). Setup is the schema owner, so it may.
    await lock.query(`ANALYZE world.customer, world.past_visit, world.equipment, world.import_problem_row, world.duplicate_pair, world."merge", world.import_run`);

    // 5 and 6. The world seed and the snapshot, in 1 transaction.
    t0 = opts.realNow('log_stamp');
    const { world, snapshot, vanTracks } = await inTx(lock, async () => {
      // The tracks first: the world seed plans each demo-week day on them (SD-15).
      const vt = await loadVanTracks(lock, tracks);
      const w = await seedWorld(lock, { fixture, sampleSeed: opts.sampleSeed });
      emit({ status: 'world seed written', durationMs: since(t0) });
      const s = await writeSnapshot(lock, { clockReal: opts.realNow('clock_anchor'), recordReal: opts.realNow('record_stamp') });
      return { world: w, snapshot: s, vanTracks: vt };
    });
    emit({ status: 'snapshot written', durationMs: since(t0) });
    emit({ status: 'setup done' });
    return { dryRun, realRun, world, snapshot, vanTracks, realRunMs };
  } catch (e) {
    emit({ status: 'setup refused', errorCode: e instanceof SetupError ? e.code : 'error' });
    throw e;
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_CLASS, SETUP_LOCK]).catch(() => undefined);
    lock.release();
    await pool.end();
  }
}
