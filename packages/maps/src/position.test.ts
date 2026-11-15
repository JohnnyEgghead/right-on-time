// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DEMO-8 (SD-22 positionAt over a baked track: computed on read from the track and the clock, never stored)
import { describe, expect, it } from 'vitest';
import { approximateDriveMinutes } from '../../domain/src/planner.ts';
import { haversineMeters, legFromVan, pointAlongLine, pointAlongTrack, positionAt, stepsFromVan, trackMinutes, visitPosition, type DayStop, type LegTrack, type Point } from './position.ts';
import type { TrackStep } from './steps.ts';

/** Encode [lon, lat] vertices as a precision-5 polyline (the inverse of decodePolyline). */
function encode(points: [number, number][]): string {
  let out = '';
  let lat = 0;
  let lon = 0;
  const put = (v: number): void => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const [x, y] of points) {
    const la = Math.round(y * 1e5);
    const lo = Math.round(x * 1e5);
    put(la - lat);
    put(lo - lon);
    lat = la;
    lon = lo;
  }
  return out;
}

const MIN = 60_000;
const t0 = Date.UTC(2026, 8, 15, 11); // 7:00 AM EDT, the shift start
const shiftEnd = t0 + 9 * 60 * MIN;
const depot: Point = { lon: -83, lat: 39.96 };
const home: Point = { lon: -83.02, lat: 39.98 };
const trackAB: LegTrack = { polyline: encode([[-83, 39.96], [-83.01, 39.97], [-83.02, 39.98]]), seconds: [0, 300, 601] };

const stop = (jobNumber: number, status: string, over: Partial<DayStop> = {}): DayStop =>
  ({ jobNumber, status, point: home, onTheWayAt: null, endedAt: null, ...over });
const day = (stops: DayStop[], now: number, track: LegTrack | null = trackAB) =>
  positionAt({ now, shiftStart: t0, shiftEnd, depot, stops, track: () => track });
const near = (p: Point | null, lon: number, lat: number) => {
  expect(p).not.toBeNull();
  expect(p!.lon).toBeCloseTo(lon, 5);
  expect(p!.lat).toBeCloseTo(lat, 5);
};

describe('the baked track', () => {
  // why: SD-15
  it('takes drive minutes from its last cumulative second, rounded up', () => {
    expect(trackMinutes(trackAB)).toBe(11);
    expect(trackMinutes({ seconds: [0, 600] })).toBe(10);
  });

  // why: FR-DEMO-8
  it('puts the van on the polyline by the seconds driven, and holds it at the end', () => {
    near(pointAlongTrack(trackAB, 0), -83, 39.96);
    near(pointAlongTrack(trackAB, 150), -83.005, 39.965);
    near(pointAlongTrack(trackAB, 300), -83.01, 39.97);
    near(pointAlongTrack(trackAB, 601), -83.02, 39.98);
    near(pointAlongTrack(trackAB, 5000), -83.02, 39.98);
    near(pointAlongTrack(trackAB, -20), -83, 39.96);
  });

  // why: SD-22
  it('drives a leg with no track along the straight line over the approximate minutes', () => {
    const minutes = approximateDriveMinutes(depot, home);
    near(pointAlongLine(depot, home, 0), depot.lon, depot.lat);
    near(pointAlongLine(depot, home, (minutes * 60) / 2), (depot.lon + home.lon) / 2, (depot.lat + home.lat) / 2);
    near(pointAlongLine(depot, home, minutes * 60 * 3), home.lon, home.lat);
  });
});

