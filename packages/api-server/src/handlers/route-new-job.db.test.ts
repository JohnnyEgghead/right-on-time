// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-MAP-3, FR-DISP-8, NFR-03 (F-1509: an office new job with a technician, run in 2 passes by routedOutside, keeps its routes and its 1 job number)
// The web server runs a call that lacks a leg twice (F-1504, route-source.ts routedOutside): a first pass that notes the legs and is rolled
// back, the asks with no transaction open, and a second pass that stores the routes. A create draws its job number from an identity
// sequence, which a rollback does not return. Through the production kernel (createWebKernel) as bw_web, with routing on (FakeRouting):
//   1. 2 office creates for 1 technician use 2 consecutive job numbers, ask each new leg once, store both legs as live rows (SD-49: "live
//      rows answer ... a job the office adds") and plan both arrivals from the routes (SD-15), as with 1 transaction;
//   2. a reset that winds the job sequence back while a create waits on routing (SD-12) leaves no job number for a later create to collide with.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { approximateDriveMinutes, planDay, type DriveMinutes } from '../../../domain/src/planner.ts';
import { configureRouting } from '../../../maps/src/route-source.ts';
import { FakeRouting } from '../../../maps/src/testing.ts';
import { caller, officeWorld, type Caller, type OfficeWorld } from '../office-writes/testing.ts';

const db = useMigratedDatabase();
let world: OfficeWorld;
let api: Caller;
const fake = new FakeRouting();
let open: (() => void) | null = null;
const DATE = '2026-09-15';
// Test 1 checks each property softly, so a run shows every one that fails.
const SEQ = `pg_get_serial_sequence('world.job', 'job_number')`;

beforeAll(async () => {
  world = await officeWorld(db, 10);
  api = caller(world.kernel);
  configureRouting({ service: fake });
}, 120_000);
afterEach(() => {
  open?.();
  open = null;
  fake.gate = null;
});
afterAll(async () => {
  configureRouting(null);
  await world?.close();
});

const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.admin().query<T>(sql, params)).rows;
/** The last number the job sequence handed out (null before the first). */
const lastDrawn = async (): Promise<number | null> => (await rows<{ n: number | null }>(`SELECT pg_sequence_last_value(${SEQ}::regclass)::int AS n`))[0]!.n;

function create(customer: number, window: string, technician: string): Promise<Response> {
  return api.post('/jobs', {
    customerId: world.customers[customer], serviceId: 'furnace_tune_up', equipmentId: null, problem: null,
    date: DATE, windowId: world.windows.get(window), technicianId: world.technicians.get(technician),
  }, world.staff.keisha);
}
async function jobNumber(r: Response): Promise<number> {
  const body = (await r.json()) as { data: { job: { jobNumber: number } } };
  expect(r.status, JSON.stringify(body)).toBe(201);
  return body.data.job.jobNumber;
}
async function asked(n: number): Promise<void> {
  const by = performance.now() + 5_000;
  while (fake.calls < n) {
    if (performance.now() > by) throw new Error(`the routing service was asked ${fake.calls} times, not ${n}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('an office new job with a technician, routing on (F-1509)', () => {
  // why: FR-DISP-8, FR-MAP-3 a create's legs are asked once, stored live and planned from the route, and the create uses 1 job number
  it('stores the new legs live, plans from the routes and uses 1 job number per create', async () => {
    const tech = 'Kevin Doyle';
    const before = await lastDrawn();
    const c0 = fake.calls;
    const a = await jobNumber(await create(0, 'two_hour 08:00', tech));
    const c1 = fake.calls;
    const b = await jobNumber(await create(1, 'two_hour 08:00', tech));
    const c2 = fake.calls;
    // 1 number per create, none skipped: the sequence handed out exactly a and b.
    expect.soft([a, b]).toEqual([(before ?? 24799) + 1, (before ?? 24799) + 2]);
    expect.soft(await lastDrawn()).toBe(b);
    // Each create asks its 1 new leg once (the first depot to a, the second a to b), and each route is stored.
    expect.soft([c1 - c0, c2 - c1]).toEqual([1, 1]);
    expect.soft(await rows<{ from_ref: string; to_ref: string; build_id: string }>(
      `SELECT from_ref, to_ref, build_id FROM world.van_track WHERE to_ref = ANY($1::text[]) ORDER BY from_ref, to_ref`, [[String(a), String(b)]]))
      .toEqual([{ from_ref: String(a), to_ref: String(b), build_id: 'live' }, { from_ref: 'depot', to_ref: String(a), build_id: 'live' }]);
    // SD-15: both planned arrivals come from the routes (FakeRouting's 150 s: 3 minutes a leg), not from SD-22's minutes.
    const day = await rows<{ job_number: number; window_start: Date; booked_at: Date; expected_minutes: number; lon: number; lat: number; planned_arrival: Date; shift_start: Date; depot_lon: number; depot_lat: number }>(
      `SELECT j.job_number, j.window_start, j.booked_at, j.expected_minutes, c.lon, c.lat, j.planned_arrival,
              (j.date + t.shift_start) AT TIME ZONE b.zone AS shift_start, b.depot_lon, b.depot_lat
         FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.technician t ON t.id = j.technician_id
         JOIN world.branch b ON b.id = j.branch_id
        WHERE j.job_number = ANY($1::int[]) ORDER BY j.job_number`, [[a, b]]);
    const plan = (drive: DriveMinutes) => planDay({
      shiftStart: day[0]!.shift_start.getTime(), depot: { lon: day[0]!.depot_lon, lat: day[0]!.depot_lat }, drive,
      stops: day.map((j) => ({ jobNumber: j.job_number, windowStart: j.window_start.getTime(), bookedAt: j.booked_at.getTime(), expectedMinutes: j.expected_minutes, point: { lon: j.lon, lat: j.lat } })),
    }).map((p) => [p.jobNumber, p.plannedArrival]);
    const stored = day.map((j) => [j.job_number, j.planned_arrival.getTime()]);
    expect.soft(stored).toEqual(plan(() => 3));
    expect.soft(stored).not.toEqual(plan(approximateDriveMinutes));
  });

  // why: NFR-03 a reset (SD-12) that winds the job sequence back while a create waits on routing must not leave the create's number for a
  // later create to draw again: the create takes a number the sequence has handed out, and the next create answers 201
  it('leaves no number for a later create to collide with when the sequence is wound back between the passes', async () => {
    const tech = 'Greg Hoffman';
    fake.gate = new Promise<void>((r) => { open = r; });
    const c0 = fake.calls;
    const creating = create(2, 'two_hour 08:00', tech);
    await asked(c0 + 1);
    // The first pass drew n and was rolled back; a reset now sets the sequence below it, as restore_world does (setval to the snapshot's largest).
    const n = (await lastDrawn()) as number;
    await rows(`SELECT setval(${SEQ}, $1)`, [n - 1]);
    open?.();
    const c = await jobNumber(await creating);
    const d = await jobNumber(await create(3, 'two_hour 10:00', tech));
    expect([c, d]).toEqual([n, n + 1]);
    expect(await lastDrawn()).toBe(d);
  });
});
