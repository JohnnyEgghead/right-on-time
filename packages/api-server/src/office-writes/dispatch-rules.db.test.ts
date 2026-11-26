// SPDX-License-Identifier: AGPL-3.0-or-later
// The dispatch rules (SPECIFICATIONS SD-26, SD-28, SD-45; OA-78, OI-44) on the real database (PostgreSQL 18, the migrated
// schema, P2-SEED's reference seed). The service functions run in a real transaction on a pool, as a handler's kernel
// transaction does; jobs are made through the production kernel's office routes. The pure rules are tested in
// packages/domain/src/dispatch.test.ts. Run by gate G-CI7 step 3 with the other api-server database tests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, inTransaction } from '@bw/db';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { branchWindows } from './day.ts';
import { recordTimeOff, removeTimeOff, suggestTechnicians } from './dispatch-rules.ts';
import { WriteRefused, type WriteContext } from './service.ts';
import { caller, officeWorld, type Caller, type OfficeWorld, type Staff } from './testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let keisha: Staff;
let pool: ReturnType<typeof createPool>;
let customer = 0;

beforeAll(async () => {
  world = await officeWorld(db, 40);
  api = caller(world.kernel);
  keisha = world.staff.keisha;
  pool = createPool({ connectionString: db.url(), max: 2 });
}, 120_000);
afterAll(async () => {
  await pool?.end();
  await world?.close();
});

interface Job { jobNumber: number; technicianId: string | null; version: number; plannedArrival: string | null }

const tech = (name: string) => world.technicians.get(name) as string;
const win = (key: string) => world.windows.get(key) as string;
const nextCustomer = () => world.customers[customer++ % world.customers.length] as string;
const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const ctx = (): WriteContext => ({ actor: { kind: 'office', userId: keisha.userId }, at: new Date('2026-09-15T11:00:00Z') });

