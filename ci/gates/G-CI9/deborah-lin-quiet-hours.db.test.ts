// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G-CI9, inv9-quiet-hours (P3-OUTBOX; SPECIFICATIONS section 14 item 9, invariant 9; FR-TEXT-7; UC-14).
// Run by ci/gates/G-CI9.sh under every host zone of NFR-08's matrix (UTC, America/New_York, America/Los_Angeles), with
// the database session zone moved to the host zone too, through the real paths: enqueueText as bw_web, the worker as
// main.ts starts it (the job registry, bw_worker, DbClock on system.demo_clock), the clock row moved by the test.
// P3-REPLAY adds its clock-jump replay case as another *.test.ts file in this folder.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../../../packages/db/src/client.ts';
import { useMigratedDatabase } from '../../../packages/db/src/testing/fixture.ts';
import { enqueueText, scheduleTry, tryNow } from '../../../packages/outbox/src/index.ts';
import {
  addCustomer, addJob, attemptsOf, confirmationValues, count, hostZone, I, loginPool, seedOutboxWorld, setDemoClock, setSimulator,
  testCatalog, textRow, type OutboxRef,
} from '../../../packages/outbox/src/testing/world.ts';
import { startTestWorker, type TestWorker } from '../../../apps/worker/src/testing/worker.ts';

const db = useMigratedDatabase();
let ref: OutboxRef;
let web: ReturnType<typeof loginPool>;
let worker: TestWorker;
let deborah: string;

beforeAll(async () => {
  ref = await seedOutboxWorld(db.admin());
  web = loginPool(db.url(), 'bw_web');
  worker = await startTestWorker(db.url());
  // UC-14: a Grandview landlord who lives in the Pacific zone.
  deborah = await addCustomer(db.admin(), ref, { name: 'Deborah Lin', zone: 'America/Los_Angeles' });
});
afterAll(async () => {
  await worker?.stop();
  await web?.end();
});

const inbox = (textId: string) =>
  db.admin().query<{ at: Date }>(`SELECT at FROM world.inbox_message WHERE text_id = $1 AND direction = 'out'`, [textId]).then((r) => r.rows.map((x) => x.at.toISOString()));

async function at(t: string): Promise<void> {
  await setDemoClock(db.admin(), t);
  await worker.drain();
}

async function confirm(customerId: string, now: string): Promise<string> {
  const jobNumber = await addJob(db.admin(), ref, customerId);
  await setDemoClock(db.admin(), now);
  const r = await inTransaction(web, (tx) =>
    enqueueText(tx, { kind: 'confirmation', customerId, jobNumber, now: I(now), catalog: testCatalog, values: confirmationValues }),
  );
  if (!r.ok) throw new Error(`not enqueued: ${r.reason}`);
  return r.textId;
}

