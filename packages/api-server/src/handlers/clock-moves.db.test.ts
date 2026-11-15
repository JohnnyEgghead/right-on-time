// SPDX-License-Identifier: AGPL-3.0-or-later
// The clock moves API-11 to API-14 (UI-SPECIFICATION 12.2; SPECIFICATIONS 6.9, section 5.2 step 6, SD-12) on the real
// database (PostgreSQL 18, the migrated schema, a day-start snapshot written by setup's own writeSnapshot), through the
// production kernel (createWebKernel: the real policy table, handlers, SQL sessions and DbClock) as the web process's
// login bw_web. The reset runs as bw_web too, so its 1 new power (EXECUTE on system.restore_world, F-150) is exercised.
// Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@bw/config';
import { createPool, resetWorld, type Queryable } from '@bw/db';
import { createLogger } from '@bw/log';
import { realNow, type RealTimeUse } from '@bw/time';
import { insertJob, seedReference } from '../../../db/src/testing/fixture.ts';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { writeSnapshot } from '../../../setup/src/snapshot.ts';
import { sessionCookie, SqlSessionStore, startSession } from '../kernel/sessions.ts';
import { createWebKernel, type WebKernel } from '../web.ts';
import { jumpClockHandler } from './clock-moves.ts';

const db = useMigratedDatabase();
const log = createLogger({ process: 'web', write: () => undefined });
const asWeb = () => {
  const u = new URL(db.url());
  u.username = 'bw_web';
  return u.toString();
};
const ORIGIN = 'http://localhost:8080';
let k: WebKernel;
let sessionPool: ReturnType<typeof createPool>;
let ref: Awaited<ReturnType<typeof seedReference>>;
const cookies: Record<'manager' | 'office', string> = { manager: '', office: '' };

const get = (path: string, cookie = cookies.manager) =>
  k.router.handle(new Request(`http://web:3000/api/v1${path}`, { headers: { cookie } }), { address: '203.0.113.9' });
const send = (method: string, path: string, body: unknown, cookie = cookies.manager) =>
  k.router.handle(new Request(`http://web:3000/api/v1${path}`, {
    method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
  }), { address: '203.0.113.9' });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (r: Response): Promise<any> => r.json();
const clockRow = async () =>
  (await db.admin().query<{ world_epoch: number; pbs_epoch: number; paused: boolean; demo_anchor: Date; replay_target: Date | null; last_write_real: Date }>(
    'SELECT world_epoch, pbs_epoch, paused, demo_anchor, replay_target, last_write_real FROM system.demo_clock WHERE id = 1')).rows[0]!;

/** Let the clock move again: the reset confirmed (pbs_epoch = world_epoch), no replay, the cool-down over, paused at `at`. */
async function settle(a: Queryable, at = '2026-09-15T13:00:00Z'): Promise<void> {
  await a.query(`UPDATE system.demo_clock SET pbs_epoch = world_epoch, replay_target = NULL, paused = true, demo_anchor = $1,
                   last_reset_real = now() - interval '1 hour' WHERE id = 1`, [at]);
}

async function tableCounts(a: Queryable, schema: 'world' | 'world_snapshot'): Promise<Record<string, number>> {
  const t = await a.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1`, [schema]);
  const out: Record<string, number> = {};
  for (const { name } of t.rows) out[name] = Number((await a.query<{ n: string }>(`SELECT count(*) AS n FROM ${schema}."${name}"`)).rows[0]!.n);
  return out;
}

beforeAll(async () => {
  const a = db.admin();
  ref = await seedReference(a);
  const office = await a.query<{ id: string }>(`INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, sample, reviewer)
                 VALUES ('keisha@example.test', 'Keisha Thompson', 'keisha thompson', 'office', 'columbus', 'en', 'active', true, false) RETURNING id`);
  await insertJob(a, ref);
  await insertJob(a, ref);
  await a.query(`INSERT INTO world.part (code, name, name_search, price_cents) VALUES ('P-1', 'Filter', 'filter', 1200), ('P-2', 'Belt', 'belt', 900)`);
  // The seed's 1 due alert.check (section 3 writer table), which every reset must bring back (F-463).
  await a.query(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ('2026-09-15T11:05:00Z', 'alert.check', 'alerts', '{}', 'due')`);
  await a.query(`INSERT INTO system.demo_clock (id, demo_anchor, real_anchor, rate, paused, world_epoch, pbs_epoch, last_reset_real, last_write_real)
                 VALUES (1, '2026-09-15T11:00:00Z', now(), 1, true, 1, 1, now(), now())`);
  const real = new Date(realNow('clock_anchor').epochMilliseconds);
  await writeSnapshot(a, { clockReal: real, recordReal: real });
  await settle(a);
  k = createWebKernel({ settings: loadConfig({ DATABASE_URL: asWeb(), ACCESS_CODE_ON: 'off' }), log });
  sessionPool = createPool({ connectionString: asWeb(), max: 1 });
  const store = new SqlSessionStore(sessionPool);
  const clock = { realNow: (use: RealTimeUse) => (use === 'session_idle' ? realNow('session_idle') : realNow('session_lifetime')) };
  for (const [role, userId] of [['manager', ref.userId], ['office', office.rows[0]!.id]] as const) {
    const token = await startSession(store, clock, { userId, role }, { client: 'web', via: 'password', keepSignedIn: false });
    cookies[role] = sessionCookie(token, false, false).split(';')[0]!;
  }
});
afterAll(async () => {
  await k?.close();
  await sessionPool?.end();
});

