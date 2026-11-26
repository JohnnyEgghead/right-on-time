// SPDX-License-Identifier: AGPL-3.0-or-later
// Cancel a job (API-25) and Edit job details (API-27) on the real database (PostgreSQL 18, the migrated schema, P2-SEED's
// reference seed) through the production kernel as the web process's login bw_web, with dispatchers whose sessions the
// real session layer created and the notices read by a real LISTEN connection (SPECIFICATIONS section 5.3; FR-TECH-6).
// The cancel-versus-move barrier race is gate G-CI3's: ci/gates/G-CI3/job-writes.db.test.ts.
// Run by gate G-CI7 step 3 (ci/gates/G-CI7/vitest.db.config.ts) with the other api-server database tests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsOf } from '../handlers/me.ts';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { caller, listen, officeWorld, ORIGIN, type Caller, type OfficeWorld, type Staff } from './testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let keisha: Staff;
let ana: Staff;
let customer = 0;

beforeAll(async () => {
  world = await officeWorld(db, 30);
  api = caller(world.kernel);
  ({ keisha, ana } = world.staff);
}, 120_000);
afterAll(async () => {
  await world?.close();
});

interface Job { jobNumber: number; technicianId: string | null; status: string; version: number; plannedArrival: string | null; expectedMinutes: number; serviceId: string }
interface Problem { code: string; status: number; [k: string]: unknown }

/**
 * The count of notices once the ones the setup's own writes sent have all arrived (F-570). A notice reaches the listener some time after
 * its commit, so a count read right after the setup's creates can miss a creation notice still on the wire, which then lands among the
 * notices the case counts as its own (the Spectre push run read 3 where it expected 2). Counted as stable across 3 reads 100 ms apart.
 */
async function settled(bus: { notices: unknown[] }): Promise<number> {
  for (let same = 0, last = -1; same < 3;) {
    await new Promise((x) => setTimeout(x, 100));
    same = bus.notices.length === last ? same + 1 : 0;
    last = bus.notices.length;
  }
  return bus.notices.length;
}

const tech = (name: string) => world.technicians.get(name) as string;
const win = (key: string) => world.windows.get(key) as string;
const nextCustomer = () => world.customers[customer++ % world.customers.length] as string;
const body = async <T>(r: Response): Promise<T> => ((await r.json()) as { data: T }).data;
const problem = async (r: Response): Promise<Problem> => (await r.json()) as Problem;
const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const count = async (sql: string, params: unknown[] = []) => Number((await rows<{ n: string }>(sql, params))[0]?.n);

async function created(input: { date: string; window: string; technician?: string; service?: string; customerId?: string }): Promise<Job> {
  const r = await api.post('/jobs', {
    customerId: input.customerId ?? nextCustomer(), serviceId: input.service ?? 'furnace_tune_up', equipmentId: null, problem: null,
    date: input.date, windowId: win(input.window), technicianId: input.technician ? tech(input.technician) : null,
  }, keisha);
  if (r.status !== 201) throw new Error(`create answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return (await body<{ job: Job }>(r)).job;
}
const cancel = (job: number, baseVersion: number, who: Staff = keisha) => api.post(`/jobs/${job}/cancellation`, { baseVersion }, who);
const edit = (job: number, input: { serviceId: string; equipmentId?: string | null; problem?: string | null; baseVersion: number }, who: Staff = keisha) =>
  world.kernel.router.handle(new Request(`http://web:3000/api/v1/jobs/${job}`, {
    method: 'PATCH', body: JSON.stringify({ equipmentId: null, problem: null, ...input }),
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: who.cookie },
  }), { address: '203.0.113.9' });
const changes = (job: number) => rows<{ kind: string; from_version: number; to_version: number; actor_kind: string }>(
  'SELECT kind, from_version, to_version, actor_kind FROM world.job_change WHERE job_number = $1 ORDER BY id', [job]);

