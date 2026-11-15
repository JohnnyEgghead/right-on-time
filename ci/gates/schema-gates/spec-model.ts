// SPDX-License-Identifier: AGPL-3.0-or-later
// schema-doc-parity, part 1 (P2-SCHEMA; SPECIFICATIONS section 3): the expected schema, parsed from the document itself.
// Strict by design: a section 3 row this parser cannot read is an error, never a skipped row, so a doc change can
// never silently drop out of the comparison. Pure: no database, no file system (the caller passes the text).
//
// What it reads from each `#### <tables> ... (store: <store>)` block's `| Field | Type | Notes |` table:
//   Field  1 or more backticked names; `t.c` sets the current table, a bare `c` belongs to the current table.
//   Type   1 backticked type per name, or 1 for all names; each may carry `null` and `unique` after it.
//   Notes  "Primary key ..." (see primaryKeyOf), "`c` references `t.c`", "References `t.c`", "zone: branch|customer".
// And from the "Nullability and keys" paragraph: the foreign-key naming rules (expectedForeignKeys).

export type Store = 'world' | 'pbs' | 'system';

export interface SpecColumn {
  name: string;
  type: string; // as the document spells it: `timestamptz`, `text[]`, `double precision`
  nullable: boolean;
  unique: boolean;
  zoneNote: 'branch' | 'customer' | null; // a "zone: <owner>" note on the column's row
}

export interface SpecTable {
  schema: Store;
  name: string;
  columns: Map<string, SpecColumn>;
  primaryKey: string[];
  /** Explicit "references" notes: column -> "schema.table.column". */
  references: Map<string, string>;
}

export interface SpecModel {
  tables: Map<string, SpecTable>; // key "schema.table"
  views: string[]; // "schema.view"
  schemas: string[]; // every schema the persistence-stores table names
}

export class SpecParseError extends Error {}

const STORES: readonly Store[] = ['world', 'pbs', 'system'];
const DOC_TYPES = new Set([
  'text', 'uuid', 'integer', 'bigint', 'boolean', 'double precision', 'numeric', 'date', 'time', 'timestamptz',
  'jsonb', 'bytea', 'citext', 'text[]', 'integer[]',
]);

export function sectionThree(doc: string): string {
  const start = doc.search(/^## 3\. /m);
  if (start < 0) throw new SpecParseError('SPECIFICATIONS has no "## 3. " heading');
  const rest = doc.slice(start + 1);
  const end = rest.search(/^## \d+\. /m);
  return end < 0 ? doc.slice(start) : doc.slice(start, start + 1 + end);
}

const ticks = (s: string): string[] => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');

function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const parts = inner.split('|').map((c) => c.trim());
  if (parts.length < 3) throw new SpecParseError(`row has fewer than 3 cells: ${line}`);
  return [parts[0] ?? '', parts[1] ?? '', parts.slice(2).join('|')];
}

interface TypeItem { type: string; nullable: boolean; unique: boolean }

function parseTypes(cell: string, where: string): TypeItem[] {
  const items: TypeItem[] = [];
  const re = /`([^`]+)`((?:\s+(?:null|unique))*)/g;
  let consumed = cell;
  for (const m of cell.matchAll(re)) {
    const type = m[1] ?? '';
    if (!DOC_TYPES.has(type)) throw new SpecParseError(`${where}: unknown type \`${type}\``);
    const mods = (m[2] ?? '').trim().split(/\s+/).filter(Boolean);
    items.push({ type, nullable: mods.includes('null'), unique: mods.includes('unique') });
    consumed = consumed.replace(m[0], '');
  }
  if (consumed.replace(/[,\s]/g, '') !== '') throw new SpecParseError(`${where}: unreadable text in the Type cell: "${cell}"`);
  return items;
}

interface PendingKey { table: SpecTable; names: string[]; note: string; where: string }

/**
 * The document's primary-key phrasings, as they occur in section 3:
 *   "Primary key (a, b)"       the listed columns, when every item names a column of the table (else it is a citation)
 *   "Primary key pair"         the row's names
 *   "Primary key: ..." / "= ..." the row's first name (the colon or equals sign defines that one key value)
 *   "Primary key; ..." / "Primary key" / "Primary key (FR-...)"  the row's names
 */
