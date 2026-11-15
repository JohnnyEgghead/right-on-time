// SPDX-License-Identifier: AGPL-3.0-or-later
// The event dispatcher on PostgreSQL 18 as bw_worker (SPECIFICATIONS section 5.2 steps 6 and 7; FR-DEMO-3): (due_at, id)
// order, each event at max(its due_at, demo now), exactly once under concurrent dispatchers (FOR UPDATE SKIP LOCKED),
// a throwing handler left due without blocking the rows behind it, and a kind with no handler never touched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '@bw/db';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { scheduleEvent } from '../../../packages/outbox/src/events.ts';
import { count, I, loginPool, seedOutboxWorld } from '../../../packages/outbox/src/testing/world.ts';
import { drainDue, type EventHandlers } from './dispatcher.ts';

const db = useMigratedDatabase();
let pool: ReturnType<typeof loginPool>;

beforeAll(async () => {
  await seedOutboxWorld(db.admin());
  pool = loginPool(db.url(), 'bw_worker');
});
afterAll(async () => {
  await pool?.end();
});

/** The world epoch the drains name (F-642: required); read fresh, as a caller reads it with its bound. */
const epoch = async (): Promise<number> => (await db.admin().query<{ world_epoch: number }>('SELECT world_epoch FROM system.demo_clock WHERE id = 1')).rows[0]!.world_epoch;

async function plant(kind: string, dueAt: string, subject: string): Promise<string> {
  return inTransaction(pool, (tx) => scheduleEvent(tx, { kind, dueAt: I(dueAt), subject, payload: { subject } }));
}

describe('the event dispatcher', () => {
  // why: FR-DEMO-3
  it('runs due events in (due_at, id) order, each at max(its due_at, demo now), and leaves later ones due', async () => {
    const seen: [string, string][] = [];
    const handlers: EventHandlers = {
      'test.order': async (e, { now }) => {
        seen.push([e.subject, now.toString()]);
        return { state: 'done', result: 'ok' };
      },
    };
    await plant('test.order', '2026-09-15T18:00:00Z', 'c');
    await plant('test.order', '2026-09-15T16:00:00Z', 'a');
    await plant('test.order', '2026-09-15T17:00:00Z', 'b');
    await plant('test.order', '2026-09-15T19:00:00Z', 'later');
    // A replay to 6:30 PM whose clock is paused at 3:00 PM: each event at its own due time.
    const r = await drainDue(pool, handlers, { through: I('2026-09-15T18:30:00Z'), demoNow: I('2026-09-15T15:00:00Z'), epoch: await epoch() });
    expect(r).toEqual({ ran: 3, skipped: 0, failed: [] });
    expect(seen).toEqual([['a', '2026-09-15T16:00:00Z'], ['b', '2026-09-15T17:00:00Z'], ['c', '2026-09-15T18:00:00Z']]);
    // Normal running at 8:00 PM: the 7:00 PM event runs at demo now.
    await drainDue(pool, handlers, { through: I('2026-09-15T20:00:00Z'), demoNow: I('2026-09-15T20:00:00Z'), epoch: await epoch() });
    expect(seen.at(-1)).toEqual(['later', '2026-09-15T20:00:00Z']);
    const stored = await db.admin().query<{ subject: string; state: string; run_at: Date; result: string }>(
      `SELECT subject, state, run_at, result FROM world.scheduled_event WHERE kind = 'test.order' ORDER BY due_at`,
    );
    expect(stored.rows.map((x) => [x.subject, x.state, x.run_at.toISOString(), x.result])).toEqual([
      ['a', 'done', '2026-09-15T16:00:00.000Z', 'ok'],
      ['b', 'done', '2026-09-15T17:00:00.000Z', 'ok'],
      ['c', 'done', '2026-09-15T18:00:00.000Z', 'ok'],
      ['later', 'done', '2026-09-15T20:00:00.000Z', 'ok'],
    ]);
  });

  // why: FR-TEXT-12
  it('leaves a throwing handler\'s event due, with its writes rolled back, and still runs the events behind it', async () => {
    const handlers: EventHandlers = {
      'test.fail': async (e, { tx }) => {
        await tx.query(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES (now(), 'test.leak', $1, '{}', 'due')`, [e.subject]);
        throw new Error('handler failed');
      },
      'test.after': async () => ({ state: 'done', result: 'ok' }),
    };
    const bad = await plant('test.fail', '2026-09-16T10:00:00Z', 'bad');
    await plant('test.after', '2026-09-16T10:01:00Z', 'after');
    const r = await drainDue(pool, handlers, { through: I('2026-09-16T11:00:00Z'), demoNow: I('2026-09-16T11:00:00Z'), epoch: await epoch() });
    expect(r).toEqual({ ran: 1, skipped: 0, failed: [bad] });
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.scheduled_event WHERE id = $1 AND state = 'due' AND run_at IS NULL`, [bad])).toBe(1);
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.scheduled_event WHERE kind = 'test.leak'`)).toBe(0);
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.scheduled_event WHERE kind = 'test.after' AND state = 'done'`)).toBe(1);
  });

  // why: FR-DEMO-3
  it('never claims a kind it has no handler for', async () => {
    const id = await plant('billing.send', '2026-09-16T09:00:00Z', 'b1');
    await drainDue(pool, { 'test.other': async () => ({ state: 'done', result: 'ok' }) }, { through: I('2026-09-17T00:00:00Z'), demoNow: I('2026-09-17T00:00:00Z'), epoch: await epoch() });
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.scheduled_event WHERE id = $1 AND state = 'due' AND run_at IS NULL`, [id])).toBe(1);
  });

  // why: FR-TEXT-12
  it('runs each event exactly once when 2 dispatchers drain the same due rows at the same time', async () => {
    const runs = new Map<string, number>();
    const handlers: EventHandlers = {
      'test.once': async (e, { tx }) => {
        await tx.query(`SELECT pg_sleep(0.01)`);
        runs.set(e.subject, (runs.get(e.subject) ?? 0) + 1);
        return { state: 'done', result: 'ok' };
      },
    };
    for (let i = 0; i < 30; i++) await plant('test.once', '2026-09-17T10:00:00Z', `s${i}`);
    const other = loginPool(db.url(), 'bw_worker');
    try {
      const opts = { through: I('2026-09-17T11:00:00Z'), demoNow: I('2026-09-17T11:00:00Z'), epoch: await epoch() };
      const [a, b] = await Promise.all([drainDue(pool, handlers, opts), drainDue(other, handlers, opts)]);
      expect(a.ran + b.ran).toBe(30);
      expect(a.ran).toBeGreaterThan(0);
      expect(b.ran).toBeGreaterThan(0);
    } finally {
      await other.end();
    }
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
    expect(runs.size).toBe(30);
  });
});