describe('cancel a job (API-25) on a day with a block in the plan (F-504)', () => {
  // why: F-504 removing a visit pulls a later job over a block; API-25 names no time_overlap, so the cancel settles and answers 200, not 500
  it('cancels a job whose removal pulls a later job over a block, answering 200 and keeping the block', async () => {
    const date = '2026-09-24';
    const a = await created({ date, window: 'two_hour 08:00', technician: 'Jamal Carter', service: 'heating_or_ac_fix' });
    await created({ date, window: 'two_hour 08:00', technician: 'Jamal Carter' });
    const c = await created({ date, window: 'two_hour 10:00', technician: 'Jamal Carter' });
    const arrival = async (n: number) => (await rows<{ planned_arrival: Date }>('SELECT planned_arrival FROM world.job WHERE job_number = $1', [n]))[0]!.planned_arrival;
    const before = await arrival(c.jobNumber);
    // A block over where C will be once A is gone (about 10:15 AM, its window start plus 15 minutes) and clear of today's plan is not
    // possible through the block write's own overlap rule (createBlock, API-136), so it goes in the way a merge leaves one: by the database.
    await rows(`INSERT INTO world.time_block (technician_id, date, zone, start, "end", label, place, version, seeded)
                VALUES ($1, $2, 'America/New_York', $3, $4, 'Gap', NULL, 1, false)`, [tech('Jamal Carter'), date, '2026-09-24T14:20:00Z', '2026-09-24T14:30:00Z']);
    const r = await cancel(a.jobNumber, a.version);
    expect([r.status, r.status === 200 ? null : await problem(r)]).toEqual([200, null]);
    expect((await body<{ job: Job }>(r)).job).toMatchObject({ jobNumber: a.jobNumber, status: 'canceled' });
    expect((await arrival(c.jobNumber)).getTime()).toBeLessThan(before.getTime()); // C was pulled earlier, onto the block
    expect(await count(`SELECT count(*) AS n FROM world.time_block WHERE label = 'Gap' AND date = $1`, [date])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM world.job_change WHERE job_number = $1 AND kind = 'canceled'`, [a.jobNumber])).toBe(1);
  });
});

describe('cancel a job (API-25)', () => {
  // why: FR-TECH-6
  it('cancels a scheduled job with 1 canceled history row, a version bump and 1 notice, and its technician day loses it', async () => {
    const bus = await listen(db.url());
    try {
      const a = await created({ date: '2026-09-22', window: 'two_hour 08:00', technician: 'Jamal Carter', service: 'heating_or_ac_fix' });
      const b = await created({ date: '2026-09-22', window: 'two_hour 08:00', technician: 'Jamal Carter' });
      const planned = async (n: number) => (await rows<{ planned_arrival: Date | null; status: string }>(
        'SELECT planned_arrival, status FROM world.job WHERE job_number = $1', [n]))[0]!;
      // b follows a's 90 minutes: well after 9:30 AM (13:30Z).
      expect((await planned(b.jobNumber)).planned_arrival!.getTime()).toBeGreaterThan(Date.parse('2026-09-22T13:30:00Z'));
      const published = await settled(bus);
      const r = await cancel(a.jobNumber, a.version);
      expect(r.status).toBe(200);
      expect((await body<{ job: Job }>(r)).job).toMatchObject({ jobNumber: a.jobNumber, status: 'canceled', version: a.version + 1, plannedArrival: null });
      expect(await changes(a.jobNumber)).toEqual([
        { kind: 'created', from_version: 0, to_version: 1, actor_kind: 'office' },
        { kind: 'canceled', from_version: 1, to_version: 2, actor_kind: 'office' },
      ]);
      expect(await bus.waitFor(published + 1)).toBe(published + 1);
      await new Promise((x) => setTimeout(x, 100));
      expect(bus.notices.slice(published)).toEqual([{ name: 'job.changed', ids: { jobNumber: a.jobNumber, branch: 'columbus' } }]);
      // The canceled job left the day's planned arrivals: b is now first, about 8:0x AM, and its version did not move.
      const after = await planned(b.jobNumber);
      expect(after.planned_arrival!.getTime()).toBeLessThan(Date.parse('2026-09-22T12:30:00Z'));
      expect((await planned(a.jobNumber)).planned_arrival).toBeNull();
      expect(await count('SELECT version AS n FROM world.job WHERE job_number = $1', [b.jobNumber])).toBe(b.version);
    } finally {
      await bus.end();
    }
  });

  // why: FR-TECH-6
  it('answers a stale baseVersion with version_conflict naming the other change, and leaves no row or notice', async () => {
    const bus = await listen(db.url());
    try {
      const job = await created({ date: '2026-09-23', window: 'two_hour 10:00' });
      expect((await api.post(`/jobs/${job.jobNumber}/assignment`, { technicianId: tech('Kevin Doyle'), baseVersion: 1 }, keisha)).status).toBe(200);
      await new Promise((x) => setTimeout(x, 250)); // the assignment's notice has arrived
      const published = bus.notices.length;
      const r = await cancel(job.jobNumber, 1, ana);
      expect(r.status).toBe(409);
      expect(await problem(r)).toMatchObject({
        code: 'version_conflict', by: 'Keisha Thompson', byKind: 'office', change: 'assigned', technician: 'Kevin Doyle', currentVersion: 2,
      });
      expect(await rows('SELECT status, version FROM world.job WHERE job_number = $1', [job.jobNumber])).toEqual([{ status: 'scheduled', version: 2 }]);
      expect((await changes(job.jobNumber)).map((c) => c.kind)).toEqual(['created', 'assigned']);
      await new Promise((x) => setTimeout(x, 150));
      expect(bus.notices.length).toBe(published);
      // The same call again with the current version succeeds (Cancel anyway).
      expect((await cancel(job.jobNumber, 2, ana)).status).toBe(200);
    } finally {
      await bus.end();
    }
  });

  // why: FR-TECH-6
  it('refuses a job already canceled with rule_refused and the rule key, and writes nothing; an On site job cancels (F-505)', async () => {
    const job = await created({ date: '2026-09-24', window: 'two_hour 08:00', technician: 'Tom Reinhart' });
    expect((await cancel(job.jobNumber, 1)).status).toBe(200);
    const again = await cancel(job.jobNumber, 2);
    const p = await problem(again);
    expect([again.status, p.code, p.key]).toEqual([409, 'rule_refused', 'rule.jobClosed']);
    expect((await changes(job.jobNumber)).map((c) => c.kind)).toEqual(['created', 'canceled']);
    // Owner ruling 4241980e ("Match the UI spec"): CTL-OFC-03-07 enables Cancel visit for a begun job, and API-25 accepts it.
    const onSite = await created({ date: '2026-09-24', window: 'two_hour 10:00', technician: 'Tom Reinhart' });
    await db.admin().query(`UPDATE world.job SET status = 'on_site' WHERE job_number = $1`, [onSite.jobNumber]);
    expect((await cancel(onSite.jobNumber, 1)).status).toBe(200);
    expect(await rows('SELECT status, version FROM world.job WHERE job_number = $1', [onSite.jobNumber])).toEqual([{ status: 'canceled', version: 2 }]);
  });

  // why: FR-TECH-6
  it('answers a job that does not exist with not_found', async () => {
    const r = await cancel(99999999, 1);
    expect([r.status, (await problem(r)).code]).toEqual([404, 'not_found']);
  });
});

describe('edit job details (API-27)', () => {
  // why: FR-TECH-6
  it('changes the service, equipment and problem with 1 details history row, a version bump and 1 notice, and replans the day', async () => {
    const bus = await listen(db.url());
    try {
      const cust = nextCustomer();
      const eq = await rows<{ id: string }>(`INSERT INTO world.equipment (customer_id, type) VALUES ($1, 'furnace') RETURNING id`, [cust]);
      const equipmentId = eq[0]!.id;
      const a = await created({ date: '2026-09-29', window: 'two_hour 08:00', technician: 'Jamal Carter', customerId: cust });
      const b = await created({ date: '2026-09-29', window: 'two_hour 08:00', technician: 'Jamal Carter' });
      const arrival = async (n: number) => (await rows<{ planned_arrival: Date }>('SELECT planned_arrival FROM world.job WHERE job_number = $1', [n]))[0]!.planned_arrival.getTime();
      const bBefore = await arrival(b.jobNumber);
      const published = await settled(bus);
      const r = await edit(a.jobNumber, { serviceId: 'heating_or_ac_fix', equipmentId, problem: 'No heat upstairs', baseVersion: a.version });
      expect(r.status).toBe(200);
      expect((await body<{ job: Job }>(r)).job).toMatchObject({ serviceId: 'heating_or_ac_fix', expectedMinutes: 90, version: a.version + 1 });
      expect(await rows('SELECT service_id, equipment_id, problem FROM world.job WHERE job_number = $1', [a.jobNumber]))
        .toEqual([{ service_id: 'heating_or_ac_fix', equipment_id: equipmentId, problem: 'No heat upstairs' }]);
      const history = await rows<{ kind: string; from_version: number; to_version: number; data: { from: { serviceId: string }; to: { serviceId: string; problem: string } } }>(
        `SELECT kind, from_version, to_version, data FROM world.job_change WHERE job_number = $1 AND kind = 'details'`, [a.jobNumber]);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ from_version: 1, to_version: 2, data: { from: { serviceId: 'furnace_tune_up' }, to: { serviceId: 'heating_or_ac_fix', problem: 'No heat upstairs' } } });
      expect(await bus.waitFor(published + 1)).toBe(published + 1);
      await new Promise((x) => setTimeout(x, 100));
      expect(bus.notices.slice(published)).toEqual([{ name: 'job.changed', ids: { jobNumber: a.jobNumber, branch: 'columbus' } }]);
      // 30 more minutes for a: b's planned arrival moves later, its version does not.
      expect(await arrival(b.jobNumber)).toBeGreaterThan(bBefore);
      expect(await count('SELECT version AS n FROM world.job WHERE job_number = $1', [b.jobNumber])).toBe(b.version);
      // Equipment back to none.
      const none = await edit(a.jobNumber, { serviceId: 'heating_or_ac_fix', equipmentId: null, problem: null, baseVersion: 2 });
      expect(none.status).toBe(200);
      expect(await rows('SELECT equipment_id, problem FROM world.job WHERE job_number = $1', [a.jobNumber])).toEqual([{ equipment_id: null, problem: null }]);
    } finally {
      await bus.end();
    }
  });

  // why: FR-TECH-6
  it('answers a stale baseVersion with version_conflict naming the other change, and writes nothing', async () => {
    const job = await created({ date: '2026-09-30', window: 'two_hour 12:00' });
    expect((await cancel(job.jobNumber, 1)).status).toBe(200);
    const r = await edit(job.jobNumber, { serviceId: 'heating_or_ac_fix', problem: 'x', baseVersion: 1 }, ana);
    expect(r.status).toBe(409);
    expect(await problem(r)).toMatchObject({ code: 'version_conflict', by: 'Keisha Thompson', byKind: 'office', change: 'canceled', currentVersion: 2 });
    expect(await rows('SELECT service_id, problem FROM world.job WHERE job_number = $1', [job.jobNumber])).toEqual([{ service_id: 'furnace_tune_up', problem: null }]);
    expect((await changes(job.jobNumber)).map((c) => c.kind)).toEqual(['created', 'canceled']);
  });

  // why: FR-TECH-6
  it("refuses an unknown service and another customer's equipment with validation_failed, and writes nothing", async () => {
    const job = await created({ date: '2026-10-01', window: 'two_hour 14:00' });
    const other = await rows<{ id: string }>(`INSERT INTO world.equipment (customer_id, type) VALUES ($1, 'boiler') RETURNING id`, [world.customers[29]]);
    const unknown = await edit(job.jobNumber, { serviceId: 'no_such_service', baseVersion: 1 });
    expect([unknown.status, (await problem(unknown)).code]).toEqual([422, 'validation_failed']);
    const foreign = await edit(job.jobNumber, { serviceId: 'furnace_tune_up', equipmentId: other[0]!.id, baseVersion: 1 });
    expect([foreign.status, (await problem(foreign)).code]).toEqual([422, 'validation_failed']);
    expect(await rows('SELECT version FROM world.job WHERE job_number = $1', [job.jobNumber])).toEqual([{ version: 1 }]);
    expect((await changes(job.jobNumber)).map((c) => c.kind)).toEqual(['created']);
  });
});

describe('the policy table and API-07 (owner ruling c025a9ec)', () => {
  // why: FR-TECH-6
  it("lists API-25 and API-27 in API-07's permissions for office and manager and not for a technician", async () => {
    const me = await body<{ permissions: string[] }>(await api.get('/me', keisha));
    expect(me.permissions).toEqual(expect.arrayContaining(['API-25', 'API-27']));
    for (const role of ['office', 'manager'] as const) expect(permissionsOf(role)).toEqual(expect.arrayContaining(['API-25', 'API-27']));
    expect(permissionsOf('technician')).not.toContain('API-25');
    expect(permissionsOf('technician')).not.toContain('API-27');
  });
});
