// SPDX-License-Identifier: AGPL-3.0-or-later
// Test and gate support for the import (not product code): the real generator's output, the reference rows the import
// resolves against, a pool as the web process's login, and a whole-database fingerprint for the dry-run check.
//
// The reference rows come from the real reference seed (D-3 step 1; P2-SEED), so a past visit's technician_id mapping meets the
// seeded roster. Nothing here reads the zone registry (finding F-152).
import path from 'node:path';
import { createPool, type Queryable } from '@bw/db';
import { DEFAULT_DIR } from '../../../../ci/data-assets.ts';
import { seedReference as realSeedReference } from '../../../db/src/seed/index.ts';
import { readStreetList } from '../../../db/src/street-list.ts';
import { generate, loadInputs, type Output } from '../../../generator/src/index.ts';
import type { ExportFiles } from '../layout.ts';

/** A roster technician who appears in visits.csv (packages/generator/technicians.json). */
export const SEEDED_TECHNICIAN = 'Marcus Bell';

export interface Truth {
  counts: { exact: number; likely: number };
  exact: { a: string; b: string }[];
  likely: { a: string; b: string }[];
}

export interface GeneratedWorld {
  files: ExportFiles;
  truth: Truth;
  output: Output;
}

let cached: GeneratedWorld | undefined;

/** The generator's real output from seed 20260915 and the verified street list (in memory; D7: never committed). */
export function generatedWorld(): GeneratedWorld {
  if (!cached) {
    const output = generate(loadInputs());
    cached = {
      output,
      files: { 'customers.csv': output['customers.csv'], 'visits.csv': output['visits.csv'], 'equipment.csv': output['equipment.csv'] },
      truth: JSON.parse(output['truth.json']) as Truth,
    };
  }
  return cached;
}

/** A test value of SAMPLE_PASSWORD_SEED (SD-9), not a deployed secret. */
export const TEST_SAMPLE_SEED = 'test-seed-0123456789ab';
/** The real instant the seeded clock row is anchored to (a fixed test value). */
const TEST_ANCHOR_REAL = new Date('2026-11-01T16:00:00Z');

/**
 * The reference rows, written by setup's own reference seed (packages/db/src/seed; D-3 step 1: branches, the real bundled street list,
 * services, staff and technician users, technicians from the generator's roster, windows, the clock row), as a
 * superuser connection: the seed's role, not the import's.
 */
export async function seedReference(admin: Queryable, streetList = path.join(DEFAULT_DIR, 'street-list.json')): Promise<void> {
  await realSeedReference(admin, { sampleSeed: TEST_SAMPLE_SEED, anchorReal: TEST_ANCHOR_REAL, streetList: readStreetList(streetList) });
}

/** A pool as the web process's own login bw_web (member of role app): the access wall API-84 and setup run behind. */
export function webPool(databaseUrl: string): ReturnType<typeof createPool> {
  const u = new URL(databaseUrl);
  u.username = 'bw_web';
  u.password = '';
  return createPool({ connectionString: u.toString(), max: 4 });
}

/** 1 table's row count and checksum. */
export interface TableFingerprint {
  rows: number;
  md5: string;
}

/**
 * Every base table of every schema in the database (not a hand list: read from pg_class), each with its row count
 * and the MD5 of its rows' text in sorted order. `excludeRun` leaves out 1 run's own record and problem list, the 2
 * row sets section 6.7 places outside the dry-run check. The clock row is fingerprinted without last_write_real, which the
 * kernel stamps on every successful write (F-541): a dry run that moved the clock's anchor, pause or epoch still shows.
 */
export async function databaseFingerprint(q: Queryable, excludeRun?: string): Promise<Map<string, TableFingerprint>> {
  const tables = await q.query<{ name: string }>(
    `SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY 1`);
  const out = new Map<string, TableFingerprint>();
  for (const { name } of tables.rows) {
    let where = '';
    const params: unknown[] = [];
    if (excludeRun && name === 'world.import_run') { where = 'WHERE t.id <> $1'; params.push(excludeRun); }
    if (excludeRun && name === 'world.import_problem_row') { where = 'WHERE t.run_id <> $1'; params.push(excludeRun); }
    const row = name === 'system.demo_clock' ? `(to_jsonb(t) - 'last_write_real')::text` : 't::text';
    const r = await q.query<{ n: string; md5: string | null }>(
      `SELECT count(*) AS n, md5(coalesce(string_agg(${row}, E'\\n' ORDER BY ${row}), '')) AS md5 FROM ${name} t ${where}`, params);
    out.set(name, { rows: Number(r.rows[0]?.n), md5: r.rows[0]?.md5 ?? '' });
  }
  return out;
}

/** Setup's fixed stamps (SD-24): the dry run 5:38 to 5:59 AM and the real run 6:02 to 6:44 AM, Mon, Aug 31, 2026, EDT. */
export function stampClock(kind: 'dry_run' | 'real'): () => Date {
  const [start, end] = kind === 'dry_run'
    ? ['2026-08-31T05:38:00-04:00', '2026-08-31T05:59:00-04:00']
    : ['2026-08-31T06:02:00-04:00', '2026-08-31T06:44:00-04:00'];
  let calls = 0;
  return () => new Date(calls++ === 0 ? start : end);
}
