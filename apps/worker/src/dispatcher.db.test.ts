// SPDX-License-Identifier: AGPL-3.0-or-later
// The event dispatcher on PostgreSQL 18 as bw_worker (SPECIFICATIONS section 5.2 steps 6 and 7; FR-DEMO-3): (due_at, id)
// order, each event at max(its due_at, demo now), exactly once under concurrent dispatchers (FOR UPDATE SKIP LOCKED),
// a throwing handler left due without blocking the rows behind it, and a kind with no handler never touched.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inTransaction } from '@bw/db';
import { createLogger } from '@bw/log';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { scheduleEvent } from '../../../packages/outbox/src/events.ts';
import { count, I, loginPool, seedOutboxWorld } from '../../../packages/outbox/src/testing/world.ts';
import { drainDue, startDispatcher, type EventHandlers, type ParallelLane } from './dispatcher.ts';

const db = useMigratedDatabase();
let pool: ReturnType<typeof loginPool>;
/** The drains' log (F-1844: required); the lines are kept for the failure-line tests. */
const lines: string[] = [];
const log = createLogger({ process: 'worker', write: (l) => lines.push(l) });

beforeAll(async () => {
  await seedOutboxWorld(db.admin());
  pool = loginPool(db.url(), 'bw_worker');
});
afterAll(async () => {
  await pool?.end();
});

/** The world epoch the drains name (F-642: required); read fresh, as a caller reads it with its bound. F-1923: through the worker pool, not db.admin():
 * the dispatcher's timer pass reads the epoch as the test's own drain does, and db.admin() is 1 shared connection that refuses an overlapping query. */