function primaryKeyOf(p: PendingKey): string[] {
  const note = p.note.trim();
  const list = /^Primary key \(([^)]*)\)/.exec(note);
  if (list) {
    const items = (list[1] ?? '').split(',').map((s) => s.trim().replace(/`/g, ''));
    if (items.every((c) => p.table.columns.has(c))) return items;
  }
  if (/^Primary key pair\b/.test(note)) return p.names;
  if (/^Primary key\s*[:=]/.test(note)) return p.names.slice(0, 1);
  return p.names;
}

export function parseSpec(doc: string): SpecModel {
  const s3 = sectionThree(doc);
  const tables = new Map<string, SpecTable>();
  const lines = s3.split('\n');
  const schemas = new Set<string>();

  // The persistence-stores table names the schemas (`world` schema, `pbs` and `pbs_snapshot` schemas, ...).
  for (const line of lines) {
    const m = /^\| `([a-z_]+)` (?:and `([a-z_]+)` )?schemas?\b/.exec(line);
    if (m) for (const s of [m[1], m[2]]) if (s) schemas.add(s);
  }

  const pendingKeys: PendingKey[] = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i] ?? '';
    if (!heading.startsWith('#### ')) continue;
    const where = `section 3 heading "${heading.slice(5, 80)}"`;
    const storeMatch = /\(store: (\w+)/.exec(heading);
    const store = storeMatch?.[1] as Store | undefined;
    if (!store || !STORES.includes(store)) throw new SpecParseError(`${where}: no (store: world|pbs|system)`);
    const namePart = heading.slice(5).split(' — ')[0] ?? '';
    const blockTables: SpecTable[] = [];
    for (const raw of ticks(namePart)) {
      const [schema, name] = raw.includes('.') ? (raw.split('.') as [string, string]) : [store, raw];
      if (!STORES.includes(schema as Store)) throw new SpecParseError(`${where}: table ${raw} names an unknown schema`);
      const t: SpecTable = { schema: schema as Store, name, columns: new Map(), primaryKey: [], references: new Map() };
      if (tables.has(`${schema}.${name}`)) throw new SpecParseError(`${where}: table ${schema}.${name} is defined twice`);
      tables.set(`${schema}.${name}`, t);
      blockTables.push(t);
    }
    if (blockTables.length === 0) throw new SpecParseError(`${where}: no backticked table name`);

    // The block's Field | Type | Notes table: the first table line after the heading.
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
    if (!/^\| Field \| Type \| Notes \|/.test(lines[j] ?? '')) throw new SpecParseError(`${where}: no "| Field | Type | Notes |" table under it`);
    j += 2; // header and separator
    let current: SpecTable | undefined = blockTables.length === 1 ? blockTables[0] : undefined;
    for (; j < lines.length && (lines[j] ?? '').startsWith('|'); j++) {
      const line = lines[j] ?? '';
      const [field, typeCell, notes] = cells(line);
      const rowWhere = `section 3 row "${line.slice(0, 90)}"`;
      const rawNames = ticks(field ?? '');
      if (rawNames.length === 0) {
        // A table-level row such as "| Grant | — | ... |": no column.
        if ((typeCell ?? '').trim() !== '—') throw new SpecParseError(`${rowWhere}: a row with no backticked field must have Type "—"`);
        continue;
      }
      const names: string[] = [];
      let rowTable: SpecTable | undefined;
      for (const raw of rawNames) {
        let col = raw;
        if (raw.includes('.')) {
          const [prefix, c] = raw.split('.') as [string, string];
          const t = blockTables.find((b) => b.name === prefix);
          if (!t) throw new SpecParseError(`${rowWhere}: \`${raw}\` names a table this heading does not`);
          if (rowTable && rowTable !== t) throw new SpecParseError(`${rowWhere}: 1 row names 2 tables`);
          current = t;
          col = c;
        }
        if (!current) throw new SpecParseError(`${rowWhere}: \`${raw}\` has no table (qualify it as table.column)`);
        rowTable = current;
        names.push(col);
      }
      const table = rowTable as SpecTable;
      const types = parseTypes(typeCell ?? '', rowWhere);
      if (types.length !== names.length && types.length !== 1) {
        throw new SpecParseError(`${rowWhere}: ${names.length} names but ${types.length} types`);
      }
      const zone = /zone: (branch|customer)\b/.exec(notes ?? '')?.[1] as 'branch' | 'customer' | undefined;
      names.forEach((name, k) => {
        const ty = (types.length === 1 ? types[0] : types[k]) as TypeItem;
        if (table.columns.has(name)) throw new SpecParseError(`${rowWhere}: column ${table.name}.${name} is defined twice`);
        table.columns.set(name, { name, type: ty.type, nullable: ty.nullable, unique: ty.unique, zoneNote: zone ?? null });
      });
      for (const m of (notes ?? '').matchAll(/`(\w+)` references `(\w+)\.(\w+)`/g)) {
        if (!names.includes(m[1] ?? '')) throw new SpecParseError(`${rowWhere}: references note names a column not on the row`);
        table.references.set(m[1] ?? '', `${table.schema}.${m[2]}.${m[3]}`);
      }
      const bare = /(?:^|\. )References `(\w+)\.(\w+)`/.exec(notes ?? '');
      if (bare) {
        if (names.length !== 1) throw new SpecParseError(`${rowWhere}: a bare "References" note needs a 1-name row`);
        table.references.set(names[0] ?? '', `${table.schema}.${bare[1]}.${bare[2]}`);
      }
      if (/^\s*Primary key\b/.test(notes ?? '')) pendingKeys.push({ table, names, note: notes ?? '', where: rowWhere });
    }
  }

  for (const p of pendingKeys) {
    if (p.table.primaryKey.length > 0) throw new SpecParseError(`${p.where}: a second primary key for ${p.table.name}`);
    p.table.primaryKey = primaryKeyOf(p);
  }
  for (const t of tables.values()) {
    if (t.primaryKey.length === 0 && t.columns.has('id')) t.primaryKey = ['id'];
    if (t.columns.size === 0) throw new SpecParseError(`table ${t.schema}.${t.name} has no columns`);
  }

  const views: string[] = [];
  const view = /\*\*Projection view\.\*\* `(\w+)` is a view/.exec(s3);
  if (view) views.push(`world.${view[1]}`);
  return { tables, views, schemas: [...schemas].sort() };
}

