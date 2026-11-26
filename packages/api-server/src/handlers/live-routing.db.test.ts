// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-MAP-3, FR-TECH-5, FR-TECH-13, FR-DEMO-8 (P6-LIVE-ROUTING: SD-49's route source on the real database, through the production kernel)
// The route source (SD-49) on PostgreSQL 18 as bw_web, with a routing service the test drives (FakeRouting: the live mapping runs on an OSRM-shaped answer):
//   1. a leg no row covers is routed, stored as 1 live row, and answered from it by Directions (API-104), the Map
//      tab's route (API-163) and the planned arrival of an assignment;
//   2. while the service is down the leg is approximate and nothing is stored; once it answers, the next read routes;
//   3. a stalled service answers approximate within the 3 s budget plus the read's own time;
//   4. the barrier: 2 concurrent readers of 1 new pair store exactly 1 row, in both interleavings of their writes, and through the kernel;
//   5. a write that moves a job's point deletes every row naming the job, and a reader storing the old point meanwhile stores nothing;
//   6. the snapshot keeps no live row, and a world reset drops every live row and keeps every baked one.
// Run by the G-CI7 database step with the other api-server database tests. The Compose stack suite (ci/live-routing-stack) runs the
// same clauses against the real osrm-routed.
import type { dayRoute, techRoute } from '@bw/api';
import { createClient, resetWorld, type Queryable } from '@bw/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { configureRouting, legsFor, type LegStop, type RouteTrack, type RoutingService } from '../../../maps/src/route-source.ts';
import { FakeRouting } from '../../../maps/src/testing.ts';
import { decodePolyline } from '../../../maps/src/tracks.ts';
import { writeSnapshot } from '../../../setup/src/snapshot.ts';
import { loginUrl, ORIGIN } from '../office-writes/testing.ts';
import { techWorld, type TechWorld } from '../tech-items/testing.ts';

const db = useMigratedDatabase();
let w: TechWorld;
const fake = new FakeRouting();

type Route = z.output<typeof techRoute.response>;
type Day = z.output<typeof dayRoute.response>;
const read = async <T>(r: Response): Promise<T> => {
  if (r.status !== 200) throw new Error(`answered ${r.status}: ${await r.text()}`);
  return ((await r.json()) as { data: T }).data;
};
const rows = async (where = 'true') => w.rows<{ from_ref: string; to_ref: string; build_id: string; polyline: string; seconds: number[] }>(
  `SELECT from_ref, to_ref, build_id, polyline, seconds FROM world.van_track WHERE ${where} ORDER BY from_ref, to_ref`);
const liveRows = () => rows(`build_id = 'live'`);
const pointOf = async (job: number): Promise<LegStop> => {
  const [p] = await w.rows<{ lon: number; lat: number }>('SELECT c.lon, c.lat FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.job_number = $1', [job]);
  return { job, lon: p!.lon, lat: p!.lat };
};
/** A bw_web connection of its own, for a transaction the test holds open. */
async function webClient(): Promise<Queryable & { end(): Promise<void> }> {
  const c = createClient({ connectionString: loginUrl(db.url(), 'bw_web') });
  await c.connect();
  return c as unknown as Queryable & { end(): Promise<void> };
}

beforeAll(async () => {
  w = await techWorld(db);
  configureRouting({ service: fake });
}, 120_000);
afterEach(() => {
  fake.mode = 'up';
  fake.gate = null;
});
afterAll(async () => {
  configureRouting(null);
  await w?.close();
});

