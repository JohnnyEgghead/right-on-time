// SPDX-License-Identifier: AGPL-3.0-or-later
// SD-49's step mapping (SPECIFICATIONS v0.13 SD-49): every row of the table, the folded types, an unknown type failing by its
// name, and the 3 guarantees (depart first and arrive last, each `at` a polyline vertex, the lengths adding up to distance_m).
// The same checks over the real baked tracks run in steps.maps.test.ts (the gate map-manifest).
import { describe, expect, it } from 'vitest';
import {
  FOLDED_TYPES, headingOf, KNOWN_TYPES, STEP_KINDS, StepMappingError, stepsFromOsrm, stepVertexIndexes, UnknownManeuverError,
  type OsrmStep, type TrackStep,
} from './steps.ts';
import { decodePolyline } from './tracks.ts';

// 6 vertices along a street grid near Columbus (precision 5, so each equals its decoded value).
const V: [number, number][] = [[-83.0, 39.96], [-83.001, 39.96], [-83.002, 39.961], [-83.003, 39.962], [-83.004, 39.962], [-83.005, 39.963]];

const step = (type: string, from: number, to: number, distance: number, extra: Partial<OsrmStep['maneuver']> = {}, name = 'High St', ref?: string): OsrmStep => ({
  distance, name, ...(ref ? { ref } : {}),
  geometry: { coordinates: V.slice(from, to + 1) },
  maneuver: { type, ...extra },
});
const depart = (to = 1, d = 100, bearing = 270): OsrmStep => step('depart', 0, to, d, { bearing_after: bearing });
const arrive = (modifier?: string): OsrmStep => ({ distance: 0, name: 'Elm St', geometry: { coordinates: [V[5]!, V[5]!] }, maneuver: { type: 'arrive', ...(modifier ? { modifier } : {}) } });

/** A precision-5 polyline encoder (the bake's), for the decode round trip. */
const encode = (coords: [number, number][]): string => {
  const one = (n: number): string => {
    let v = n < 0 ? ~(n << 1) : n << 1;
    let out = '';
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return out + String.fromCharCode(v + 63);
  };
  let plat = 0;
  let plon = 0;
  return coords.map(([lon, lat]) => {
    const la = Math.round(lat * 1e5);
    const lo = Math.round(lon * 1e5);
    const s = one(la - plat) + one(lo - plon);
    plat = la;
    plon = lo;
    return s;
  }).join('');
};

/** 1 route: depart over vertices 0 to 1, the step under test over 1 to 5, arrive at 5. */
const around = (s: OsrmStep): OsrmStep[] => [depart(), s, arrive()];
const middle = (s: OsrmStep): TrackStep => stepsFromOsrm(around(s), V, 100 + s.distance)[1]!;

