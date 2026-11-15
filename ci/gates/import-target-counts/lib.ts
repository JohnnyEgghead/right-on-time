// SPDX-License-Identifier: AGPL-3.0-or-later
// The gate's real path: a fresh migrated PostgreSQL 18 database, the reference rows, the import's own dry run as the
// web process's login bw_web, and the report read back from the run's import_run row (what API-81 serves), never the
// runner's return value.
import { createClient, type Queryable } from '../../../packages/db/src/client.ts';
import { migrateUrl } from '../../../packages/db/src/migrate.ts';
import { createDatabase } from '../../../packages/db/src/testing/database.ts';
import type { ExportFiles } from '../../../packages/import/src/layout.ts';
import { runImport } from '../../../packages/import/src/runner.ts';
import { seedReference, stampClock, webPool } from '../../../packages/import/src/testing/world.ts';
import type { ReportLike } from './targets.ts';

export interface DryRunRecord {
  runId: string;
  report: ReportLike;
  status: string;
}

/** Run the import's dry run on the world at databaseUrl (migrated, reference seeded) and read its stored report. */
export async function storedDryRun(databaseUrl: string, files: ExportFiles): Promise<DryRunRecord> {
  const pool = webPool(databaseUrl);
  try {
    const out = await runImport(pool, { kind: 'dry_run', files, bySetup: true, byUser: null, clock: stampClock('dry_run') });
    const c = createClient({ connectionString: databaseUrl });
    await c.connect();
    try {
      const r = await (c as unknown as Queryable).query<{ status: string; report: ReportLike }>(
        'SELECT status, report FROM world.import_run WHERE id = $1', [out.runId]);
      const row = r.rows[0];
      if (!row) throw new Error(`import-target-counts: run ${out.runId} has no import_run row`);
      return { runId: out.runId, report: row.report, status: row.status };
    } finally {
      await c.end();
    }
  } finally {
    await pool.end();
  }
}

/** A fresh database on the server at adminUrl, migrated and seeded with the reference rows. */
export async function preparedWorld(adminUrl: string): Promise<{ url: string; drop(): Promise<void> }> {
  const db = await createDatabase(adminUrl, 'bw_imp');
  await migrateUrl(db.url);
  const c = createClient({ connectionString: db.url });
  await c.connect();
  try {
    await seedReference(c as unknown as Queryable);
  } finally {
    await c.end();
  }
  return { url: db.url, drop: db.drop };
}