describe('a leg no row covers', () => {
  // why: FR-MAP-3, FR-TECH-5, FR-TECH-13 API-104 routes it live with steps and stores 1 live row; API-163 answers the same minutes and line from that row, with no second request
  it('is routed once, stored as 1 live row, and answered from it by API-104 and API-163', async () => {
    const [a] = w.techs;
    const j1 = await w.newJob({ tech: a });
    const j2 = await w.newJob({ tech: a });
    await w.admin().query(`UPDATE world.job SET window_start = window_start + interval '2 hours', window_end = window_end + interval '2 hours' WHERE job_number = $1`, [j2]);
    expect(await rows(`to_ref = '${j2}'`)).toEqual([]);
    const calls = fake.calls;
    const r = await read<Route>(await w.get(`/tech/route?fromJob=${j1}&toJob=${j2}`, a));
    expect(fake.calls).toBe(calls + 1);
    const stored = await rows(`from_ref = '${j1}' AND to_ref = '${j2}'`);
    expect(stored.map((x) => x.build_id)).toEqual(['live']);
    expect(r.leg.track).toEqual(decodePolyline(stored[0]!.polyline));
    expect(r.leg.minutes).toBe(Math.ceil(stored[0]!.seconds.at(-1)! / 60));
    expect(r.steps.map((s) => s.kind)).toEqual(['depart', 'turn', 'arrive']);
    expect(r.steps.reduce((n, s) => n + s.distanceMeters, 0)).toBe(r.leg.distanceMeters);
    const d = await read<Day>(await w.get('/tech/day-route', a));
    const leg = d.legs.find((l) => l.toJob === j2)!;
    expect([leg.minutes, leg.track, leg.distanceMeters]).toEqual([r.leg.minutes, r.leg.track, r.leg.distanceMeters]);
    expect((await rows(`from_ref = '${j1}' AND to_ref = '${j2}'`))).toHaveLength(1);
  });

  // why: FR-MAP-3, FR-TEXT-5 an office assignment plans the day on the live leg: the planned arrival is the previous planned end plus the live row's minutes
  it('is the planned arrival of an assignment, from the same live row', async () => {
    const [a] = w.techs;
    const prior = await w.newJob({ tech: a, date: '2026-09-16' });
    const moved = await w.newJob({ tech: a, date: '2026-09-16' });
    await w.admin().query(`UPDATE world.job SET technician_id = NULL, booked_at = booked_at + interval '1 hour' WHERE job_number = $1`, [moved]);
    const r = await w.post(`/jobs/${moved}/assignment`, { technicianId: a.technicianId, baseVersion: 1 }, w.keisha);
    expect(r.status, await r.clone().text()).toBe(200);
    const live = await rows(`from_ref = '${prior}' AND to_ref = '${moved}'`);
    expect(live.map((x) => x.build_id)).toEqual(['live']);
    const [p] = await w.rows<{ prior_at: Date; prior_min: number; at: Date }>(
      `SELECT p.planned_arrival AS prior_at, p.expected_minutes AS prior_min, m.planned_arrival AS at FROM world.job p, world.job m WHERE p.job_number = $1 AND m.job_number = $2`, [prior, moved]);
    const minutes = Math.ceil(live[0]!.seconds.at(-1)! / 60);
    expect(p!.at.getTime()).toBe(p!.prior_at.getTime() + (p!.prior_min + minutes) * 60_000);
  });
});

describe('while the routing service gives no route', () => {
  // why: FR-MAP-3 down: approximate with no steps and nothing stored; once it answers, the next read routes and stores
  it('answers approximate and stores nothing, and the next read once it answers routes', async () => {
    const [a] = w.techs;
    const j1 = await w.newJob({ tech: a });
    const j2 = await w.newJob({ tech: a });
    fake.mode = 'down';
    const r = await read<Route>(await w.get(`/tech/route?fromJob=${j1}&toJob=${j2}`, a));
    expect([r.leg.track, r.leg.distanceMeters, r.steps]).toEqual([null, null, []]);
    expect(await rows(`from_ref = '${j1}' AND to_ref = '${j2}'`)).toEqual([]);
    fake.mode = 'up';
    const again = await read<Route>(await w.get(`/tech/route?fromJob=${j1}&toJob=${j2}`, a));
    expect(again.leg.track).not.toBeNull();
    expect(again.steps.length).toBe(3);
    expect((await rows(`from_ref = '${j1}' AND to_ref = '${j2}'`)).map((x) => x.build_id)).toEqual(['live']);
  });

  // why: FR-MAP-3 stalled: the read answers approximate within the 3 s budget plus its own time, and stores nothing
  it('answers approximate within the budget when the service stalls', async () => {
    const [a] = w.techs;
    const j1 = await w.newJob({ tech: a });
    const j2 = await w.newJob({ tech: a });
    fake.mode = 'stall';
    const t0 = performance.now();
    const r = await read<Route>(await w.get(`/tech/route?fromJob=${j1}&toJob=${j2}`, a));
    const took = performance.now() - t0;
    expect(r.leg.track).toBeNull();
    expect(took).toBeGreaterThanOrEqual(2_900);
    expect(took).toBeLessThan(4_500);
    expect(await rows(`from_ref = '${j1}' AND to_ref = '${j2}'`)).toEqual([]);
  });
});