describe('the route from the van (F-1003)', () => {
  // why: FR-TECH-5 the route left starts at the point pointAlongTrack gives, with the seconds left and the polyline's length from there
  it('cuts a baked track at the van and keeps the part left', () => {
    const v = legFromVan(trackAB, depot, home, 150);
    near(v.from, -83.005, 39.965);
    expect(v.track).toHaveLength(3);
    expect(v.track!.slice(1)).toEqual([[-83.01, 39.97], [-83.02, 39.98]]);
    expect(v.minutes).toBe(Math.ceil((601 - 150) / 60));
    const whole = legFromVan(trackAB, depot, home, 0);
    expect(whole.minutes).toBe(trackMinutes(trackAB));
    expect(v.distanceMeters!).toBeLessThan(whole.distanceMeters!);
    // a vertex reached exactly is not repeated, and a driven track is only its end
    expect(legFromVan(trackAB, depot, home, 300).track).toEqual([[-83.01, 39.97], [-83.02, 39.98]]);
    expect(legFromVan(trackAB, depot, home, 5000)).toMatchObject({ track: [[-83.02, 39.98]], minutes: 0, distanceMeters: 0 });
  });

  // why: FR-MAP-3 with no baked track the route from the van is the straight line from its point, with SD-22's minutes from there and no length
  it('starts an approximate line at the van on it', () => {
    const minutes = approximateDriveMinutes(depot, home);
    const v = legFromVan(null, depot, home, (minutes * 60) / 2);
    near(v.from, (depot.lon + home.lon) / 2, (depot.lat + home.lat) / 2);
    expect(v).toMatchObject({ track: null, distanceMeters: null, minutes: approximateDriveMinutes(v.from, home) });
  });
});

describe('positionAt (SD-22)', () => {
  // why: FR-DEMO-8
  it('has no position before the shift starts or after it ends, with no job in hand', () => {
    expect(day([], t0 - 1)).toBeNull();
    expect(day([], shiftEnd + 1)).toBeNull();
    expect(day([stop(1, 'scheduled')], t0 - MIN)).toBeNull();
    expect(day([stop(1, 'done', { endedAt: shiftEnd - MIN })], shiftEnd + 1)).toBeNull();
    expect(day([stop(1, 'no_one_home', { endedAt: shiftEnd + 5 * MIN })], shiftEnd + 6 * MIN)).toBeNull();
  });

  // why: FR-DEMO-8 F-811 at any demo time a van at work has its position: the board and the live map read 1 van, inside the shift or outside it
  it('keeps a van on the way or on site at the same point past the shift end and before the shift start', () => {
    const late = shiftEnd + 25 * MIN;
    const way = stop(1, 'on_the_way', { onTheWayAt: late - 5 * MIN });
    expect(day([way], late)).toEqual(pointAlongTrack(trackAB, 300));
    expect(day([way], late)).toEqual(visitPosition({ status: 'on_the_way', onTheWayAt: way.onTheWayAt, now: late, from: depot, to: home, track: trackAB }));
    expect(day([stop(1, 'on_site')], late)).toEqual(home);
    const early = t0 - 20 * MIN;
    const dawn = stop(2, 'on_the_way', { onTheWayAt: early - 5 * MIN });
    expect(day([dawn], early)).toEqual(pointAlongTrack(trackAB, 300));
    expect(day([stop(2, 'on_site')], early)).toEqual(home);
  });

  // why: FR-DISP-3 F-811 past the shift end a van with a job left waits at its last stop, so it does not vanish between 2 jobs; with none left it drops off
  it('holds a van at its last stop in the gap between 2 jobs past the shift end, and drops it once no job is left', () => {
    const last = stop(1, 'done', { point: home, endedAt: shiftEnd + 10 * MIN });
    expect(day([last, stop(2, 'scheduled')], shiftEnd + 12 * MIN)).toEqual(home);
    expect(day([stop(2, 'scheduled')], shiftEnd + 12 * MIN)).toEqual(depot);
    expect(day([last, stop(2, 'done', { endedAt: shiftEnd + 90 * MIN })], shiftEnd + 91 * MIN)).toBeNull();
  });

  // why: FR-DEMO-8
  it('is at the depot with no job started, and at the last ended job after one', () => {
    near(day([stop(1, 'scheduled')], t0 + MIN), depot.lon, depot.lat);
    const other: Point = { lon: -83.1, lat: 40 };
    near(day([stop(1, 'done', { point: home, endedAt: t0 + 60 * MIN }), stop(2, 'no_one_home', { point: other, endedAt: t0 + 90 * MIN }), stop(3, 'scheduled')], t0 + 100 * MIN), -83.1, 40);
  });

  // why: FR-DEMO-8
  it('moves along the leg from the previous stop at now minus On my way, from the same clock for every reader', () => {
    const stops = [stop(1, 'on_the_way', { onTheWayAt: t0 })];
    near(day(stops, t0 + 150_000), -83.005, 39.965);
    near(day(stops, t0 + 150_000), -83.005, 39.965);
    near(day(stops, t0 + 700_000), -83.02, 39.98);
  });

  // why: SD-22
  it('asks for the leg from the last ended job, else the depot, and draws a straight line where none was baked', () => {
    const asked: (number | null)[][] = [];
    const prev = stop(1, 'done', { point: { lon: -83.1, lat: 40 }, endedAt: t0 });
    const here = stop(2, 'on_the_way', { onTheWayAt: t0 + MIN });
    positionAt({ now: t0 + 2 * MIN, shiftStart: t0, shiftEnd, depot, stops: [prev, here], track: (f, to) => { asked.push([f, to]); return null; } });
    positionAt({ now: t0 + 2 * MIN, shiftStart: t0, shiftEnd, depot, stops: [here], track: (f, to) => { asked.push([f, to]); return null; } });
    expect(asked).toEqual([[1, 2], [null, 2]]);
    const line = positionAt({ now: t0 + MIN, shiftStart: t0, shiftEnd, depot, stops: [prev, here], track: () => null });
    near(line, -83.1, 40);
  });

  // why: FR-DEMO-8
  it('is at the customer while the job is on site', () => {
    near(day([stop(1, 'done', { endedAt: t0 }), stop(2, 'on_site', { point: { lon: -82.9, lat: 39.9 } })], t0 + 30 * MIN), -82.9, 39.9);
  });
});