const epoch = async (): Promise<number> => (await pool.query<{ world_epoch: number }>('SELECT world_epoch FROM system.demo_clock WHERE id = 1')).rows[0]!.world_epoch;

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
    const r = await drainDue(pool, handlers, { through: I('2026-09-15T18:30:00Z'), demoNow: I('2026-09-15T15:00:00Z'), epoch: await epoch(), log });
    expect(r).toEqual({ ran: 3, skipped: 0, failed: [] });
    expect(seen).toEqual([['a', '2026-09-15T16:00:00Z'], ['b', '2026-09-15T17:00:00Z'], ['c', '2026-09-15T18:00:00Z']]);
    // Normal running at 8:00 PM: the 7:00 PM event runs at demo now.
    await drainDue(pool, handlers, { through: I('2026-09-15T20:00:00Z'), demoNow: I('2026-09-15T20:00:00Z'), epoch: await epoch(), log });
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
    const r = await drainDue(pool, handlers, { through: I('2026-09-16T11:00:00Z'), demoNow: I('2026-09-16T11:00:00Z'), epoch: await epoch(), log });
    expect(r).toEqual({ ran: 1, skipped: 0, failed: [bad] });
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.scheduled_event WHERE id = $1 AND state = 'due' AND run_at IS NULL`, [bad])).toBe(1);
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.scheduled_event WHERE kind = 'test.leak'`)).toBe(0);
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.scheduled_event WHERE kind = 'test.after' AND state = 'done'`)).toBe(1);
  });

  // why: FR-DEMO-3
  it('never claims a kind it has no handler for', async () => {
    const id = await plant('billing.send', '2026-09-16T09:00:00Z', 'b1');
    await drainDue(pool, { 'test.other': async () => ({ state: 'done', result: 'ok' }) }, { through: I('2026-09-17T00:00:00Z'), demoNow: I('2026-09-17T00:00:00Z'), epoch: await epoch(), log });
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
      const opts = { through: I('2026-09-17T11:00:00Z'), demoNow: I('2026-09-17T11:00:00Z'), epoch: await epoch(), log };
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

/** The log lines of 1 event, parsed. */
const linesOf = (id: string): Record<string, unknown>[] => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.eventId === id);

/** Record text in a thrown message: the lines must carry the cause code, never these words. */
const PRIVATE = 'Harold Jenkins 6145550100 at 12 Oak St';

describe('the failed run of an event is logged with its kind, id and cause (F-1844, F-1847)', () => {
  // why: F-1844: a failing event logged nothing, so a person could not see which event failed or why.
  it('logs each failed run at error level with the kind, the event id and the cause code, never the message or subject', async () => {
    const bad = await plant('test.seen', '2026-09-18T10:00:00Z', 'Harold Jenkins');
    const handlers: EventHandlers = { 'test.seen': async () => { throw Object.assign(new Error(PRIVATE), { code: '23505' }); } };
    const r = await drainDue(pool, handlers, { through: I('2026-09-18T11:00:00Z'), demoNow: I('2026-09-18T10:30:00Z'), epoch: await epoch(), log });
    expect(r.failed).toEqual([bad]);
    expect(linesOf(bad)).toEqual([
      expect.objectContaining({ level: 'error', status: 'event failed', eventKind: 'test.seen', eventId: bad, errorCode: '23505', demoTime: '2026-09-18T10:30:00+00:00[UTC]' }),
    ]);
    expect(Object.keys(linesOf(bad)[0]!).sort()).toEqual(['demoTime', 'errorCode', 'eventId', 'eventKind', 'level', 'process', 'realTime', 'status']);
    expect(lines.join('')).not.toMatch(/Harold|6145550100|Oak/);
  });

  // why: F-1844: a failure count that could not be written was swallowed, so the event retried for ever with no line.
  it('logs a failure count it could not write, with the count error\'s own code, and leaves the event due', async () => {
    const admin = db.admin();
    await admin.query(`CREATE FUNCTION world.test_refuse_count() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.kind = 'test.uncounted' AND NEW.payload ? 'failures' THEN RAISE EXCEPTION '${PRIVATE}' USING ERRCODE = '53100'; END IF;
        RETURN NEW;
      END $f$`);
    await admin.query(`CREATE TRIGGER test_refuse_count BEFORE UPDATE ON world.scheduled_event FOR EACH ROW EXECUTE FUNCTION world.test_refuse_count()`);
    try {
      const bad = await plant('test.uncounted', '2026-09-19T10:00:00Z', 'u');
      const handlers: EventHandlers = { 'test.uncounted': async () => { throw new TypeError(PRIVATE); } };
      const giveUps = { 'test.uncounted': async () => ({ state: 'skipped' as const, result: 'handler_failed' }) };
      const r = await drainDue(pool, handlers, { through: I('2026-09-19T11:00:00Z'), demoNow: I('2026-09-19T11:00:00Z'), epoch: await epoch(), giveUps, log });
      expect(r.failed).toEqual([bad]);
      expect(linesOf(bad).map((l) => [l.level, l.status, l.errorCode, l.failures])).toEqual([
        ['error', 'event failed', 'TypeError', undefined],
        ['error', 'event failure not counted', '53100', undefined],
      ]);
      expect(await count(admin, `SELECT count(*) AS n FROM world.scheduled_event WHERE id = $1 AND state = 'due' AND NOT payload ? 'failures'`, [bad])).toBe(1);
      expect(lines.join('')).not.toMatch(/Harold|6145550100|Oak/);
    } finally {
      await admin.query(`DROP TRIGGER test_refuse_count ON world.scheduled_event`);
      await admin.query(`DROP FUNCTION world.test_refuse_count()`);
    }
  });

  // why: F-1847: a keyOf that threw (a payload with no job number) failed the whole pass, so no serial event ran either.
  it('counts a parallel-lane event whose key cannot be read as a failed run of that event, and the pass still runs both lanes', async () => {
    const lane: ParallelLane<null, null> = {
      name: 'test-lane',
      kinds: ['test.keyed'],
      concurrency: 2,
      keyOf: (e) => {
        const n = (e.payload as { jobNumber?: unknown }).jobNumber;
        if (typeof n !== 'number') throw new TypeError(PRIVATE);
        return String(n);
      },
      handler: {
        prepare: async () => ({ settle: { state: 'done', result: 'ok' } }),
        call: async () => null,
        record: async () => null,
      },
    };
    const keyless = await plant('test.keyed', '2026-09-20T10:00:00Z', 'k1');
    const keyed = await inTransaction(pool, (tx) => scheduleEvent(tx, { kind: 'test.keyed', dueAt: I('2026-09-20T10:01:00Z'), subject: 'k2', payload: { jobNumber: 24825 } }));
    const serial = await plant('test.serial', '2026-09-20T10:02:00Z', 's1');
    const at = I('2026-09-20T11:00:00Z');
    const d = startDispatcher({
      pool, log, lanes: [lane as ParallelLane], intervalMs: 3_600_000,
      clock: { worldEpoch: epoch, demoNow: async () => at },
      handlers: { 'test.serial': async () => ({ state: 'done', result: 'ok' }) },
    });
    try {
      await d.drain();
      await vi.waitFor(async () => expect(await count(db.admin(), `SELECT count(*) AS n FROM world.scheduled_event WHERE id = ANY($1::uuid[]) AND state = 'done'`, [[keyed, serial]])).toBe(2));
    } finally {
      await d.stop();
    }
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.scheduled_event WHERE id = $1 AND state = 'due'`, [keyless])).toBe(1);
    const failed = linesOf(keyless);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    for (const l of failed) expect(l).toMatchObject({ level: 'error', status: 'event failed', eventKind: 'test.keyed', errorCode: 'TypeError' });
    expect(lines.some((l) => l.includes('dispatcher pass failed'))).toBe(false);
    expect(lines.join('')).not.toMatch(/Harold|6145550100|Oak/);
  });
});
