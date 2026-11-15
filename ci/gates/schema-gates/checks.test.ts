// SPDX-License-Identifier: AGPL-3.0-or-later
// The 2 schema gates' comparisons on hand-built catalogs: every finding kind, both directions, and the clean pass.
import { describe, expect, it } from 'vitest';
import type { ZoneDeclaration } from '../../../packages/db/src/zone-registry.ts';
import type { DbCatalog, DbColumn, DbTable } from './catalog.ts';
import { PENDING_DOC_BATCH, schemaDocParity, schemaTimeZoneCheck } from './checks.ts';
import { parseSpec } from './spec-model.ts';

const DOC = `## 3. Canonical Data Model

| Store | What | Mutability | Backed by |
|---|---|---|---|
| \`world\` schema | x | x | x |
| \`system\` schema | x | x | x |
| \`world_snapshot\` schema | x | x | x |

#### \`branch\` (store: world)

| Field | Type | Notes |
|---|---|---|
| \`id\` | \`text\` | x |
| \`zone\` | \`text\` | IANA |

#### \`visit\` (store: world)

| Field | Type | Notes |
|---|---|---|
| \`id\` | \`uuid\` | Primary key |
| \`branch_id\`, \`date\` | \`text\`, \`date\` | zone: branch |
| \`at\`, \`code\` | \`timestamptz\` null, \`text\` unique | x |

**Projection view.** \`report_visit\` is a view, never written.

## 4. Next
`;
const spec = parseSpec(DOC);

const c = (name: string, type: string, notNull = true): [string, DbColumn] => [name, { name, type, notNull }];
function catalog(): DbCatalog {
  const t = (schema: string, name: string, cols: [string, DbColumn][], pk: string[], unique: string[] = [], kind: 'table' | 'view' = 'table'): [string, DbTable] =>
    [`${schema}.${name}`, { schema, name, kind, columns: new Map(cols), primaryKey: pk, uniqueColumns: new Set(unique) }];
  return {
    schemas: new Set(['world', 'system', 'world_snapshot']),
    tables: new Map([
      t('world', 'branch', [c('id', 'text'), c('zone', 'text')], ['id']),
      t('world', 'visit', [c('id', 'uuid'), c('branch_id', 'text'), c('date', 'date'), c('at', 'timestamp with time zone', false), c('code', 'text')], ['id'], ['code']),
      t('world', 'report_visit', [c('id', 'uuid', false)], [], [], 'view'),
      t('system', 'schema_migration', [c('version', 'text'), c('applied_real', 'timestamp with time zone')], ['version']),
    ]),
    foreignKeys: new Map([['world.visit.branch_id', 'world.branch.id']]),
    multiColumnForeignKeys: [],
  };
}
const registry: Record<string, ZoneDeclaration> = { 'world.visit': { owner: 'branch', via: 'branch_id' } };
const table = (db: DbCatalog, key: string) => db.tables.get(key) as DbTable;

