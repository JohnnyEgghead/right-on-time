// SPDX-License-Identifier: AGPL-3.0-or-later
// node packages/db/src/cli/generate-repositories.ts [--check]
// Writes 1 repository module per entity (SD-2) into packages/db/src/repositories from the migrated schema itself:
// it starts a PostgreSQL 18 server (BW_TEST_PG_URL or the embedded one), migrates a fresh database, reads the catalog,
// and renders each table's row type, insert type, key and access. --check writes nothing and exits 1 when any file
// would change (the repositories database test runs the same comparison on every run).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createClient, type Queryable } from '../client.ts';
import { migrateUrl } from '../migrate.ts';
import { createDatabase } from '../testing/database.ts';
import { startPgServer } from '../testing/pg-server.ts';

export const REPOSITORIES_DIR = path.resolve(import.meta.dirname, '..', 'repositories');

/**
 * The 8 history logs of the section 3 stores table, and the time-block change log (P4-BOARD; owner ruling 8ef38e83, migration 0015):
 * role app may insert and read, never update or delete.
 */
export const APPEND_ONLY = new Set([
  'world.job_change', 'world.tech_item', 'world.text_attempt', 'world.billing_attempt',
  'world.user_change', 'world.note', 'world.photo', 'world.signature', 'world.time_block_change',
]);
/** Seeded, read-only to every role (FR-DISP-32), and the never-written projection view (SD-25). */
export const READ_ONLY = new Set(['world.membership', 'world.report_visit']);
/** 1-row tables (section 3): update names no row. */
const SINGLETONS = new Set(['world.text_simulator', 'pbs.mode', 'system.demo_clock', 'system.worker_heartbeat']);
/** Tables owned by the migration runner, not by a repository. */
export const NOT_ENTITIES = new Set(['system.schema_migration']);
/** Line 1 of every file the generator writes: the public tree's license header (P8-PUBLIC-FILES, ci/public-files.ts). */
export const SPDX_HEADER = '// SPDX-License-Identifier: AGPL-3.0-or-later';

interface Col { name: string; type: string; notNull: boolean; filled: boolean }
interface Rel { schema: string; table: string; view: boolean; columns: Col[]; key: string[] }

const TS_TYPE: Readonly<Record<string, string>> = {
  uuid: 'string', text: 'string', citext: 'string', integer: 'number', 'double precision': 'number',
  bigint: 'string', numeric: 'string', boolean: 'boolean', 'timestamp with time zone': 'Date', date: 'string',
  'time without time zone': 'string', jsonb: 'unknown', bytea: 'Buffer', 'text[]': 'string[]', 'integer[]': 'number[]',
};

const pascal = (s: string) => s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
const camel = (s: string) => { const p = pascal(s); return p.charAt(0).toLowerCase() + p.slice(1); };

export async function readRelations(db: Queryable): Promise<Rel[]> {
  const { rows } = await db.query<{ schema: string; table: string; relkind: string; name: string; type: string; notnull: boolean; filled: boolean }>(
    `SELECT n.nspname AS schema, c.relname AS table, c.relkind, a.attname AS name,
            regexp_replace(format_type(a.atttypid, a.atttypmod), '^public\\.', '') AS type, a.attnotnull AS notnull,
            (a.atthasdef OR a.attidentity <> '' OR NOT a.attnotnull) AS filled
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname IN ('world', 'pbs', 'system') AND c.relkind IN ('r', 'v')
      ORDER BY n.nspname, c.relname, a.attnum`,
  );
  const keys = await db.query<{ schema: string; table: string; columns: string[] }>(
    `SELECT n.nspname AS schema, c.relname AS table,
            ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum ORDER BY k.ord) AS columns
       FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE i.indisprimary AND n.nspname IN ('world', 'pbs', 'system')`,
  );
  const rels = new Map<string, Rel>();
  for (const r of rows) {
    const id = `${r.schema}.${r.table}`;
    if (NOT_ENTITIES.has(id)) continue;
    let rel = rels.get(id);
    if (!rel) { rel = { schema: r.schema, table: r.table, view: r.relkind === 'v', columns: [], key: [] }; rels.set(id, rel); }
    rel.columns.push({ name: r.name, type: r.type, notNull: r.notnull, filled: r.filled });
  }
  for (const k of keys.rows) { const rel = rels.get(`${k.schema}.${k.table}`); if (rel) rel.key = k.columns; }
  return [...rels.values()];
}

