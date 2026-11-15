// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-379, F-622 (mergePair takes the technician-day locks before the pair and customer rows, and a day beyond them in sorted order)
// 2 and 3 database sessions on the real database (PostgreSQL 18, the migrated schema, the reference seed), SPECIFICATIONS section 5.3
// step 6: booking-day rows, then technician-day locks, then job or customer rows, always. Each test has a plant: on the order before
// this fix (customer rows first; a later batch of days in discovery order) PostgreSQL aborts one session with 40P01.
// Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts) with the other api-server database tests.
import { inTransaction } from '@bw/db';
import { mergePair } from '@bw/import';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { lockTechnicianDays } from './locks.ts';
import { moveJobsToCustomer } from './service.ts';
import { caller, officeWorld, type OfficeWorld } from './testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let runId: string;

beforeAll(async () => {
  world = await officeWorld(db, 10);
  runId = ((await db.admin().query<{ id: string }>(
    `INSERT INTO world.import_run (kind, status, stage, percent, started_at, finished_at, by_setup) VALUES ('real', 'done', 'done', 100, now(), now(), true) RETURNING id`)).rows[0] as { id: string }).id;
}, 120_000);
afterAll(async () => {
  await world?.close();
});

const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, cond: () => Promise<boolean>, tries = 800): Promise<void> {
  for (let i = 0; !(await cond()); i++) {
    if (i >= tries) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const advisoryWaiters = async () => Number((await rows<{ n: string }>(`SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`))[0]?.n);
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { open, opened };
};
const outcome = (s: PromiseSettledResult<unknown>) => (s.status === 'rejected' ? String((s.reason as { code?: string }).code ?? s.reason) : 'ok');

const DAY = '2026-10-21';
const MERGE_AT = new Date('2026-09-15T12:00:00Z');

/** A pair of listed duplicates a (kept) and b, with 1 job of b at `technician` on DAY. Returns the ids. */
async function pairWithJob(aIndex: number, technician: string): Promise<{ pairId: string; a: string; b: string; job: number }> {
  const api = caller(world.kernel);
  const [a, b] = [world.customers[aIndex] as string, world.customers[aIndex + 1] as string];
  const win = world.windows.get('two_hour 08:00') as string;
  const made = await api.post('/jobs', { customerId: b, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: DAY, windowId: win, technicianId: world.technicians.get('Kevin Doyle') as string }, world.staff.keisha);
  expect(made.status).toBe(201);
  const job = ((await made.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
  await rows('UPDATE world.job SET technician_id = $2 WHERE job_number = $1', [job, technician]);
  const pairId = (await rows<{ id: string }>(
    `INSERT INTO world.duplicate_pair (run_id, kind, why, record_a, record_b, status) VALUES ($1, 'likely', 'name', $2, $3, 'listed') RETURNING id`, [runId, a, b]))[0]?.id as string;
  return { pairId, a, b, job };
}
const merge = (pairId: string) => inTransaction(world.web, (tx) => mergePair(tx, pairId, { kind: 'office', at: MERGE_AT, by: null, jobs: moveJobsToCustomer }));

describe('mergePair lock order (F-379, F-622)', () => {
  // why: F-622 a booking that holds a technician-day and then takes KEY SHARE on the customer is not deadlocked by a merge of that customer
  it('finishes a merge and a booking that holds the merge job\'s technician-day and then reads the kept customer', async () => {
    const tech = world.technicians.get('Greg Hoffman') as string;
    const { pairId, a, job } = await pairWithJob(0, tech);
    const hold = gate();
    const booking = inTransaction(world.web, async (tx) => {
      await lockTechnicianDays(tx, [{ technicianId: tech, date: DAY }]);
      await hold.opened;
      // The job INSERT's foreign key on customer_id: KEY SHARE on the customer row, which a FOR UPDATE on it makes wait.
      await tx.query('SELECT 1 FROM world.customer WHERE id = $1 FOR KEY SHARE', [a]);
    });
    await sleep(100);
    const merged = merge(pairId);
    // New order: the merge waits for the day holding no customer row. Old order: it holds both customers FOR UPDATE.
    await until('the merge to wait for the technician-day', async () => (await advisoryWaiters()) === 1);
    hold.open();
    const settled = await Promise.allSettled([booking, merged]);
    expect(settled.map(outcome)).toEqual(['ok', 'ok']);
    expect((await rows<{ customer_id: string }>('SELECT customer_id FROM world.job WHERE job_number = $1', [job]))[0]?.customer_id).toBe(a);
    expect((await rows<{ status: string }>('SELECT status FROM world.duplicate_pair WHERE id = $1', [pairId]))[0]?.status).toBe('merged');
  });

  // why: F-622 a job that reaches a technician-day the merge did not hold while it waited for the customer rows makes the merge start its locks again, so a booking on that day is not deadlocked
  it('retries its locks when a job reaches a new day while the merge waits for the customer rows', async () => {
    const [t1, t2] = [world.technicians.get('Greg Hoffman') as string, world.technicians.get('Kevin Doyle') as string];
    const { pairId, b, job } = await pairWithJob(2, t1);
    const zHold = gate();
    const yHold = gate();
    // Z holds the pair's record B, so the merge stops at the customer rows after it has taken the day of the job as read (t1).
    const z = inTransaction(world.web, async (tx) => {
      await tx.query('SELECT 1 FROM world.customer WHERE id = $1 FOR UPDATE', [b]);
      await zHold.opened;
    });
    await sleep(100);
    const merged = merge(pairId);
    await sleep(300);
    // The job is reassigned to t2 (as a committed write that held both days would), and a booking holds t2's day.
    await rows('UPDATE world.job SET technician_id = $2, version = version + 1 WHERE job_number = $1', [job, t2]);
    const y = inTransaction(world.web, async (tx) => {
      await lockTechnicianDays(tx, [{ technicianId: t2, date: DAY }]);
      await yHold.opened;
      await tx.query('SELECT 1 FROM world.customer WHERE id = $1 FOR KEY SHARE', [b]);
    });
    await sleep(150);
    zHold.open();
    // The merge gets the customer rows, finds t2 and cannot have it: it gives the customer rows back and waits for t2's day holding none.
    await until('the merge to wait for the new day', async () => (await advisoryWaiters()) === 1);
    yHold.open();
    const settled = await Promise.allSettled([z, merged, y]);
    expect(settled.map(outcome)).toEqual(['ok', 'ok', 'ok']);
    expect((await rows<{ status: string }>('SELECT status FROM world.duplicate_pair WHERE id = $1', [pairId]))[0]?.status).toBe('merged');
  });

  // why: F-622 the days of a merge's jobs are taken in 1 sorted batch, so a write that locks 2 days in sorted order is not deadlocked by a job that moved to the earlier day
  it('takes a day a job moved to in its sorted place, so a write locking both days in order is not deadlocked', async () => {
    const ids = [world.technicians.get('Greg Hoffman') as string, world.technicians.get('Kevin Doyle') as string].sort();
    const [low, high] = [ids[0] as string, ids[1] as string];
    const { pairId, job } = await pairWithJob(4, high);
    const xHold = gate();
    const x = inTransaction(world.web, async (tx) => {
      await lockTechnicianDays(tx, [{ technicianId: high, date: DAY }]);
      await xHold.opened;
    });
    await sleep(100);
    const merged = merge(pairId);
    await until('the merge to wait for the high day', async () => (await advisoryWaiters()) === 1);
    await rows('UPDATE world.job SET technician_id = $2, version = version + 1 WHERE job_number = $1', [job, low]);
    // W takes both days in sorted order: the low day at once, then waits behind the merge for the high day.
    const w = inTransaction(world.web, (tx) => lockTechnicianDays(tx, [{ technicianId: low, date: DAY }, { technicianId: high, date: DAY }]));
    await until('the write to wait behind the merge', async () => (await advisoryWaiters()) === 2);
    xHold.open();
    const settled = await Promise.allSettled([x, merged, w]);
    expect(settled.map(outcome)).toEqual(['ok', 'ok', 'ok']);
    expect((await rows<{ customer_id: string; technician_id: string }>('SELECT customer_id, technician_id FROM world.job WHERE job_number = $1', [job]))[0]?.technician_id).toBe(low);
  });
});