describe('G-CI9: no text between 9 PM and 8 AM in the customer zone, under every host zone (invariant 9)', () => {
  // why: NFR-08
  it('runs with the host zone and the database session zone both in the zone this run was started under', async () => {
    const want = process.env.BW_EXPECT_TZ;
    if (want) expect(hostZone()).toBe(want);
    const r = await worker.pool.query<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`);
    expect(r.rows[0]?.tz).toBe(hostZone());
  });

  // why: UC-14
  it('holds Deborah Lin\'s 10:29 AM EDT booking text to 8:00 AM Pacific (11:00 AM EDT) and sends it then', async () => {
    const textId = await confirm(deborah, '2026-09-15T14:29:00Z');
    expect(await textRow(db.admin(), textId)).toMatchObject({
      status: 'held', held_until: new Date('2026-09-15T15:00:00Z'), next_try_at: new Date('2026-09-15T15:00:00Z'),
    });
    await at('2026-09-15T14:29:00Z');
    await at('2026-09-15T14:59:59Z');
    expect(await attemptsOf(db.admin(), textId)).toEqual([]);
    expect(await inbox(textId)).toEqual([]);
    // why: FR-TEXT-7
    await at('2026-09-15T15:00:00Z');
    expect(await attemptsOf(db.admin(), textId)).toEqual([[1, '2026-09-15T15:00:00Z', 'delivered']]);
    expect(await inbox(textId)).toEqual(['2026-09-15T15:00:00.000Z']);
    expect(await textRow(db.admin(), textId)).toMatchObject({ status: 'delivered', delivered_at: new Date('2026-09-15T15:00:00Z') });
  });

  // why: FR-TEXT-7
  it('rechecks quiet hours at the try itself: a try that comes due in quiet hours is held, never sent', async () => {
    // A queued text whose try event sits at 9:30 PM Pacific (as a clock jump or a stopped worker would leave it): the
    // try runs then, sees quiet hours in her zone, and moves itself to the next 8:00 AM, with no attempt.
    const textId = await confirm(deborah, '2026-09-15T16:00:00Z'); // 9:00 AM Pacific: queued, try 1 due at once
    await db.admin().query(`UPDATE world.scheduled_event SET state = 'skipped' WHERE subject = $1`, [textId]);
    await inTransaction(web, (tx) => scheduleTry(tx, I('2026-09-16T04:30:00Z'), { textId, number: 1 })); // 9:30 PM PDT
    await at('2026-09-16T04:30:00Z');
    expect(await attemptsOf(db.admin(), textId)).toEqual([]);
    expect(await textRow(db.admin(), textId)).toMatchObject({ status: 'held', held_until: new Date('2026-09-16T15:00:00Z') });
    await at('2026-09-16T14:59:00Z');
    expect(await attemptsOf(db.admin(), textId)).toEqual([]);
    await at('2026-09-16T15:00:00Z');
    expect(await attemptsOf(db.admin(), textId)).toEqual([[1, '2026-09-16T15:00:00Z', 'delivered']]);
  });

  // why: FR-TEXT-7
  it('never sends a text held at 9:05 PM before 8:00 AM, even when the clock jumps to 7:59 AM', async () => {
    const textId = await confirm(deborah, '2026-09-16T04:05:00Z'); // Tue 9:05 PM PDT
    await at('2026-09-16T14:59:00Z'); // jump to Wed 7:59 AM PDT
    expect(await attemptsOf(db.admin(), textId)).toEqual([]);
    await at('2026-09-16T15:00:00Z');
    expect(await attemptsOf(db.admin(), textId)).toEqual([[1, '2026-09-16T15:00:00Z', 'delivered']]);
  });

  // why: FR-TEXT-7
  it('never sends a held text in the next night\'s quiet hours when a jump passes its 8:00 AM release', async () => {
    const textId = await confirm(deborah, '2026-09-19T04:05:00Z'); // Fri 9:05 PM PDT: held to Sat 8:00 AM
    await at('2026-09-20T05:00:00Z'); // jump to Sat 10:00 PM PDT: its try is due, and it is quiet again
    expect(await attemptsOf(db.admin(), textId)).toEqual([]);
    expect(await textRow(db.admin(), textId)).toMatchObject({ status: 'held', held_until: new Date('2026-09-20T15:00:00Z') });
    await at('2026-09-20T15:00:00Z'); // Sun 8:00 AM PDT
    expect(await attemptsOf(db.admin(), textId)).toEqual([[1, '2026-09-20T15:00:00Z', 'delivered']]);
  });

  // why: FR-TEXT-24
  it('holds Try now in quiet hours to 8:00 AM in the customer zone (OI-23)', async () => {
    // Tries 1 to 4 fail at 8:50, 8:52, 8:54 and 8:59 PM PDT; try 5 (9:09 PM) is planned at 8:00 AM.
    await setSimulator(db.admin(), 'all_fail');
    const textId = await confirm(deborah, '2026-09-18T03:50:00Z');
    for (const t of ['2026-09-18T03:50:00Z', '2026-09-18T03:52:00Z', '2026-09-18T03:54:00Z', '2026-09-18T03:59:00Z']) await at(t);
    expect(await textRow(db.admin(), textId)).toMatchObject({ status: 'retrying', tries: 4, next_try_at: new Date('2026-09-18T15:00:00Z') });
    await setSimulator(db.admin(), 'up');
    // Try now at 9:30 PM PDT: quiet hours, so the try waits for 8:00 AM Pacific and the answer says so.
    await setDemoClock(db.admin(), '2026-09-18T04:30:00Z');
    const r = await inTransaction(web, (tx) => tryNow(tx, { textId, by: ref.userId, now: I('2026-09-18T04:30:00Z') }));
    expect(r).toMatchObject({ ok: true, number: 5, heldUntil: I('2026-09-18T15:00:00Z') });
    await at('2026-09-18T04:30:00Z');
    await at('2026-09-18T14:59:00Z');
    expect((await attemptsOf(db.admin(), textId)).length).toBe(4);
    await at('2026-09-18T15:00:00Z');
    expect((await attemptsOf(db.admin(), textId)).slice(4)).toEqual([[5, '2026-09-18T15:00:00Z', 'delivered']]);
    expect(await count(db.admin(), `SELECT count(*) AS n FROM world.text_attempt WHERE text_id = $1 AND "by" = $2`, [textId, ref.userId])).toBe(1);
  });
});
