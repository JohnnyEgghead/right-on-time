// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1934, FR-AUTH-12 (2 managers who act on each other at once never leave the world with no active manager)
// API-151, API-152 and API-170 on the real database (PostgreSQL 18, the migrated schema, the reference seed), through the production kernel
// as bw_web. Interleavings are forced by a row lock the test holds, never by a sleep: a step waits until the call is seen waiting for a lock
// (or is done, which is what code that takes no such lock does). Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts).
import { createClient, createPool, type Queryable } from '@bw/db';
import { realNow, type RealTimeUse } from '@bw/time';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { sessionCookie, SqlSessionStore, startSession } from '../kernel/sessions.ts';
import { loginUrl, officeWorld, ORIGIN, type OfficeWorld } from '../office-writes/testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let web: ReturnType<typeof createPool>;

beforeAll(async () => {
  world = await officeWorld(db, 1);
  web = createPool({ connectionString: loginUrl(db.url(), 'bw_web'), max: 2 });
}, 120_000);
afterAll(async () => {
  await web?.end();
  await world?.close();
});

const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
/** Backends of this database waiting for a lock right now. */
const waiting = async () => Number((await rows<{ n: string }>(
  `SELECT count(DISTINCT l.pid) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.datname = current_database() AND NOT l.granted`))[0]!.n);
async function until(what: string, cond: () => Promise<boolean>): Promise<void> {
  const stop = performance.now() + 20_000;
  while (!(await cond())) if (performance.now() > stop) throw new Error(`timed out waiting for ${what}`);
}
/** A connection of the test's own, in a transaction, for the lock it holds. */
async function holder(): Promise<Queryable & { end(): Promise<void> }> {
  const c = createClient({ connectionString: db.url() });
  await c.connect();
  await c.query('BEGIN');
  return c as unknown as Queryable & { end(): Promise<void> };
}

type Person = { id: string; cookie: string };
let people = 0;
async function person(role: 'manager' | 'office', status = 'active'): Promise<Person> {
  const n = ++people;
  const id = (await rows<{ id: string }>(
    `INSERT INTO world."user" (email, name, name_search, password_hash, role, branch_id, language, status, employee_number, title, sample, reviewer)
     VALUES ($1, $2, lower($2), NULL, $3, 'columbus', 'en', $4, NULL, NULL, false, false) RETURNING id`, [`person.${n}@brightwater.example`, `Person ${n}`, role, status]))[0]!.id;
  const clock = { realNow: (use: RealTimeUse) => (use === 'session_idle' ? realNow('session_idle') : realNow('session_lifetime')) };
  const token = await startSession(new SqlSessionStore(web), clock, { userId: id, role }, { client: 'web', via: 'password', keepSignedIn: false });
  return { id, cookie: sessionCookie(token, false, false).split(';')[0] as string };
}
/** The world's only 2 active managers, each signed in. */
async function twoManagers(): Promise<[Person, Person]> {
  await rows(`UPDATE world."user" SET role = 'office' WHERE role = 'manager'`);
  return [await person('manager'), await person('manager')];
}
const activeManagers = async () => Number((await rows<{ n: string }>(`SELECT count(*) AS n FROM world."user" WHERE role = 'manager' AND status = 'active'`))[0]!.n);

async function send(method: string, path: string, body: unknown, by: Person): Promise<string> {
  const r = await world.kernel.router.handle(new Request(`http://web:3000/api/v1/users/${path}`, {
    method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: by.cookie },
  }), { address: '203.0.113.9' });
  return r.status < 300 ? `${r.status}` : `${r.status} ${((await r.json()) as { code: string }).code}`;
}
const acts = {
  'turn off': (by: Person, on: Person) => send('POST', `${on.id}/turn-off`, {}, by),
  demote: (by: Person, on: Person) => send('PUT', `${on.id}/role`, { role: 'office' }, by),
  'turn on': (by: Person, on: Person) => send('POST', `${on.id}/turn-on`, {}, by),
};
function started(p: Promise<string>): { done: boolean; answer: Promise<string> } {
  const s = { done: false, answer: p };
  s.answer = p.finally(() => { s.done = true; });
  return s;
}

