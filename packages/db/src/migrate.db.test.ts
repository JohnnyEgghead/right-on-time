// SPDX-License-Identifier: AGPL-3.0-or-later
// The migration runner's re-run semantics (SD-40), proven on a real PostgreSQL 18 at every durable write: a second run,
// 2 runners at once, a failed file and its healed retry, an edited applied file, a misnumbered file, and the previous
// release running against the next release's schema.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pgAdminUrl } from './testing/provided.ts';
import { createClient } from './client.ts';
import { MIGRATIONS_DIR, MigrationDriftError, MigrationOrderError, loadMigrations, migrateUrl } from './migrate.ts';
import { createDatabase, type TestDatabase } from './testing/database.ts';

const made: TestDatabase[] = [];
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => d.drop()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function freshDb(): Promise<TestDatabase> {
  const d = await createDatabase(pgAdminUrl(), 'bw_mig');
  made.push(d);
  return d;
}

function copyOfMigrations(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'bw-mig-'));
  dirs.push(d);
  cpSync(MIGRATIONS_DIR, d, { recursive: true });
  return d;
}

async function query<T>(url: string, sql: string): Promise<T[]> {
  const c = createClient({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(sql)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Everything a migration can change, as 1 text: relations, columns, constraints, indexes, views, privileges, roles. */
const FINGERPRINT = `
SELECT md5(string_agg(x, E'\\n' ORDER BY x)) AS fp, count(*)::int AS n FROM (
  SELECT 'rel ' || n.nspname || '.' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') AS x
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('world','world_snapshot','system','pbs','pbs_snapshot')
  UNION ALL
  SELECT 'col ' || n.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull
         || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' ' || a.attidentity::text
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname IN ('world','system','pbs') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint
   WHERE connamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('world','system','pbs'))
  UNION ALL
  SELECT 'idx ' || indexdef FROM pg_indexes WHERE schemaname IN ('world','system','pbs')
  UNION ALL
  SELECT 'view ' || schemaname || '.' || viewname || ' ' || definition FROM pg_views WHERE schemaname IN ('world','system','pbs')
  UNION ALL
  SELECT 'nsp ' || nspname || ' ' || coalesce(nspacl::text, '') FROM pg_namespace WHERE nspname IN ('world','world_snapshot','system','pbs','pbs_snapshot')
  UNION ALL
  SELECT 'role ' || rolname || ' ' || rolcanlogin FROM pg_roles WHERE rolname IN ('app', 'pbs')
) s`;

const ledger = (url: string) => query<{ version: string }>(url, 'SELECT version FROM system.schema_migration ORDER BY version');

describe('rolling forward', () => {
  // why: SD-40
  it('applies every migration to an empty PostgreSQL 18 database, then rolls forward twice more changing nothing', async () => {
    const db = await freshDb();
    const all = loadMigrations().map((m) => `${m.version}_${m.name}`);
    const first = await migrateUrl(db.url);
    expect(first.applied).toEqual(all);
    const [before] = await query<{ fp: string; n: number }>(db.url, FINGERPRINT);
    for (let run = 2; run <= 3; run++) {
      const again = await migrateUrl(db.url);
      expect(again.applied, `run ${run}`).toEqual([]);
      expect(again.alreadyApplied, `run ${run}`).toEqual(all);
      expect((await query<{ fp: string; n: number }>(db.url, FINGERPRINT))[0], `run ${run}`).toEqual(before);
    }
    expect(before?.n).toBeGreaterThan(900);
    expect((await ledger(db.url)).map((r) => r.version)).toEqual(loadMigrations().map((m) => m.version));
  });

  // why: SD-40
  it('serializes 2 runners started at once: each file is applied exactly once, by one of them', async () => {
    const db = await freshDb();
    const [a, b] = await Promise.all([migrateUrl(db.url), migrateUrl(db.url)]);
    const all = loadMigrations().map((m) => `${m.version}_${m.name}`);
    expect([...(a?.applied ?? []), ...(b?.applied ?? [])].sort()).toEqual(all);
    expect((await ledger(db.url)).length).toBe(all.length);
  });
});

describe('a failed migration and its retry', () => {
  // why: SD-40
  it('leaves nothing of a failed file, and the fixed retry applies it and records it', async () => {
    const db = await freshDb();
    const dir = copyOfMigrations();
    writeFileSync(path.join(dir, '0900_broken.sql'), 'CREATE TABLE world.half_done (id int);\nSELECT 1 / 0;\n');
    await expect(migrateUrl(db.url, { dir })).rejects.toThrow(/0900_broken failed and was rolled back: division by zero/);
    expect(await query(db.url, "SELECT 1 FROM pg_class WHERE relname = 'half_done'")).toEqual([]);
    expect((await ledger(db.url)).map((r) => r.version)).not.toContain('0900');
    // The files before it were each committed with their own ledger row, so the retry starts at 0900.
    writeFileSync(path.join(dir, '0900_broken.sql'), 'CREATE TABLE world.half_done (id int);\n');
    const retry = await migrateUrl(db.url, { dir });
    expect(retry.applied).toEqual(['0900_broken']);
    expect((await ledger(db.url)).map((r) => r.version)).toContain('0900');
    expect(await query(db.url, "SELECT 1 AS one FROM pg_class WHERE relname = 'half_done'")).toEqual([{ one: 1 }]);
  });
});

describe('forward-only guards', () => {
  // why: SD-40
  it('refuses to run when an applied file was edited afterwards', async () => {
    const db = await freshDb();
    const dir = copyOfMigrations();
    await migrateUrl(db.url, { dir });
    writeFileSync(path.join(dir, '0005_list_filter_indexes.sql'), '-- edited\n', { flag: 'a' });
    await expect(migrateUrl(db.url, { dir })).rejects.toThrow(MigrationDriftError);
    await expect(migrateUrl(db.url, { dir })).rejects.toThrow(/0005_list_filter_indexes changed after it was applied/);
  });

  // why: SD-40
  it('refuses a new file numbered below an applied one', async () => {
    const db = await freshDb();
    const dir = copyOfMigrations();
    writeFileSync(path.join(dir, '0901_later.sql'), 'SELECT 1;\n');
    await migrateUrl(db.url, { dir });
    writeFileSync(path.join(dir, '0900_earlier.sql'), 'SELECT 1;\n');
    await expect(migrateUrl(db.url, { dir })).rejects.toThrow(MigrationOrderError);
  });

  // why: SD-40
  it('lets the previous release run against the next release schema (a rollback), reporting the newer files', async () => {
    const db = await freshDb();
    const dir = copyOfMigrations();
    writeFileSync(path.join(dir, '0900_next_release.sql'), 'CREATE TABLE world.next_release (id int);\n');
    await migrateUrl(db.url, { dir });
    const previous = await migrateUrl(db.url); // the committed files only: no 0900
    expect(previous.applied).toEqual([]);
    expect(previous.newerThanCode).toEqual(['0900']);
  });
});