describe('visitPosition (invariant 5 server half)', () => {
  const visit = { onTheWayAt: t0, from: depot, to: home, track: trackAB };

  // why: NFR-04
  it('has no position before On my way, none from arrival on, and one only while on the way', () => {
    expect(visitPosition({ ...visit, status: 'scheduled', now: t0 + 150_000 })).toBeNull();
    expect(visitPosition({ ...visit, status: 'on_site', now: t0 + 700_000 })).toBeNull();
    expect(visitPosition({ ...visit, status: 'done', now: t0 + 700_000 })).toBeNull();
    expect(visitPosition({ ...visit, status: 'no_one_home', now: t0 + 700_000 })).toBeNull();
    expect(visitPosition({ ...visit, status: 'canceled', now: t0 + 700_000 })).toBeNull();
    near(visitPosition({ ...visit, status: 'on_the_way', now: t0 + 150_000 }), -83.005, 39.965);
  });

  // why: FR-DEMO-8
  it('shows the live map the same point the board shows for a van on the way, on a baked leg and on a straight line', () => {
    const prev = stop(1, 'done', { point: { lon: -83.1, lat: 40 }, endedAt: t0 });
    const here = stop(2, 'on_the_way', { onTheWayAt: t0 + MIN });
    for (const [track, from] of [[trackAB, depot], [null, prev.point]] as const) {
      for (const secs of [0, 90, 150, 300, 450, 5000]) {
        const now = t0 + MIN + secs * 1000;
        const board = positionAt({ now, shiftStart: t0, shiftEnd, depot, stops: from === depot ? [here] : [prev, here], track: () => track });
        const map = visitPosition({ status: 'on_the_way', onTheWayAt: here.onTheWayAt, now, from, to: here.point, track });
        expect(board).not.toBeNull();
        expect(map).toEqual(board);
      }
    }
  });
});

