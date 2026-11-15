// SPDX-License-Identifier: AGPL-3.0-or-later
// The repository pattern of @bw/db (SPECIFICATIONS SD-2: 1 repository module per entity). Each module in
// src/repositories declares its table once (columns, key, access) and gets typed, parameterized SQL from here.
//
// Access mirrors the database grants of role app (migration 0007), so the type system refuses what the database
// would: an append-only history log (section 3 stores table) has no update or remove, a read-only entity
// (membership, report_visit) has no insert either. Names only ever come from the declared column list, quoted;
// values only ever travel as parameters, so no caller string reaches SQL text.
import type { Queryable } from './client.ts';

export type Access = 'mutable' | 'append-only' | 'read-only';

export interface TableDef<R extends object, K extends keyof R & string> {
  schema: 'world' | 'pbs' | 'system';
  table: string;
  /** Every column, in table order. */
  columns: readonly (keyof R & string)[];
  /** The primary key; empty for a table section 3 gives none. */
  key: readonly K[];
  /** jsonb columns: their values are sent as JSON text (pg would send a JavaScript array as a SQL array). */
  json: readonly (keyof R & string)[];
  /** A 1-row table: update may name no row. */
  singleton?: boolean;
}

export interface FindOptions<R> {
  orderBy?: readonly (readonly [keyof R & string, 'asc' | 'desc'])[];
  limit?: number;
  forUpdate?: boolean;
}

export type Where<R> = { [C in keyof R]?: R[C] };

export interface ReadRepository<R extends object, K extends keyof R & string> {
  readonly def: TableDef<R, K> & { access: Access };
  /** Rows equal to every given column (null matches IS NULL). */
  find(db: Queryable, where?: Where<R>, opts?: FindOptions<R>): Promise<R[]>;
  /** The row with this primary key, or null. */
  get(db: Queryable, key: Pick<R, K>, opts?: { forUpdate?: boolean }): Promise<R | null>;
}

export interface AppendRepository<R extends object, I, K extends keyof R & string> extends ReadRepository<R, K> {
  insert(db: Queryable, row: I): Promise<R>;
}

export interface MutableRepository<R extends object, I, K extends keyof R & string> extends AppendRepository<R, I, K> {
  /** Set the patch on every row equal to where; returns the changed rows. */
  update(db: Queryable, where: Where<R>, patch: Where<R>): Promise<R[]>;
  /** Delete every row equal to where; returns how many. */
  remove(db: Queryable, where: Where<R>): Promise<number>;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

function sqlParts<R extends object>(def: TableDef<R, keyof R & string>) {
  const known = new Set<string>(def.columns);
  const json = new Set<string>(def.json);
  const target = `${ident(def.schema)}.${ident(def.table)}`;
  const check = (c: string) => {
    if (!known.has(c)) throw new Error(`${def.schema}.${def.table} has no column ${c}`);
    return ident(c);
  };
  const value = (c: string, v: unknown) => (json.has(c) && v !== null ? JSON.stringify(v) : v);
  const entries = (o: object) => Object.entries(o).filter(([, v]) => v !== undefined);
  const whereSql = (where: object, values: unknown[]) => {
    const parts = entries(where).map(([c, v]) => {
      const col = check(c);
      if (v === null) return `${col} IS NULL`;
      values.push(value(c, v));
      return `${col} = $${values.length}`;
    });
    return parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '';
  };
  return { target, check, value, entries, whereSql };
}

function readRepo<R extends object, K extends keyof R & string>(def: TableDef<R, K>, access: Access): ReadRepository<R, K> {
  const p = sqlParts(def as TableDef<R, keyof R & string>);
  const find = async (db: Queryable, where: Where<R> = {}, opts: FindOptions<R> = {}) => {
    const values: unknown[] = [];
    let sql = `SELECT * FROM ${p.target}${p.whereSql(where, values)}`;
    if (opts.orderBy?.length) sql += ` ORDER BY ${opts.orderBy.map(([c, d]) => `${p.check(c)} ${d === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`;
    if (opts.limit !== undefined) {
      if (!Number.isInteger(opts.limit) || opts.limit < 0) throw new Error(`limit must be a whole number, got ${opts.limit}`);
      sql += ` LIMIT ${opts.limit}`;
    }
    if (opts.forUpdate) sql += ' FOR UPDATE';
    return (await db.query<R>(sql, values)).rows;
  };
  return {
    def: { ...def, access },
    find,
    async get(db, key, opts = {}) {
      if (def.key.length === 0) throw new Error(`${def.schema}.${def.table} has no primary key; use find`);
      const where: Where<R> = {};
      for (const k of def.key) {
        if (key[k] === undefined || key[k] === null) throw new Error(`${def.schema}.${def.table} key column ${k} is missing`);
        where[k] = key[k];
      }
      const rows = await find(db, where, opts.forUpdate ? { forUpdate: true } : {});
      return rows[0] ?? null;
    },
  };
}

function insertFn<R extends object, I, K extends keyof R & string>(def: TableDef<R, K>) {
  const p = sqlParts(def as TableDef<R, keyof R & string>);
  return async (db: Queryable, row: I): Promise<R> => {
    const pairs = p.entries(row as object);
    const values = pairs.map(([c, v]) => p.value(c, v));
    const sql = pairs.length === 0
      ? `INSERT INTO ${p.target} DEFAULT VALUES RETURNING *`
      : `INSERT INTO ${p.target} (${pairs.map(([c]) => p.check(c)).join(', ')}) VALUES (${pairs.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`;
    const out = (await db.query<R>(sql, values)).rows[0];
    if (!out) throw new Error(`insert into ${def.schema}.${def.table} returned no row`);
    return out;
  };
}

export function readOnlyRepository<R extends object, K extends keyof R & string = never>(def: TableDef<R, K>): ReadRepository<R, K> {
  return readRepo(def, 'read-only');
}

export function appendOnlyRepository<R extends object, I, K extends keyof R & string = never>(def: TableDef<R, K>): AppendRepository<R, I, K> {
  return { ...readRepo(def, 'append-only'), insert: insertFn<R, I, K>(def) };
}

export function mutableRepository<R extends object, I, K extends keyof R & string = never>(def: TableDef<R, K>): MutableRepository<R, I, K> {
  const p = sqlParts(def as TableDef<R, keyof R & string>);
  const needsWhere = (where: object, verb: string) => {
    if (p.entries(where).length === 0 && !def.singleton) throw new Error(`${verb} on ${def.schema}.${def.table} names no row`);
  };
  return {
    ...readRepo(def, 'mutable'),
    insert: insertFn<R, I, K>(def),
    async update(db, where, patch) {
      needsWhere(where, 'update');
      const sets = p.entries(patch);
      if (sets.length === 0) throw new Error(`update on ${def.schema}.${def.table} sets no column`);
      const values: unknown[] = sets.map(([c, v]) => p.value(c, v));
      const setSql = sets.map(([c], i) => `${p.check(c)} = $${i + 1}`).join(', ');
      const sql = `UPDATE ${p.target} SET ${setSql}${p.whereSql(where, values)} RETURNING *`;
      return (await db.query<R>(sql, values)).rows;
    },
    async remove(db, where) {
      needsWhere(where, 'remove');
      const values: unknown[] = [];
      const r = await db.query(`DELETE FROM ${p.target}${p.whereSql(where, values)}`, values);
      return r.rowCount ?? 0;
    },
  };
}
