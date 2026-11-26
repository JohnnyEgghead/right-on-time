// SPDX-License-Identifier: AGPL-3.0-or-later
// SD-49's step mapping (SPECIFICATIONS v0.13 SD-49, section 3 `van_track.steps`, section 6.10; UI-SPECIFICATION v0.15 API-104;
// FR-TECH-5): 1 function turns OSRM's route steps into the step objects `{kind, direction, heading, road, exit, side, at,
// distanceMeters}` that `world.van_track.steps` stores and API-104 answers by the same names. The track bake
// (infra/data/maps/bake.mjs) runs it now; P6-LIVE-ROUTING's live client runs the same code, so a baked and a live track share
// 1 vocabulary.
//
// This file has no imports, so the bake can ship it into its node container as is (node strips the types).
//
// The 3 guarantees a caller relies on, each checked here rather than trusted (a wrong one stays silent to a green client test):
//   1. the first step's kind is `depart` (with its heading) and the last's `arrive`;
//   2. every `at` is a vertex of the track's polyline, the decoded vertex itself, so the server finds a step by exact match;
//   3. the `distanceMeters` add up to the track's `distance_m` (whole meters by running total; what is left goes on the step before
//      `arrive`, see the rounding below).
// A route that breaks one throws {@link StepMappingError}; a maneuver type outside the table throws {@link UnknownManeuverError}
// naming the type. The bake fails on either; the live client treats either as no route (SD-49 step 3).

/** The 12 kinds of step a route can have: the `kind` field of the Directions read (API-104; the table of SD-49). */
export const STEP_KINDS = [
  'depart', 'turn', 'continue', 'new_name', 'merge', 'ramp', 'exit', 'fork', 'end_of_road', 'roundabout', 'uturn', 'arrive',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** API-104's `direction`: OSRM's `maneuver.modifier` with its space written as an underscore (`uturn` is a kind of its own). */
export const STEP_DIRECTIONS = ['left', 'right', 'slight_left', 'slight_right', 'sharp_left', 'sharp_right', 'straight'] as const;
export type StepDirection = (typeof STEP_DIRECTIONS)[number];

/** API-104's `heading` on `depart`: the nearest of 8 compass points. */
export const STEP_HEADINGS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export type StepHeading = (typeof STEP_HEADINGS)[number];

export const STEP_SIDES = ['left', 'right'] as const;
export type StepSide = (typeof STEP_SIDES)[number];

/** 1 stored and answered step (SPECIFICATIONS section 3 `van_track.steps`; API-104). */
export interface TrackStep {
  kind: StepKind;
  direction: StepDirection | null;
  heading: StepHeading | null;
  road: string | null;
  exit: number | null;
  side: StepSide | null;
  /** The polyline vertex where the step starts, [longitude, latitude], as the decoded polyline holds it. */
  at: [number, number];
  /** The stretch from this step's turn to the next step's, whole meters. */
  distanceMeters: number;
}

/** The slice of an OSRM route step (`steps=true`, `geometries=geojson`) the mapping reads. */
export interface OsrmStep {
  distance: number;
  name?: string;
  ref?: string;
  geometry: { coordinates: [number, number][] };
  maneuver: { type: string; modifier?: string; bearing_after?: number; exit?: number };
}

/** OSRM's `maneuver.type` to our step kind (the table of SD-49). `depart`, `arrive`, the folded types and the uturn rule are handled before this table. */
const KIND_OF: Readonly<Record<string, StepKind>> = {
  turn: 'turn',
  'roundabout turn': 'turn',
  continue: 'continue',
  'new name': 'new_name',
  merge: 'merge',
  'on ramp': 'ramp',
  ramp: 'ramp',
  'off ramp': 'exit',
  fork: 'fork',
  'end of road': 'end_of_road',
  roundabout: 'roundabout',
  rotary: 'roundabout',
};

/** Types with no step of their own: folded into the step before, their length added to it (SD-49). */
export const FOLDED_TYPES: readonly string[] = ['exit roundabout', 'exit rotary', 'notification', 'use lane'];

/** Every OSRM type the table names: the mapped ones, the folded ones, `depart` and `arrive`. */
export const KNOWN_TYPES: readonly string[] = ['depart', 'arrive', ...Object.keys(KIND_OF), ...FOLDED_TYPES];

/** Kinds that carry no direction (SD-49 `direction`). */
const NO_DIRECTION: ReadonlySet<StepKind> = new Set(['depart', 'arrive', 'roundabout', 'uturn']);

/** A maneuver type outside the step table (SD-49): the bake fails naming it; the live client answers no route. */
export class UnknownManeuverError extends Error {
  readonly type: string;
  constructor(type: string, index: number) {
    super(`step ${index}: OSRM maneuver type "${type}" is not in SD-49's step mapping`);
    this.name = 'UnknownManeuverError';
    this.type = type;
  }
}

/** A route the mapping cannot turn into steps that keep the 3 guarantees above. */
export class StepMappingError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'StepMappingError';
  }
}