export function render(rel: Rel): string {
  const id = `${rel.schema}.${rel.table}`;
  const T = pascal(rel.table);
  const access = READ_ONLY.has(id) ? 'read-only' : APPEND_ONLY.has(id) ? 'append-only' : 'mutable';
  const factory = { 'read-only': 'readOnlyRepository', 'append-only': 'appendOnlyRepository', mutable: 'mutableRepository' }[access];
  const tsType = (c: Col) => {
    const t = TS_TYPE[c.type];
    if (!t) throw new Error(`${id}.${c.name}: no TypeScript type for ${c.type}`);
    return c.notNull ? t : `${t} | null`; // a view's columns are never NOT NULL in the catalog
  };
  const q = (s: string) => `'${s}'`;
  const optional = rel.columns.filter((c) => c.filled).map((c) => q(c.name));
  const keyType = rel.key.length > 0 ? rel.key.map(q).join(' | ') : 'never';
  const lines = [
    SPDX_HEADER,
    `// Generated by packages/db/src/cli/generate-repositories.ts from the migrated schema: change the migration, then`,
    `// regenerate. Repository of ${id} (SPECIFICATIONS ${rel.view ? 'SD-25 view' : 'section 3'} \`${rel.table}\`), ${access}.`,
    `import { ${factory} } from '../../repository.ts';`,
    '',
    `export interface ${T}Row {`,
    ...rel.columns.map((c) => `  ${c.name}: ${tsType(c)};`),
    '}',
  ];
  if (access !== 'read-only') {
    lines.push(
      '',
      '/** Insert shape: columns with a default, an identity or null may be left out. */',
      optional.length > 0
        ? `export type ${T}Insert = Omit<${T}Row, ${optional.join(' | ')}> & Partial<Pick<${T}Row, ${optional.join(' | ')}>>;`
        : `export type ${T}Insert = ${T}Row;`,
    );
  }
  const generics = access === 'read-only' ? `${T}Row, ${keyType}` : `${T}Row, ${T}Insert, ${keyType}`;
  const json = rel.columns.filter((c) => c.type === 'jsonb').map((c) => q(c.name));
  lines.push(
    '',
    `export const ${camel(rel.table)}Repository = ${factory}<${generics}>({`,
    `  schema: '${rel.schema}',`,
    `  table: '${rel.table}',`,
    `  columns: [${rel.columns.map((c) => q(c.name)).join(', ')}],`,
    `  key: [${rel.key.map(q).join(', ')}],`,
    `  json: [${json.join(', ')}],`,
    ...(SINGLETONS.has(id) ? ['  singleton: true,'] : []),
    '});',
    '',
  );
  return lines.join('\n');
}

export function renderIndex(rels: Rel[]): string {
  const sorted = [...rels].sort((a, b) => `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`));
  const names = new Set<string>();
  for (const r of sorted) {
    if (names.has(r.table)) throw new Error(`2 schemas define ${r.table}; the generator needs schema-qualified names`);
    names.add(r.table);
  }
  return [
    SPDX_HEADER,
    '// Generated by packages/db/src/cli/generate-repositories.ts: every entity of SPECIFICATIONS section 3 and its 1',
    '// repository module (SD-2), plus the report_visit view (SD-25).',
    ...sorted.map((r) => `import { ${camel(r.table)}Repository } from './${r.schema}/${r.table}.ts';`),
    '',
    ...sorted.map((r) => `export * from './${r.schema}/${r.table}.ts';`),
    '',
    '/** Every repository, in schema and table order. */',
    'export const repositories = [',
    ...sorted.map((r) => `  ${camel(r.table)}Repository,`),
    '] as const;',
    '',
  ].join('\n');
}

/** Every file the generator owns, by path relative to REPOSITORIES_DIR. */
export function renderAll(rels: Rel[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rels) out.set(`${r.schema}/${r.table}.ts`, render(r));
  out.set('index.ts', renderIndex(rels));
  return out;
}

export function existingFiles(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(REPOSITORIES_DIR)) return out;
  for (const e of readdirSync(REPOSITORIES_DIR, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.ts')) continue;
    const abs = path.join(e.parentPath, e.name);
    out.set(path.relative(REPOSITORIES_DIR, abs).split(path.sep).join('/'), readFileSync(abs, 'utf8'));
  }
  return out;
}

/** Paths whose committed text differs from a fresh generation (added, changed or stale). */
export function drift(fresh: Map<string, string>, committed: Map<string, string>): string[] {
  const paths = new Set([...fresh.keys(), ...committed.keys()]);
  return [...paths].filter((p) => fresh.get(p) !== committed.get(p)).sort();
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const server = await startPgServer();
  const db = await createDatabase(server.adminUrl, 'bw_gen');
  try {
    await migrateUrl(db.url);
    const c = createClient({ connectionString: db.url });
    await c.connect();
    const fresh = renderAll(await readRelations(c as unknown as Queryable));
    await c.end();
    const changed = drift(fresh, existingFiles());
    if (check) {
      for (const p of changed) console.error(`generate-repositories: ${p} differs from the migrated schema`);
      process.exitCode = changed.length > 0 ? 1 : 0;
    } else {
      rmSync(REPOSITORIES_DIR, { recursive: true, force: true });
      for (const [p, text] of fresh) {
        mkdirSync(path.dirname(path.join(REPOSITORIES_DIR, p)), { recursive: true });
        writeFileSync(path.join(REPOSITORIES_DIR, p), text);
      }
      console.log(`generate-repositories: wrote ${fresh.size} files (${changed.length} changed)`);
    }
  } finally {
    await db.drop();
    await server.stop();
  }
}