describe('API-12 jump: forward only, held for the replay', () => {
  // why: FR-DEMO-4
  it('refuses a target at or before demo now with not_forward and leaves the clock as it was', async () => {
    await settle(db.admin(), '2026-09-15T13:00:00Z');
    for (const to of ['2026-09-15T08:59:00-04:00[America/New_York]', '2026-09-15T09:00:00-04:00[America/New_York]']) {
      const r = await send('POST', '/clock/jumps', { to });
      expect(r.status, to).toBe(409);
      expect((await body(r)).code).toBe('not_forward');
    }
    const c = await clockRow();
    expect(c.replay_target).toBeNull();
    expect(c.demo_anchor).toEqual(new Date('2026-09-15T13:00:00Z'));
  });

  // why: FR-DEMO-3
  it('answers 202, holds the clock paused at the old time with a pause row by the mover, and counts the due events', async () => {
    await settle(db.admin(), '2026-09-15T13:00:00Z');
    const a = db.admin();
    await a.query(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state)
                   VALUES ('2026-09-15T15:00:00Z', 'text.try', 'x', '{}', 'due'), ('2026-09-15T21:00:00Z', 'text.reminder', 'y', '{}', 'due'),
                          ('2026-09-16T12:00:00Z', 'text.try', 'z', '{}', 'due')`);
    const r = await send('POST', '/clock/jumps', { to: '2026-09-15T18:05:00-04:00[America/New_York]' });
    expect(r.status).toBe(202);
    // Due through 6:05 PM EDT: the seed's alert.check (7:05 AM) and the 2 inserted at 11:00 AM and 5:00 PM EDT.
    expect((await body(r)).data).toEqual({ replay: { running: true, done: 0, total: 3 } });
    const c = await clockRow();
    expect(c).toMatchObject({ paused: true, demo_anchor: new Date('2026-09-15T13:00:00Z'), replay_target: new Date('2026-09-15T22:05:00Z') });
    const move = await a.query(`SELECT kind, by_name, from_demo, to_demo FROM system.clock_move ORDER BY at_real DESC, id DESC LIMIT 1`);
    expect(move.rows[0]).toEqual({ kind: 'pause', by_name: 'Dana Ruiz', from_demo: new Date('2026-09-15T13:00:00Z'), to_demo: new Date('2026-09-15T13:00:00Z') });
    const clock = (await body(await get('/clock'))).data;
    expect(clock.replay).toEqual({ running: true, done: 0, total: 3 });
    expect(clock.paused).toBe(true);
    await a.query(`DELETE FROM world.scheduled_event WHERE subject IN ('x', 'y', 'z')`);
  });

  // why: FR-DEMO-6, F-545
  it('answers replay_running to API-12 and API-13 while a replay runs and to all 3 while a reset is unconfirmed, and lets API-14 end a running replay', async () => {
    const a = db.admin();
    for (const state of ['replay', 'unconfirmed'] as const) {
      await settle(a);
      if (state === 'replay') await a.query(`UPDATE system.demo_clock SET replay_target = '2026-09-15T22:05:00Z' WHERE id = 1`);
      else await a.query(`UPDATE system.demo_clock SET pbs_epoch = world_epoch - 1 WHERE id = 1`);
      // F-919: API-10 says running in both states, so the page offers no move that API-12 would refuse.
      expect((await body(await get('/clock'))).data.replay.running, state).toBe(true);
      const calls = [
        await send('POST', '/clock/jumps', { to: '2026-09-16T08:00:00-04:00[America/New_York]' }),
        await send('PUT', '/clock/paused', { paused: false }),
      ];
      for (const r of calls) {
        expect(r.status, state).toBe(409);
        expect((await body(r)).code, state).toBe('replay_running');
      }
      // F-545: a demo reset ends a running replay; only an unconfirmed reset makes it wait.
      const reset = await send('POST', '/clock/resets', {});
      if (state === 'unconfirmed') {
        expect(reset.status, state).toBe(409);
        expect((await body(reset)).code, state).toBe('replay_running');
      } else {
        expect(reset.status, state).toBe(202);
        expect((await clockRow()).replay_target, state).toBeNull();
      }
    }
    await settle(a);
  });

  // why: FR-DEMO-6
  it('lets only a manager move the clock (an office user is forbidden)', async () => {
    await settle(db.admin());
    expect((await send('POST', '/clock/jumps', { to: '2026-09-16T08:00:00-04:00[America/New_York]' }, cookies.office)).status).toBe(403);
    expect((await send('PUT', '/clock/paused', { paused: false }, cookies.office)).status).toBe(403);
    expect((await send('POST', '/clock/resets', {}, cookies.office)).status).toBe(403);
    expect((await get('/clock/presets', cookies.office)).status).toBe(403);
  });
});

describe('API-13 pause and resume, the banner names the mover', () => {
  // why: FR-DEMO-6
  it('writes the mover user.name and the move to the clock row, which API-10 answers to every caller', async () => {
    await settle(db.admin(), '2026-09-15T13:00:00Z');
    const r = await send('PUT', '/clock/paused', { paused: false });
    expect(r.status).toBe(200);
    expect((await body(r)).data).toEqual({ paused: false });
    const seen = (await body(await get('/clock', cookies.office))).data;
    expect(seen.lastMove).toEqual({ by: 'Dana Ruiz', kind: 'resume', toDemo: '2026-09-15T09:00:00-04:00[America/New_York]' });
    expect(seen.paused).toBe(false);
    const p = await send('PUT', '/clock/paused', { paused: true });
    expect((await body(p)).data).toEqual({ paused: true });
    expect((await body(await get('/clock', cookies.office))).data.lastMove).toMatchObject({ by: 'Dana Ruiz', kind: 'pause' });
  });
});

describe('API-11 presets', () => {
  // why: FR-DEMO-5, NFR-08
  it('answers the 6 presets with their offsets on each side of both changes, reachable when after demo now', async () => {
    await settle(db.admin(), '2026-09-15T23:00:00Z'); // 7:00 PM EDT: the 6:05 PM preset is behind the clock
    const presets = (await body(await get('/clock/presets'))).data.presets;
    expect(presets).toEqual([
      { presetId: 'reminder_6pm', labelKey: 'clock.preset.reminder_6pm', target: '2026-09-15T18:05:00-04:00[America/New_York]', reachable: false },
      { presetId: 'tomorrow_8am', labelKey: 'clock.preset.tomorrow_8am', target: '2026-09-16T08:00:00-04:00[America/New_York]', reachable: true },
      { presetId: 'sat_oct_31', labelKey: 'clock.preset.sat_oct_31', target: '2026-10-31T07:00:00-04:00[America/New_York]', reachable: true },
      { presetId: 'sun_nov_1', labelKey: 'clock.preset.sun_nov_1', target: '2026-11-01T17:55:00-05:00[America/New_York]', reachable: true },
      { presetId: 'sat_mar_13_2027', labelKey: 'clock.preset.sat_mar_13_2027', target: '2027-03-13T07:00:00-05:00[America/New_York]', reachable: true },
      { presetId: 'sun_mar_14_2027', labelKey: 'clock.preset.sun_mar_14_2027', target: '2027-03-14T07:00:00-04:00[America/New_York]', reachable: true },
    ]);
    const r = await send('POST', '/clock/jumps', { presetId: 'reminder_6pm' });
    expect((await body(r)).code).toBe('not_forward');
  });
});

describe('API-14 reset the world', () => {
  // why: FR-DEMO-4, F-416, F-463, F-323
  it('restores the snapshot row counts of every world table exactly, bumps the epoch and parks the clock at Sep 15, 7:00 AM', async () => {
    const a = db.admin();
    await settle(a, '2026-09-16T20:00:00Z');
    const snapshot = await tableCounts(a, 'world_snapshot');
    // Visitor changes after the snapshot: new rows, a deleted row, a changed row, a job past the snapshot's numbers.
    await a.query(`INSERT INTO world.part (code, name, name_search, price_cents) VALUES ('P-9', 'Extra', 'extra', 100)`);
    await a.query(`UPDATE world.customer SET name = 'Changed' WHERE id = $1`, [ref.customerId]);
    const visitorJob = await insertJob(a, ref);
    await a.query(`UPDATE world.scheduled_event SET state = 'done' WHERE kind = 'alert.check'`);
    await a.query(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ('2026-09-16T20:05:00Z', 'alert.check', 'alerts', '{}', 'due')`);
    await a.query(`DELETE FROM world.part WHERE code = 'P-2'`);
    expect(await tableCounts(a, 'world')).not.toEqual(snapshot);
    const before = await clockRow();

    const r = await send('POST', '/clock/resets', {});
    expect(r.status).toBe(202);
    expect((await body(r)).data).toEqual({ worldEpoch: before.world_epoch + 1 });

    // Every table holds the snapshot's rows; alert holds 1 more, the reset's own info alert world_reset (section 3 writer table).
    expect(await tableCounts(a, 'world')).toEqual({ ...snapshot, alert: snapshot.alert! + 1 });
    // F-416: read from the snapshot, never a fixed number (P3-PARTS-CATALOG grows the catalog).
    expect((await a.query(`SELECT count(*)::int AS n FROM world.part`)).rows[0]!.n).toBe(snapshot.part);
    expect((await a.query(`SELECT name FROM world.customer WHERE id = $1`, [ref.customerId])).rows[0]).toEqual({ name: 'Ann Lee' });
    // F-463: the snapshot's 1 due alert.check comes back, so the chain keeps going.
    expect((await a.query(`SELECT count(*)::int AS n FROM world.scheduled_event WHERE kind = 'alert.check' AND state = 'due'`)).rows[0]!.n).toBe(1);
    const c = await clockRow();
    expect(c).toMatchObject({ world_epoch: before.world_epoch + 1, paused: true, demo_anchor: new Date('2026-09-15T11:00:00Z'), replay_target: null });
    expect(c.pbs_epoch).toBeLessThan(c.world_epoch); // unconfirmed until the confirmer has pbs apply it
    const seen = (await body(await get('/clock'))).data;
    expect(seen).toMatchObject({ worldEpoch: before.world_epoch + 1, paused: true, demoNow: '2026-09-15T07:00:00-04:00[America/New_York]' });
    expect(seen.lastMove).toEqual({ by: 'Dana Ruiz', kind: 'reset', toDemo: '2026-09-15T07:00:00-04:00[America/New_York]' });
    // The job number sequence continues after the snapshot's jobs, so the visitor's number is handed out again.
    const next = await insertJob(a, ref);
    expect(next).toBe(visitorJob);
    await a.query('DELETE FROM world.job WHERE job_number = $1', [next]);
    // F-323: every refilled table has fresh planner statistics. TRUNCATE leaves reltuples at -1 (unknown) and the test
    // server runs autovacuum off, so a row estimate equal to the restored count is the reset's own ANALYZE.
    const estimates = await a.query<{ relname: string; reltuples: number }>(
      `SELECT c.relname, c.reltuples FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'world' AND c.relkind = 'r'`);
    const counts = await tableCounts(a, 'world');
    // (alert: the restored rows; the reset's own info alert is written after the ANALYZE.)
    expect(Object.fromEntries(estimates.rows.map((x) => [x.relname, x.reltuples]))).toEqual({ ...counts, alert: counts.alert! - 1 });
    // Sessions live in system and survive; the manager's session still answers.
    expect((await get('/me')).status).toBe(200);
    const moves = await a.query(`SELECT kind, by_name, world_epoch FROM system.clock_move ORDER BY at_real DESC, id DESC LIMIT 1`);
    expect(moves.rows[0]).toEqual({ kind: 'reset', by_name: 'Dana Ruiz', world_epoch: before.world_epoch + 1 });
    const alert = await a.query(`SELECT state FROM world.alert WHERE type = 'world_reset'`);
    expect(alert.rows).toEqual([{ state: 'info' }]);
  });

  // why: FR-DEMO-6
  it('refuses a second reset inside the 5-minute cool-down with cooldown and the seconds left', async () => {
    const a = db.admin();
    await settle(a);
    await a.query(`UPDATE system.demo_clock SET last_reset_real = now() - interval '60 seconds' WHERE id = 1`);
    const before = await clockRow();
    const r = await send('POST', '/clock/resets', {});
    expect(r.status).toBe(429);
    const problem = await body(r);
    expect(problem.code).toBe('cooldown');
    expect(problem.availableInSeconds).toBeGreaterThan(230);
    expect(problem.availableInSeconds).toBeLessThanOrEqual(240);
    expect((await clockRow()).world_epoch).toBe(before.world_epoch);
    expect((await body(await get('/clock'))).data.resetAvailableInSeconds).toBeGreaterThan(230);
  });
});