/** SD-49 `heading`: `n` from 337.5 to under 22.5 degrees, then every 45 degrees clockwise. */
export function headingOf(bearing: number): StepHeading {
  const b = ((bearing % 360) + 360) % 360;
  return STEP_HEADINGS[Math.floor(((b + 22.5) % 360) / 45)] as StepHeading;
}

const directionOf = (modifier: string | undefined): StepDirection | null => {
  if (modifier === undefined) return null;
  const d = modifier.replace(/ /g, '_');
  return (STEP_DIRECTIONS as readonly string[]).includes(d) ? (d as StepDirection) : null;
};

const sideOf = (modifier: string | undefined): StepSide | null => {
  if (modifier === 'left' || modifier === 'slight left' || modifier === 'sharp left') return 'left';
  if (modifier === 'right' || modifier === 'slight right' || modifier === 'sharp right') return 'right';
  return null;
};

const roadOf = (s: OsrmStep): string | null => (s.name ? s.name : s.ref ? s.ref : null);

/** The kind of 1 OSRM step, `folded` for a type with no step of its own. Throws {@link UnknownManeuverError} outside the table. */
function kindOf(type: string, modifier: string | undefined, index: number): StepKind | 'folded' {
  if (type === 'depart' || type === 'arrive') return type;
  if (FOLDED_TYPES.includes(type)) return 'folded';
  if (modifier === 'uturn') return 'uturn';
  const k = KIND_OF[type];
  if (!k) throw new UnknownManeuverError(type, index);
  return k;
}

const e5 = (v: number): number => Math.round(v * 1e5);
const sameVertex = (a: readonly [number, number], b: readonly [number, number]): boolean => e5(a[0]) === e5(b[0]) && e5(a[1]) === e5(b[1]);

/**
 * OSRM's route steps (1 leg, `steps=true`) to our step objects (the step mapping of SD-49).
 *
 * @param steps    the leg's `steps`, in driving order
 * @param vertices the track's polyline decoded (`decodePolyline`), so each `at` is that vertex itself
 * @param distanceM the track's `distance_m` (OSRM's route distance rounded); the steps' meters add up to it
 */
