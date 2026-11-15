// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-MAP-3, NFR-01, NFR-03 (F-1504: no call of the web server waits on the routing service while it holds a transaction)
// The hosted real-speed day (P7-LOAD, Nov 12-13) answered 500 to 16 board reads and 12 van reads, every one inside a burst of live route
// asks at a 75-minute job slot: each read or write that lacked a leg waited on the routing service, up to SD-49's 3 s, inside its
// transaction, holding 1 of the web pool's 10 connections, and calls that waited 5 s for a connection were answered 500. Through the
// production kernel (createWebKernel) as bw_web, with a routing service the test holds (FakeRouting's gate):
//   1. a read that lacks a leg holds no transaction while its ask waits, then answers the live route and stores it as 1 live row;
//   2. an On my way that lacks its leg holds no transaction while its ask waits, then applies once, its ETA from the live route;
//   3. 12 such reads at once leave the pool free: a read that needs no route answers at once, not after the asks are cut.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { configureRouting } from '../../../maps/src/route-source.ts';
import { FakeRouting } from '../../../maps/src/testing.ts';
import { answers, demoAt, item, techWorld, type TechWorld } from '../tech-items/testing.ts';

const db = useMigratedDatabase();
let w: TechWorld;
const fake = new FakeRouting();
let open: (() => void) | null = null;

/** Hold every answer of the routing service until {@link release}. */
function hold(): void {
  fake.gate = new Promise<void>((r) => { open = r; });
}
function release(): void {
  open?.();
  open = null;
  fake.gate = null;
}
async function asked(n: number): Promise<void> {
  const by = performance.now() + 5_000;
  while (fake.calls < n) {
    if (performance.now() > by) throw new Error(`the routing service was asked ${fake.calls} times, not ${n}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
/** The web kernel's connections (application_name bw-web) that sit inside an open transaction, waiting on the server process. */
const inTransaction = async (): Promise<number> => (await w.rows<{ n: number }>(
  `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'bw-web' AND state LIKE 'idle in transaction%'`))[0]!.n;
const liveRows = (from: string, to: string) => w.rows<{ build_id: string }>(
  'SELECT build_id FROM world.van_track WHERE from_ref = $1 AND to_ref = $2', [from, to]);

beforeAll(async () => {
  w = await techWorld(db);
  await w.runningClock(demoAt('11:06'));
  configureRouting({ service: fake });
}, 120_000);
afterEach(() => {
  release();
  fake.mode = 'up';
});
afterAll(async () => {
  configureRouting(null);
  await w?.close();
});

describe('a call that lacks a leg (F-1504)', () => {
  // why: FR-MAP-3 the read waits on the service with no transaction open, then answers the live route and stores 1 live row
  it('holds no transaction while its ask waits, then answers and stores the route', async () => {
    const [a] = w.techs;
    const j1 = await w.newJob({ tech: a });
    const j2 = await w.newJob({ tech: a });
    hold();
    const calls = fake.calls;
    const reading = w.get(`/tech/route?fromJob=${j1}&toJob=${j2}`, a);
    await asked(calls + 1);
    expect(await inTransaction()).toBe(0);
    release();
    const r = await reading;
    expect(r.status).toBe(200);
    const leg = ((await r.json()) as { data: { leg: { track: unknown; minutes: number } } }).data.leg;
    expect(leg.track).not.toBeNull();
    expect(leg.minutes).toBe(3); // FakeRouting's route: 150 s
    expect(await liveRows(String(j1), String(j2))).toEqual([{ build_id: 'live' }]);
    expect(fake.calls).toBe(calls + 1);
  });

  // why: NFR-03 an On my way that lacks its leg waits with no transaction (and no job lock) open, then applies exactly once with its ETA from the route
  it('applies an On my way once, its ETA from the route, holding no transaction while the ask waits', async () => {
    const [a] = w.techs;
    const n = await w.newJob({ tech: a, customerId: w.texting[0] });
    hold();
    const calls = fake.calls;
    const sending = w.send([item({ kind: 'on_my_way', jobNumber: n, baseVersion: 1, entered: demoAt('10:28') })], a);
    await asked(calls + 1);
    expect(await inTransaction()).toBe(0);
    release();
    expect((await answers(await sending))[0]?.result).toBe('applied');
    const [job] = await w.rows<{ version: number; on_the_way_at: Date; texted_arrival: Date | null }>(
      'SELECT version, on_the_way_at, texted_arrival FROM world.job WHERE job_number = $1', [n]);
    expect(job!.version).toBe(2);
    expect(job!.texted_arrival).not.toBeNull();
    expect(await w.rows('SELECT 1 FROM world.job_change WHERE job_number = $1 AND kind = $2', [n, 'status'])).toHaveLength(1);
    expect(await w.rows('SELECT 1 FROM world.outbox_text WHERE job_number = $1', [n])).toHaveLength(1);
    // The second pass answered the leg from the route asked between the passes, and stored it in its own transaction.
    expect(await w.rows('SELECT build_id FROM world.van_track WHERE to_ref = $1', [String(n)])).toEqual([{ build_id: 'live' }]);
    expect(fake.calls).toBe(calls + 1);
  });

  // why: NFR-01 12 reads waiting on the service at once leave the web pool (10 connections) free for a call that needs no route
  it('leaves the pool free while many asks wait', async () => {
    const [a, b] = w.techs;
    const jobs: number[] = [];
    for (let i = 0; i < 13; i++) jobs.push(await w.newJob({ tech: a }));
    hold();
    const calls = fake.calls;
    const reads = jobs.slice(1).map((to, i) => w.get(`/tech/route?fromJob=${jobs[i]}&toJob=${to}`, a));
    await asked(calls + 10);
    const t0 = performance.now();
    const me = await w.get('/me', b);
    const took = performance.now() - t0;
    expect(me.status).toBe(200);
    expect(took).toBeLessThan(1_000);
    release();
    expect((await Promise.all(reads)).map((r) => r.status)).toEqual(Array(12).fill(200));
  });
});