describe('the kernel stamps the last write (the idle reset reads it)', () => {
  // why: FR-DEMO-6
  it('sets last_write_real on a successful write, at most once per 10 s, and never on a read or a refused write', async () => {
    const a = db.admin();
    await settle(a);
    await a.query(`UPDATE system.demo_clock SET last_write_real = now() - interval '1 hour' WHERE id = 1`);
    const old = (await clockRow()).last_write_real;
    await get('/clock');
    expect((await clockRow()).last_write_real).toEqual(old);
    expect((await send('POST', '/clock/jumps', { to: '2026-09-15T08:00:00-04:00[America/New_York]' })).status).toBe(409);
    expect((await clockRow()).last_write_real).toEqual(old);
    expect((await send('PUT', '/clock/paused', { paused: true })).status).toBe(200);
    const stamped = (await clockRow()).last_write_real;
    expect(realNow('idle_reset').epochMilliseconds - stamped.getTime()).toBeLessThan(60_000);
    expect((await send('PUT', '/clock/paused', { paused: true })).status).toBe(200);
    expect((await clockRow()).last_write_real).toEqual(stamped);
  });
});

describe('a jump and a reset together (F-540)', () => {
  // why: F-540 a jump holds the clock row and then reads world.user; a reset holds the world tables and then wants the clock row. With the
  // clock-move lock first in both, neither answers 500 (PostgreSQL's deadlock abort): the reset waits for the jump and then runs
  it('lets a reset that starts while a jump holds the clock row wait for it, and both complete', async () => {
    const a = db.admin();
    await settle(a);
    const pool = createPool({ connectionString: asWeb(), max: 3 });
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const pid2 = (await c2.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      let reached!: () => void;
      let release!: () => void;
      const atBarrier = new Promise<void>((r) => { reached = r; });
      const gate = new Promise<void>((r) => { release = r; });
      await c1.query('BEGIN');
      // The jump's own transaction, held once it has locked the clock row (the statement after which it reads world.user).
      const gated = {
        query: async (sql: string, values?: unknown[]) => {
          const r = await c1.query(sql, values);
          if (/FROM system\.demo_clock/.test(sql) && /FOR UPDATE/.test(sql)) {
            reached();
            await gate;
          }
          return r;
        },
      };
      const req = { params: { presetId: 'tomorrow_8am' }, caller: { kind: 'staff', userId: ref.userId, role: 'manager' } };
      const jump = jumpClockHandler(req as never, gated as never, { clock: { realNow: () => realNow('clock_anchor') } } as never);
      await atBarrier;
      await c2.query('BEGIN');
      const reset = resetWorld(c2, { byName: 'Dana Ruiz', real: new Date(realNow('clock_anchor').epochMilliseconds) });
      for (;;) {
        const waiting = await a.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = $2', [pid2, 'Lock']);
        if (waiting.rowCount === 1) break;
        await new Promise((r) => setImmediate(r));
      }
      release();
      const answered = await jump;
      expect(answered.ok).toBe(true);
      await c1.query('COMMIT');
      await expect(reset).resolves.toMatchObject({ epoch: expect.any(Number) });
      await c2.query('COMMIT');
    } finally {
      c1.release();
      c2.release();
      await pool.end();
    }
  }, 60_000);
});
