// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-379 (moveJobsToCustomer takes the technician-day locks before the job rows, even for a job reassigned while it waits)
// The 3 writes on 1 job (SPECIFICATIONS section 5.3 step 6; review 163), on the real database (PostgreSQL 18, the migrated schema, the
// reference seed). The merge's move picks a job at technician T1, and while it waits for T1's day lock another write reassigns the job to
// T2 and commits, and a 3rd write takes T2's day lock and is about to write the job row. Before the fix the move then wrote the row and
// asked for T2's day afterwards: the 3rd write waited on the row, the move on the day, and PostgreSQL aborted one with 40P01. Now the move
// reads the job again after its lock, finds T2, and locks that day before it touches the row.
// Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts) with the other api-server database tests.
import { inTransaction } from '@bw/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { lockTechnicianDays } from './locks.ts';
import { moveJobsToCustomer } from './service.ts';
import { caller, officeWorld, type OfficeWorld } from './testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;

beforeAll(async () => {
  world = await officeWorld(db, 6);
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
/** Lock waits on an advisory lock right now. */
const advisoryWaiters = async () => Number((await rows<{ n: string }>(`SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`))[0]?.n);
const rowWaiters = async () => Number((await rows<{ n: string }>(`SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.datname = current_database() AND l.locktype = 'transactionid' AND NOT l.granted`))[0]?.n);

describe('moveJobsToCustomer lock order (F-379)', () => {
  // why: F-379 3 writes on 1 job: a job reassigned while the merge waits for its first day has its new day locked before its row is written, so no write is aborted as a deadlock
  it('finishes the move, the reassign and the 3rd write with no deadlock when the job is reassigned while the move waits', async () => {
    const api = caller(world.kernel);
    const tech = (n: string) => world.technicians.get(n) as string;
    const [from, to] = [world.customers[0] as string, world.customers[1] as string];
    const win = world.windows.get('two_hour 08:00') as string;
    const made = await api.post('/jobs', { customerId: from, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: '2026-10-20', windowId: win, technicianId: tech('Kevin Doyle') }, world.staff.keisha);
    expect(made.status).toBe(201);
    const job = ((await made.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
    const [t1, t2] = [tech('Kevin Doyle'), tech('Greg Hoffman')];
    const day = '2026-10-20';

    let x!: () => void;
    const holdT1 = new Promise<void>((r) => { x = r; });
    let r2Done!: () => void;
    const releaseR2 = new Promise<void>((r) => { r2Done = r; });
    // X holds T1's day, so the move blocks right after it has read the job at T1.
    const xTx = inTransaction(world.web, async (tx) => {
      await lockTechnicianDays(tx, [{ technicianId: t1, date: day }]);
      await holdT1;
    });
    await sleep(100);
    const move = inTransaction(world.web, (tx) => moveJobsToCustomer(tx, {
      from, to, jobNumbers: [job], mergeId: '00000000-0000-4000-8000-000000000000', step: 'merge', by: null, at: new Date('2026-09-15T12:00:00Z'),
    }));
    await until('the move to wait for T1\'s day', async () => (await advisoryWaiters()) === 1);
    // The 2nd write reassigns the job to T2 and commits; the 3rd takes T2's day and is about to write the row.
    await rows('UPDATE world.job SET technician_id = $2, version = version + 1 WHERE job_number = $1', [job, t2]);
    const third = inTransaction(world.web, async (tx) => {
      await lockTechnicianDays(tx, [{ technicianId: t2, date: day }]);
      await releaseR2;
      await tx.query('UPDATE world.job SET problem = $2 WHERE job_number = $1', [job, 'third write']);
    });
    await sleep(150);
    x(); // the move gets T1's day
    // Old code: the move writes the row, then waits for T2's day; the 3rd write waits for the row. New code: the move waits for T2's day
    // holding no row, and the 3rd write goes on.
    await until('the move to wait for T2\'s day', async () => (await advisoryWaiters()) === 1);
    expect(await rowWaiters()).toBe(0);
    r2Done();
    const settled = await Promise.allSettled([xTx, move, third]);
    expect(settled.map((s) => (s.status === 'rejected' ? String((s.reason as { code?: string }).code ?? s.reason) : 'ok'))).toEqual(['ok', 'ok', 'ok']);
    const end = (await rows<{ customer_id: string; problem: string | null }>('SELECT customer_id, problem FROM world.job WHERE job_number = $1', [job]))[0];
    expect(end).toEqual({ customer_id: to, problem: 'third write' });
  });
});
