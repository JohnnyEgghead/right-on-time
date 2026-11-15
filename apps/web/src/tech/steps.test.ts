// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-5, F-1233 (owner, Nov 9: "I have never heard of an app that does not include turn-by-turn instructions as a primary
// component of directions.")
// SCR-TEC-08's turn-by-turn rules on the web technician app (steps.ts, P6-WEB-STEPS): the states, the step rows and the Next turn card worded by the shared step
// words, the turn arrows, Route updated against a re-read that only drops passed steps, and API-104 read by an app that may point at a
// server older than the steps (F-1296). The steps are the real baked leg from Harold Jenkins's job to Linda Miller's (tracks.ndjson of
// maps-data-v2, 24830 to 24828), so the words are the ones the phone shows on that leg.
import { routeStep, techRoute, type z } from '@bw/api';
import { formatterFor } from '@bw/i18n/src/format.ts';
import { stepDistanceText, stepText } from '@bw/i18n/src/step-words.ts';
import { describe, expect, it } from 'vitest';
import { pointAlongLine } from '../../../../packages/maps/src/position.ts';
import { isRestOf, nextTurn, routeRead, stepIcon, stepRows, stepsMeters, stepsPhase, streetOf, type RouteStep, type ShownRoute } from './steps.ts';

const en = formatterFor('en');
const es = formatterFor('es');
const ADDRESS = '2271 Cobblestone Avenue';
const s = (kind: string, road: string | null, distanceMeters: number, at: [number, number], o: Partial<RouteStep> = {}): RouteStep =>
  ({ kind, direction: null, heading: null, road, exit: null, side: null, at, distanceMeters, ...o }) as RouteStep;
/** Harold Jenkins's job to Linda Miller's, as baked (10 steps, 7442 m). */
const HAROLD_TO_LINDA: RouteStep[] = [
  s('depart', 'Spring Hollow Court', 10, [-82.9301, 40.1201], { heading: 'w' }),
  s('turn', 'Spring Hollow Lane', 113, [-82.9302, 40.1201], { direction: 'left' }),
  s('end_of_road', 'West Main Street', 2493, [-82.9310, 40.1195], { direction: 'left' }),
  s('turn', 'South West Street', 142, [-82.9420, 40.1260], { direction: 'right' }),
  s('new_name', 'West Park Street', 153, [-82.9425, 40.1272], { direction: 'slight_left' }),
  s('turn', 'University Street', 267, [-82.9431, 40.1285], { direction: 'right' }),
  s('new_name', 'West Walnut Street', 4109, [-82.9440, 40.1300], { direction: 'slight_left' }),
  s('turn', 'Brookstone Boulevard', 147, [-82.9900, 40.1380], { direction: 'right' }),
  s('end_of_road', 'Cobblestone Avenue', 8, [-82.9905, 40.1392], { direction: 'right' }),
  s('arrive', 'Cobblestone Avenue', 0, [-82.9906, 40.1392]),
];
const leg = (track: boolean, from: [number, number] = [-82.9301, 40.1201]) => ({
  from: { lon: from[0], lat: from[1] }, to: { lon: -82.9906, lat: 40.1392 }, track: track ? [from, [-82.9906, 40.1392]] as [number, number][] : null,
  minutes: 14, distanceMeters: track ? 7442 : null,
});
const shown = (steps: RouteStep[], track = true, from?: [number, number]): ShownRoute => ({ leg: leg(track, from), branch: 'columbus', steps, at: '2026-09-15T10:26:00-04:00[America/New_York]' });

describe('the Directions states (SCR-TEC-08, kit 0.9)', () => {
  // why: FR-TECH-5, FR-MAP-3 each state of the frames from the read, the signal and the kept route: Route, Approximate, Loading, Route not loaded, Job moved, Offline with and without kept steps, No next job
  it('picks the state from the read, the signal and the kept route', () => {
    const routed = { kind: 'leg' as const, ...shown(HAROLD_TO_LINDA) };
    const approx = { kind: 'leg' as const, ...shown([], false) };
    expect(stepsPhase(routed, false, false, true)).toBe('route');
    expect(stepsPhase(approx, false, false, true)).toBe('approximate');
    expect(stepsPhase(null, false, false, true)).toBe('loading');
    expect(stepsPhase({ kind: 'failed' }, false, true, true)).toBe('failed');
    expect(stepsPhase({ kind: 'moved' }, false, true, true)).toBe('moved');
    expect(stepsPhase(routed, true, true, true)).toBe('offlineSaved');
    expect(stepsPhase(routed, true, false, true)).toBe('offline');
    expect(stepsPhase(null, true, false, true)).toBe('offline');
    expect(stepsPhase(routed, false, true, false)).toBe('none');
  });
});

