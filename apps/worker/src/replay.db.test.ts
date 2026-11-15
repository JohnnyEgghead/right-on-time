// SPDX-License-Identifier: AGPL-3.0-or-later
// The replay of a forward clock jump (SPECIFICATIONS section 5.2 step 6; FR-DEMO-3) through the worker as main.ts starts
// it: the real job registry (the event dispatcher and the clock job), the login bw_worker and DbClock on the clock row,
// with 1 fixed real time. The jump itself is API-12's handler on the web login, as the kernel runs it. The test waits for
// the clock job to end the replay (the clock row's replay_target cleared), with a deadline; it never sleeps.
// Run by gate G-CI2 (ci/gates/G-CI2/vitest.db.config.ts: apps/worker/src/*.db.test.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient, decodeNotification, inTransaction } from '@bw/db';
import { Temporal } from '@bw/time';
import { jumpClockHandler } from '../../../packages/api-server/src/handlers/clock-moves.ts';
import type { ApiRequest, HandlerContext } from '../../../packages/api-server/src/types.ts';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { catalogs as realCatalogs } from '../../../packages/i18n/src/catalog.ts';
import { planReminder, sendConfirmation, type TextContext } from '../../../packages/outbox/src/index.ts';
import { addCustomer, addJob, I, loginPool, seedOutboxWorld, setDemoClock, type OutboxRef } from '../../../packages/outbox/src/testing/world.ts';
import { REPLAY_BATCH } from './clock/replay.ts';
import { startTestWorker, type TestWorker } from './testing/worker.ts';

const REAL = Temporal.Instant.from('2026-11-01T16:00:00Z');
const db = useMigratedDatabase();
let ref: OutboxRef;
let web: ReturnType<typeof loginPool>;
let worker: TestWorker;
const ctx: TextContext = { catalogs: { en: { ...realCatalogs.en, 't.k': 'furnace tune-up' }, es: { ...realCatalogs.es, 't.k': 'ajuste de calefactor' } }, linkHost: 'bw.j7l.io' };

beforeAll(async () => {
  ref = await seedOutboxWorld(db.admin(), '2026-09-15T13:00:00Z');
  web = loginPool(db.url(), 'bw_web');
  worker = await startTestWorker(db.url(), {}, { real: () => REAL });
});
afterAll(async () => {
  await worker?.stop();
  await web?.end();
});

/** API-12 as the kernel runs it: the manager Dana Ruiz (the reference fixture's user) jumps the clock to `to`. */
async function jump(to: string): Promise<{ status: number; data?: unknown; code?: string }> {
  const req = {
    contract: 'API-12', params: { to }, body: null, worldEpoch: 1, demoNow: REAL,
    caller: { kind: 'staff', userId: ref.userId, role: 'manager', client: 'web', via: 'password' },
  } as unknown as ApiRequest;
  const hctx = { settings: {}, clock: { realNow: () => REAL }, accessKey: null, secure: false, presented: null, events: null } as unknown as HandlerContext;
  const r = await inTransaction(web, (tx) => jumpClockHandler(req, tx, hctx));
  return r.ok ? { status: r.status, data: r.data } : { status: r.status, code: r.code };
}

/** Wait (bounded) for the clock job to end the replay. */
async function replayEnded(): Promise<void> {
  await vi.waitFor(async () => {
    const r = await db.admin().query<{ replay_target: Date | null }>('SELECT replay_target FROM system.demo_clock WHERE id = 1');
    if (r.rows[0]!.replay_target !== null) throw new Error('the replay is still running');
  }, { timeout: 30_000, interval: 10 });
}

const clockRow = async () =>
  (await db.admin().query(`SELECT demo_anchor, paused, replay_target, replay_done, replay_total, last_move_by_name, last_move_kind, last_move_to
                             FROM system.demo_clock WHERE id = 1`)).rows[0];

