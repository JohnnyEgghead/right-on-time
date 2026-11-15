// SPDX-License-Identifier: AGPL-3.0-or-later
// A fresh, empty database per test file (or per gate case) on 1 shared PostgreSQL 18 server, so files run in
// parallel without seeing each other's rows. Roles are cluster-wide; migration 0001 tolerates a concurrent create.
//
// Every wait on a test database is bounded (F-314). The database itself carries lock_timeout and statement_timeout
// (ALTER DATABASE ... SET), so every session that connects to it gets them: the test's own clients, the code under
// test (the import's pools as bw_web), and the child processes a test starts (pnpm run setup, the gate CLI). A lock
// wait or a statement that never ends then fails with PostgreSQL's own error (55P03 lock timeout, 57014 statement
// timeout) instead of holding a test, and every later test of its file, to vitest's timeout. The bounds sit far above
// the slowest statement measured (a 5,000-row insert or a whole-table fingerprint: seconds on the loaded Spectre
// container; F-325: the slowest non-trap statement sampled was 8 s, an INSERT INTO world.past_visit, in the F-314 gate
// repro run, .build/evidence/F-314/gate-repro-iter1-pg-activity.log, 10 s pg_stat_activity samples, so 50 s is about
// 6 times that maximum, and a 57014 red means a new trap, not a slow statement) and below the 60 s / 180 s test timeouts of the gates that use these databases, so the statement's own
// error is what a test reports.
import { randomUUID } from 'node:crypto';
import { createClient } from '../client.ts';

/** Longest a statement may wait for a lock on a test database. */
export const TEST_LOCK_TIMEOUT = '30s';
/** Longest a statement may run on a test database (a lock wait counts toward it). */
export const TEST_STATEMENT_TIMEOUT = '50s';

export interface TestDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

function withDatabase(adminUrl: string, name: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
}

async function admin<T>(adminUrl: string, fn: (c: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const c = createClient({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function createDatabase(adminUrl: string, prefix = 'bw_t'): Promise<TestDatabase> {
  const name = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await admin(adminUrl, async (c) => {
    await c.query(`CREATE DATABASE "${name}"`);
    await c.query(`ALTER DATABASE "${name}" SET lock_timeout = '${TEST_LOCK_TIMEOUT}'`);
    await c.query(`ALTER DATABASE "${name}" SET statement_timeout = '${TEST_STATEMENT_TIMEOUT}'`);
  });
  return {
    name,
    url: withDatabase(adminUrl, name),
    drop: () => admin(adminUrl, (c) => dropDatabase(c, name)),
  };
}

/**
 * F-916: a file's pools are ended before its database is dropped, but pg-pool's end() resolves once it has sent Terminate to
 * its idle connections, not once their backends have exited. On a loaded rig a backend can still be waiting for the CPU to
 * read that Terminate when the drop comes; WITH (FORCE) then makes it send FATAL 57P01 to a client its pool has already let
 * go, whose error reaches the pool's idle listener and a pool with no error listener: an uncaught error, and a red run after
 * every test passed (measured: .build/evidence/F-916/). So the plain DROP comes first: PostgreSQL itself waits up to 5 s for
 * the database's other sessions to end. Only a session still there after that, a connection a test never closed, is
 * terminated by WITH (FORCE), as before (and its 57P01 still names the leak).
 */
async function dropDatabase(c: ReturnType<typeof createClient>, name: string): Promise<void> {
  try {
    await c.query(`DROP DATABASE IF EXISTS "${name}"`);
  } catch (e) {
    if ((e as { code?: string }).code !== '55006') throw e; // object_in_use: "database is being accessed by other users"
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
}