describe('the Steps list and the Next turn card (CTL-TEC-08-05, CTL-TEC-08-06)', () => {
  // why: FR-TECH-5 every step left in driving order, each with its arrow, the shared words and its distance, the first marked Now, the arrival with no distance
  it('lists every step in driving order with the shared words and distances, the first marked Now', () => {
    const rows = stepRows(HAROLD_TO_LINDA, en, ADDRESS, true);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(rows.map((r) => r.words)).toEqual(HAROLD_TO_LINDA.map((x) => stepText(x, en, ADDRESS)));
    expect(rows[0]).toMatchObject({ words: 'Head west on Spring Hollow Court', distance: '50 ft', now: true, icon: 'arrowUp' });
    expect(rows[2]).toMatchObject({ words: 'At the end of the road, turn left onto West Main Street', distance: '1.5 mi', now: false, icon: 'turnLeft' });
    expect(rows[9]).toMatchObject({ words: 'Arrive at 2271 Cobblestone Avenue', distance: null, arrive: true, icon: 'pin' });
    expect(rows.filter((r) => r.now)).toHaveLength(1);
    expect(rows.slice(0, 9).map((r) => r.distance)).toEqual(HAROLD_TO_LINDA.slice(0, 9).map((x) => stepDistanceText(x.distanceMeters, en)));
    expect(stepsMeters(HAROLD_TO_LINDA)).toBe(7442);
  });

  // why: FR-TECH-5 with no signal the kept steps show with no step marked Now (Offline, steps saved)
  it('marks no step Now on the kept steps', () => {
    expect(stepRows(HAROLD_TO_LINDA, en, ADDRESS, false).some((r) => r.now)).toBe(false);
  });

  // why: FR-TECH-5, FR-LANG-1 a Spanish-speaking technician reads the same steps in Spanish, road names as the map data holds them
  it('words the same steps in Spanish', () => {
    const rows = stepRows(HAROLD_TO_LINDA, es, ADDRESS, true);
    expect(rows.map((r) => r.words)).toEqual(HAROLD_TO_LINDA.map((x) => stepText(x, es, ADDRESS)));
    expect(rows[1]?.words).toBe('Gire a la izquierda en Spring Hollow Lane');
    expect(rows.map((r) => r.words).join(' ')).not.toMatch(/\bTurn\b|\bHead\b|\bArrive\b/);
  });

  // why: FR-TECH-5 the Next turn card names the step after the van's with the distance to it; on the last stretch, the arrival; none with 1 step
  it('names the next turn with the distance to it, the arrival on the last stretch', () => {
    expect(nextTurn(HAROLD_TO_LINDA, en, ADDRESS)).toMatchObject({ lead: 'In 50 ft:', words: 'Turn left onto Spring Hollow Lane', icon: 'turnLeft' });
    expect(nextTurn(HAROLD_TO_LINDA.slice(8), en, ADDRESS)).toMatchObject({ lead: 'In 50 ft:', words: 'Arrive at 2271 Cobblestone Avenue', icon: 'pin' });
    expect(nextTurn(HAROLD_TO_LINDA.slice(9), en, ADDRESS)).toBeNull();
    expect(nextTurn(HAROLD_TO_LINDA, es, ADDRESS)?.lead).toBe('En 50 pies:');
  });

  // why: FR-TECH-5 the arrival names the destination's street address, as the frame does (Arrive at 2271 Cobblestone Dr), not its town
  it('names the street address in the arrival', () => {
    expect(streetOf('2271 Cobblestone Avenue, Westerville')).toBe(ADDRESS);
    expect(streetOf('418 Maple Hollow Ct')).toBe('418 Maple Hollow Ct');
    expect(stepText(HAROLD_TO_LINDA[9]!, en, streetOf('2271 Cobblestone Avenue, Westerville'))).toBe('Arrive at 2271 Cobblestone Avenue');
  });

  // why: FR-TECH-5 a step the catalog has no words for is left out, never drawn empty
  it('leaves out a step with no words', () => {
    const odd = [...HAROLD_TO_LINDA.slice(0, 2), s('teleport', null, 5, [0, 0]), ...HAROLD_TO_LINDA.slice(2)];
    expect(stepRows(odd, en, ADDRESS, true).map((r) => r.index)).toEqual([0, 1, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  // why: FR-TECH-5 the turn arrows follow the kit: straight on, left and right turns, the exit arrow, the pin at the arrival
  it('gives each step its kit arrow', () => {
    expect(stepIcon({ kind: 'depart', direction: null })).toBe('arrowUp');
    expect(stepIcon({ kind: 'turn', direction: 'sharp_right' })).toBe('turnRight');
    expect(stepIcon({ kind: 'fork', direction: 'slight_left' })).toBe('turnLeft');
    expect(stepIcon({ kind: 'exit', direction: 'slight_right' })).toBe('exitRight');
    expect(stepIcon({ kind: 'ramp', direction: null })).toBe('exitRight');
    expect(stepIcon({ kind: 'continue', direction: 'straight' })).toBe('arrowUp');
    expect(stepIcon({ kind: 'uturn', direction: null })).toBe('turnLeft');
    expect(stepIcon({ kind: 'arrive', direction: null })).toBe('pin');
  });
});

describe('Route updated (CTL-TEC-08-08)', () => {
  // why: FR-TECH-5 a re-read that only drops passed steps is the rest of the route, not announced
  it('reads a re-read with the passed steps dropped as the rest of the route', () => {
    const van = HAROLD_TO_LINDA.slice(3).map((x, i) => (i === 0 ? { ...x, at: [-82.9415, 40.1255] as [number, number], distanceMeters: 60 } : x));
    expect(isRestOf(shown(HAROLD_TO_LINDA), shown(van, true, [-82.9415, 40.1255]))).toBe(true);
    expect(isRestOf(shown(HAROLD_TO_LINDA), shown(HAROLD_TO_LINDA))).toBe(true);
    expect(isRestOf(shown(HAROLD_TO_LINDA), shown(HAROLD_TO_LINDA.slice(9)))).toBe(true);
  });

  // why: FR-TECH-5, FR-MAP-3 another route is announced: routed and approximate replacing each other, another way, another destination
  it('reads another way, a routed or approximate change and another destination as another route', () => {
    expect(isRestOf(shown([], false), shown(HAROLD_TO_LINDA))).toBe(false);
    expect(isRestOf(shown(HAROLD_TO_LINDA), shown([], false))).toBe(false);
    const other = HAROLD_TO_LINDA.map((x, i) => (i === 5 ? { ...x, road: 'North State Street' } : x));
    expect(isRestOf(shown(HAROLD_TO_LINDA), shown(other))).toBe(false);
    const elsewhere = { ...shown(HAROLD_TO_LINDA), leg: { ...leg(true), to: { lon: -83, lat: 40 } } };
    expect(isRestOf(shown(HAROLD_TO_LINDA), elsewhere)).toBe(false);
    expect(isRestOf(shown(HAROLD_TO_LINDA.slice(4)), shown(HAROLD_TO_LINDA))).toBe(false);
    expect(isRestOf(shown([], false, [-82.9, 40.1]), shown([], false, [-82.8, 40.1]))).toBe(false);
  });

  // why: FR-TECH-5, FR-MAP-3 F-1304 on an approximate leg API-104 answers the van's point on the straight line, which moves with demo time: a re-read 60 s later is the same route, never Route updated
  it('reads the van further along the shown straight line as the same approximate route', () => {
    const start = { lon: -82.9301, lat: 40.1201 };
    const to = { lon: -82.9906, lat: 40.1392 };
    const at = (sec: number): [number, number] => { const p = pointAlongLine(start, to, sec); return [p.lon, p.lat]; };
    expect(isRestOf(shown([], false, at(60)), shown([], false, at(120)))).toBe(true);
    expect(isRestOf(shown([], false, at(60)), shown([], false, at(60)))).toBe(true);
    expect(isRestOf(shown([], false, at(120)), shown([], false, at(60)))).toBe(false);
    expect(isRestOf(shown([], false, at(60)), shown([], false, [at(120)[0], at(120)[1] + 0.001]))).toBe(false);
    expect(isRestOf(shown([], false, at(120)), shown([], false, [-82.9201, 40.1151]))).toBe(false);
    // F-1317: a start on the line extended past the destination is not on the shown line
    expect(isRestOf(shown([], false, at(60)), shown([], false, [-82.99665, 40.14111]))).toBe(false);
  });
});

describe('API-104 as the app reads it (F-1296)', () => {
  const answer = (steps?: unknown) => ({ branch: 'columbus', leg: leg(true), insideWindow: true, ...(steps === undefined ? {} : { steps }) });
  // why: FR-TECH-5 F-1296 a server from before the steps answers none: the phone reads no steps instead of failing the whole Directions read
  it('reads an answer with no steps as an empty list, where the contract refuses it', () => {
    expect(techRoute.response.safeParse(answer()).success).toBe(false);
    expect(routeRead.response.parse(answer()).steps).toEqual([]);
  });

  // why: FR-TECH-5 a server with steps is read exactly as the contract reads it, and a step that breaks the contract is still refused
  it('reads a server with steps as the contract does', () => {
    const wire = HAROLD_TO_LINDA as z.input<typeof routeStep>[];
    expect(routeRead.response.parse(answer(wire))).toEqual(techRoute.response.parse(answer(wire)));
    expect(routeRead.response.safeParse(answer([{ ...wire[0], kind: 'teleport' }])).success).toBe(false);
    expect([routeRead.id, routeRead.method, routeRead.path]).toEqual([techRoute.id, techRoute.method, techRoute.path]);
  });
});
