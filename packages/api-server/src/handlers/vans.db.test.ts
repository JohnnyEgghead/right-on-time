// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-3, FR-DISP-19, FR-DISP-21, FR-DEMO-8, F-515 (API-21 Van positions on the real database, through the production kernel)
// The demo clock is set per case: a position is computed from it. Run by gate G-CI7 step 3.
import { approximateDriveMinutes } from '@bw/domain';
import { CLOCK_CACHE_MS } from '@bw/time';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { pointAlongLine } from '../../../maps/src/position.ts';
import { caller, officeWorld, type Caller, type OfficeWorld, type Staff } from '../office-writes/testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let keisha: Staff;
let customer = 0;

beforeAll(async () => {
  world = await officeWorld(db, 20);
  api = caller(world.kernel);
  keisha = world.staff.keisha;
}, 120_000);
afterAll(async () => {
  await world?.close();
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const DATE = '2026-09-15';
const MARIA = 'Maria Santos';
const q = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const wall = (hhmm: string) => `${DATE}T${hhmm}:00-04:00`;
const setNow = async (hhmm: string) => {
  await q(`UPDATE system.demo_clock SET demo_anchor = $1, paused = true WHERE id = 1`, [wall(hhmm)]);
  // The kernel's clock caches the row for CLOCK_CACHE_MS (section 4.2).
  await new Promise((r) => setTimeout(r, CLOCK_CACHE_MS + 50));
};
const vans = async (): Promise<Json[]> => {
  const r = await api.get('/vans?branch=columbus', keisha);
  expect(r.status).toBe(200);
  return ((await r.json()) as { data: { vans: Json[] } }).data.vans;
};
const van = async (name: string): Promise<Json> => (await vans()).find((v) => v.name === name);
async function book(window: string): Promise<number> {
  const r = await api.post('/jobs', {
    customerId: world.customers[customer++ % world.customers.length], serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: DATE,
    windowId: world.windows.get(`two_hour ${window}`), technicianId: world.technicians.get(MARIA),
  }, keisha);
  expect(r.status).toBe(201);
  return ((await r.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
}
const setJob = (n: number, status: string, at: Record<string, string>) => q(
  `UPDATE world.job SET status = $2, on_the_way_at = $3, arrived_at = $4, ended_at = $5 WHERE job_number = $1`,
  [n, status, at['way'] ? wall(at['way']) : null, at['arrived'] ? wall(at['arrived']) : null, at['ended'] ? wall(at['ended']) : null]);
const pointOf = async (n: number) => (await q<{ lon: number; lat: number }>(
  'SELECT c.lon, c.lat FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.job_number = $1', [n]))[0]!;

describe('van positions (API-21)', () => {
  // why: FR-DISP-3 outside the shift a van has no position, so it is no live van; inside, it stands at the depot
  it('has no position before the shift starts and the depot once it has', async () => {
    await setNow('07:00');
    expect((await van(MARIA)).position).toBeNull();
    await setNow('08:30');
    const depot = (await q<{ depot_lon: number; depot_lat: number }>(`SELECT depot_lon, depot_lat FROM world.branch WHERE id = 'columbus'`))[0]!;
    expect(await van(MARIA)).toMatchObject({ position: { lon: depot.depot_lon, lat: depot.depot_lat }, status: 'between_jobs', jobNumber: null, eta: null, route: null });
  });

  // why: FR-DISP-19 the vans are those of the technicians working that day, each with what the map, the menu and the card read
  it('lists the branch\'s vans of the day\'s technicians, with van number, skill and phone', async () => {
    await setNow('10:30');
    const all = await vans();
    const working = await q<{ name: string; phone: string; number: string }>(
      `SELECT t.name, t.phone, v.number FROM world.technician t JOIN world.van v ON v.id = t.van_id WHERE t.branch_id = 'columbus' AND 2 = ANY(t.working_days)`);
    expect(all.map((v) => v.name).sort()).toEqual(working.map((w) => w.name).sort());
    for (const v of all) {
      const w = working.find((x) => x.name === v.name)!;
      expect([v.phone, v.van]).toEqual([w.phone, w.number]);
      expect(v.skills.length).toBeGreaterThan(0);
    }
  });

  // why: FR-DISP-21 the number the van card's Call shows is the technician's own
  it('answers Maria\'s number for the card', async () => {
    expect((await van(MARIA)).phone).toBe((await q<{ phone: string }>(`SELECT phone FROM world.technician WHERE name = $1`, [MARIA]))[0]!.phone);
  });

  // why: FR-DEMO-8, FR-DISP-3 the position is the leg's point at the clock, computed on read, and it moves with the clock
  it('moves a van on the way along the leg from its last ended job, and holds an on-site van at the customer', async () => {
    const first = await book('08:00');
    const second = await book('10:00');
    await setJob(first, 'no_one_home', { way: '08:10', arrived: '08:30', ended: '09:30' });
    await setJob(second, 'on_the_way', { way: '10:00' });
    await setNow('10:05');
    const from = await pointOf(first);
    const to = await pointOf(second);
    const v = await van(MARIA);
    const want = pointAlongLine(from, to, 300);
    expect(v.position.lon).toBeCloseTo(want.lon, 9);
    expect(v.position.lat).toBeCloseTo(want.lat, 9);
    expect(v).toMatchObject({ status: 'on_the_way', jobNumber: second, route: { from, to, track: null } });
    expect(Date.parse(v.eta.replace(/\[.*\]$/, ''))).toBe(Date.parse(wall('10:00')) + approximateDriveMinutes(from, to) * 60_000);
    await setNow('10:06');
    expect((await van(MARIA)).position).not.toEqual(v.position);
    await setJob(second, 'on_site', { way: '10:00', arrived: '10:20' });
    await setNow('10:30');
    expect(await van(MARIA)).toMatchObject({ position: to, status: 'on_site', jobNumber: second, route: null });
  });

  // why: FR-MAP-3 a baked leg comes back as its road; the approximate line is only for a leg with no track
  it('answers the baked track of the leg of a van on the way', async () => {
    const [first, second] = (await q<{ job_number: number }>(`SELECT job_number FROM world.job WHERE technician_id = $1 AND date = $2 ORDER BY window_start`, [world.technicians.get(MARIA), DATE])).map((j) => j.job_number);
    await setJob(second as number, 'on_the_way', { way: '10:00' });
    await q(`INSERT INTO world.van_track (branch_id, from_ref, to_ref, polyline, seconds, distance_m, build_id) VALUES ('columbus', $1, $2, '_p~iF~ps|U_ulLnnqC_mqNvxq\`@', '{0,600,1200}', 5000, 'test')`,
      [String(first), String(second)]);
    await setNow('10:10');
    const v = await van(MARIA);
    expect(v.route.track).toEqual([[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
    expect(v.position).toEqual({ lon: -120.95, lat: 40.7 });
  });

  // why: FR-DEMO-8, FR-DISP-3 F-811 past the shift end, through both real readers: API-21 and API-135 answer 1 point for the van on the way, an on-site van stays, and a van with nothing left drops off
  it('answers the same van from API-21 and API-135 past the shift end, and drops the van once no job is left', async () => {
    await q(`UPDATE world.job SET status = 'canceled' WHERE technician_id = $1 AND date = $2`, [world.technicians.get(MARIA), DATE]);
    const first = await book('14:00');
    const second = await book('16:00');
    await setJob(first, 'no_one_home', { way: '14:00', arrived: '14:30', ended: '18:00' });
    await setNow('18:05'); // past her 5:30 PM shift end, between the 2 jobs: at her last stop
    const from = await pointOf(first);
    const to = await pointOf(second);
    expect(await van(MARIA)).toMatchObject({ position: from, status: 'between_jobs', jobNumber: null });
    await setJob(second, 'on_the_way', { way: '18:05' });
    await setNow('18:10');
    const v = await van(MARIA);
    const live = await api.get(`/jobs/${second}/on-the-way`, keisha);
    expect(live.status).toBe(200);
    const panel = ((await live.json()) as { data: Json }).data;
    expect(v).toMatchObject({ status: 'on_the_way', jobNumber: second });
    expect(v.position).toEqual({ lon: panel.van.lon, lat: panel.van.lat });
    expect(v.position).toEqual(pointAlongLine(from, to, 300));
    await setJob(second, 'on_site', { way: '18:05', arrived: '18:20' });
    await setNow('18:30');
    expect(await van(MARIA)).toMatchObject({ position: to, status: 'on_site', jobNumber: second });
    await setJob(second, 'no_one_home', { way: '18:05', arrived: '18:20', ended: '19:00' });
    await setNow('19:01');
    expect(await van(MARIA)).toMatchObject({ position: null, status: 'between_jobs', jobNumber: null });
  });

  // why: FR-DEMO-8 F-811 the rule holds at both ends of the shift: On my way before the shift start is drawn by both readers too
  it('answers the same van from API-21 and API-135 before the shift starts', async () => {
    await q(`UPDATE world.job SET status = 'canceled' WHERE technician_id = $1 AND date = $2`, [world.technicians.get(MARIA), DATE]);
    const job = await book('08:00');
    await setJob(job, 'on_the_way', { way: '07:40' });
    await setNow('07:45'); // before her 8:00 AM shift start
    const v = await van(MARIA);
    const panel = ((await (await api.get(`/jobs/${job}/on-the-way`, keisha)).json()) as { data: Json }).data;
    expect(v.position).not.toBeNull();
    expect(v.position).toEqual({ lon: panel.van.lon, lat: panel.van.lat });
  });

  // why: FR-DISP-3 the board reads a branch that exists; the row is the office's
  it('answers 404 for an unknown branch and 401 signed out', async () => {
    expect((await api.get('/vans?branch=nowhere', keisha)).status).toBe(404);
    expect((await world.kernel.router.handle(new Request('http://web:3000/api/v1/vans?branch=columbus'), { address: '203.0.113.9' })).status).toBe(401);
  });
});