describe('2 concurrent readers of 1 new pair (the barrier)', () => {
  /** A service whose every answer waits for the test to release that call, in call order. */
  function heldService(): RoutingService & { release(i: number): void; asked(n: number): Promise<void> } {
    const gates: (() => void)[] = [];
    const waiting: (() => void)[] = [];
    return {
      async route(from, to): Promise<RouteTrack | null> {
        const i = gates.length;
        const held = new Promise<void>((r) => { gates[i] = r; });
        waiting.splice(0).forEach((f) => f());
        await held;
        return fake.route(from, to);
      },
      release: (i) => gates[i]!(),
      async asked(n) {
        while (gates.length < n) await new Promise<void>((r) => waiting.push(r));
      },
    };
  }

  // why: FR-MAP-3 the second writer finds the first's lock held (its transaction still open) and stores nothing; 1 row
  it('stores 1 row when the second write comes while the first transaction is open', async () => {
    const s = heldService();
    configureRouting({ service: s });
    const [c1, c2] = [await webClient(), await webClient()];
    try {
      const from = await pointOf(await w.newJob({ tech: w.techs[0] }));
      const to = await pointOf(await w.newJob({ tech: w.techs[0] }));
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      // c1 asks first (call 0), then c2 (call 1): both read no row and asked the service, in that order
      const p1 = legsFor(c1, 'columbus', [{ from, to }]);
      await s.asked(1);
      const p2 = legsFor(c2, 'columbus', [{ from, to }]);
      await s.asked(2);
      s.release(0);
      const [a1] = await p1; // stored, lock held, not committed
      s.release(1);
      const [a2] = await p2; // lock taken by c1: nothing stored, answered from its own route
      await c1.query('COMMIT');
      await c2.query('COMMIT');
      expect([a1!.source, a2!.source]).toEqual(['live', 'live']);
      expect(a2!.track).toEqual(a1!.track);
      expect((await rows(`from_ref = '${from.job}' AND to_ref = '${to.job}'`)).length).toBe(1);
    } finally {
      configureRouting({ service: fake });
      await c1.end();
      await c2.end();
    }
  });

  // why: FR-MAP-3 the second writer takes the lock after the first committed, reads the pair again and finds the row; 1 row
  it('stores 1 row when the second write comes after the first committed', async () => {
    const s = heldService();
    configureRouting({ service: s });
    const [c1, c2] = [await webClient(), await webClient()];
    try {
      const from = await pointOf(await w.newJob({ tech: w.techs[0] }));
      const to = await pointOf(await w.newJob({ tech: w.techs[0] }));
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      const p1 = legsFor(c1, 'columbus', [{ from, to }]);
      await s.asked(1);
      const p2 = legsFor(c2, 'columbus', [{ from, to }]);
      await s.asked(2);
      s.release(0);
      const [a1] = await p1;
      expect(a1!.source, 'the first reader routed and stored').toBe('live');
      expect((await rows(`from_ref = '${from.job}' AND to_ref = '${to.job}'`)).length, 'not yet committed').toBe(0);
      await c1.query('COMMIT');
      s.release(1);
      const [a2] = await p2;
      await c2.query('COMMIT');
      expect(a2!.source).toBe('live');
      expect((await rows(`from_ref = '${from.job}' AND to_ref = '${to.job}'`)).length).toBe(1);
    } finally {
      configureRouting({ service: fake });
      await c1.end();
      await c2.end();
    }
  });

  // why: FR-MAP-3 the same race through the production kernel: 2 API-104 reads at once, both routed, 1 row
  it('stores 1 row for 2 API-104 reads at once', async () => {
    const [a] = w.techs;
    const j1 = await w.newJob({ tech: a });
    const j2 = await w.newJob({ tech: a });
    let open!: () => void;
    fake.gate = new Promise<void>((r) => { open = r; });
    const calls = fake.calls;
    const both = Promise.all([w.get(`/tech/route?fromJob=${j1}&toJob=${j2}`, a), w.get(`/tech/route?fromJob=${j1}&toJob=${j2}`, a)]);
    while (fake.calls < calls + 2) await new Promise((r) => setTimeout(r, 10));
    open();
    const [x, y] = await both;
    const [r1, r2] = [await read<Route>(x), await read<Route>(y)];
    expect(r1.leg.track).toEqual(r2.leg.track);
    expect(r1.steps).toEqual(r2.steps);
    expect((await rows(`from_ref = '${j1}' AND to_ref = '${j2}'`)).length).toBe(1);
  });
});

