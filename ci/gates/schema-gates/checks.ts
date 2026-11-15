// SPDX-License-Identifier: AGPL-3.0-or-later
// The 2 schema gates (P2-SCHEMA; SPECIFICATIONS section 3 and section 14), as pure comparisons of a parsed section 3
// (spec-model.ts) and a migrated database's catalog (catalog.ts). Each finding is 1 line naming the object and why.
import type { ZoneDeclaration } from '../../../packages/db/src/zone-registry.ts';
import { COMPARED_SCHEMAS, type DbCatalog, type DbTable } from './catalog.ts';
import { expectedForeignKeys, type SpecModel } from './spec-model.ts';

/**
 * Tables the database holds that section 3 lists without columns: the migration ledger, which the stores table puts
 * in `system` ("..., migrations") and which the runner (packages/db/src/migrate.ts) owns.
 */
export const PARITY_EXEMPT_TABLES: Readonly<Record<string, string>> = {
  'system.schema_migration': 'section 3 stores table: system holds the migrations; written only by the migration runner',};

const DOC_TO_PG: Readonly<Record<string, string>> = {
  timestamptz: 'timestamp with time zone',
  time: 'time without time zone',
};
export const pgTypeOf = (docType: string): string => DOC_TO_PG[docType] ?? docType;

/** A column's stored type with domains and arrays resolved and any precision removed: timestamp(0) -> timestamp without time zone (F-149). */
export const storedType = (c: { type: string; base?: string }): string =>
  (c.base ?? c.type).replace(/\[\]$/, '').replace(/\((\d+)\)/, '');

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Differences a plan task makes on purpose ahead of section 3's doc batch, each named exactly, with the task and finding
 * that make it. A listed difference is not reported while the database still shows it; once section 3 or the database
 * changes so that it no longer appears, it is reported as stale, so the entry must leave with the doc batch.
 */
export const PENDING_DOC_BATCH: Readonly<Record<string, string>> = {};

export function schemaDocParity(spec: SpecModel, db: DbCatalog, pending: Readonly<Record<string, string>> = {}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const fail = (s: string) => {
    if (pending[s] !== undefined) seen.add(s);
    else out.push(`schema-doc-parity: FAIL ${s}`);
  };
  try {
    parityFindings(spec, db, fail);
  } finally {
    for (const s of Object.keys(pending)) {
      if (!seen.has(s)) out.push(`schema-doc-parity: FAIL stale pending doc-batch entry (it no longer appears; remove it from PENDING_DOC_BATCH): ${s}`);
    }
  }
  return out;
}

function parityFindings(spec: SpecModel, db: DbCatalog, fail: (s: string) => void): void {

  for (const s of spec.schemas) if (!db.schemas.has(s)) fail(`schema ${s} is in section 3's stores table but not in the database`);

  // F-149: the schema list and every relation outside the compared schemas are checked for extras, not only for presence.
  const storeSchemas = new Set(spec.schemas);
  for (const sch of db.schemas) {
    if (sch !== 'public' && !storeSchemas.has(sch)) fail(`extra schema ${sch}: in the database, not among section 3's stores`);
  }
  for (const [key, t] of db.outside ?? []) {
    const mirror = t.schema.endsWith('_snapshot') && storeSchemas.has(t.schema) ? `${t.schema.slice(0, -'_snapshot'.length)}.${t.name}` : undefined;
    if (mirror && db.tables.has(mirror)) continue; // a day-start copy of a table the schema holds (SD-12)
    fail(`extra ${t.kind} ${key}: in the database${storeSchemas.has(t.schema) ? '' : ', outside the stores'}, not in section 3`);
  }

  for (const [key, t] of spec.tables) {
    const d = db.tables.get(key);
    if (!d) { fail(`table ${key} is in section 3 but not in the database`); continue; }
    if (d.kind !== 'table') { fail(`${key} is a view in the database but a table in section 3`); continue; }
    for (const c of t.columns.values()) {
      const dc = d.columns.get(c.name);
      if (!dc) { fail(`missing column ${key}.${c.name}: in section 3, not in the database`); continue; }
      if (dc.type !== pgTypeOf(c.type)) fail(`column ${key}.${c.name} is ${dc.type} in the database but \`${c.type}\` in section 3`);
      if (dc.notNull === c.nullable) {
        fail(`column ${key}.${c.name} is ${dc.notNull ? 'NOT NULL' : 'nullable'} in the database but ${c.nullable ? 'null' : 'NOT NULL'} in section 3`);
      }
      if (c.unique && !d.uniqueColumns.has(c.name)) fail(`column ${key}.${c.name} is unique in section 3 but has no unique constraint`);
    }
    for (const dc of d.columns.values()) {
      if (!t.columns.has(dc.name)) fail(`extra column ${key}.${dc.name}: in the database, not in section 3`);
    }
    for (const u of d.uniqueColumns) {
      if (t.columns.has(u) && !t.columns.get(u)?.unique) fail(`column ${key}.${u} has a unique constraint section 3 does not state`);
    }
    if (!same(d.primaryKey, t.primaryKey)) {
      fail(`table ${key} primary key is (${d.primaryKey.join(', ')}) in the database but (${t.primaryKey.join(', ')}) in section 3`);
    }
  }
  for (const [key, d] of db.tables) {
    if (spec.tables.has(key) || PARITY_EXEMPT_TABLES[key]) continue;
    if (d.kind === 'view') { if (!spec.views.includes(key)) fail(`extra view ${key}: in the database, not in section 3`); continue; }
    fail(`extra table ${key}: in the database, not in section 3`);
  }
  for (const v of spec.views) {
    const d = db.tables.get(v);
    if (!d) fail(`view ${v} is in section 3 but not in the database`);
    else if (d.kind !== 'view') fail(`${v} is a table in the database but a view in section 3`);
  }

  const want = expectedForeignKeys(spec);
  for (const [from, to] of want) {
    const got = db.foreignKeys.get(from);
    if (!got) fail(`missing foreign key ${from} -> ${to}`);
    else if (got !== to) fail(`foreign key ${from} references ${got} in the database but ${to} by section 3`);
  }
  for (const [from, to] of db.foreignKeys) {
    if (!want.has(from)) fail(`extra foreign key ${from} -> ${to}: section 3 states no such reference`);
  }
  for (const k of db.multiColumnForeignKeys) fail(`extra multi-column foreign key ${k}: section 3 states only single-column references`);
}