async function book(date: string, window: string, technician: string): Promise<Job> {
  const r = await api.post('/jobs', {
    customerId: nextCustomer(), serviceId: 'furnace_tune_up', equipmentId: null, problem: null,
    date, windowId: win(window), technicianId: tech(technician),
  }, keisha);
  if (r.status !== 201) throw new Error(`create answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return ((await r.json()) as { data: { job: Job } }).data.job;
}

const timeOff = (technician: string, from: string, to: string) =>
  inTransaction(pool, (tx) => recordTimeOff(tx, ctx(), { technicianId: tech(technician), from, to, note: null }));

describe('time off over booked jobs (SD-28; OA-78)', () => {
  // why: SD-28, OA-78
  it('records time off over 2 booked jobs and finds both Unassigned, each with a job_change row of kind unassigned_time_off', async () => {
    const a = await book('2026-10-14', 'two_hour 08:00', 'Kevin Doyle');
    const b = await book('2026-10-14', 'two_hour 10:00', 'Kevin Doyle');
    await rows('UPDATE world.job SET touched_by_person = false WHERE job_number = ANY($1)', [[a.jobNumber, b.jobNumber]]);
    const done = await timeOff('Kevin Doyle', '2026-10-14', '2026-10-15');
    expect(done.unassigned.map((j) => [j.jobNumber, j.version])).toEqual([[a.jobNumber, 2], [b.jobNumber, 2]]);
    const jobs = await rows<{ job_number: number; technician_id: string | null; planned_arrival: Date | null; version: number }>(
      'SELECT job_number, technician_id, planned_arrival, version FROM world.job WHERE job_number = ANY($1) ORDER BY job_number', [[a.jobNumber, b.jobNumber]]);
    expect(jobs.map((j) => [j.technician_id, j.planned_arrival, j.version])).toEqual([[null, null, 2], [null, null, 2]]);
    // why: F-423 (the time off unassign is an office write: SD-21)
    expect(await rows('SELECT 1 FROM world.job WHERE job_number = ANY($1) AND touched_by_person', [[a.jobNumber, b.jobNumber]])).toHaveLength(2);
    const changes = await rows<{ job_number: number; kind: string; from_version: number; to_version: number; actor_kind: string }>(
      `SELECT job_number, kind, from_version, to_version, actor_kind FROM world.job_change WHERE job_number = ANY($1) AND kind = 'unassigned_time_off' ORDER BY job_number`,
      [[a.jobNumber, b.jobNumber]]);
    expect(changes).toEqual([a, b].map((j) => ({ job_number: j.jobNumber, kind: 'unassigned_time_off', from_version: 1, to_version: 2, actor_kind: 'office' })));
    expect(await rows('SELECT 1 FROM world.time_off WHERE id = $1', [done.timeOffId])).toHaveLength(1);
  });

  // why: SD-28, OA-78
  it('refuses time off while a job in the span is on the way, and leaves no span, no job change and no version bump', async () => {
    const onWay = await book('2026-10-21', 'two_hour 08:00', 'Greg Hoffman');
    const waiting = await book('2026-10-21', 'two_hour 10:00', 'Greg Hoffman');
    await db.admin().query(`UPDATE world.job SET status = 'on_the_way' WHERE job_number = $1`, [onWay.jobNumber]);
    const err = await timeOff('Greg Hoffman', '2026-10-20', '2026-10-22').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteRefused);
    expect(err).toMatchObject({ code: 'rule_refused', detail: { jobNumbers: [onWay.jobNumber] } });
    expect(await rows('SELECT 1 FROM world.time_off WHERE technician_id = $1', [tech('Greg Hoffman')])).toHaveLength(0);
    expect(await rows('SELECT technician_id, version FROM world.job WHERE job_number = $1', [waiting.jobNumber]))
      .toEqual([{ technician_id: tech('Greg Hoffman'), version: 1 }]);
    expect(await rows(`SELECT 1 FROM world.job_change WHERE job_number = $1 AND kind = 'unassigned_time_off'`, [waiting.jobNumber])).toHaveLength(0);
  });

  // why: F-426
  it('refuses a span over 366 days and a malformed date at once, before building any list of days (a loop to year 9999 would run the test out of time)', async () => {
    for (const [from, to] of [['2026-10-20', '9999-12-31'], ['2026-10-20', 'zzzz'], ['2026-02-30', '2026-03-02']] as const) {
      expect(await timeOff('Greg Hoffman', from, to).catch((e: unknown) => e)).toMatchObject({ code: 'validation_failed' });
    }
    expect(await rows('SELECT 1 FROM world.time_off WHERE technician_id = $1', [tech('Greg Hoffman')])).toHaveLength(0);
  });

  // why: SD-28
  it('removes time off with no confirm step and changes no job, then the job can be reassigned to the technician', async () => {
    const job = await book('2026-10-28', 'two_hour 08:00', 'Ryan Mitchell');
    const done = await timeOff('Ryan Mitchell', '2026-10-28', '2026-10-28');
    const versionBefore = (await rows<{ version: number }>('SELECT version FROM world.job WHERE job_number = $1', [job.jobNumber]))[0]?.version;
    await inTransaction(pool, (tx) => removeTimeOff(tx, ctx(), { timeOffId: done.timeOffId }));
    expect(await rows('SELECT 1 FROM world.time_off WHERE id = $1', [done.timeOffId])).toHaveLength(0);
    expect(await rows('SELECT technician_id, version FROM world.job WHERE job_number = $1', [job.jobNumber])).toEqual([{ technician_id: null, version: versionBefore }]);
    const assign = await api.post(`/jobs/${job.jobNumber}/assignment`, { technicianId: tech('Ryan Mitchell'), baseVersion: versionBefore }, keisha);
    expect(assign.status).toBe(200);
    const gone = await inTransaction(pool, (tx) => removeTimeOff(tx, ctx(), { timeOffId: done.timeOffId })).catch((e: unknown) => e);
    expect(gone).toMatchObject({ code: 'not_found' });
  });
});

describe('suggested technicians over the database (SD-26)', () => {
  // why: SD-26
  it('leaves out a technician with time off that day, marks the ones without the service skill, and orders skill then drive then load', async () => {
    await timeOff('Marcus Bell', '2026-11-04', '2026-11-04');
    const ranked = await suggestTechnicians(pool, {
      branch: 'columbus', serviceId: 'furnace_tune_up', customerId: nextCustomer(), date: '2026-11-04', windowId: win('two_hour 10:00'),
    });
    expect(ranked.map((r) => r.technicianId)).not.toContain(tech('Marcus Bell'));
    expect(ranked.length).toBeGreaterThan(0);
    const skills = await rows<{ id: string; primary_skill: string; skills: string[] }>('SELECT id, primary_skill, skills FROM world.technician');
    const hasSkill = (id: string) => skills.find((s) => s.id === id)?.skills.includes('heating_cooling') === true || skills.find((s) => s.id === id)?.primary_skill === 'heating_cooling';
    for (const r of ranked) expect([r.technicianId, r.suggested, r.reason]).toEqual([r.technicianId, hasSkill(r.technicianId), hasSkill(r.technicianId) ? null : 'skill_missing']);
    const firstNoSkill = ranked.findIndex((r) => !r.suggested);
    if (firstNoSkill >= 0) expect(ranked.slice(firstNoSkill).every((r) => !r.suggested)).toBe(true);
    const skilled = ranked.filter((r) => r.suggested && r.room);
    const sorted = [...skilled].sort((x, y) => x.driveMinutes - y.driveMinutes || x.loadRatio - y.loadRatio);
    expect(skilled.map((r) => r.driveMinutes)).toEqual(sorted.map((r) => r.driveMinutes));
  });

  // why: SD-26
  it('measures the drive from the stop before the window, not the depot, once a technician has an earlier job that day', async () => {
    const date = '2026-11-11';
    const customerId = nextCustomer();
    const input = { branch: 'columbus', serviceId: 'furnace_tune_up', customerId, date, windowId: win('two_hour 10:00') };
    const before = (await suggestTechnicians(pool, input)).find((r) => r.technicianId === tech('Kevin Doyle'));
    await book(date, 'two_hour 08:00', 'Kevin Doyle');
    const after = (await suggestTechnicians(pool, input)).find((r) => r.technicianId === tech('Kevin Doyle'));
    expect(after?.loadRatio).toBeGreaterThan(before?.loadRatio ?? 0);
    const prior = await rows<{ lon: number; lat: number }>(
      `SELECT c.lon, c.lat FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.technician_id = $1 AND j.date = $2::date`, [tech('Kevin Doyle'), date]);
    const target = await rows<{ lon: number; lat: number }>('SELECT lon, lat FROM world.customer WHERE id = $1', [customerId]);
    const { approximateDriveMinutes } = await import('@bw/domain');
    expect(after?.driveMinutes).toBe(approximateDriveMinutes(prior[0]!, target[0]!));
  });

  // why: F-427 (SD-26, SD-15) with excludeJob, a same-window job booked after the moved job is not its stop before
  it('takes the stop before a job on the board from the jobs that sort before it in plan order, not a later-booked job of its window', async () => {
    const date = '2026-10-21';
    const first = await book(date, 'two_hour 10:00', 'Kevin Doyle');
    const second = await book(date, 'two_hour 10:00', 'Kevin Doyle');
    const points = await rows<{ job_number: number; customer_id: string; lon: number; lat: number }>(
      'SELECT j.job_number, j.customer_id, c.lon, c.lat FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.job_number = ANY($1)', [[first.jobNumber, second.jobNumber]]);
    const at = (n: number) => points.find((p) => p.job_number === n)!;
    const depot = (await rows<{ lon: number; lat: number }>(`SELECT depot_lon AS lon, depot_lat AS lat FROM world.branch WHERE id = 'columbus'`))[0]!;
    const { approximateDriveMinutes } = await import('@bw/domain');
    const suggest = (job: number) => suggestTechnicians(pool, {
      branch: 'columbus', serviceId: 'furnace_tune_up', customerId: at(job).customer_id, date, windowId: win('two_hour 10:00'), excludeJob: job,
    }).then((r) => r.find((x) => x.technicianId === tech('Kevin Doyle')));
    // The first-booked job comes first in the plan: its stop before is the depot (F-427).
    expect((await suggest(first.jobNumber))?.driveMinutes).toBe(approximateDriveMinutes(depot, at(first.jobNumber)));
    // The second-booked job follows the first.
    expect((await suggest(second.jobNumber))?.driveMinutes).toBe(approximateDriveMinutes(at(first.jobNumber), at(second.jobNumber)));
  });
});

describe('1 query at a time on a transaction client (F-886)', () => {
  // why: F-886; branchWindows read every window with a Promise.all on the transaction's client, so pg warned once per process
  it('reads a branch\'s windows without calling client.query() on a busy client', async () => {
    const warned: string[] = [];
    const on = (w: Error) => { warned.push(w.message); };
    process.on('warning', on);
    try {
      const windows = await inTransaction(pool, (tx) => branchWindows(tx, 'columbus'));
      expect(windows.length).toBeGreaterThan(1);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off('warning', on);
    }
    expect(warned.filter((m) => m.includes('already executing a query'))).toEqual([]);
  });
});
