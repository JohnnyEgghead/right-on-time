// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-MAP-3, FR-TECH-5, FR-TECH-13, NFR-12 (P6-LIVE-ROUTING: SD-49's route source, its live client and its budget, without a database)
// The live client's mapping is the bake's (polyline, cumulative seconds, distance, steps); every failure of the routing service answers no
// route; the budget is per transaction and shared by every ask in it; a run with routing off never asks. The stored-row read, the live
// write and its lock run on a real PostgreSQL in packages/api-server/src/handlers/live-routing.db.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, type Logger } from '../../log/src/index.ts';
import type { Queryable } from '../../db/src/client.ts';
import { etaDay, legsAsked, planDay, type EtaStop } from '../../domain/src/planner.ts';
import { configureRouting, legsFor, LIVE_ROUTE_CONCURRENCY, osrmRoutingService, osrmRouteUrl, ROUTE_SIGNAL_INTERVAL_MS, ROUTING_SERVICE_URL, routedOutside, trackFromOsrm, type RouteTrack, type RoutingService } from './route-source.ts';
import { FakeRouting, osrmRouteBetween } from './testing.ts';
import { decodePolyline } from './tracks.ts';

const A = { lon: -83.0, lat: 39.96 };
const B = { lon: -83.01234, lat: 39.97456 };

/** A transaction stand-in: no stored rows, a fixed transaction id, and a record of every statement. A store attempt is a test failure. */
function fakeTx(id = '2026-11-10 09:00:00.000001+00'): Queryable & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    async query<R>(text: string) {
      sql.push(text);
      if (text.includes('transaction_timestamp()')) return { rows: [{ id }] as R[], rowCount: 1 };
      if (text.includes('FROM unnest')) return { rows: [] as R[], rowCount: 0 };
      throw new Error(`unexpected statement: ${text.slice(0, 60)}`);
    },
  };
}

afterEach(() => configureRouting(null));

describe('the live mapping (trackFromOsrm)', () => {
  // why: FR-TECH-5 a live track is written as the bake writes one: precision-5 polyline, rounded cumulative seconds per vertex, rounded distance, SD-49 steps summing to it
  it('maps an OSRM route as the bake does', () => {
    const rt = osrmRouteBetween(A, B);
    const t = trackFromOsrm(rt);
    expect(decodePolyline(t.polyline)).toEqual(rt.geometry.coordinates);
    expect(t.seconds).toEqual([0, 60, 150]);
    expect(t.distance_m).toBe(Math.round(rt.distance));
    expect(t.steps.map((s) => [s.kind, s.direction, s.heading, s.road])).toEqual([['depart', null, 'e', 'Test Rd'], ['turn', 'left', null, 'Second St'], ['arrive', null, null, 'Second St']]);
    expect(t.steps.reduce((n, s) => n + s.distanceMeters, 0)).toBe(t.distance_m);
  });

  // why: FR-TECH-13 a route whose duration annotation does not match its geometry spreads the route's duration evenly, as the bake does
  it('spreads the duration evenly when the annotation does not match the geometry', () => {
    const rt = osrmRouteBetween(A, B);
    rt.legs[0]!.annotation = { duration: [60] };
    expect(trackFromOsrm(rt).seconds).toEqual([0, 75, 150]);
  });
});