describe('schema-doc-parity', () => {
  // why: SD-40
  it('passes a database equal to section 3, the migration ledger exempt', () => {
    expect(schemaDocParity(spec, catalog())).toEqual([]);
  });

  // why: SD-40
  it('fails an extra and a missing column, a type, a nullability, a unique and a primary key that differ', () => {
    const db = catalog();
    const v = table(db, 'world.visit');
    v.columns.set('extra', { name: 'extra', type: 'text', notNull: false });
    v.columns.delete('at');
    v.columns.set('code', { name: 'code', type: 'integer', notNull: false });
    v.uniqueColumns.clear();
    v.uniqueColumns.add('branch_id');
    v.primaryKey = ['id', 'date'];
    expect(schemaDocParity(spec, db).sort()).toEqual([
      'schema-doc-parity: FAIL column world.visit.branch_id has a unique constraint section 3 does not state',
      'schema-doc-parity: FAIL column world.visit.code is integer in the database but `text` in section 3',
      'schema-doc-parity: FAIL column world.visit.code is nullable in the database but NOT NULL in section 3',
      'schema-doc-parity: FAIL column world.visit.code is unique in section 3 but has no unique constraint',
      'schema-doc-parity: FAIL extra column world.visit.extra: in the database, not in section 3',
      'schema-doc-parity: FAIL missing column world.visit.at: in section 3, not in the database',
      'schema-doc-parity: FAIL table world.visit primary key is (id, date) in the database but (id) in section 3',
    ]);
  });

  // why: SD-40
  it('fails a missing, a retargeted and an extra foreign key, an extra table and view, and a missing schema and view', () => {
    const db = catalog();
    db.foreignKeys.set('world.visit.branch_id', 'world.visit.id');
    db.foreignKeys.set('world.branch.zone', 'world.branch.id');
    db.tables.set('world.scratch', { schema: 'world', name: 'scratch', kind: 'table', columns: new Map(), primaryKey: [], uniqueColumns: new Set() });
    db.tables.set('world.other_view', { schema: 'world', name: 'other_view', kind: 'view', columns: new Map(), primaryKey: [], uniqueColumns: new Set() });
    db.tables.delete('world.report_visit');
    db.schemas.delete('world');
    expect(schemaDocParity(spec, db).sort()).toEqual([
      'schema-doc-parity: FAIL extra foreign key world.branch.zone -> world.branch.id: section 3 states no such reference',
      'schema-doc-parity: FAIL extra table world.scratch: in the database, not in section 3',
      'schema-doc-parity: FAIL extra view world.other_view: in the database, not in section 3',
      'schema-doc-parity: FAIL foreign key world.visit.branch_id references world.visit.id in the database but world.branch.id by section 3',
      'schema-doc-parity: FAIL schema world is in section 3\'s stores table but not in the database',
      'schema-doc-parity: FAIL view world.report_visit is in section 3 but not in the database',
    ]);
    db.foreignKeys.delete('world.visit.branch_id');
    expect(schemaDocParity(spec, db)).toContain('schema-doc-parity: FAIL missing foreign key world.visit.branch_id -> world.branch.id');
  });
});

describe('differences pending the doc batch (F-562)', () => {
  const NULLABLE = 'column world.visit.date is nullable in the database but NOT NULL in section 3';
  // why: F-562 a migration made ahead of section 3's doc batch passes only by its exact line, and only while it still appears
  it('holds back exactly the named difference, reports every other one, and reports a named one that no longer appears', () => {
    const db = catalog();
    table(db, 'world.visit').columns.set('date', { name: 'date', type: 'date', notNull: false });
    table(db, 'world.visit').columns.set('code', { name: 'code', type: 'text', notNull: false });
    expect(schemaDocParity(spec, db, { [NULLABLE]: 'F-562' })).toEqual([
      'schema-doc-parity: FAIL column world.visit.code is nullable in the database but NOT NULL in section 3',
    ]);
    expect(schemaDocParity(spec, catalog(), { [NULLABLE]: 'F-562' })).toEqual([
      `schema-doc-parity: FAIL stale pending doc-batch entry (it no longer appears; remove it from PENDING_DOC_BATCH): ${NULLABLE}`,
    ]);
  });
  // why: F-1139, F-941 section 3 (v0.12) now agrees with migrations 0022 and 0023, so no difference is held back for a doc batch
  it('holds back nothing: the real schema and section 3 agree, so the pending list is empty', () => {
    expect(Object.keys(PENDING_DOC_BATCH)).toEqual([]);
  });
});

