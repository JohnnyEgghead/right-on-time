// SPDX-License-Identifier: AGPL-3.0-or-later
// The database connection surface of @bw/db (SPECIFICATIONS SD-2: migrations and 1 repository module per entity).
// Repositories take a Queryable, so the caller owns the transaction: the handler kernel's 1 transaction (SD-6)
// passes its client, and every repository call inside it joins that transaction.
import pg from 'pg';

export type Row = Record<string, unknown>;

export interface QueryResultLike<R> {
  rows: R[];
  rowCount: number | null;
}

/** What a repository needs: pg.Client, pg.PoolClient and pg.Pool all satisfy it. */
export interface Queryable {
  query<R = Row>(text: string, values?: unknown[]): Promise<QueryResultLike<R>>;
}

const DATE_OID = 1082;

/**
 * Type parsers for every @bw/db connection. `date` stays the text 'YYYY-MM-DD': a local date in its row's zone
 * (invariant 4), never a JavaScript Date at the server process's midnight. Everything else keeps pg's defaults
 * (timestamptz to Date, bigint and numeric to string, jsonb parsed, arrays to arrays).
 */
export const pgTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary'): (value: string) => unknown {
    if (oid === DATE_OID && format !== 'binary') return (value: string) => value;
    return pg.types.getTypeParser(oid, format as 'text');
  },
};

export function createPool(config: Omit<pg.PoolConfig, 'types'>): pg.Pool {
  return new pg.Pool({ ...config, types: pgTypes as pg.CustomTypesConfig });
}

export function createClient(config: Omit<pg.ClientConfig, 'types'>): pg.Client {
  return new pg.Client({ ...config, types: pgTypes as pg.CustomTypesConfig });
}

/** Run fn inside 1 transaction on a pool client; commit on success, roll back and rethrow on any error. */
export async function inTransaction<T>(pool: pg.Pool, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client as unknown as Queryable);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
