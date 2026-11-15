// SPDX-License-Identifier: AGPL-3.0-or-later
// The test database's waits are bounded and its plans stable (F-314): a query left running on a file's shared
// connection by a test that timed out cannot make every later test of the file wait behind it; every session on a test
// database carries a lock and a statement bound, whoever connects (a test's client, the code under test as bw_web, a
// child process); and no background autovacuum rewrites a table's statistics in the middle of a test.
import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../client.ts';
import { createDatabase, TEST_LOCK_TIMEOUT, TEST_STATEMENT_TIMEOUT } from './database.ts';
import { useMigratedDatabase } from './fixture.ts';
import { pgAdminUrl } from './provided.ts';

const db = useMigratedDatabase();

async function settings(url: string): Promise<{ lock: string; statement: string }> {
  const c = createClient({ connectionString: url });
  await c.connect();
  try {
    const lock = (await c.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0]?.lock_timeout ?? '';
    const statement = (await c.query<{ statement_timeout: string }>('SHOW statement_timeout')).rows[0]?.statement_timeout ?? '';
    return { lock, statement };
  } finally {
    await c.end();
  }
}

describe('bounded waits and stable plans on a test database', () => {
  // why: F-314
  it("refuses a query on the file's shared connection while an earlier one is still in flight, naming it, then serves the next", async () => {
    const side = createClient({ connectionString: db.url() });
    await side.connect();
    let first: Promise<unknown> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      await side.query('BEGIN');
      await side.query('LOCK TABLE world.branch IN ACCESS EXCLUSIVE MODE');
      // the earlier query waits on the side connection's lock, as a query a timed-out test left behind would
      first = db.admin().query('SELECT count(*) AS n FROM world.branch');
      first.catch(() => undefined);
      const second = db.admin().query('SELECT 1 AS one');
      const outcome = await Promise.race([
        second.then(() => 'ran', (e: unknown) => `refused: ${(e as Error).message}`),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve('queued behind the earlier query'), 2000); }),
      ]);
      expect(outcome).toMatch(/^refused: the file's shared database connection is still running an earlier query .*SELECT count\(\*\) AS n FROM world\.branch/);
    } finally {
      clearTimeout(timer);
      await side.query('ROLLBACK');
      await side.end();
    }
    await first;
    expect((await db.admin().query<{ one: number }>('SELECT 1 AS one')).rows[0]?.one).toBe(1);
  });

  // why: F-314
  it.skipIf(Boolean(process.env.BW_TEST_PG_URL))('runs the embedded test server with autovacuum off, so a table keeps the statistics a test or the code under test gave it', async () => {
    const r = await db.admin().query<{ autovacuum: string }>('SHOW autovacuum');
    expect(r.rows[0]?.autovacuum).toBe('off');
  });

  // why: F-314
  it('gives every session on the database the lock and statement bounds, as the schema owner and as the web login', async () => {
    const want = { lock: TEST_LOCK_TIMEOUT, statement: TEST_STATEMENT_TIMEOUT };
    expect(await settings(db.url())).toEqual(want);
    const web = new URL(db.url());
    web.username = 'bw_web';
    expect(await settings(web.toString())).toEqual(want);
  });
});

/** The databases' names on the server whose name is `name`: 1 when it exists, 0 once dropped. */
async function exists(name: string): Promise<number> {
  const c = createClient({ connectionString: pgAdminUrl() });
  await c.connect();
  try {
    return (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_database WHERE datname = $1', [name])).rows[0]?.n ?? -1;
  } finally {
    await c.end();
  }
}

describe("a test database's drop at the end of its file (F-916)", () => {
  // why: F-916 (G-CI9 red on an uncaught 57P01 after every test passed: a pool's ended connection was still on its way out)
  it('waits for a session that is closing and never terminates it, so its client sees no 57P01', async () => {
    const t = await createDatabase(pgAdminUrl());
    const c = createClient({ connectionString: t.url });
    const errors: string[] = [];
    c.on('error', (e) => errors.push(String((e as { code?: string }).code ?? e.message)));
    await c.connect();
    // The session ends 300 ms after the drop begins, as a backend that reads its Terminate late on a loaded rig does.
    const closing = new Promise<void>((resolve) => setTimeout(() => void c.end().then(resolve, resolve), 300));
    await t.drop();
    await closing;
    expect(errors, 'the closing session was not terminated').toEqual([]);
    expect(await exists(t.name)).toBe(0);
  });

  // why: F-916 (a connection a test never closes still cannot hold its database: after PostgreSQL's own wait the drop terminates it)
  it('still drops the database past a session that never closes, terminating that session (57P01 names the leak)', async () => {
    const t = await createDatabase(pgAdminUrl());
    const c = createClient({ connectionString: t.url });
    const errors: string[] = [];
    c.on('error', (e) => errors.push(String((e as { code?: string }).code ?? e.message)));
    await c.connect();
    try {
      await t.drop();
      await vi.waitFor(() => expect(errors).toContain('57P01'), { timeout: 5_000, interval: 20 });
      expect(await exists(t.name)).toBe(0);
    } finally {
      await c.end().catch(() => undefined);
    }
  });
});
