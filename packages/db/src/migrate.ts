// SPDX-License-Identifier: AGPL-3.0-or-later
// The forward-only migration runner of @bw/db (SPECIFICATIONS SD-40: forward-only, backward-compatible for 1
// release). Plain numbered SQL files in packages/db/migrations, applied in order, each in its own transaction with its
// ledger row in system.schema_migration (section 3 stores table: `system` holds the migrations).
//
// Re-run semantics, at each durable write:
//   - A file and its ledger row commit together (PostgreSQL DDL is transactional, CREATE ROLE and CREATE EXTENSION
//     included), so a crash or an error leaves both or neither; the next run applies exactly the files with no row.
//   - A second run applies nothing and changes nothing: the ledger is read after the lock is held.
//   - 2 runners at once: a session advisory lock serializes them; the second sees the first's rows and applies none.
//     The lock dies with its session, so a killed runner never leaves it held.
//   - An applied file whose bytes changed, or that is gone, stops the run (MigrationDriftError): forward-only means a
//     change is a new file. A pending file numbered below an applied one stops it too (MigrationOrderError).
//   - Ledger rows newer than every file are tolerated: that is the previous release running against the next
//     release's schema during a rollback, which SD-40's 1-release backward compatibility exists to allow.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient, type Queryable } from './client.ts';

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', 'migrations');
const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** Advisory lock key: the bytes "bw-migr" as an integer, unique to this runner. */
export const MIGRATION_LOCK_KEY = 0x62772d6d696772n;

export interface Migration {
  version: string;
  name: string;
  sql: string;
  sha256: Buffer;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
  /** Ledger versions newer than every file this code knows (a rollback to the previous release). */
  newerThanCode: string[];
}

export class MigrationDriftError extends Error {}
export class MigrationOrderError extends Error {}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const m = FILE_NAME.exec(file);
    if (!m) throw new Error(`migration file ${file} is not named NNNN_lower_snake.sql`);
    const sql = readFileSync(path.join(dir, file), 'utf8');
    out.push({ version: m[1] ?? '', name: m[2] ?? '', sql, sha256: createHash('sha256').update(sql).digest() });
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i]?.version === out[i - 1]?.version) throw new Error(`2 migration files share version ${out[i]?.version}`);
  }
  return out;
}

const BOOTSTRAP = `
CREATE SCHEMA IF NOT EXISTS system;
CREATE TABLE IF NOT EXISTS system.schema_migration (
  version       text PRIMARY KEY,
  name          text NOT NULL,
  sha256        bytea NOT NULL,
  applied_real  timestamptz NOT NULL DEFAULT now()
);`;

/** Apply every pending migration. `client` must be 1 dedicated connection (not a pool): the lock is per session. */
export async function migrate(client: Queryable, opts: { dir?: string; migrations?: Migration[] } = {}): Promise<MigrateResult> {
  const files = opts.migrations ?? loadMigrations(opts.dir);
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
  try {
    await client.query(BOOTSTRAP);
    const { rows } = await client.query<{ version: string; name: string; sha256: Buffer }>(
      'SELECT version, name, sha256 FROM system.schema_migration ORDER BY version',
    );
    const byVersion = new Map(files.map((f) => [f.version, f]));
    const maxFile = files.at(-1)?.version ?? '';
    const ledger = new Set<string>();
    const newerThanCode: string[] = [];
    for (const r of rows) {
      ledger.add(r.version);
      const f = byVersion.get(r.version);
      if (!f) {
        if (r.version > maxFile) { newerThanCode.push(r.version); continue; }
        throw new MigrationDriftError(`migration ${r.version}_${r.name} is applied but its file is gone`);
      }
      if (!Buffer.from(r.sha256).equals(f.sha256)) {
        throw new MigrationDriftError(`migration ${r.version}_${r.name} changed after it was applied; add a new file instead (SD-40)`);
      }
    }
    const maxApplied = [...ledger].filter((v) => byVersion.has(v)).sort().at(-1) ?? '';
    const pending = files.filter((f) => !ledger.has(f.version));
    const below = pending.find((f) => f.version < maxApplied);
    if (below) {
      throw new MigrationOrderError(`migration ${below.version}_${below.name} is numbered below applied ${maxApplied}; renumber it after the newest`);
    }
    const applied: string[] = [];
    for (const f of pending) {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL search_path = public');
        await client.query(f.sql);
        await client.query('INSERT INTO system.schema_migration (version, name, sha256) VALUES ($1, $2, $3)', [f.version, f.name, f.sha256]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`migration ${f.version}_${f.name} failed and was rolled back: ${(e as Error).message}`, { cause: e });
      }
      applied.push(`${f.version}_${f.name}`);
    }
    const alreadyApplied = files.filter((f) => ledger.has(f.version)).map((f) => `${f.version}_${f.name}`);
    return { applied, alreadyApplied, newerThanCode };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]).catch(() => undefined);
  }
}

/** Run every pending migration on a database URL over 1 dedicated connection. */
export async function migrateUrl(url: string, opts: { dir?: string } = {}): Promise<MigrateResult> {
  const c = createClient({ connectionString: url });
  await c.connect();
  try {
    return await migrate(c as unknown as Queryable, opts);
  } finally {
    await c.end();
  }
}
