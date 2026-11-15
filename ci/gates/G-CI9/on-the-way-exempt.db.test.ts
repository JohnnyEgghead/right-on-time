// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G-CI9, inv9-quiet-hours: the exempt kinds (F-1545; owner ruling Nov 13 2026: "On the way" text messages are not held
// for quiet hours). An on-the-way text goes at its due time at any hour, with its retries on the 0, 2, 4, 9 and 19 minute
// schedule, while every other kind keeps the 9:00 PM to 8:00 AM hold. Same paths as clock-jump.db.test.ts: enqueueText as
// bw_web, API-12's handler, the worker as main.ts starts it, under every host zone of NFR-08's matrix.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inTransaction } from '../../../packages/db/src/client.ts';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { enqueueText } from '../../../packages/outbox/src/index.ts';
import {
  addCustomer, addJob, attemptsOf, confirmationValues, I, loginPool, seedOutboxWorld, setDemoClock, setSimulator, testCatalog, textRow,
  type OutboxRef,
} from '../../../packages/outbox/src/testing/world.ts';
import { jumpClockHandler } from '../../../packages/api-server/src/handlers/clock-moves.ts';
import type { ApiRequest, HandlerContext } from '../../../packages/api-server/src/types.ts';
import { Temporal } from '../../../packages/time/src/index.ts';
import { startTestWorker, type TestWorker } from '../../../apps/worker/src/testing/worker.ts';

const REAL = Temporal.Instant.from('2026-11-01T16:00:00Z');
const db = useMigratedDatabase();
let ref: OutboxRef;
let web: ReturnType<typeof loginPool>;
let worker: TestWorker;

beforeAll(async () => {
  ref = await seedOutboxWorld(db.admin(), '2026-09-16T00:50:00Z'); // Tue, Sep 15, 8:50 PM EDT
  web = loginPool(db.url(), 'bw_web');
  worker = await startTestWorker(db.url(), {}, { real: () => REAL });
});
afterAll(async () => {
  await worker?.stop();
  await web?.end();
});

async function jump(to: string): Promise<void> {
  const req = {
    contract: 'API-12', params: { to }, body: null, worldEpoch: 1, demoNow: REAL,
    caller: { kind: 'staff', userId: ref.userId, role: 'manager', client: 'web', via: 'password' },
  } as unknown as ApiRequest;
  const hctx = { settings: {}, clock: { realNow: () => REAL }, accessKey: null, secure: false, presented: null, events: null } as unknown as HandlerContext;
  const r = await inTransaction(web, (tx) => jumpClockHandler(req, tx, hctx));
  if (!r.ok || r.status !== 202) throw new Error(`the jump to ${to} answered ${r.status}`);
  await vi.waitFor(async () => {
    const c = await db.admin().query<{ replay_target: Date | null }>('SELECT replay_target FROM system.demo_clock WHERE id = 1');
    if (c.rows[0]!.replay_target !== null) throw new Error('the replay is still running');
  }, { timeout: 30_000, interval: 10 });
}

async function enqueue(kind: 'on_the_way' | 'late' | 'confirmation', customerId: string, now: string) {
  const jobNumber = await addJob(db.admin(), ref, customerId, '2026-09-17');
  const values = kind === 'on_the_way' ? { tech: 'Maria', arrival: '9:45 PM', mapLink: 'bw.j7l.io/m/AbC12345' }
    : kind === 'late' ? { tech: 'Maria', arrival: '9:45 PM' } : confirmationValues;
  const r = await inTransaction(web, (tx) => enqueueText(tx, { kind, customerId, jobNumber, now: I(now), catalog: testCatalog, values }));
  if (!r.ok) throw new Error(`not enqueued: ${r.reason}`);
  return r;
}

describe('G-CI9 exempt kinds: an on-the-way text is never held for quiet hours (F-1545)', () => {
  // why: FR-TEXT-7, F-1545
  it('queues an on-the-way text at 9:30 PM and delivers it then, while a confirmation of the same minute waits for 8:00 AM', async () => {
    await setDemoClock(db.admin(), '2026-09-16T00:50:00Z');
    const way = await addCustomer(db.admin(), ref, { name: 'Eastern On The Way' });
    const lateC = await addCustomer(db.admin(), ref, { name: 'Eastern Late' });
    const conf = await addCustomer(db.admin(), ref, { name: 'Eastern Confirmation' });
    const onTheWay = await enqueue('on_the_way', way, '2026-09-16T01:30:00Z'); // 9:30 PM EDT
    // why: FR-TEXT-7, F-1545 (e): the owner's answer c40c66e2, the late text skips quiet hours too.
    const late = await enqueue('late', lateC, '2026-09-16T01:30:00Z');
    expect(late).toMatchObject({ status: 'queued', heldUntil: null });
    const confirmation = await enqueue('confirmation', conf, '2026-09-16T01:30:00Z');
    expect(onTheWay).toMatchObject({ status: 'queued', heldUntil: null });
    expect(await textRow(db.admin(), onTheWay.textId)).toMatchObject({ status: 'queued', held_until: null, reason_key: null });
    // why: FR-TEXT-7, F-1545 (c)
    expect(confirmation).toMatchObject({ status: 'held' });
    expect(await textRow(db.admin(), confirmation.textId)).toMatchObject({ status: 'held', held_until: new Date('2026-09-16T12:00:00Z') });

    // why: FR-TEXT-7, F-1545 (d): the jump passes 9 PM and every hour to 7:59 AM; only the exempt text goes before 8:00 AM.
    await jump('2026-09-16T07:59:00-04:00[America/New_York]');
    expect(await attemptsOf(db.admin(), onTheWay.textId)).toEqual([[1, '2026-09-16T01:30:00Z', 'delivered']]);
    expect(await textRow(db.admin(), onTheWay.textId)).toMatchObject({ status: 'delivered', delivered_at: new Date('2026-09-16T01:30:00Z') });
    expect(await attemptsOf(db.admin(), late.textId)).toEqual([[1, '2026-09-16T01:30:00Z', 'delivered']]);
    expect(await attemptsOf(db.admin(), confirmation.textId)).toEqual([]);
    expect((await textRow(db.admin(), confirmation.textId)).status).toBe('held');

    await jump('2026-09-16T08:30:00-04:00[America/New_York]');
    expect(await attemptsOf(db.admin(), confirmation.textId)).toEqual([[1, '2026-09-16T12:00:00Z', 'delivered']]);
  });

  // why: FR-TEXT-7, F-1545 (b)
  it('retries a failed on-the-way try at 8:55 PM at +2, +4, +9 and +19 minutes, not at 8:00 AM', async () => {
    const retry = await addCustomer(db.admin(), ref, { name: 'Eastern Way Retry' });
    const onTheWay = await enqueue('on_the_way', retry, '2026-09-17T00:55:00Z'); // 8:55 PM EDT Sep 16
    await setSimulator(db.admin(), 'fail_customer', { customerId: retry });
    await jump('2026-09-16T21:30:00-04:00[America/New_York]');
    expect(await attemptsOf(db.admin(), onTheWay.textId)).toEqual([
      [1, '2026-09-17T00:55:00Z', 'failed'], [2, '2026-09-17T00:57:00Z', 'failed'], [3, '2026-09-17T00:59:00Z', 'failed'],
      [4, '2026-09-17T01:04:00Z', 'failed'], [5, '2026-09-17T01:14:00Z', 'failed'],
    ]);
    await setSimulator(db.admin(), 'up');
  });
});
