// SPDX-License-Identifier: AGPL-3.0-or-later
// Migration 0019 (F-864): world.time_block_change.actor_user_id references world.user.id, as SPECIFICATIONS section 3's
// "Nullability and keys" rule says, with the column still nullable and block_id still a plain value.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { errorCode, seedReference, useMigratedDatabase } from './testing/fixture.ts';

const db = useMigratedDatabase();
const attempt = async (q: ReturnType<typeof db.admin>, sql: string, v: unknown[]) => errorCode(q.query(sql, v));
let userId = '';
const BLOCK = '019a0000-0000-7000-8000-000000000001';
const GHOST = '019a0000-0000-7000-8000-0000000000ff';
const insert = `INSERT INTO world.time_block_change (block_id, at, actor_user_id, actor_kind, kind, from_version, to_version, data)
  VALUES ($1, now(), $2, 'office', 'moved', 1, 2, '{}')`;
const sql0019 = () => readFileSync(new URL('../migrations/0019_time_block_change_actor_fk.sql', import.meta.url), 'utf8');

describe('time_block_change.actor_user_id key (F-864)', () => {
  // why: F-864: the key is the point of 0019: an actor naming no user is refused, a real user, null and a block with no row are not
  it('refuses an actor that names no user, and allows a real user, a null actor and a block that does not exist', async () => {
    userId = (await seedReference(db.admin())).userId;
    expect(await attempt(db.admin(), insert, [BLOCK, GHOST])).toBe('23503');
    expect(await attempt(db.admin(), insert, [BLOCK, userId])).toBe('no error');
    expect(await attempt(db.admin(), insert, [BLOCK, null])).toBe('no error');
  });

  // why: F-864: the migration's own clean-up: a live row with an orphan actor keeps its history row and the id it named
  it('migration 0019 keeps an orphan row, nulls its actor and records the id in data; valid rows stay as they are', async () => {
    await db.admin().query('DELETE FROM world.time_block_change');
    await db.admin().query('ALTER TABLE world.time_block_change DROP CONSTRAINT time_block_change_actor_user_id_fkey');
    await db.admin().query(insert, [BLOCK, GHOST]);
    await db.admin().query(insert, [BLOCK, userId]);
    await db.admin().query(sql0019());
    const rows = await db.admin().query<{ actor_user_id: string | null; data: Record<string, string> }>(
      `SELECT actor_user_id, data FROM world.time_block_change WHERE actor_user_id IS NULL AND data ? 'unresolved_actor_user_id'`);
    expect(rows.rows).toEqual([{ actor_user_id: null, data: { unresolved_actor_user_id: GHOST } }]);
    const kept = await db.admin().query<{ n: string }>(`SELECT count(*) AS n FROM world.time_block_change WHERE actor_user_id = $1`, [userId]);
    expect(Number(kept.rows[0]?.n)).toBe(1);
    expect(await attempt(db.admin(), insert, [BLOCK, GHOST])).toBe('23503');
  });
});
