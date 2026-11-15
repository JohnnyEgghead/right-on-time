// SPDX-License-Identifier: AGPL-3.0-or-later
// schema-doc-parity, part 2: the real schema, read from a migrated database's own catalog (pg_catalog), never from
// the migration files. Only reads; the caller owns the connection.
import type { Queryable } from '../../../packages/db/src/client.ts';

export interface DbColumn {
  name: string;
  type: string; // format_type(), with a "public." prefix removed: "timestamp with time zone", "text[]", "citext"
  notNull: boolean;
  /** The type with arrays and domains resolved to the underlying type, precision kept as format_type prints it (F-149). */
  base?: string;
}

export interface DbTable {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: Map<string, DbColumn>;
  primaryKey: string[];
  /** Columns with a single-column, full (no predicate, no expression) unique constraint or index, primary key excluded. */
  uniqueColumns: Set<string>;
}

export interface DbCatalog {
  schemas: Set<string>;
  tables: Map<string, DbTable>; // "schema.table"
  foreignKeys: Map<string, string>; // single-column: "schema.table.column" -> "schema.table.column"
  multiColumnForeignKeys: string[]; // constraint names, "schema.table.constraint"
  /** Tables and views in any schema outside COMPARED_SCHEMAS (public, the snapshot stores, a stray schema), extension objects left out (F-149). */
  outside?: Map<string, DbTable>;
}

export const COMPARED_SCHEMAS = ['world', 'pbs', 'system'];

export async function readCatalog(db: Queryable): Promise<DbCatalog> {
  const schemas = new Set(
    (await db.query<{ nspname: string }>("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'")).rows.map((r) => r.nspname),
  );
  const tables = new Map<string, DbTable>();
  const rels = await db.query<{ nspname: string; relname: string; relkind: string }>(
    `SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
    [COMPARED_SCHEMAS],
  );
  for (const r of rels.rows) {
    tables.set(`${r.nspname}.${r.relname}`, {
      schema: r.nspname, name: r.relname, kind: r.relkind === 'v' || r.relkind === 'm' ? 'view' : 'table',
      columns: new Map(), primaryKey: [], uniqueColumns: new Set(),
    });
  }
  const cols = await db.query<{ nspname: string; relname: string; attname: string; type: string; attnotnull: boolean }>(
    `SELECT n.nspname, c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [COMPARED_SCHEMAS],
  );
  // Domains resolve to their base type, arrays to their element type, so a time column is classified by what it stores (F-149).
  const domains = new Map(
    (await db.query<{ name: string; base: string }>(
      "SELECT format_type(t.oid, NULL) AS name, format_type(t.typbasetype, t.typtypmod) AS base FROM pg_type t WHERE t.typtype = 'd'",
    )).rows.map((r) => [r.name.replace(/^public\./, ''), r.base.replace(/^public\./, '')]),
  );
  const baseOf = (type: string): string => {
    let t = type;
    for (let i = 0; i < 20; i++) {
      const bare = t.replace(/\[\]$/, '');
      const next = domains.get(bare) ?? (bare !== t ? bare : undefined);
      if (next === undefined) break;
      t = next;
    }
    return t;
  };
  for (const r of cols.rows) {
    const type = r.type.replace(/^public\./, '');
    tables.get(`${r.nspname}.${r.relname}`)?.columns.set(r.attname, { name: r.attname, type, notNull: r.attnotnull, base: baseOf(type) });
  }
  const keys = await db.query<{ nspname: string; relname: string; columns: string[]; primary: boolean }>(
    `SELECT n.nspname, c.relname, i.indisprimary AS primary,
            ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum ORDER BY k.ord) AS columns
       FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL`,
    [COMPARED_SCHEMAS],
  );
  for (const r of keys.rows) {
    const t = tables.get(`${r.nspname}.${r.relname}`);
    if (!t) continue;
    if (r.primary) t.primaryKey = r.columns;
    else if (r.columns.length === 1) t.uniqueColumns.add(r.columns[0] ?? '');
  }
  const fks = await db.query<{ nspname: string; relname: string; conname: string; from_cols: string[]; to_schema: string; to_table: string; to_cols: string[] }>(
    `SELECT n.nspname, c.relname, k.conname,
            ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.attnum ORDER BY x.ord) AS from_cols,
            fn.nspname AS to_schema, fc.relname AS to_table,
            ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = x.attnum ORDER BY x.ord) AS to_cols
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class fc ON fc.oid = k.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE k.contype = 'f' AND n.nspname = ANY($1)`,
    [COMPARED_SCHEMAS],
  );
  const foreignKeys = new Map<string, string>();
  const multiColumnForeignKeys: string[] = [];
  for (const r of fks.rows) {
    if (r.from_cols.length !== 1) { multiColumnForeignKeys.push(`${r.nspname}.${r.relname}.${r.conname}`); continue; }
    foreignKeys.set(`${r.nspname}.${r.relname}.${r.from_cols[0]}`, `${r.to_schema}.${r.to_table}.${r.to_cols[0]}`);
  }
  // Relations outside the 3 compared schemas, with their columns, minus objects an extension owns (citext lives in public).
  const outside = new Map<string, DbTable>();
  const orels = await db.query<{ nspname: string; relname: string; relkind: string; attname: string; type: string; attnotnull: boolean }>(
    `SELECT n.nspname, c.relname, c.relkind, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname <> ALL($1) AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      ORDER BY n.nspname, c.relname, a.attnum`,
    [COMPARED_SCHEMAS],
  );
  for (const r of orels.rows) {
    const key = `${r.nspname}.${r.relname}`;
    let t = outside.get(key);
    if (!t) {
      t = { schema: r.nspname, name: r.relname, kind: r.relkind === 'v' || r.relkind === 'm' ? 'view' : 'table', columns: new Map(), primaryKey: [], uniqueColumns: new Set() };
      outside.set(key, t);
    }
    if (r.attname) {
      const type = r.type.replace(/^public\./, '');
      t.columns.set(r.attname, { name: r.attname, type, notNull: r.attnotnull, base: baseOf(type) });
    }
  }
  return { schemas, tables, foreignKeys, multiColumnForeignKeys, outside };
}