// ---- Foreign keys: the "Nullability and keys" rules -------------------------------------------------------------

/** Reference-shaped world columns that name no single table, so they carry no constraint. */
export const UNCONSTRAINED_REFERENCES: Readonly<Record<string, string>> = {
  'world.import_problem_row.flagged_entity_id': 'the imported, flagged record: a customer, a visit or equipment',
  'world.van_track.build_id': 'the pinned map bake (D7), a file-level id with no table',
  'world.time_block_change.block_id': 'the moved block: a deleted block keeps its history, so no constraint',
};

/** Expected single-column foreign keys: "schema.table.column" -> "schema.table.column". */
export function expectedForeignKeys(model: SpecModel): Map<string, string> {
  const out = new Map<string, string>();
  const has = (t: string) => model.tables.has(`world.${t}`);
  for (const t of model.tables.values()) {
    for (const c of t.columns.values()) {
      const from = `${t.schema}.${t.name}.${c.name}`;
      const explicit = t.references.get(c.name);
      if (explicit) { out.set(from, explicit); continue; }
      if (t.schema === 'pbs' && t.name === 'invoice_line' && c.name === 'job_number') { out.set(from, 'pbs.invoice.job_number'); continue; }
      if (t.schema !== 'world') continue; // system and pbs columns naming a world row are plain values (SD-12)
      if (UNCONSTRAINED_REFERENCES[from]) continue;
      if (c.name === 'job_number') { if (t.name !== 'job') out.set(from, 'world.job.job_number'); continue; }
      if (c.name === 'item_key') { out.set(from, 'world.tech_item.key'); continue; }
      if (['actor_user_id', 'author_user_id', 'user_id', 'manager_id'].includes(c.name) || c.name.endsWith('_by')) {
        out.set(from, 'world.user.id'); continue;
      }
      if (c.name.endsWith('_id') && has(c.name.slice(0, -3))) { out.set(from, `world.${c.name.slice(0, -3)}.id`); continue; }
      if (c.name.endsWith('_id') && c.name !== 'id') {
        throw new SpecParseError(`${from}: a reference column no rule resolves; give it a references note in section 3 or add it to UNCONSTRAINED_REFERENCES`);
      }
    }
  }
  for (const [from, to] of out) {
    const [s, tb, col] = to.split('.') as [string, string, string];
    const target = model.tables.get(`${s}.${tb}`);
    if (!target?.columns.has(col)) throw new SpecParseError(`${from} references ${to}, which section 3 does not define`);
  }
  return out;
}