describe('a forward jump replays every due event in time order (FR-DEMO-3)', () => {
  // why: FR-DEMO-3, FR-TEXT-2, F-442
  it('a 9:00 AM to 6:05 PM jump runs 3 due events in their due order, each at its own time: the reminder is stamped 6:00 PM', async () => {
    const a = db.admin();
    await setDemoClock(a, '2026-09-15T13:00:00Z'); // 9:00 AM EDT
    const booked = await addCustomer(a, ref, { name: 'Booked Today' });
    const halifax = await addCustomer(a, ref, { zone: 'America/Halifax', name: 'Atlantic Customer' });
    const ny = await addCustomer(a, ref, { name: 'Eastern Customer' });
    const jobs = { booked: await addJob(a, ref, booked, '2026-09-17'), halifax: await addJob(a, ref, halifax, '2026-09-16'), ny: await addJob(a, ref, ny, '2026-09-16') };
    // Written in the reverse of their due order: the NY reminder (6:00 PM EDT), the Halifax one (6:00 PM ADT = 5:00 PM
    // EDT) and a confirmation booked at 2:00 PM EDT.
    await inTransaction(web, (tx) => planReminder(tx, { jobNumber: jobs.ny, now: I('2026-09-15T13:00:00Z') }));
    await inTransaction(web, (tx) => planReminder(tx, { jobNumber: jobs.halifax, now: I('2026-09-15T13:00:00Z') }));
    const conf = await inTransaction(web, (tx) => sendConfirmation(tx, ctx, { jobNumber: jobs.booked, now: I('2026-09-15T18:00:00Z') }));
    if (!conf.ok) throw new Error(conf.reason);
    const due = await a.query<{ id: string; due_at: Date }>(`SELECT id, due_at FROM world.scheduled_event WHERE state = 'due' ORDER BY due_at`);
    expect(due.rows.map((r) => r.due_at)).toEqual([new Date('2026-09-15T18:00:00Z'), new Date('2026-09-15T21:00:00Z'), new Date('2026-09-15T22:00:00Z')]);

    const r = await jump('2026-09-15T18:05:00-04:00[America/New_York]');
    expect(r).toEqual({ status: 202, data: { replay: { running: true, done: 0, total: 3 } } });
    await replayEnded();

    // Each of the 3 ran at its own due time, never at the jump's 6:05 PM.
    const ran = await a.query<{ run_at: Date; state: string }>(`SELECT run_at, state FROM world.scheduled_event WHERE id = ANY($1::uuid[]) ORDER BY due_at`, [due.rows.map((x) => x.id)]);
    expect(ran.rows).toEqual(due.rows.map((x) => ({ run_at: x.due_at, state: 'done' })));
    const texts = await a.query<{ customer_id: string; kind: string; created_at: Date; delivered_at: Date | null }>(
      `SELECT customer_id, kind, created_at, delivered_at FROM world.outbox_text WHERE customer_id = ANY($1::uuid[]) ORDER BY created_at`, [[booked, halifax, ny]]);
    expect(texts.rows).toEqual([
      { customer_id: booked, kind: 'confirmation', created_at: new Date('2026-09-15T18:00:00Z'), delivered_at: new Date('2026-09-15T18:00:00Z') },
      { customer_id: halifax, kind: 'reminder', created_at: new Date('2026-09-15T21:00:00Z'), delivered_at: new Date('2026-09-15T21:00:00Z') },
      // F-442 / FR-TEXT-2: the 9:00 AM to 6:05 PM jump stamps the Eastern reminder 6:00 PM, and its try (an event the
      // replay itself created) joins the same ordered replay.
      { customer_id: ny, kind: 'reminder', created_at: new Date('2026-09-15T22:00:00Z'), delivered_at: new Date('2026-09-15T22:00:00Z') },
    ]);
    // The clock is at the target, running, and the banner names the mover.
    expect(await clockRow()).toMatchObject({
      demo_anchor: new Date('2026-09-15T22:05:00Z'), paused: false, replay_target: null,
      last_move_by_name: 'Dana Ruiz', last_move_kind: 'jump', last_move_to: new Date('2026-09-15T22:05:00Z'),
    });
    const c = await clockRow();
    expect(c!.replay_done).toBe(c!.replay_total);
    expect(c!.replay_done).toBeGreaterThanOrEqual(5); // the 3 above and the 2 reminder tries they made due
    const move = await a.query(`SELECT kind, by_name, from_demo, to_demo FROM system.clock_move ORDER BY at_real DESC, id DESC LIMIT 1`);
    expect(move.rows[0]).toEqual({ kind: 'jump', by_name: 'Dana Ruiz', from_demo: new Date('2026-09-15T13:00:00Z'), to_demo: new Date('2026-09-15T22:05:00Z') });
  });

  // why: FR-DEMO-3
  it('replays in capped batches of 50 and publishes its progress after each batch', async () => {
    const a = db.admin();
    await setDemoClock(a, '2026-09-16T13:00:00Z');
    const n = 2 * REPLAY_BATCH + 20;
    // n due events 1 minute apart (tries of texts that no longer exist: each runs and is skipped).
    await a.query(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state)
                   SELECT '2026-09-16T13:00:00Z'::timestamptz + make_interval(mins => g), 'text.try', 'gone', jsonb_build_object('textId', gen_random_uuid(), 'number', 1), 'due'
                     FROM generate_series(1, $1) g`, [n]);
    const listen = createClient({ connectionString: db.url() });
    await listen.connect();
    const seen: { done: number; total: number }[] = [];
    listen.on('notification', (m) => {
      if (decodeNotification(m.payload)?.name !== 'clock.changed') return;
      // Read on the listening connection itself (it queues), never on the file's shared one.
      void listen.query<{ replay_done: number; replay_total: number }>('SELECT replay_done, replay_total FROM system.demo_clock WHERE id = 1')
        .then((r) => seen.push({ done: r.rows[0]!.replay_done, total: r.rows[0]!.replay_total }))
        // A notification that arrives as the test ends queues a read the end() below terminates; it counts for nothing.
        .catch(() => undefined);
    });
    await listen.query('LISTEN bw_events');
    try {
      expect((await jump('2026-09-17T08:00:00-04:00[America/New_York]')).status).toBe(202);
      await replayEnded();
      await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(4), { timeout: 5_000, interval: 10 });
    } finally {
      listen.removeAllListeners('notification');
      await listen.end();
    }
    // 3 batches (50, 50, 20), each with its own clock.changed, then the end of the replay.
    expect(await a.query(`SELECT count(*)::int AS n FROM world.scheduled_event WHERE subject = 'gone' AND state = 'skipped'`)).toMatchObject({ rows: [{ n }] });
    const c = await clockRow();
    expect(c).toMatchObject({ replay_done: n, replay_total: n, paused: false });
    expect(Math.max(...seen.map((s) => s.done))).toBe(n);
  });

  // why: FR-DEMO-3, F-435
  it('runs the 5-minute alert check at its own due time and once at the jump target, never once per skipped 5 minutes', async () => {
    const a = db.admin();
    await setDemoClock(a, '2026-09-18T13:00:00Z');
    await a.query(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ('2026-09-18T13:05:00Z', 'alert.check', 'alerts', '{}', 'due')`);
    expect((await jump('2026-09-19T13:00:00-04:00[America/New_York]')).status).toBe(202);
    await replayEnded();
    const checks = await a.query<{ due_at: Date; state: string; run_at: Date | null }>(
      `SELECT due_at, state, run_at FROM world.scheduled_event WHERE kind = 'alert.check' AND due_at >= '2026-09-18T13:00:00Z' ORDER BY due_at`);
    expect(checks.rows).toEqual([
      { due_at: new Date('2026-09-18T13:05:00Z'), state: 'done', run_at: new Date('2026-09-18T13:05:00Z') },
      { due_at: new Date('2026-09-19T17:00:00Z'), state: 'done', run_at: new Date('2026-09-19T17:00:00Z') },
      { due_at: new Date('2026-09-19T17:05:00Z'), state: 'due', run_at: null },
    ]);
    // F-463: the replay never marks an alert.check skipped, so the chain keeps exactly 1 due event.
    expect(await a.query(`SELECT count(*)::int AS n FROM world.scheduled_event WHERE kind = 'alert.check' AND state = 'skipped'`)).toMatchObject({ rows: [{ n: 0 }] });
  });

  // why: FR-DEMO-3, F-538
  it('runs the 5-minute eta.sweep at its own due time and once at the jump target: a jump of 288 intervals runs it 2 times, not 288', async () => {
    const a = db.admin();
    await setDemoClock(a, '2026-09-20T13:00:00Z');
    await a.query(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ('2026-09-20T13:05:00Z', 'eta.sweep', 'eta', '{}', 'due')`);
    // Sun, Sep 20, 9:00 AM to Mon, Sep 21, 9:00 AM EDT: 24 hours, 288 sweep intervals.
    expect((await jump('2026-09-21T09:00:00-04:00[America/New_York]')).status).toBe(202);
    await replayEnded();
    const sweeps = await a.query<{ due_at: Date; state: string; run_at: Date | null }>(
      `SELECT due_at, state, run_at FROM world.scheduled_event WHERE kind = 'eta.sweep' AND due_at >= '2026-09-20T13:00:00Z' ORDER BY due_at`);
    expect(sweeps.rows).toEqual([
      { due_at: new Date('2026-09-20T13:05:00Z'), state: 'done', run_at: new Date('2026-09-20T13:05:00Z') },
      { due_at: new Date('2026-09-21T13:00:00Z'), state: 'done', run_at: new Date('2026-09-21T13:00:00Z') },
      { due_at: new Date('2026-09-21T13:05:00Z'), state: 'due', run_at: null },
    ]);
    expect(await a.query(`SELECT count(*)::int AS n FROM world.scheduled_event WHERE kind = 'eta.sweep' AND state = 'skipped'`)).toMatchObject({ rows: [{ n: 0 }] });
  });
});
