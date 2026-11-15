// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: SD-2 (the repository layer's SQL, checked on a recording Queryable: names quoted from the declared list,
// values only as parameters, access per entity)
import { describe, expect, it } from 'vitest';
import type { Queryable } from './client.ts';
import { appendOnlyRepository, mutableRepository, readOnlyRepository } from './repository.ts';

interface Thing { id: string; tags: unknown; note: string | null; end: Date }

function recorder(rows: unknown[] = [{}]): { db: Queryable; calls: { text: string; values: unknown[] }[] } {
  const calls: { text: string; values: unknown[] }[] = [];
  const db: Queryable = {
    query: async <R>(text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: rows as R[], rowCount: rows.length };
    },
  };
  return { db, calls };
}

const def = { schema: 'world', table: 'thing', columns: ['id', 'tags', 'note', 'end'], key: ['id'], json: ['tags'] } as const;
const things = mutableRepository<Thing, Thing, 'id'>({ ...def, columns: [...def.columns], key: [...def.key], json: [...def.json] });

describe('mutableRepository SQL', () => {
  it('inserts with quoted names and numbered parameters, sending jsonb values as JSON text', async () => {
    const { db, calls } = recorder();
    await things.insert(db, { id: 'a', tags: ['x', 'y'], note: null, end: new Date(0) });
    expect(calls[0]?.text).toBe('INSERT INTO "world"."thing" ("id", "tags", "note", "end") VALUES ($1, $2, $3, $4) RETURNING *');
    expect(calls[0]?.values).toEqual(['a', '["x","y"]', null, new Date(0)]);
  });

  it('finds with equality and IS NULL, ordered and limited, optionally FOR UPDATE', async () => {
    const { db, calls } = recorder([]);
    await things.find(db, { note: null, id: 'a' }, { orderBy: [['end', 'desc']], limit: 5, forUpdate: true });
    expect(calls[0]?.text).toBe('SELECT * FROM "world"."thing" WHERE "note" IS NULL AND "id" = $1 ORDER BY "end" DESC LIMIT 5 FOR UPDATE');
    expect(calls[0]?.values).toEqual(['a']);
  });

  it('updates the patch on the rows named, and refuses an update or remove that names no row', async () => {
    const { db, calls } = recorder();
    await things.update(db, { id: 'a' }, { note: 'n' });
    expect(calls[0]?.text).toBe('UPDATE "world"."thing" SET "note" = $1 WHERE "id" = $2 RETURNING *');
    expect(calls[0]?.values).toEqual(['n', 'a']);
    await expect(things.update(db, {}, { note: 'n' })).rejects.toThrow(/names no row/);
    await expect(things.remove(db, {})).rejects.toThrow(/names no row/);
    await expect(things.update(db, { id: 'a' }, {})).rejects.toThrow(/sets no column/);
  });

  it('refuses a column name it does not declare, before any SQL is sent', async () => {
    const { db, calls } = recorder();
    await expect(things.find(db, { ['id" OR 1=1 --' as 'id']: 'x' })).rejects.toThrow(/has no column/);
    await expect(things.find(db, {}, { limit: 1.5 })).rejects.toThrow(/whole number/);
    expect(calls).toEqual([]);
  });

  it('gets by the whole primary key and refuses a missing key column', async () => {
    const { db, calls } = recorder([]);
    expect(await things.get(db, { id: 'a' })).toBeNull();
    expect(calls[0]?.text).toBe('SELECT * FROM "world"."thing" WHERE "id" = $1');
    await expect(things.get(db, {} as { id: string })).rejects.toThrow(/key column id is missing/);
  });
});

describe('access per entity', () => {
  it('gives an append-only entity insert and reads only, and a read-only one reads only', () => {
    const log = appendOnlyRepository<Thing, Thing, 'id'>({ ...things.def });
    const view = readOnlyRepository<Thing>({ ...things.def, key: [] });
    expect(Object.keys(log).sort()).toEqual(['def', 'find', 'get', 'insert']);
    expect(Object.keys(view).sort()).toEqual(['def', 'find', 'get']);
    expect([things.def.access, log.def.access, view.def.access]).toEqual(['mutable', 'append-only', 'read-only']);
  });
});
