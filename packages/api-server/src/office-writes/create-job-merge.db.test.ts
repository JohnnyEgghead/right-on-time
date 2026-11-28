// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-680 (createJob re-reads the customer's status after its INSERT, so a booking that waited on a merge is refused)
// 2 database sessions on the real database (PostgreSQL 18, the migrated schema, the reference seed). The plant: with the status read
// before the locks only, the INSERT waits on the merge's FOR UPDATE, goes ahead when it commits, and leaves a scheduled job on a merged
// customer. Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts) with the other api-server database tests.
import { inTransaction } from '@bw/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { createJob, moveJobsToCustomer } from './service.ts';
import { officeWorld, type OfficeWorld } from './testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;

beforeAll(async () => {
  world = await officeWorld(db, 4);
}, 120_000);
afterAll(async () => {
  await world?.close();
});

const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lockWaiters = async () => Number((await rows<{ n: string }>(
  `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple')`))[0]?.n);

describe('createJob against a merge of the same customer (F-680)', () => {
  // why: F-680 a booking for record B that waits on the merge's FOR UPDATE on B must not leave a scheduled job on the merged record
  it('refuses with rule_refused and writes no job when the customer is merged while the INSERT waits', async () => {
    const [a, b] = [world.customers[0] as string, world.customers[1] as string];
    const win = world.windows.get('two_hour 08:00') as string;
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const merging = inTransaction(world.web, async (tx) => {
      await tx.query('SELECT 1 FROM world.customer WHERE id = $1 FOR UPDATE', [b]);
      await tx.query(`UPDATE world.customer SET status = 'merged', merged_into = $1 WHERE id = $2`, [a, b]);
      await released;
    });
    await sleep(150);
    // The merge's UPDATE is uncommitted, so the booking's status read still sees 'active'.
    const booking = inTransaction(world.web, (tx) => createJob(tx, { actor: { kind: 'office', userId: world.staff.keisha.userId }, at: new Date('2026-09-15T12:00:00Z') }, {
      customerId: b, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: '2026-10-22', windowId: win, technicianId: null,
    }));
    const outcome = booking.then(() => 'done', () => 'refused');
    for (let i = 0; (await lockWaiters()) < 1; i++) {
      if (i > 400) throw new Error('the booking never waited on the merge');
      await sleep(25);
    }
    release();
    await merging;
    expect(await outcome).toBe('refused');
    await expect(booking).rejects.toMatchObject({ code: 'rule_refused' });
    expect(await rows('SELECT 1 FROM world.job WHERE customer_id = $1', [b])).toEqual([]);
  });
});

describe('a merge plans again only open jobs from today on (F-2012 K-09.3)', () => {
  // why: F-2012 K-09.3 a merge that moves a past done job must leave the plan that day ran on as it was
  it("moves a past done job and leaves its day's planned arrival unchanged, while an open job from today on is planned again", async () => {
    const [from, to] = [world.customers[2] as string, world.customers[3] as string];
    const points = await rows<{ lon: number; lat: number }>('SELECT lon, lat FROM world.customer WHERE id = ANY($1::uuid[])', [[from, to]]);
    expect(new Set(points.map((p) => `${p.lon},${p.lat}`)).size).toBe(2); // the kept record is at another point, so a plan again would move
    const kevin = world.technicians.get('Kevin Doyle') as string;
    const ctx = { actor: { kind: 'office' as const, userId: world.staff.keisha.userId }, at: new Date('2026-09-15T11:00:00Z') };
    const book = (date: string) => inTransaction(world.web, (tx) => createJob(tx, ctx, {
      customerId: from, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date, windowId: world.windows.get('two_hour 10:00') as string, technicianId: kevin,
    }));
    const past = await book('2026-10-23');
    const open = await book('2026-10-23');
    // A plan no settle would write (6:13 AM), so any plan again shows. The past job is made the one Mon, Sep 14 ran on, and Done
    // with its billing item (migration 0012 refuses a done job without one at commit).
    const stale = new Date('2026-09-14T10:13:00Z');
    await rows(`WITH j AS (UPDATE world.job SET date = '2026-09-14', status = 'done', planned_arrival = $2 WHERE job_number = $1 RETURNING job_number)
                INSERT INTO world.billing_item (job_number, state, tries) SELECT job_number, 'in_billing', 1 FROM j`, [past.jobNumber, stale]);
    await rows('UPDATE world.job SET planned_arrival = $2 WHERE job_number = $1', [open.jobNumber, new Date('2026-10-23T10:13:00Z')]);

    const moved = await inTransaction(world.web, (tx) => moveJobsToCustomer(tx, {
      from, to, jobNumbers: null, mergeId: 'k-09-3-merge', step: 'merge', by: null, at: ctx.at,
    }));
    expect(moved).toEqual([past.jobNumber, open.jobNumber].sort((x, y) => x - y));
    const after = await rows<{ job_number: number; customer_id: string; planned_arrival: Date }>(
      'SELECT job_number, customer_id, planned_arrival FROM world.job WHERE job_number = ANY($1::int[]) ORDER BY job_number', [moved]);
    expect(after.every((j) => j.customer_id === to)).toBe(true);
    const plan = new Map(after.map((j) => [j.job_number, j.planned_arrival.getTime()]));
    expect(plan.get(past.jobNumber)).toBe(stale.getTime());
    expect(plan.get(open.jobNumber)).not.toBe(new Date('2026-10-23T10:13:00Z').getTime());
  });
});