describe('the live client (osrmRoutingService)', () => {
  const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

  // why: FR-MAP-3, NFR-12 the 1 request is the bake's (full geometry, duration annotation, steps) to the Compose service, no outside host
  it('asks the routing service on the Compose network with the bake\'s options', async () => {
    const urls: string[] = [];
    const s = osrmRoutingService(ROUTING_SERVICE_URL, { fetch: (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ code: 'Ok', routes: [osrmRouteBetween(A, B)] })); }) as typeof fetch });
    const t = await s.route(A, B);
    expect(t?.seconds).toEqual([0, 60, 150]);
    expect(urls).toEqual([osrmRouteUrl('http://routing:5000', A, B)]);
    expect(urls[0]).toBe('http://routing:5000/route/v1/driving/-83,39.96;-83.01234,39.97456?overview=full&geometries=geojson&annotations=duration&steps=true');
  });

  // why: FR-MAP-3 no route, an HTTP error, a refused connection, a body that is not JSON and a step the mapping refuses all answer no route (approximate), never a throw
  it('answers null for every failure', async () => {
    const bad = osrmRouteBetween(A, B);
    bad.legs[0]!.steps[1]!.maneuver.type = 'teleport';
    const cases: (() => Promise<Response>)[] = [
      answer({ code: 'NoRoute' }), answer({ code: 'Ok', routes: [] }), answer({ code: 'Ok', routes: [osrmRouteBetween(A, B)] }, 500),
      async () => { throw new TypeError('fetch failed'); }, async () => new Response('<html>'), answer({ code: 'Ok', routes: [bad] }),
    ];
    for (const f of cases) expect(await osrmRoutingService('http://x', { fetch: f as typeof fetch }).route(A, B)).toBeNull();
  });

  // why: FR-MAP-3 a request the service never answers is cut at the client's timeout
  it('cuts a request the service never answers', async () => {
    const stalled = ((_u: string, init?: RequestInit) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as typeof fetch;
    const t0 = performance.now();
    expect(await osrmRoutingService('http://x', { fetch: stalled, timeoutMs: 80 }).route(A, B)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  // why: FR-MAP-3 2 reads of the same pair in 1 process share 1 request
  it('shares a request already in flight for the same points', async () => {
    let n = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const f = (async () => { n += 1; await held; return new Response(JSON.stringify({ code: 'Ok', routes: [osrmRouteBetween(A, B)] })); }) as typeof fetch;
    const s = osrmRoutingService('http://x', { fetch: f });
    const both = Promise.all([s.route(A, B), s.route(A, B)]);
    release();
    const [x, y] = await both;
    expect(n).toBe(1);
    expect(x).toEqual(y);
    await s.route(A, B);
    expect(n).toBe(2); // nothing is remembered once answered: the next read asks again
  });
});

describe('the route source without a database row (legsFor)', () => {
  const legs = (n: number) => Array.from({ length: n }, (_, i) => ({ from: { job: null, ...A }, to: { job: 1000 + i, lon: B.lon + i / 1000, lat: B.lat } }));

  // why: FR-MAP-3 with routing off (setup, a unit test) the source never asks, stores nothing and answers SD-22's approximate line
  it('answers approximate and asks nothing with routing off', async () => {
    const tx = fakeTx();
    const [a] = await legsFor(tx, 'columbus', legs(1));
    expect(a).toMatchObject({ source: 'approximate', track: null });
    expect(tx.sql).toHaveLength(1); // the 1 stored-row read
  });

  // why: FR-MAP-3 a stalled service answers approximate within the budget, and the rest of the transaction's asks share what is left
  it('spends 1 budget per transaction, shared by every ask in it', async () => {
    const f = new FakeRouting();
    f.mode = 'stall';
    configureRouting({ service: f, budgetMs: 200 });
    const tx = fakeTx('t1');
    let t0 = performance.now();
    expect((await legsFor(tx, 'columbus', legs(3))).map((a) => a.source)).toEqual(['approximate', 'approximate', 'approximate']);
    const first = performance.now() - t0;
    expect(first).toBeGreaterThanOrEqual(190);
    expect(first).toBeLessThan(1_000);
    t0 = performance.now();
    const calls = f.calls;
    await legsFor(tx, 'columbus', legs(2)); // same transaction: the budget is spent, so nothing is asked
    expect(performance.now() - t0).toBeLessThan(100);
    expect(f.calls).toBe(calls);
    // a new transaction on the same connection gets its own budget and asks again
    const again = fakeTx('t2');
    t0 = performance.now();
    await legsFor(again, 'columbus', legs(1));
    expect(performance.now() - t0).toBeGreaterThanOrEqual(190);
    expect(f.calls).toBe(calls + 1);
  });

  // why: FR-MAP-3 the ask cut at the deadline spends the transaction's budget then, so a later ask in it asks nothing even when the cut
  // lands before the clock reads the deadline (Node fires a timer up to about 2 ms early; F-1328 asked the stalled service 2 more times)
  it('spends the budget at the cut, whatever the clock reads', async () => {
    // Only the cut is faked: performance.now() keeps real time, so every cut below lands about 200 ms before the clock reads the deadline.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const f = new FakeRouting();
      f.mode = 'stall';
      configureRouting({ service: f, budgetMs: 200 });
      const tx = fakeTx('t1');
      const first = legsFor(tx, 'columbus', legs(3));
      await vi.advanceTimersByTimeAsync(200);
      expect((await first).map((a) => a.source)).toEqual(['approximate', 'approximate', 'approximate']);
      expect(f.calls).toBe(3);
      const second = legsFor(tx, 'columbus', legs(2));
      await vi.advanceTimersByTimeAsync(200);
      expect((await second).map((a) => a.source)).toEqual(['approximate', 'approximate']);
      expect(f.calls).toBe(3);
      // a new transaction still gets its own budget and asks again
      const third = legsFor(fakeTx('t2'), 'columbus', legs(1));
      await vi.advanceTimersByTimeAsync(200);
      expect((await third).map((a) => a.source)).toEqual(['approximate']);
      expect(f.calls).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  // why: FR-MAP-3 the missing legs of 1 read are asked in parallel, at most LIVE_ROUTE_CONCURRENCY at once
  it('asks in parallel with a cap', async () => {
    let open = 0;
    let most = 0;
    const s: RoutingService = {
      async route(): Promise<RouteTrack | null> {
        open += 1;
        most = Math.max(most, open);
        await new Promise((r) => setTimeout(r, 20));
        open -= 1;
        return null;
      },
    };
    configureRouting({ service: s, budgetMs: 2_000 });
    const t0 = performance.now();
    await legsFor(fakeTx(), 'columbus', legs(20));
    expect(most).toBe(LIVE_ROUTE_CONCURRENCY);
    expect(performance.now() - t0).toBeLessThan(20 * 20); // not 1 after another
  });
});

describe('a call run outside its transaction (routedOutside, F-1504)', () => {
  const legs = (n: number) => Array.from({ length: n }, (_, i) => ({ from: { job: null, ...A }, to: { job: 2000 + i, lon: B.lon + i / 1000, lat: B.lat } }));
  /** A transaction runner that knows when a transaction is open and counts the ones it ran and rolled back. */
  function runner() {
    const r = {
      open: false, ran: 0, rolledBack: 0,
      transaction: async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
        r.open = true;
        r.ran += 1;
        try {
          return await fn(fakeTx(`t${r.ran}`));
        } catch (e) {
          r.rolledBack += 1;
          throw e;
        } finally {
          r.open = false;
        }
      },
    };
    return r;
  }
  /** A service that answers no route after `ms` and records whether a transaction was open at each ask. */
  const service = (r: { open: boolean }, ms = 20) => {
    const s = {
      openAtAsk: [] as boolean[],
      async route(): Promise<RouteTrack | null> {
        s.openAtAsk.push(r.open);
        await new Promise((x) => setTimeout(x, ms));
        return null;
      },
    };
    return s;
  };

  // why: NFR-01, NFR-03 every ask runs with no transaction open, so a slow service holds no pooled connection; the call runs again after
  it('asks with no transaction open, then runs the call again', async () => {
    const r = runner();
    const s = service(r);
    configureRouting({ service: s, budgetMs: 2_000 });
    let passes = 0;
    const out = await routedOutside(r.transaction, async (tx) => {
      passes += 1;
      return (await legsFor(tx, 'columbus', legs(3))).map((a) => a.source);
    });
    expect(out).toEqual(['approximate', 'approximate', 'approximate']);
    expect(s.openAtAsk).toEqual([false, false, false]);
    expect([passes, r.ran, r.rolledBack]).toEqual([2, 2, 1]);
  });

  // why: NFR-01 a call that lacks no leg runs once in 1 transaction, as before, and asks nothing
  it('runs a call that lacks nothing once', async () => {
    const r = runner();
    const s = service(r);
    configureRouting({ service: s });
    expect(await routedOutside(r.transaction, async () => 'ok')).toBe('ok');
    expect([r.ran, r.rolledBack, s.openAtAsk.length]).toEqual([1, 0, 0]);
  });

  // why: FR-MAP-3 a stalled service costs the call 1 budget, cut outside the transaction; the second pass answers approximate and asks nothing
  it('cuts a stalled service at 1 budget for the call and asks nothing in the second pass', async () => {
    const r = runner();
    const f = new FakeRouting();
    f.mode = 'stall';
    configureRouting({ service: f, budgetMs: 200 });
    const t0 = performance.now();
    const out = await routedOutside(r.transaction, async (tx) => [...(await legsFor(tx, 'columbus', legs(2))), ...(await legsFor(tx, 'columbus', legs(3)))].map((a) => a.source));
    const took = performance.now() - t0;
    expect(out).toEqual(Array(5).fill('approximate'));
    // The first call's 2 legs are asked and cut at the budget; the second call's 1 new leg then finds it spent, as in 1 transaction.
    expect(f.calls).toBe(2);
    expect(took).toBeGreaterThanOrEqual(190);
    expect(took).toBeLessThan(1_000);
  });

  // why: FR-MAP-3 the lacked legs are asked as the call would ask them in its transaction: each legsFor call's legs together, the calls in
  // turn, so a board read of many technicians never puts more than 1 technician's legs on the service at once (P7-LOAD-CAUSE run f320s)
  it('asks each legsFor call\'s legs together and the calls one after another', async () => {
    const r = runner();
    let open = 0;
    let most = 0;
    const order: number[] = [];
    configureRouting({
      service: {
        async route(_from, to): Promise<RouteTrack | null> {
          open += 1;
          most = Math.max(most, open);
          order.push(Math.floor((to.lon - B.lon) * 1000 + 0.5));
          await new Promise((x) => setTimeout(x, 10));
          open -= 1;
          return null;
        },
      },
      budgetMs: 2_000,
    });
    const third = (i: number) => legs(9).slice(3 * i, 3 * i + 3);
    await routedOutside(r.transaction, async (tx) => {
      for (const i of [0, 1, 2]) await legsFor(tx, 'columbus', third(i));
      return null;
    });
    expect(most).toBe(3);
    expect(order.slice(0, 3).sort()).toEqual([0, 1, 2]);
    expect(order.slice(6).sort()).toEqual([6, 7, 8]);
  });

  // why: NFR-03 a refusal of the first pass may hang on an approximate drive time: the call runs again after the asks, and its own outcome stands
  it('runs the call again after a first pass that threw, and answers the second pass', async () => {
    const r = runner();
    configureRouting({ service: service(r) });
    let passes = 0;
    const out = await routedOutside(r.transaction, async (tx) => {
      passes += 1;
      await legsFor(tx, 'columbus', legs(1));
      if (passes === 1) throw new Error('refused on an approximate drive time');
      return 'second';
    });
    expect([out, passes]).toEqual(['second', 2]);
  });

  // why: FR-MAP-3 a route depends only on its 2 points: a leg whose stop's job number differs in the second pass (a create's number drawn
  // again) takes the route asked for its points, with no second ask (F-1509)
  it('answers a leg from the route asked for its points when its job number differs between the passes', async () => {
    const f = new FakeRouting();
    configureRouting({ service: f });
    // The live write finds the pair's lock taken (busy), so the leg is answered from the route and nothing is stored.
    const busyTx: Queryable = {
      async query<R>(text: string) {
        if (text.includes('pg_try_advisory_xact_lock')) return { rows: [{ ok: false }] as R[], rowCount: 1 };
        if (text.includes('FROM unnest')) return { rows: [] as R[], rowCount: 0 };
        throw new Error(`unexpected statement: ${text.slice(0, 60)}`);
      },
    };
    let passes = 0;
    const out = await routedOutside(async (fn) => fn(busyTx), async (tx) => {
      passes += 1;
      const [leg] = await legsFor(tx, 'columbus', [{ from: { job: null, ...A }, to: { job: 24800 + passes, ...B } }]);
      return [leg!.source, leg!.minutes];
    });
    expect([passes, f.calls]).toEqual([2, 1]);
    expect(out).toEqual(['live', 3]);
  });

  // why: FR-MAP-3, F-1515 a stop moved between the 2 passes (a different point) is not the route asked for: the leg is answered approximate,
  // with no second ask and no route stored
  it('answers a leg approximate and stores nothing when its stop moved between the passes', async () => {
    const f = new FakeRouting();
    configureRouting({ service: f });
    const statements: string[] = [];
    const tx: Queryable = {
      async query<R>(text: string) {
        statements.push(text);
        if (text.includes('pg_try_advisory_xact_lock')) return { rows: [{ ok: true }] as R[], rowCount: 1 };
        if (text.includes('FROM unnest')) return { rows: [] as R[], rowCount: 0 };
        return { rows: [] as R[], rowCount: 0 };
      },
    };
    let passes = 0;
    const out = await routedOutside(async (fn) => fn(tx), async (t) => {
      passes += 1;
      const to = passes === 1 ? B : { lon: B.lon + 0.05, lat: B.lat };
      const [leg] = await legsFor(t, 'columbus', [{ from: { job: null, ...A }, to: { job: 24800, ...to } }]);
      return leg!.source;
    });
    expect(passes).toBe(2);
    expect(out).toBe('approximate');
    expect(f.calls).toBe(1);
    expect(statements.filter((s) => /insert/i.test(s))).toEqual([]);
  });

  // why: FR-MAP-3 with routing off it is 1 transaction and never notes or asks
  it('is 1 plain transaction with routing off', async () => {
    const r = runner();
    expect(await routedOutside(r.transaction, async (tx) => (await legsFor(tx, 'columbus', legs(1)))[0]!.source)).toBe('approximate');
    expect([r.ran, r.rolledBack]).toEqual([1, 0]);
  });
});

describe('the legs a planner run asks for (legsAsked)', () => {
  const stop = (n: number, startHour: number, lon: number) => ({ jobNumber: n, windowStart: Date.UTC(2026, 8, 15, startHour), bookedAt: 0, expectedMinutes: 60, point: { lon, lat: 39.9 } });

  // why: FR-MAP-3 the planner asks only the legs of its day order (depot to the first, then each next), not every pair of the day
  it('records planDay\'s legs in day order', () => {
    const day = { shiftStart: Date.UTC(2026, 8, 15, 12), depot: { lon: -83, lat: 39.96 }, stops: [stop(3, 16, -83.03), stop(1, 12, -83.01), stop(2, 14, -83.02)] };
    expect(legsAsked((drive) => planDay({ ...day, drive })).map((l) => [l.fromJob, l.toJob])).toEqual([[null, 1], [1, 2], [2, 3]]);
  });

  // why: FR-MAP-3, FR-TECH-13 etaDay's on-the-way leg is the previous ended stop's, asked as well as the day-order legs
  it('records etaDay\'s on-the-way leg from the last ended stop', () => {
    const e = (s: ReturnType<typeof stop>, status: EtaStop['status'], endedAt: number | null = null): EtaStop => ({
      ...s, status, windowEnd: s.windowStart + 7_200_000, onTheWayAt: status === 'on_the_way' ? s.windowStart : null, arrivedAt: null, endedAt,
    });
    const stops = [e(stop(1, 12, -83.01), 'done', 1), e(stop(2, 14, -83.02), 'scheduled'), e(stop(3, 16, -83.03), 'on_the_way')];
    const asks = legsAsked((drive) => etaDay({ now: Date.UTC(2026, 8, 15, 16), shiftStart: Date.UTC(2026, 8, 15, 12), depot: { lon: -83, lat: 39.96 }, stops, drive }));
    expect(asks.map((l) => [l.fromJob, l.toJob])).toEqual([[1, 2], [1, 3]]);
  });
});

describe('the operator signal of the live client (F-1306)', () => {
  const ok = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
  const logTo = (lines: Record<string, unknown>[]): Logger => createLogger({ process: 'web', write: (l) => lines.push(JSON.parse(l)) });
  const bad = osrmRouteBetween(A, B);
  bad.legs[0]!.steps[1]!.maneuver.type = 'teleport';
  const fail = (code: string, name = 'TypeError') => async () => { throw Object.assign(new TypeError('fetch failed'), { name, cause: { code } }); };
  const byClass: [string, () => Promise<Response>][] = [
    ['refused', fail('ECONNREFUSED')],
    ['unresolved', fail('ENOTFOUND')],
    ['timed out', fail('UND_ERR_CONNECT_TIMEOUT', 'TimeoutError')],
    ['bad answer', async () => new Response('<html>')],
    ['no route', ok({ code: 'NoRoute', message: 'Impossible route between points' }, 400)],
    ['no route', ok({ code: 'NoSegment', message: 'No segment found' }, 400)],
    ['bad answer', async () => new Response('<html>', { status: 400 })],
    ['bad answer', ok({ code: 'InvalidQuery', message: 'Query string malformed' }, 400)],
    ['step refused', ok({ code: 'Ok', routes: [bad] })],
  ];

  // why: F-1306 F-1767 (osrm-routed answers NoRoute and NoSegment as HTTP 400 with a JSON body, F-1337; the clock stamp is no field that can carry a location) a stub service failing by each cause class gives 1 warn line naming that class, through @bw/log, with no point or job in it
  it.each(byClass)('writes 1 warn line naming %s', async (cause, f) => {
    const lines: Record<string, unknown>[] = [];
    expect(await osrmRoutingService('http://x', { fetch: f as typeof fetch, log: logTo(lines) }).route(A, B)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', process: 'web', status: 'live route failed', errorCode: cause, failures: 1 });
    // the clock stamp (realTime) is no field that can carry a location; a stamp reading :39.9 must not fail this
    const fields = Object.fromEntries(Object.entries(lines[0]!).filter(([k]) => k !== 'realTime'));
    expect(JSON.stringify(fields)).not.toMatch(/-83|39\.9|Test Rd|Second St/);
    expect(Object.keys(lines[0]!).sort()).toEqual(['errorCode', 'failures', 'level', 'process', 'realTime', 'status']);
  });

  // why: F-1306 100 failures inside 1 minute of real time give exactly 1 line; the next minute's first failure gives the 2nd, carrying the count
  it('writes 1 line a minute, the next carrying the failures since the last', async () => {
    const lines: Record<string, unknown>[] = [];
    let t = 1_000;
    const s = osrmRoutingService('http://x', { fetch: fail('ECONNREFUSED') as typeof fetch, log: logTo(lines), now: () => t });
    for (let i = 0; i < 100; i++) {
      t += 500; // 100 failures over 50 s
      await s.route({ lon: A.lon + i / 1000, lat: A.lat }, B);
    }
    expect(lines).toHaveLength(1);
    t += ROUTE_SIGNAL_INTERVAL_MS;
    await s.route(A, B);
    expect(lines.map((l) => [l.errorCode, l.failures])).toEqual([['refused', 1], ['refused', 100]]);
  });

  // why: F-1338 an ask the transaction's budget cuts while its request is pending writes the timed out line, even when that request
  // answers later (the shared request runs on to its own cut), so the office's Approximate route always has a line behind it
  it('signals an ask cut by the budget while its request is pending, whatever the request does after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const lines: Record<string, unknown>[] = [];
      const late: RoutingService = { route: () => new Promise((r) => setTimeout(() => r(trackFromOsrm(osrmRouteBetween(A, B))), 400)) };
      configureRouting({ service: late, budgetMs: 200, log: logTo(lines) });
      const answer = legsFor(fakeTx('t1'), 'columbus', [{ from: { job: null, ...A }, to: { job: 1000, ...B } }]);
      await vi.advanceTimersByTimeAsync(200);
      expect((await answer).map((a) => a.source)).toEqual(['approximate']);
      expect(lines.map((l) => [l.status, l.errorCode, l.failures])).toEqual([['live route failed', 'timed out', 1]]);
      await vi.advanceTimersByTimeAsync(400); // the request answers after the cut: still 1 line, nothing new
      expect(lines).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // why: F-1338 an ask answered inside the budget writes no line, and a route source configured without a logger writes none at the cut
  it('writes nothing for an ask answered inside the budget, or at a cut with no logger', async () => {
    const lines: Record<string, unknown>[] = [];
    configureRouting({ service: { route: async () => trackFromOsrm(osrmRouteBetween(A, B)) }, budgetMs: 200, log: logTo(lines) });
    const tx = { ...fakeTx('t1'), query: async <R>(text: string) => (text.includes('transaction_timestamp()') ? { rows: [{ id: 't1' }] as R[], rowCount: 1 } : { rows: [] as R[], rowCount: 0 }) };
    await legsFor(tx, 'columbus', [{ from: { job: null, ...A }, to: { job: 1000, ...B } }]);
    const f = new FakeRouting();
    f.mode = 'stall';
    configureRouting({ service: f, budgetMs: 50 });
    await legsFor(fakeTx('t2'), 'columbus', [{ from: { job: null, ...A }, to: { job: 1001, ...B } }]);
    expect(lines).toEqual([]);
  });

  // why: F-1306 a working service writes no line, and a client given no logger writes none (tests, setup)
  it('writes nothing for an answered route or without a logger', async () => {
    const lines: Record<string, unknown>[] = [];
    await osrmRoutingService('http://x', { fetch: ok({ code: 'Ok', routes: [osrmRouteBetween(A, B)] }) as typeof fetch, log: logTo(lines) }).route(A, B);
    await osrmRoutingService('http://x', { fetch: fail('ECONNREFUSED') as typeof fetch }).route(A, B);
    expect(lines).toEqual([]);
  });
});