describe('SD-49 step mapping, row by row', () => {
  // why: FR-TECH-5
  it.each([
    ['turn', 'turn'], ['roundabout turn', 'turn'], ['continue', 'continue'], ['new name', 'new_name'], ['merge', 'merge'],
    ['on ramp', 'ramp'], ['ramp', 'ramp'], ['off ramp', 'exit'], ['fork', 'fork'], ['end of road', 'end_of_road'],
  ])('%s is kind %s, with its modifier as the direction', (type, kind) => {
    const s = middle(step(type, 1, 5, 400, { modifier: 'slight right' }));
    expect(s).toEqual({ kind, direction: 'slight_right', heading: null, road: 'High St', exit: null, side: null, at: V[1], distanceMeters: 400 });
  });

  // why: FR-TECH-5
  it.each([['roundabout'], ['rotary']])('%s is kind roundabout with its exit number and no direction', (type) => {
    const s = middle(step(type, 1, 5, 400, { modifier: 'right', exit: 2 }));
    expect(s).toMatchObject({ kind: 'roundabout', direction: null, exit: 2, heading: null, side: null });
  });

  // why: FR-TECH-5
  it('any type whose modifier is uturn is kind uturn with no direction', () => {
    for (const type of ['turn', 'continue', 'end of road']) {
      expect(middle(step(type, 1, 5, 400, { modifier: 'uturn' }))).toMatchObject({ kind: 'uturn', direction: null });
    }
  });

  // why: FR-TECH-5
  it('depart carries the heading of its bearing_after and no direction; arrive carries its side and no direction', () => {
    const r = stepsFromOsrm([depart(5, 500, 10), arrive('sharp left')], V, 500);
    expect(r[0]).toEqual({ kind: 'depart', direction: null, heading: 'n', road: 'High St', exit: null, side: null, at: V[0], distanceMeters: 500 });
    expect(r[1]).toEqual({ kind: 'arrive', direction: null, heading: null, road: 'Elm St', exit: null, side: 'left', at: V[5], distanceMeters: 0 });
    expect(stepsFromOsrm([depart(5, 500), arrive('slight right')], V, 500)[1]!.side).toBe('right');
    expect(stepsFromOsrm([depart(5, 500), arrive('straight')], V, 500)[1]!.side).toBeNull();
    expect(stepsFromOsrm([depart(5, 500), arrive()], V, 500)[1]!.side).toBeNull();
  });

  // why: FR-TECH-5
  it('names the 8 compass points at their edges: n from 337.5 to under 22.5 degrees, then every 45', () => {
    expect([337.5, 359.9, 0, 22.49].map(headingOf)).toEqual(['n', 'n', 'n', 'n']);
    expect([22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.49].map(headingOf)).toEqual(['ne', 'e', 'se', 's', 'sw', 'w', 'nw', 'nw']);
  });

  // why: FR-TECH-5
  it('reads the road from the name, else the ref, else null; a modifier OSRM leaves out is a null direction', () => {
    expect(middle(step('turn', 1, 5, 400, { modifier: 'left' }, '', 'US 23')).road).toBe('US 23');
    expect(middle(step('turn', 1, 5, 400, { modifier: 'left' }, '')).road).toBeNull();
    expect(middle(step('merge', 1, 5, 400, {})).direction).toBeNull();
  });

  // why: FR-TECH-5
  it.each(FOLDED_TYPES.map((t) => [t]))('%s has no step of its own: its length goes on the step before', (type) => {
    const r = stepsFromOsrm([depart(1, 100), step('turn', 1, 3, 200, { modifier: 'left' }), step(type, 3, 5, 150, { modifier: 'straight' }), arrive()], V, 450);
    expect(r.map((s) => s.kind)).toEqual(['depart', 'turn', 'arrive']);
    expect(r[1]).toMatchObject({ at: V[1], distanceMeters: 350 });
  });

  // why: FR-TECH-5
  it('fails on a type outside the table, naming it, whatever its modifier', () => {
    expect(() => stepsFromOsrm(around(step('teleport', 1, 5, 400, { modifier: 'left' })), V, 500)).toThrow(UnknownManeuverError);
    expect(() => stepsFromOsrm(around(step('teleport', 1, 5, 400)), V, 500)).toThrow(/"teleport" is not in SD-49's step mapping/);
    try {
      stepsFromOsrm(around(step('teleport', 1, 5, 400)), V, 500);
    } catch (e) {
      expect((e as UnknownManeuverError).type).toBe('teleport');
    }
  });

  // why: FR-TECH-5
  it('maps every kind of the table and knows every type it names', () => {
    const kinds = new Set<string>(['depart', 'arrive']);
    for (const t of KNOWN_TYPES.filter((x) => x !== 'depart' && x !== 'arrive' && !FOLDED_TYPES.includes(x))) kinds.add(middle(step(t, 1, 5, 10, { modifier: 'left', exit: 1 })).kind);
    kinds.add(middle(step('turn', 1, 5, 10, { modifier: 'uturn' })).kind);
    expect([...kinds].sort()).toEqual([...STEP_KINDS].sort());
  });
});

describe('SD-49 step guarantees', () => {
  // why: FR-TECH-5
  it('rounds to whole meters by running total, so the lengths add up to distance_m and each is within 1 m of its own', () => {
    const r = stepsFromOsrm([depart(1, 100.4), step('turn', 1, 3, 200.4, { modifier: 'left' }), step('turn', 3, 5, 99.4, { modifier: 'right' }), arrive()], V, 400);
    expect(r.map((s) => s.distanceMeters)).toEqual([100, 201, 99, 0]);
    expect(r.reduce((a, s) => a + s.distanceMeters, 0)).toBe(400);
  });

  // why: FR-TECH-5
  it('never leaves a short last stretch below 0 (the real bake: 8 half-meter steps and a 3 m last stretch)', () => {
    // Rounded 1 by 1 these come to 8 x 11 + 3 = 91 m against a route of 87 m: a -4 m remainder on the 3 m step. By running total they hold.
    const many = Array.from({ length: 8 }, (_, i) => step('continue', 1 + (i % 2), 2 + (i % 2), 10.5)).map((s, i) => ({ ...s, geometry: { coordinates: [V[1]!, V[1]!] }, maneuver: { type: i % 2 ? 'turn' : 'continue', modifier: 'left' } }));
    const route = [depart(1, 0), ...many, step('turn', 1, 5, 2.9, { modifier: 'right' }), arrive()];
    const r = stepsFromOsrm(route, V, 87);
    expect(r.reduce((a, s) => a + s.distanceMeters, 0)).toBe(87);
    expect(r.every((s) => s.distanceMeters >= 0)).toBe(true);
    route.slice(0, -1).forEach((s, i) => expect(Math.abs(r[i]!.distanceMeters - s.distance), String(i)).toBeLessThanOrEqual(1));
    // the route's own distance a meter under the steps' total: taken from the step before arrive, else from the steps before it
    const short = stepsFromOsrm([depart(1, 50), step('turn', 1, 5, 0.4, { modifier: 'left' }), arrive()], V, 49);
    expect(short.map((s) => s.distanceMeters)).toEqual([49, 0, 0]);
  });

  // why: FR-TECH-5
  it('places each at on a vertex of the decoded polyline, and the server finds it again by exact match', () => {
    const vs = decodePolyline(encode([[-83.0, 39.96], [-83.001, 39.96]]));
    const r = stepsFromOsrm([
      { distance: 85, name: 'A', geometry: { coordinates: [[-83.000001, 39.960001], [-83.001, 39.96]] }, maneuver: { type: 'depart', bearing_after: 270 } },
      { distance: 0, name: 'A', geometry: { coordinates: [[-83.001, 39.96], [-83.001, 39.96]] }, maneuver: { type: 'arrive' } },
    ], vs, 85);
    expect(r.map((s) => s.at)).toEqual([vs[0], vs[1]]);
    expect(stepVertexIndexes(r, vs)).toEqual([0, 1]);
  });

  // why: FR-TECH-5
  it('refuses a step whose turn point is on no vertex, a route that does not start with depart, and a remainder that leaves a negative step', () => {
    expect(() => stepsFromOsrm([depart(), { ...step('turn', 1, 5, 10, { modifier: 'left' }), geometry: { coordinates: [[-80, 40]] } }, arrive()], V, 110)).toThrow(StepMappingError);
    expect(() => stepsFromOsrm([step('turn', 0, 5, 10, { modifier: 'left' }), arrive()], V, 10)).toThrow(/not depart/);
    expect(() => stepsFromOsrm([depart(5, 500), step('turn', 5, 5, 0, { modifier: 'left' })], V, 500)).toThrow(/not arrive/);
    expect(() => stepsFromOsrm([depart(5, 2), arrive()], V, -5)).toThrow(/more than the route/);
    expect(() => stepsFromOsrm([depart()], V, 100)).toThrow(StepMappingError);
    expect(() => stepsFromOsrm([{ ...depart(5, 500), maneuver: { type: 'depart' } }, arrive()], V, 500)).toThrow(/no bearing_after/);
  });
});