export function stepsFromOsrm(steps: readonly OsrmStep[], vertices: readonly (readonly [number, number])[], distanceM: number): TrackStep[] {
  if (steps.length < 2) throw new StepMappingError(`a route needs at least depart and arrive, got ${steps.length} step(s)`);
  if (vertices.length === 0) throw new StepMappingError('a route with no vertices has no steps');
  const out: TrackStep[] = [];
  const meters: number[] = []; // each kept step's unrounded length, folded lengths included
  let cursor = 0; // the polyline vertex the next step starts at, never moving backwards
  steps.forEach((s, i) => {
    const kind = kindOf(s.maneuver.type, s.maneuver.modifier, i);
    const start = s.geometry.coordinates[0];
    if (!start) throw new StepMappingError(`step ${i} (${s.maneuver.type}) has no geometry`);
    // The step's turn point on the polyline: its geometry's first point, found at or after the step before's.
    let at = -1;
    for (let j = cursor; j < vertices.length; j++) {
      if (sameVertex(vertices[j] as [number, number], start)) {
        at = j;
        break;
      }
    }
    if (at === -1) throw new StepMappingError(`step ${i} (${s.maneuver.type}) starts at [${start.join(', ')}], which is no polyline vertex at or after vertex ${cursor}`);
    cursor = at;
    if (kind === 'folded') {
      if (out.length === 0) throw new StepMappingError(`step ${i} (${s.maneuver.type}) has no step before it to fold into`);
      meters[meters.length - 1] = (meters[meters.length - 1] as number) + s.distance;
      return;
    }
    const v = vertices[at] as [number, number];
    // depart always names its heading (API-104 "n ... nw on depart"): a depart OSRM gives no bearing for is refused, not worded half.
    if (kind === 'depart' && typeof s.maneuver.bearing_after !== 'number') throw new StepMappingError(`step ${i} (depart) has no bearing_after for its heading`);
    out.push({
      kind,
      direction: NO_DIRECTION.has(kind) ? null : directionOf(s.maneuver.modifier),
      heading: kind === 'depart' ? headingOf(s.maneuver.bearing_after as number) : null,
      road: roadOf(s),
      exit: kind === 'roundabout' && typeof s.maneuver.exit === 'number' ? s.maneuver.exit : null,
      side: kind === 'arrive' ? sideOf(s.maneuver.modifier) : null,
      at: [v[0], v[1]],
      distanceMeters: 0,
    });
    meters.push(s.distance);
  });
  if (out[0]?.kind !== 'depart') throw new StepMappingError(`the first step is ${out[0]?.kind}, not depart`);
  if (out[out.length - 1]?.kind !== 'arrive') throw new StepMappingError(`the last step is ${out[out.length - 1]?.kind}, not arrive`);
  if (out.slice(1, -1).some((s) => s.kind === 'depart' || s.kind === 'arrive')) throw new StepMappingError('a route of 1 leg has depart and arrive only at its ends');
  // Whole meters by cumulative rounding: each step is the rounded running total less the one before it, so every step is within 1 m of
  // its own length and none is below 0, and the steps add up to the rounded total of OSRM's step lengths. Rounding each step on its own
  // left the remainder growing with the step count (up to half a meter a step): in the real bake 1 leg's -4 m remainder fell on a 3 m
  // last stretch (P6-ROUTE-BAKE). What is left, the difference between the steps' total and the route's own rounded distance (OSRM
  // sums them apart; a meter or less), goes on the step before arrive, else, where that step is shorter than a negative remainder, on
  // the nearest step before it that holds it.
  let run = 0;
  let prior = 0;
  out.forEach((s, i) => {
    run += meters[i] as number;
    const upTo = Math.round(run);
    s.distanceMeters = upTo - prior;
    prior = upTo;
  });
  let left = distanceM - prior;
  for (let i = out.length - 2; i >= 0 && left !== 0; i--) {
    const s = out[i] as TrackStep;
    const take = left > 0 ? left : Math.max(left, -s.distanceMeters);
    s.distanceMeters += take;
    left -= take;
  }
  if (left !== 0) throw new StepMappingError(`the steps add up to ${prior} m, ${-left} m more than the route's ${distanceM} m`);
  return out;
}

/**
 * The step whose span holds a point on the track (SPECIFICATIONS 6.3 Directions): the last step whose `at` vertex is at or before
 * vertex `vertexIndex` along the polyline. `vertexIndexOf` maps a step's `at` to its vertex, found by exact match from the step
 * before's, so a polyline that passes 1 point twice still places each step at its own pass.
 */
export function stepVertexIndexes(steps: readonly TrackStep[], vertices: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  let cursor = 0;
  for (const [i, s] of steps.entries()) {
    let found = -1;
    for (let j = cursor; j < vertices.length; j++) {
      const v = vertices[j] as [number, number];
      if (v[0] === s.at[0] && v[1] === s.at[1]) {
        found = j;
        break;
      }
    }
    if (found === -1) throw new StepMappingError(`step ${i} (${s.kind}) at [${s.at.join(', ')}] is no polyline vertex at or after vertex ${cursor}`);
    out.push(found);
    cursor = found;
  }
  return out;
}
