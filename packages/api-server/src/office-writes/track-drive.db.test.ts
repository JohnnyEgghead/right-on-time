// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-380 (drive minutes come from the baked track: the planner, the suggestion and the ETA of a van that leaves on time agree)
// SD-15: drive minutes between 2 stops = the baked track's last cumulative second / 60, rounded up, else SD-22's approximate
// minutes. On real PostgreSQL 18 with a loaded track for a Sep 15 same-branch pair: a settle plans the second job's arrival from
// the track's minutes, the ETA of a van that leaves on time equals that planned arrival, the dispatch suggestion measures the
// same minutes (F-425), and with the track row removed the settle plans from SD-22's minutes. Run by gate G-CI7 with the other
// api-server database tests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approximateDriveMinutes } from '@bw/domain';
import { createPool, inTransaction } from '@bw/db';
import { Temporal } from '@bw/time';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { onTheWayEta } from '../tech-items/effects.ts';
import { settleDay } from './day.ts';
import { suggestTechnicians } from './dispatch-rules.ts';
import { caller, officeWorld, type Caller, type OfficeWorld, type Staff } from './testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
let keisha: Staff;
let pool: ReturnType<typeof createPool>;

beforeAll(async () => {
  world = await officeWorld(db, 20);
  api = caller(world.kernel);
  keisha = world.staff.keisha;
  pool = createPool({ connectionString: db.url(), max: 2 });
}, 120_000);
afterAll(async () => {
  await pool?.end();
  await world?.close();
});

const rows = async <T>(sql: string, params: unknown[] = []) => (await db.admin().query<T>(sql, params)).rows;
const DATE = '2026-09-15';
const MIN = 60_000;

async function book(customerId: string, technician: string): Promise<number> {
  const r = await api.post('/jobs', {
    customerId, serviceId: 'furnace_tune_up', equipmentId: null, problem: null,
    date: DATE, windowId: world.windows.get('two_hour 08:00') as string, technicianId: world.technicians.get(technician) as string,
  }, keisha);
  if (r.status !== 201) throw new Error(`create answered ${r.status}: ${JSON.stringify(await r.json())}`);
  return ((await r.json()) as { data: { job: { jobNumber: number } } }).data.job.jobNumber;
}

const planned = async (n: number) => (await rows<{ planned_arrival: Date; expected_minutes: number }>(
  'SELECT planned_arrival, expected_minutes FROM world.job WHERE job_number = $1', [n]))[0]!;
const settle = (technicianId: string) => inTransaction(pool, (tx) => settleDay(tx, { technicianId, date: DATE }));
const loadTrack = (a: number | 'depot', b: number, lastSecond: number) => rows(
  `INSERT INTO world.van_track (branch_id, from_ref, to_ref, polyline, seconds, distance_m, build_id)
   VALUES ('columbus', $1, $2, '_p~iF~ps|U_ulLnnqC', $3::integer[], 9000, 'test')`, [String(a), String(b), [0, lastSecond]]);

describe('drive minutes from the baked track (F-380, SD-15)', () => {
  // why: F-380
  it('plans the second job from the track minutes, sends a van that leaves on time to the same minute, and falls back to SD-22 when the track row is gone', async () => {
    const tech = 'Kevin Doyle';
    const technicianId = world.technicians.get(tech) as string;
    const a = await book(world.customers[0] as string, tech);
    const b = await book(world.customers[1] as string, tech);
    await settle(technicianId);
    const pa = await planned(a);
    const aEnd = new Date(pa.planned_arrival.getTime() + pa.expected_minutes * MIN);

    // The leg A to B is baked at 25 minutes (1,500 s; 1,441 s would round up to 25 as well).
    await loadTrack(a, b, 1441);
    await settle(technicianId);
    expect((await planned(b)).planned_arrival.getTime() - aEnd.getTime()).toBe(25 * MIN);

    // The ETA of a van that leaves on time: A ended at its planned end, B's On my way at that time.
    await db.admin().query(`UPDATE world.job SET status = 'no_one_home', ended_at = $2, arrived_at = $3 WHERE job_number = $1`, [a, aEnd, pa.planned_arrival]);
    const eta = await inTransaction(pool, (tx) => onTheWayEta(tx, { jobNumber: b }, Temporal.Instant.fromEpochMilliseconds(aEnd.getTime())));
    expect(eta.epochMilliseconds).toBe((await planned(b)).planned_arrival.getTime());

    // F-515: a job on site is no previous stop: the text's ETA measures the leg the van's position draws (SD-22), from the last ended job.
    await db.admin().query(`UPDATE world.job SET status = 'on_site', ended_at = NULL WHERE job_number = $1`, [a]);
    const fromDepot = await inTransaction(pool, (tx) => onTheWayEta(tx, { jobNumber: b }, Temporal.Instant.fromEpochMilliseconds(aEnd.getTime())));
    const depot = (await rows<{ depot_lon: number; depot_lat: number }>(`SELECT depot_lon, depot_lat FROM world.branch WHERE id = 'columbus'`))[0]!;
    const toB = (await rows<{ lon: number; lat: number }>('SELECT c.lon, c.lat FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.job_number = $1', [b]))[0]!;
    expect(fromDepot.epochMilliseconds).toBe(aEnd.getTime() + approximateDriveMinutes({ lon: depot.depot_lon, lat: depot.depot_lat }, toB) * MIN);
    await db.admin().query(`UPDATE world.job SET status = 'no_one_home', ended_at = $2 WHERE job_number = $1`, [a, aEnd]);

    // F-425: the dispatch suggestion measures the same minutes for the job already on the board.
    const customerOfB = (await rows<{ customer_id: string }>('SELECT customer_id FROM world.job WHERE job_number = $1', [b]))[0]!.customer_id;
    const suggest = async () => (await suggestTechnicians(pool, {
      branch: 'columbus', serviceId: 'furnace_tune_up', customerId: customerOfB, date: DATE, windowId: world.windows.get('two_hour 08:00') as string, excludeJob: b,
    })).find((r) => r.technicianId === technicianId)!.driveMinutes;
    expect(await suggest()).toBe(25);

    // With the track row removed the settle and the suggestion plan from SD-22's approximate minutes.
    await rows('DELETE FROM world.van_track WHERE from_ref = $1 AND to_ref = $2', [String(a), String(b)]);
    await settle(technicianId);
    const pts = await rows<{ lon: number; lat: number }>(
      'SELECT c.lon, c.lat FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.job_number = ANY($1) ORDER BY j.job_number', [[a, b]]);
    const approx = approximateDriveMinutes(pts[0]!, pts[1]!);
    expect(approx).not.toBe(25);
    expect((await planned(b)).planned_arrival.getTime() - aEnd.getTime()).toBe(approx * MIN);
    expect(await suggest()).toBe(approx);
  });
});