describe('a write that moves the point a job is driven to', () => {
  // why: FR-MAP-3 an address edit (API-36) deletes every row naming the customer's jobs, baked or live, and the next read routes the new point
  it('deletes every row naming the job, baked or live', async () => {
    const [a] = w.techs;
    const j1 = await w.newJob({ tech: a });
    const j2 = await w.newJob({ tech: a });
    await read<Route>(await w.get(`/tech/route?fromJob=${j1}&toJob=${j2}`, a)); // live j1 -> j2
    await w.admin().query(`INSERT INTO world.van_track (branch_id, from_ref, to_ref, polyline, seconds, distance_m, build_id) VALUES ('columbus', 'depot', $1, '_p~iF~ps|U', '{0,60}', 100, 'test')`, [String(j2)]);
    expect((await rows(`to_ref = '${j2}'`)).map((x) => x.build_id).sort()).toEqual(['live', 'test']);
    const [c] = await w.rows<{ id: string; house_number: number }>('SELECT c.id, c.house_number FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.job_number = $1', [j2]);
    const r = await w.kernel.router.handle(new Request(`http://web:3000/api/v1/customers/${c!.id}`, {
      method: 'PATCH', body: JSON.stringify({ houseNumber: c!.house_number + 1 }), headers: { 'content-type': 'application/json', cookie: w.keisha.cookie, origin: ORIGIN },
    }), { address: '203.0.113.9' });
    expect(r.status, await r.clone().text()).toBe(200);
    // F-1933: the edit plans the day again after it deletes (SD-15), so a row naming the job now is one its own plan routed to the new point.
    const moved = await pointOf(j2);
    const at = [Math.round(moved.lon * 1e5) / 1e5, Math.round(moved.lat * 1e5) / 1e5];
    for (const x of await rows(`to_ref = '${j2}' OR from_ref = '${j2}'`)) {
      expect(x.build_id).toBe('live');
      expect(decodePolyline(x.polyline).at(x.to_ref === String(j2) ? -1 : 0)).toEqual(at);
    }
    const again = await read<Route>(await w.get(`/tech/route?fromJob=${j1}&toJob=${j2}`, a));
    expect(again.leg.to).toEqual({ lon: moved.lon, lat: moved.lat });
    expect(again.leg.track!.at(-1)).toEqual(at);
  });

  // why: FR-MAP-3 a reader that routed the old point while the edit holds the customer row stores nothing, so no row outlives its point
  it('leaves a reader routing the old point meanwhile with nothing stored', async () => {
    const from = await pointOf(await w.newJob({ tech: w.techs[0] }));
    const to = await pointOf(await w.newJob({ tech: w.techs[0] }));
    const [editor, reader] = [await webClient(), await webClient()];
    try {
      await editor.query('BEGIN');
      await editor.query(`UPDATE world.customer SET lon = lon + 0.001 WHERE id = (SELECT customer_id FROM world.job WHERE job_number = $1)`, [to.job]);
      await reader.query('BEGIN');
      const [ans] = await legsFor(reader, 'columbus', [{ from, to }]);
      await reader.query('COMMIT');
      await editor.query('ROLLBACK');
      expect(ans!.source).toBe('live'); // answered from its own route
      expect(await rows(`from_ref = '${from.job}' AND to_ref = '${to.job}'`)).toEqual([]);
    } finally {
      await editor.end();
      await reader.end();
    }
  });
});

describe('the world reset (SD-12)', () => {
  // why: FR-MAP-3, FR-DEMO-6 the snapshot keeps no live row, and the reset drops every live row and keeps every baked one
  it('drops every live row and keeps every baked row', async () => {
    await w.admin().query(`INSERT INTO world.van_track (branch_id, from_ref, to_ref, polyline, seconds, distance_m, build_id) VALUES ('columbus', 'depot', '1', '_p~iF~ps|U', '{0,60}', 100, 'ohio-test')`);
    const baked = (await rows(`build_id <> 'live'`)).length;
    expect((await liveRows()).length).toBeGreaterThan(0); // stored by the tests above, before the snapshot
    await writeSnapshot(w.admin(), { clockReal: new Date('2026-11-10T09:00:00Z'), recordReal: new Date('2026-11-10T09:00:00Z') });
    expect(Number((await w.rows<{ n: string }>(`SELECT count(*) AS n FROM world_snapshot.van_track WHERE build_id = 'live'`))[0]!.n)).toBe(0);
    const j1 = await w.newJob({ tech: w.techs[0] });
    const j2 = await w.newJob({ tech: w.techs[0] });
    await legsFor(w.admin(), 'columbus', [{ from: await pointOf(j1), to: await pointOf(j2) }]); // 1 more live row, after the snapshot
    expect((await rows(`from_ref = '${j1}' AND to_ref = '${j2}' AND build_id = 'live'`)).length).toBe(1);
    const c = await webClient();
    try {
      await c.query('BEGIN');
      await resetWorld(c, { byName: 'Test', real: new Date('2026-11-10T09:05:00Z') });
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
    expect(await liveRows()).toEqual([]);
    expect((await rows(`build_id <> 'live'`)).length).toBe(baked);
  });
});
