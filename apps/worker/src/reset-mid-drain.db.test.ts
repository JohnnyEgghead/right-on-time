// SPDX-License-Identifier: AGPL-3.0-or-later
// A world reset (SD-12) that lands while a drain is running (F-635): the drain is bound to the world epoch its bound was
// read in, so no event of the restored world runs under the old bound. 2 drains are covered: a replay batch through the
// worker's replayStep (API-14 may reset during a replay, F-545), and a normal dispatcher pass. The pass is covered in both lanes: the
// serial lane's claim and the parallel lane's (the billing lane's shape, F-641: LaneRunner's stale path).
//
// The reset is made by the first event's handler, on its own connection, and the handler returns only once that reset
// waits for the claim's lock on world.scheduled_event. So the reset commits exactly between the drain's first claim and
// its next one, with no sleep and no timing window. The restored world (the snapshot) holds 2 events due before the old
// bound; before F-635 the same drain ran them at the old world's time.
// Run by gate G-CI2 (ci/gates/G-CI2/vitest.db.config.ts: apps/worker/src/*.db.test.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetWorld } from '@bw/db';
import { createLogger } from '@bw/log';
import { realNow, Temporal } from '@bw/time';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { loginPool, seedOutboxWorld } from '../../../packages/outbox/src/testing/world.ts';
import { writeSnapshot } from '../../../packages/setup/src/snapshot.ts';
import { replayStep, ReplayState } from './clock/replay.ts';
import { startDispatcher, type Dispatcher, type EventHandlers, type ParallelLane } from './dispatcher.ts';

const KIND = 'test.reset_mid_drain';
const LANE_KIND = 'test.reset_mid_drain_lane';
const db = useMigratedDatabase();
const log = createLogger({ process: 'worker', write: () => undefined });
let worker: ReturnType<typeof loginPool>;
let resetter: ReturnType<typeof loginPool>;
let dispatcher: Dispatcher;
/** The pass's demo now: early (nothing due) until a case sets the old world's bound. */
let passNow = Temporal.Instant.from('2026-09-01T00:00:00Z');
const ran: string[] = [];
const laneRan: string[] = [];
let reset: Promise<void> | undefined;

// One helper per tag: G-CI4 needs every realNow call to pass a string-literal tag.
const nightlyResetDate = () => new Date(realNow('nightly_reset').epochMilliseconds);
const clockAnchorDate = () => new Date(realNow('clock_anchor').epochMilliseconds);
const recordStampDate = () => new Date(realNow('record_stamp').epochMilliseconds);
const epochNow = async (): Promise<number> =>
  (await db.admin().query<{ world_epoch: number }>('SELECT world_epoch FROM system.demo_clock WHERE id = 1')).rows[0]!.world_epoch;

/**
 * Start a reset on its own connection and wait (bounded) until it waits on a lock: the running claim's. The reset's promise
 * is returned inside an object, since an async function returning a promise would wait for it (and so for the claim).
 */