describe('the previous stop of a leg (F-515)', () => {
  const depot = { lon: 0, lat: 0 };
  const stop = (jobNumber: number, status: string, endedAt: number | null, onTheWayAt: number | null = null): DayStop => ({ jobNumber, status, point: { lon: jobNumber, lat: 0 }, onTheWayAt, endedAt });
  const ask = (stops: DayStop[]): (number | null)[] => {
    const asked: (number | null)[] = [];
    positionAt({ now: 100, shiftStart: 0, shiftEnd: 1000, depot, stops, track: (from) => { asked.push(from); return null; } });
    return asked;
  };

  // why: SD-22 a skipped earlier job is no stop: the van left the depot, whatever the window order says
  it('is the depot when the job before in window order has not ended', () => {
    expect(ask([stop(1, 'scheduled', null), stop(2, 'on_the_way', null, 50)])).toEqual([null]);
  });

  // why: SD-22 out of window order: job 2 ended first, so the van on the way to job 1 drives from job 2
  it('is the last ended job, whatever its window', () => {
    expect(ask([stop(1, 'on_the_way', null, 50), stop(2, 'done', 40)])).toEqual([2]);
  });

  // why: SD-22 a job on site has not ended, so it is no previous stop
  it('never takes a job still on site', () => {
    expect(ask([stop(1, 'on_site', null), stop(2, 'on_the_way', null, 50)])).toEqual([null]);
  });
});

describe('stepsFromVan: the steps left from the van on a track (SPECIFICATIONS 6.3 Directions)', () => {
  // 5 vertices, 100 s apart; steps start at vertices 0 (depart), 2 (turn) and 4 (arrive).
  const vs: [number, number][] = [[-83, 39.96], [-83.001, 39.96], [-83.002, 39.96], [-83.002, 39.961], [-83.002, 39.962]];
  const step = (kind: TrackStep['kind'], at: [number, number], distanceMeters: number): TrackStep => ({ kind, direction: kind === 'turn' ? 'left' : null, heading: kind === 'depart' ? 'w' : null, road: 'R', exit: null, side: null, at, distanceMeters });
  const t = { polyline: encode(vs), seconds: [0, 100, 200, 300, 400], steps: [step('depart', vs[0]!, 171), step('turn', vs[2]!, 222), step('arrive', vs[4]!, 0)] };
  const len = (a: [number, number], b: [number, number]): number => haversineMeters(a, b);

  // why: FR-TECH-5, FR-TECH-13
  it("starts at the step whose span holds the van, with that step's length left to the next turn", () => {
    const at150 = stepsFromVan(t, 150); // halfway along vertex 1 to 2: still on depart
    expect(at150.map((s) => s.kind)).toEqual(['depart', 'turn', 'arrive']);
    expect(at150[0]!.distanceMeters).toBe(Math.round(len([-83.0015, 39.96], vs[2]!)));
    expect(at150[1]!.distanceMeters).toBe(222);
    const at250 = stepsFromVan(t, 250); // past the turn's vertex: the turn is the van's step
    expect(at250.map((s) => s.kind)).toEqual(['turn', 'arrive']);
    expect(at250[0]!.distanceMeters).toBe(Math.round(len([-83.002, 39.9605], vs[3]!) + len(vs[3]!, vs[4]!)));
  });

  // why: FR-TECH-5
  it("at a turn vertex exactly the turn is the van's step; before the start the whole list; at the end only arrive with 0 left", () => {
    expect(stepsFromVan(t, 200).map((s) => s.kind)).toEqual(['turn', 'arrive']);
    expect(stepsFromVan(t, -5).map((s) => s.kind)).toEqual(['depart', 'turn', 'arrive']);
    expect(stepsFromVan(t, 0)[0]!.distanceMeters).toBe(Math.round(len(vs[0]!, vs[1]!) + len(vs[1]!, vs[2]!)));
    expect(stepsFromVan(t, 9999)).toEqual([{ ...t.steps[2], distanceMeters: 0 }]);
    expect(stepsFromVan({ ...t, steps: [] }, 150)).toEqual([]);
  });

  // why: FR-TECH-5
  it('leaves the stored steps as they are', () => {
    stepsFromVan(t, 150);
    expect(t.steps[0]!.distanceMeters).toBe(171);
  });
});