const ZONED_TYPES = new Set(['timestamp with time zone', 'date', 'time without time zone']);
const REFUSED_TYPES: Readonly<Record<string, string>> = {
  'timestamp without time zone': 'timestamp without time zone; every stored instant is timestamptz',
  'time with time zone': 'time with time zone; a local time is time plus its zone owner',
};

export function schemaTimeZoneCheck(db: DbCatalog, registry: Readonly<Record<string, ZoneDeclaration>>, spec?: SpecModel): string[] {
  const out: string[] = [];
  const fail = (s: string) => out.push(`schema-time-zone-check: FAIL ${s}`);
  const stored = [...db.tables.values()].filter((t) => t.kind === 'table' && COMPARED_SCHEMAS.includes(t.schema));
  const needsZone = (t: DbTable) => [...t.columns.values()].filter((c) => (ZONED_TYPES.has(storedType(c)) || REFUSED_TYPES[storedType(c)]) && !c.name.endsWith('_real'));

  for (const t of stored) {
    const key = `${t.schema}.${t.name}`;
    for (const c of t.columns.values()) {
      const refused = REFUSED_TYPES[storedType(c)];
      if (refused) fail(`column ${key}.${c.name} is ${refused} (invariant 4)`);
      else if (c.name.endsWith('_real') && storedType(c) !== 'timestamp with time zone' && ZONED_TYPES.has(storedType(c))) {
        fail(`column ${key}.${c.name} ends _real (real time, SD-10) but is ${c.type}, not timestamptz`);
      }
    }
    const zoned = needsZone(t);
    const decl = registry[key];
    if (zoned.length > 0 && !decl) {
      for (const c of zoned) fail(`column ${key}.${c.name} (${c.type}) has no declared zone: no entry for ${key} in packages/db/src/zone-registry.ts`);
      continue;
    }
    if (!decl) continue;
    if (zoned.length === 0) fail(`zone-registry entry ${key} declares a zone for a table with no time column outside _real`);
    if (decl.owner === 'column') {
      const z = t.columns.get('zone');
      if (!z || z.type !== 'text' || !z.notNull) fail(`zone-registry entry ${key} says owner column, but ${key} has no NOT NULL text column zone`);
    } else if (decl.owner === 'branch' || decl.owner === 'customer') {
      if (!decl.via) fail(`zone-registry entry ${key} (owner ${decl.owner}) names no via column`);
      else if (!t.columns.has(decl.via)) fail(`zone-registry entry ${key} finds its ${decl.owner} zone via ${decl.via}, which ${key} does not have`);
    }
    if (spec) {
      const st = spec.tables.get(key);
      for (const c of zoned) {
        const note = st?.columns.get(c.name)?.zoneNote;
        if (note && decl.owner !== note && decl.owner !== 'column') {
          fail(`column ${key}.${c.name} is "zone: ${note}" in section 3 but zone-registry declares ${decl.owner}`);
        }
      }
    }
  }
  // F-149: a time column in a relation outside the compared schemas (public, a snapshot store, a stray schema) is judged too.
  // A snapshot store holds copies of world and pbs tables, so it finds its zone through the table it copies.
  for (const [key, t] of db.outside ?? []) {
    if (t.kind !== 'table') continue;
    const mirror = t.schema.endsWith('_snapshot') ? `${t.schema.slice(0, -'_snapshot'.length)}.${t.name}` : key;
    for (const c of needsZone(t)) {
      const refused = REFUSED_TYPES[storedType(c)];
      if (refused) fail(`column ${key}.${c.name} is ${refused} (invariant 4)`);
      else if (!registry[mirror]) fail(`column ${key}.${c.name} (${c.type}) has no declared zone: no entry for ${mirror} in packages/db/src/zone-registry.ts`);
    }
  }
  for (const key of Object.keys(registry)) {
    if (!stored.some((t) => `${t.schema}.${t.name}` === key)) fail(`zone-registry entry ${key} names a table the database does not have`);
  }
  return out;
}