async function startReset(): Promise<{ done: Promise<void> }> {
  const c = await resetter.connect();
  const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const done = (async () => {
    try {
      await c.query('BEGIN');
      await resetWorld(c, { byName: 'nightly', real: nightlyResetDate() });
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  })();
  done.catch(() => undefined); // awaited by the case
  await vi.waitFor(async () => {
    const w = await db.admin().query('SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = $2', [pid, 'Lock']);
    if (w.rowCount !== 1) throw new Error('the reset does not wait on the claim yet');
  }, { timeout: 20_000, interval: 5 });
  return { done };
}

const handlers: EventHandlers = {
  [KIND]: async (e) => {
    ran.push(e.subject);
    if (e.payload.reset === true) {
      reset = (await startReset()).done;
    }
    return { state: 'done', result: 'ok' };
  },
};

/** A parallel lane of the billing lane's shape (prepare in tx 1, the call, record in tx 2); its first event starts a reset like the serial handler's. */
const lane: ParallelLane<string, string> = {
  name: 'test-lane',
  kinds: [LANE_KIND],
  keyOf: (e) => e.subject,
  concurrency: 1,
  handler: {
    prepare: async (e) => {
      laneRan.push(e.subject);
      if (e.payload.reset === true) reset = (await startReset()).done;
      return { call: e.subject };
    },
    call: async (subject) => subject,
    record: async () => ({ state: 'done', result: 'ok' }),
  },
};

const plant = (subject: string, dueAt: string, payload: Record<string, unknown> = {}, kind = KIND) =>
  db.admin().query(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ($1, $2, $3, $4, 'due')`, [dueAt, kind, subject, payload]);
const restoredStates = async (kind = KIND) =>
  (await db.admin().query<{ subject: string; state: string }>(
    `SELECT subject, state FROM world.scheduled_event WHERE kind = $1 AND subject LIKE 'restored-%' ORDER BY subject`, [kind])).rows;

beforeAll(async () => {
  const a = db.admin();
  await seedOutboxWorld(a);
  // The day-start snapshot holds 2 events of the restored world, due Sun, Sep 20, 2026: after the reset's Sep 15, 7:00 AM
  // and before every old bound below. They are then taken out of the live world, which the cases fill with old-world events.
  await plant('restored-1', '2026-09-20T12:00:00Z');
  await plant('restored-2', '2026-09-20T13:00:00Z');
  await plant('restored-lane-1', '2026-09-20T12:00:00Z', {}, LANE_KIND);
  await plant('restored-lane-2', '2026-09-20T13:00:00Z', {}, LANE_KIND);
  await writeSnapshot(a, { clockReal: clockAnchorDate(), recordReal: recordStampDate() });
  await a.query(`DELETE FROM world.scheduled_event WHERE kind = ANY($1::text[])`, [[KIND, LANE_KIND]]);
  worker = loginPool(db.url(), 'bw_worker');
  resetter = loginPool(db.url(), 'bw_worker');
  // The worker's dispatcher; its timer pass runs once at the early passNow and is then held off, so each drain is explicit.
  dispatcher = startDispatcher({ pool: worker, clock: { demoNow: async () => passNow, worldEpoch: epochNow }, handlers, lanes: [lane], log, intervalMs: 3_600_000 });
});
afterAll(async () => {
  await dispatcher?.stop();
  await worker?.end();
  await resetter?.end();
});

describe('a reset mid-drain runs no event of the restored world under the old bound (F-635)', () => {
  // why: F-635, F-545, SD-12, FR-DEMO-3
  it('a replay batch: the reset ends the replay and the batch claims nothing of the fresh world', async () => {
    const a = db.admin();
    ran.length = 0;
    // A replay of a jump from Thu, Oct 1, 6:00 AM EDT to Sat, Oct 10: the clock paused at the old time, replay_target set.
    await a.query(`UPDATE system.demo_clock SET demo_anchor = '2026-10-01T10:00:00Z', paused = true, replay_target = '2026-10-10T12:00:00Z',
                     replay_done = 0, replay_total = 2, pbs_epoch = world_epoch WHERE id = 1`);
    await plant('old-1', '2026-10-01T12:00:00Z', { reset: true });
    await plant('old-2', '2026-10-01T13:00:00Z');
    const before = await epochNow();

    const step = await replayStep({ pool: worker, dispatcher, real: () => clockAnchorDate(), state: new ReplayState() });
    await reset;
    expect(step).toBe('lost');
    expect(await epochNow()).toBe(before + 1);
    // Only the old world's first event ran; the reset truncated old-2, and the restored events wait for the fresh clock.
    expect(ran).toEqual(['old-1']);
    expect(await restoredStates()).toEqual([{ subject: 'restored-1', state: 'due' }, { subject: 'restored-2', state: 'due' }]);
  }, 60_000);

  // why: F-635, SD-12
  it('a normal pass: its bound, the old demo now, runs nothing of the fresh world', async () => {
    const a = db.admin();
    ran.length = 0;
    reset = undefined;
    await a.query(`UPDATE world.scheduled_event SET state = 'done' WHERE kind = ANY($1::text[]) AND state = 'due'`, [[KIND, LANE_KIND]]);
    await plant('old-3', '2026-10-01T12:00:00Z', { reset: true });
    passNow = Temporal.Instant.from('2026-10-05T12:00:00Z'); // the old world's demo now, read before the reset
    const before = await epochNow();

    await dispatcher.drain();
    await reset;
    expect(await epochNow()).toBe(before + 1);
    expect(ran).toEqual(['old-3']);
    expect(await restoredStates()).toEqual([{ subject: 'restored-1', state: 'due' }, { subject: 'restored-2', state: 'due' }]);
  }, 60_000);
  // why: F-641, F-635, SD-12
  it('a normal pass, parallel lane: a restored-world event due before the old bound stays due after the mid-drain reset', async () => {
    const a = db.admin();
    laneRan.length = 0;
    reset = undefined;
    await a.query(`UPDATE world.scheduled_event SET state = 'done' WHERE kind = ANY($1::text[]) AND state = 'due'`, [[KIND, LANE_KIND]]);
    await plant('old-lane-1', '2026-10-01T12:00:00Z', { reset: true }, LANE_KIND);
    await plant('old-lane-2', '2026-10-01T13:00:00Z', {}, LANE_KIND);
    passNow = Temporal.Instant.from('2026-10-05T12:00:00Z'); // the old world's demo now, read before the reset
    const before = await epochNow();

    await dispatcher.drain();
    await reset;
    expect(await epochNow()).toBe(before + 1);
    // Only the old world's first lane event started; the stale check (LaneRunner tx 1) stopped the drain before the restored ones.
    expect(laneRan).toEqual(['old-lane-1']);
    expect(await restoredStates(LANE_KIND)).toEqual([{ subject: 'restored-lane-1', state: 'due' }, { subject: 'restored-lane-2', state: 'due' }]);
  }, 60_000);
});