describe('2 managers who act on each other at once (F-1934)', () => {
  // why: F-1934 of 2 managers who turn off or demote each other at once exactly 1 passes and the other is answered as a caller who is no manager, so an active manager is left; the held row puts both calls past their session check first
  it.each([
    ['turn off', 'turn off', 0], ['turn off', 'turn off', 1], ['turn off', 'demote', 0], ['turn off', 'demote', 1], ['demote', 'demote', 0], ['demote', 'demote', 1],
  ] as const)('manager 0 does %s, manager 1 does %s, the row of manager %i held: exactly 1 passes', async (x, y, held) => {
    const m = await twoManagers();
    const act = [acts[x], acts[y]] as const;
    const other = (1 - held) as 0 | 1;
    const lock = await holder();
    try {
      // KEY SHARE stops the FOR UPDATE that a change of the held manager needs, and stops no reference to them.
      await lock.query(`SELECT 1 FROM world."user" WHERE id = $1 FOR KEY SHARE`, [m[held].id]);
      const onHeld = started(act[other](m[other], m[held]));
      await until('the change of the held manager to wait', async () => onHeld.done || (await waiting()) >= 1);
      const byHeld = started(act[held](m[held], m[other]));
      await until('the other change to wait or be done', async () => byHeld.done || (await waiting()) >= 2);
      await lock.query('COMMIT');
      expect([await onHeld.answer, await byHeld.answer].sort()).toEqual(['200', '403 forbidden']);
      expect(await activeManagers()).toBe(1);
    } finally {
      await lock.end();
    }
  });

  // why: F-1934 every write that reads its target through the same lock is covered: turning a user back on is refused to a caller who stopped being an active manager while the call waited
  it.each([['demoted', `role = 'office'`], ['turned off', `status = 'turned_off', status_before_off = 'active'`]])('refuses Turn back on to a manager %s meanwhile', async (_name, change) => {
    const m = await twoManagers();
    const off = await person('office', 'turned_off');
    const lock = await holder();
    try {
      await lock.query(`SELECT 1 FROM world."user" WHERE id = $1 FOR UPDATE`, [off.id]);
      await lock.query(`UPDATE world."user" SET ${change} WHERE id = $1`, [m[0].id]);
      const on = started(acts['turn on'](m[0], off));
      await until('the call to wait', async () => on.done || (await waiting()) >= 1);
      await lock.query('COMMIT');
      expect(await on.answer).toBe('403 forbidden');
      expect((await rows<{ status: string }>(`SELECT status FROM world."user" WHERE id = $1`, [off.id]))[0]!.status).toBe('turned_off');
    } finally {
      await lock.end();
    }
  });

  // why: F-1934 1 manager's ordinary change of another is as before, and so are the refusals for their own row, an unknown user and a state the change does not fit
  it('leaves an ordinary change of another manager unchanged', async () => {
    const [a, b] = await twoManagers();
    expect(await acts['turn off'](a, b)).toBe('200');
    expect(await acts['turn off'](a, b)).toBe('409 rule_refused');
    expect(await acts['turn on'](a, b)).toBe('200');
    expect(await acts['turn on'](a, b)).toBe('409 rule_refused');
    expect(await acts.demote(a, b)).toBe('200');
    expect(await acts.demote(a, b)).toBe('409 rule_refused');
    expect(await acts['turn off'](a, a)).toBe('409 rule_refused');
    expect(await acts.demote(a, a)).toBe('409 rule_refused');
    expect(await acts['turn off'](a, { ...b, id: '00000000-0000-4000-8000-000000000000' })).toBe('404 not_found');
    expect(await activeManagers()).toBe(1);
  });

  // why: FR-AUTH-1 K-07 F-2013 a session cookie issued while its owner was a manager loses the manager rights the moment the role is changed, since the role is read live (a read route that checks no role of its own)
  it('refuses a demoted manager\'s old cookie on a manager route, with no new sign-in', async () => {
    const [a, b] = await twoManagers();
    const search = async (by: Person) => (await world.kernel.router.handle(new Request('http://web:3000/api/v1/user-searches', {
      method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: by.cookie },
    }), { address: '203.0.113.9' })).status;
    expect(await search(b)).toBe(200);
    expect(await acts.demote(a, b)).toBe('200');
    expect(await search(b)).toBe(403);
    expect(await search(a)).toBe(200);
    expect(await acts['turn off'](b, a)).toBe('403 forbidden');
    expect(await activeManagers()).toBe(1);
  });

  // why: F-1934 2 managers who change the same third person at once, and 1 manager who changes 2 people at once, never deadlock
  it('deadlocks no pair that shares a target or a caller', async () => {
    const [a, b] = await twoManagers();
    const [c, d] = [await person('office'), await person('office')];
    const lock = await holder();
    try {
      await lock.query(`SELECT 1 FROM world."user" WHERE id = ANY($1::uuid[]) FOR KEY SHARE`, [[c.id, d.id]]);
      const going = [acts['turn off'](a, c), acts['turn off'](a, d), acts.demote(b, c), acts['turn off'](b, d)].map(started);
      await until('every call to wait or be done', async () => (await waiting()) >= going.filter((g) => !g.done).length);
      await lock.query('COMMIT');
      const got = [];
      for (const g of going) got.push(await g.answer);
      // Demoting an office user to office is refused, and of the 2 turn offs of d the later one is.
      expect([got[0], got[2]]).toEqual(['200', '409 rule_refused']);
      expect([got[1], got[3]].sort()).toEqual(['200', '409 rule_refused']);
    } finally {
      await lock.end();
    }
  });
});