describe('F-149 population: extras and stored types', () => {
  const bare = (schema: string, name: string, cols: [string, DbColumn][] = []): DbTable =>
    ({ schema, name, kind: 'table', columns: new Map(cols), primaryKey: [], uniqueColumns: new Set() });

  // why: F-149
  it('parity fails a 6th schema and a relation in public or a stray schema; a snapshot copy of a world table passes', () => {
    const db = catalog();
    db.schemas.add('scratch');
    db.outside = new Map([['public.stray', bare('public', 'stray')]]);
    expect(schemaDocParity(spec, db).sort()).toEqual([
      "schema-doc-parity: FAIL extra schema scratch: in the database, not among section 3's stores",
      'schema-doc-parity: FAIL extra table public.stray: in the database, outside the stores, not in section 3',
    ]);
    const ok = catalog();
    ok.outside = new Map([['world_snapshot.branch', bare('world_snapshot', 'branch')]]);
    expect(schemaDocParity(spec, ok)).toEqual([]); // control
  });

  // why: F-149
  it('time-zone check reads the stored type: precision, array and domain forms are caught; a declared timestamptz(p) passes', () => {
    const col = (type: string, base?: string): [string, DbColumn] => ['at2', { name: 'at2', type, notNull: false, ...(base ? { base } : {}) }];
    for (const [type, base] of [['timestamp(0) without time zone', undefined], ['timestamp without time zone[]', undefined], ['stamp', 'timestamp without time zone']] as const) {
      const db = catalog();
      table(db, 'world.visit').columns.set(...col(type, base));
      expect(schemaTimeZoneCheck(db, registry, spec).some((f) => f.includes('world.visit.at2 is timestamp without time zone'))).toBe(true);
    }
    const ok = catalog();
    table(ok, 'world.visit').columns.set(...col('timestamp(3) with time zone'));
    expect(schemaTimeZoneCheck(ok, registry, spec)).toEqual([]); // control: declared zone, timestamptz(3)
  });

  // why: F-149
  it('time-zone check judges a time column in public and in a snapshot store', () => {
    const db = catalog();
    db.outside = new Map([
      ['public.stray', bare('public', 'stray', [['at', { name: 'at', type: 'timestamp without time zone', notNull: false }]])],
      ['world_snapshot.visit', bare('world_snapshot', 'visit', [['at', { name: 'at', type: 'timestamp with time zone', notNull: false }]])],
    ]);
    expect(schemaTimeZoneCheck(db, registry, spec)).toEqual([
      'schema-time-zone-check: FAIL column public.stray.at is timestamp without time zone; every stored instant is timestamptz (invariant 4)',
    ]); // the snapshot copy of the declared world.visit passes (control)
  });
});

describe('schema-time-zone-check', () => {
  // why: FR-DEMO-2
  it('passes declared zones, and _real columns need none', () => {
    expect(schemaTimeZoneCheck(catalog(), registry, spec)).toEqual([]);
  });

  // why: FR-DEMO-2
  it('fails a timestamp or timetz column, an undeclared time column, and a _real column that is not timestamptz', () => {
    const db = catalog();
    table(db, 'world.visit').columns.set('legacy', { name: 'legacy', type: 'timestamp without time zone', notNull: false });
    table(db, 'world.branch').columns.set('opens', { name: 'opens', type: 'time with time zone', notNull: false });
    table(db, 'world.branch').columns.set('seen_real', { name: 'seen_real', type: 'date', notNull: false });
    expect(schemaTimeZoneCheck(db, registry, spec).sort()).toEqual([
      'schema-time-zone-check: FAIL column world.branch.opens (time with time zone) has no declared zone: no entry for world.branch in packages/db/src/zone-registry.ts',
      'schema-time-zone-check: FAIL column world.branch.opens is time with time zone; a local time is time plus its zone owner (invariant 4)',
      'schema-time-zone-check: FAIL column world.branch.seen_real ends _real (real time, SD-10) but is date, not timestamptz',
      'schema-time-zone-check: FAIL column world.visit.legacy is timestamp without time zone; every stored instant is timestamptz (invariant 4)',
    ]);
  });

  // why: FR-DEMO-2
  it('fails a registry entry that is stale, finds its zone through a missing column, lacks a zone column, or contradicts section 3', () => {
    const db = catalog();
    const bad: Record<string, ZoneDeclaration> = {
      'world.visit': { owner: 'customer', via: 'customer_id' },
      'world.branch': { owner: 'column' },
      'world.gone': { owner: 'utc' },
    };
    table(db, 'world.branch').columns.set('opened', { name: 'opened', type: 'date', notNull: true });
    table(db, 'world.branch').columns.delete('zone');
    expect(schemaTimeZoneCheck(db, bad, spec).sort()).toEqual([
      'schema-time-zone-check: FAIL column world.visit.date is "zone: branch" in section 3 but zone-registry declares customer',
      'schema-time-zone-check: FAIL zone-registry entry world.branch says owner column, but world.branch has no NOT NULL text column zone',
      'schema-time-zone-check: FAIL zone-registry entry world.gone names a table the database does not have',
      'schema-time-zone-check: FAIL zone-registry entry world.visit finds its customer zone via customer_id, which world.visit does not have',
    ]);
    table(db, 'world.branch').columns.delete('opened');
    expect(schemaTimeZoneCheck(db, { 'world.branch': { owner: 'utc' } })).toContain(
      'schema-time-zone-check: FAIL zone-registry entry world.branch declares a zone for a table with no time column outside _real');
  });
});
