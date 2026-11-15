// SPDX-License-Identifier: AGPL-3.0-or-later
// node ci/gates/schema-gates/cli.ts [--plant <file.sql>] [--only parity|tz] [--spec <SPECIFICATIONS.md>]
//
// The schema gates against a real migrated PostgreSQL 18 database (P2-SCHEMA):
//   schema-doc-parity       every table, column, type, nullability, key and foreign key of SPECIFICATIONS section 3
//                           exists in the database, and the database holds none beyond it (both directions)
//   schema-time-zone-check  every time column is timestamptz, date or time with a declared zone (invariant 4)
// Steps: a PostgreSQL 18 server (BW_TEST_PG_URL, else the embedded 18.4), a fresh database, every migration, the
// optional planted SQL (a known-bad case), then both checks; the database is dropped at the end.
// Exit 0: both pass. Exit 1: a finding (each printed on stderr). Exit 2: the run could not judge.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient, type Queryable } from '../../../packages/db/src/client.ts';
import { migrateUrl } from '../../../packages/db/src/migrate.ts';
import { createDatabase } from '../../../packages/db/src/testing/database.ts';
import { startPgServer } from '../../../packages/db/src/testing/pg-server.ts';
import { zoneRegistry } from '../../../packages/db/src/zone-registry.ts';
import { readCatalog } from './catalog.ts';
import { PENDING_DOC_BATCH, schemaDocParity, schemaTimeZoneCheck, storedType } from './checks.ts';
import { expectedForeignKeys, parseSpec } from './spec-model.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const only = arg('--only');
  if (only && only !== 'parity' && only !== 'tz') { console.error('usage: --only parity|tz'); return 2; }
  const plant = arg('--plant');
  const spec = parseSpec(readFileSync(arg('--spec') ?? path.join(ROOT, 'docs', 'SPECIFICATIONS.md'), 'utf8'));

  const server = await startPgServer();
  const db = await createDatabase(server.adminUrl, 'bw_gate');
  try {
    await migrateUrl(db.url);
    const c = createClient({ connectionString: db.url });
    await c.connect();
    try {
      if (plant) await c.query(readFileSync(plant, 'utf8'));
      const catalog = await readCatalog(c as unknown as Queryable);
      const findings: string[] = [];
      if (only !== 'tz') {
        // The real schema is judged with the differences a task makes ahead of the doc batch named (each printed, each must still appear).
        const f = schemaDocParity(spec, catalog, PENDING_DOC_BATCH);
        findings.push(...f);
        for (const [line, why] of Object.entries(PENDING_DOC_BATCH)) console.log(`schema-doc-parity: pending doc batch: ${line} (${why})`);
        if (f.length === 0) {
          const cols = [...spec.tables.values()].reduce((n, t) => n + t.columns.size, 0);
          console.log(`schema-doc-parity: ok (PostgreSQL ${server.version}; ${spec.tables.size} tables, ${cols} columns, `
            + `${expectedForeignKeys(spec).size} foreign keys, ${spec.views.length} view, ${spec.schemas.length} schemas; compared both ways)`);
        }
      }
      if (only !== 'parity') {
        const f = schemaTimeZoneCheck(catalog, zoneRegistry, spec);
        findings.push(...f);
        if (f.length === 0) {
          const timeCols = [...catalog.tables.values()].filter((t) => t.kind === 'table')
            .flatMap((t) => [...t.columns.values()].filter((col) => ['timestamp with time zone', 'date', 'time without time zone'].includes(storedType(col))));
          console.log(`schema-time-zone-check: ok (${timeCols.length} time columns, each timestamptz, date or time with a declared zone)`);
        }
      }
      for (const f of findings) console.error(f);
      return findings.length > 0 ? 1 : 0;
    } finally {
      await c.end();
    }
  } finally {
    await db.drop();
    await server.stop();
  }
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`schema-gates: cannot judge: ${(e as Error).message}`);
  process.exitCode = 2;
}
