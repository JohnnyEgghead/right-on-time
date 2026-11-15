// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G-CI9, inv9-quiet-hours: P3-REPLAY's clock-jump case (BUILD_PLAN D-15; SPECIFICATIONS section 5.2 steps 3 and 6,
// invariant 9; F-1545: the held text is of a kind that is not exempt, on-the-way-exempt.db.test.ts has the exempt kind). A forward jump across 9:00 PM replays every due event at its own due time, so the quiet-hours check of
// each try runs at that time and a held text is never sent before 8:00 AM in the customer's zone. Run by
// ci/gates/G-CI9.sh under every host zone of NFR-08's matrix, through the real paths: enqueueText as bw_web, API-12's
// handler as the kernel runs it (bw_web), and the worker as main.ts starts it (the job registry with the clock job that
// runs the replay, bw_worker, DbClock on system.demo_clock), with 1 fixed real time.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inTransaction } from '../../../packages/db/src/client.ts';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { enqueueText } from '../../../packages/outbox/src/index.ts';
import {
  addCustomer, addJob, attemptsOf, confirmationValues, hostZone, I, loginPool, seedOutboxWorld, setDemoClock, setSimulator, testCatalog, textRow,
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

async function text(customerId: string, now: string): Promise<string> {
  const jobNumber = await addJob(db.admin(), ref, customerId, '2026-09-17');
  const r = await inTransaction(web, (tx) =>
    enqueueText(tx, { kind: 'confirmation', customerId, jobNumber, now: I(now), catalog: testCatalog, values: confirmationValues }));
  if (!r.ok) throw new Error(`not enqueued: ${r.reason}`);
  return r.textId;
}

describe('G-CI9 clock-jump case: a jump across 9 PM never sends a held text early (invariant 9, section 5.2 step 6)', () => {
  // why: NFR-08
  it('runs with the host zone and the database session zone both in the zone this run was started under', async () => {
    const want = process.env.BW_EXPECT_TZ;
    if (want) expect(hostZone()).toBe(want);
    const r = await worker.pool.query<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`);
    expect(r.rows[0]?.tz).toBe(hostZone());
  });

  // why: FR-DEMO-3, FR-TEXT-7
  it('replays an 8:50 PM to 7:59 AM jump: 8:55 PM sends, 9:05 PM and a retry pushed past 9 PM wait, then all go at 8:00 AM', async () => {
    await setDemoClock(db.admin(), '2026-09-16T00:50:00Z');
    const ny = await addCustomer(db.admin(), ref, { name: 'Eastern Evening' });
    const late = await addCustomer(db.admin(), ref, { name: 'Eastern Late' });
    const retry = await addCustomer(db.admin(), ref, { name: 'Eastern Retry' });
    const deborah = await addCustomer(db.admin(), ref, { name: 'Deborah Lin', zone: 'America/Los_Angeles' });
    const before9 = await text(ny, '2026-09-16T00:55:00Z'); // 8:55 PM EDT: sendable
    const after9 = await text(late, '2026-09-16T01:05:00Z'); // 9:05 PM EDT: held to 8:00 AM EDT
    const pacific = await text(deborah, '2026-09-16T01:05:00Z'); // 6:05 PM PDT: sendable in her zone
    const retried = await text(retry, '2026-09-16T00:58:00Z'); // 8:58 PM: its first try fails; try 2 (+2 min) is 9:00 PM
    expect(await textRow(db.admin(), after9)).toMatchObject({ status: 'held', held_until: new Date('2026-09-16T12:00:00Z') });
    await setSimulator(db.admin(), 'fail_customer', { customerId: retry });

    await jump('2026-09-16T07:59:00-04:00[America/New_York]');
    expect(await attemptsOf(db.admin(), before9)).toEqual([[1, '2026-09-16T00:55:00Z', 'delivered']]);
    expect(await attemptsOf(db.admin(), pacific)).toEqual([[1, '2026-09-16T01:05:00Z', 'delivered']]);
    // The held text and the pushed retry: no try at all before 8:00 AM, though the jump passed every hour between.
    expect(await attemptsOf(db.admin(), after9)).toEqual([]);
    expect(await attemptsOf(db.admin(), retried)).toEqual([[1, '2026-09-16T00:58:00Z', 'failed']]);
    expect((await textRow(db.admin(), after9)).status).toBe('held');

    await setSimulator(db.admin(), 'up');
    await jump('2026-09-16T08:30:00-04:00[America/New_York]');
    expect(await attemptsOf(db.admin(), after9)).toEqual([[1, '2026-09-16T12:00:00Z', 'delivered']]);
    expect(await attemptsOf(db.admin(), retried)).toEqual([[1, '2026-09-16T00:58:00Z', 'failed'], [2, '2026-09-16T12:00:00Z', 'delivered']]);
    expect(await textRow(db.admin(), after9)).toMatchObject({ status: 'delivered', delivered_at: new Date('2026-09-16T12:00:00Z') });
  });
});
