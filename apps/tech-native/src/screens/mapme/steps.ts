// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-TEC-08's turn-by-turn half on the native app, the pure part (P6-NATIVE-STEPS; UI-SPECIFICATION v0.15 SCR-TEC-08 CTL-TEC-08-05 to
// CTL-TEC-08-08 and its states, section 4.5 rule 11; SPECIFICATIONS v0.13 SD-49, section 6.3 Directions; DK-117 r1-ios-b.html, kit 0.9): which
// state the screen is in, the step rows, the Next turn card, each step's turn arrow and whether a re-read is another route (Route updated).
// The words come from P6-ROUTE-BAKE's shared function (@bw/i18n step-words.ts), so the web app and the phone word a step alike. No React, no
// clock, no storage: the screen and the tests call these on the same inputs.
import { routeStep, techRoute, z } from '@bw/api';
import { stepDistanceText, stepText } from '@bw/i18n/src/step-words.ts';
import type { Leg, Say } from './model.ts';

export type RouteStep = z.output<typeof routeStep>;

/**
 * API-104 as the phone reads it (F-1296): the contract makes `steps` required, and an answer that lacks it fails the parse. A server
 * from before P6-ROUTE-BAKE answers no steps (the native app can point at another server address, SCR-TEC-12), so the phone reads a
 * missing list as an empty one: Directions keeps its map, drive time and destination and says the steps are not available, instead of
 * losing the whole screen. A server with steps answers exactly as the contract says.
 */
export const routeRead = { ...techRoute, response: techRoute.response.extend({ steps: z.array(routeStep).default([]) }) };

/** 1 route read (API-104) as the phone shows and keeps it: the leg, its branch, its steps and the demo time of the read. */
export interface ShownRoute { leg: Leg; branch: string; steps: RouteStep[]; at: string }

/** A read of the route: answered, the job is no longer this technician's (404 not_found: Job moved), or failed with signal. */
export type RouteRead = ({ kind: 'leg' } & ShownRoute) | { kind: 'moved' } | { kind: 'failed' };

/** The states of the Directions screen (SCR-TEC-08), worded as in the web frames (DK-113). */
export type StepsPhase = 'loading' | 'route' | 'approximate' | 'offlineSaved' | 'offline' | 'failed' | 'moved' | 'none';

/**
 * Which state Directions is in. No destination (no next job) is No next job; no signal shows the kept route of this destination when the
 * phone has one (Offline, steps saved) and else Offline; with signal, the read's answer: none yet, Loading; a 404, Job moved; any other
 * failure, Route not loaded; a leg with no track, Approximate (SD-22's straight line: the routing service gave no route); else Route.
 */
export function stepsPhase(read: RouteRead | null, offline: boolean, kept: boolean, hasJob: boolean): StepsPhase {
  if (!hasJob) return 'none';
  if (offline) return kept ? 'offlineSaved' : 'offline';
  if (read === null) return 'loading';
  if (read.kind === 'moved') return 'moved';
  if (read.kind === 'failed') return 'failed';
  return read.leg.track === null ? 'approximate' : 'route';
}

/** The turn arrows the step rows draw (DK-117: arrowUp, turnRight, turnLeft, exitRight from the kit, pin for the arrival). */
export type StepIcon = 'arrowUp' | 'turnLeft' | 'turnRight' | 'exitRight' | 'pin';

const leftward = (d: string | null): boolean => d !== null && d.endsWith('left');
const rightward = (d: string | null): boolean => d !== null && d.endsWith('right');

/** A step's arrow: the arrival its pin; a left or right move its turn arrow (a ramp or exit to the right the exit arrow); anything else straight on. */
export function stepIcon(step: Pick<RouteStep, 'kind' | 'direction'>): StepIcon {
  if (step.kind === 'arrive') return 'pin';
  if (step.kind === 'uturn') return 'turnLeft';
  if (step.kind === 'depart') return 'arrowUp';
  if (leftward(step.direction)) return 'turnLeft';
  if (step.kind === 'exit' || step.kind === 'ramp') return 'exitRight';
  if (rightward(step.direction)) return 'turnRight';
  return 'arrowUp';
}

/** 1 row of the Steps list: its arrow, words and distance, and whether the van is on it (CTL-TEC-08-06). */
export interface StepRow {
  index: number;
  icon: StepIcon;
  words: string;
  /** The stretch to the next step's turn ("0.3 mi", "400 ft"); null on the arrival, which has none. */
  distance: string | null;
  /** The step the van is on (the first): marked Now, only on a fresh read with signal. */
  now: boolean;
  arrive: boolean;
  /** The step's turn point [longitude, latitude]: a picked step centers the map on it (CTL-TEC-08-01). */
  at: readonly [number, number];
}

/**
 * The Steps list: every step left in driving order, each with its arrow, words and distance (SCR-TEC-08 Step words). A step the catalog
 * has no words for (outside SD-49's mapping; the word test over the real tracks file fails on one) is left out rather than drawn empty.
 * `now` false is the Offline, steps saved state: the kept steps with no step marked Now.
 */
export function stepRows(steps: readonly RouteStep[], t: Say, address: string, now: boolean): StepRow[] {
  const rows: StepRow[] = [];
  steps.forEach((s, index) => {
    const words = stepText(s, t, address);
    if (words === null) return;
    const arrive = s.kind === 'arrive';
    rows.push({ index, icon: stepIcon(s), words, distance: arrive ? null : stepDistanceText(s.distanceMeters, t), now: now && index === 0, arrive, at: s.at });
  });
  return rows;
}

/** The Next turn card (CTL-TEC-08-05): the step after the one the van is on, "In <the first step's distance>:"; none with fewer than 2 steps. */
export interface NextTurn { icon: StepIcon; lead: string; words: string; at: readonly [number, number] }

export function nextTurn(steps: readonly RouteStep[], t: Say, address: string): NextTurn | null {
  const [on, next] = steps;
  if (!on || !next) return null;
  const words = stepText(next, t, address);
  if (words === null) return null;
  return { icon: stepIcon(next), lead: t('tech.dir.nextTurnIn', { distance: stepDistanceText(on.distanceMeters, t) }), words, at: next.at };
}

const sameStep = (a: RouteStep, b: RouteStep): boolean =>
  a.kind === b.kind && a.road === b.road && a.direction === b.direction && a.at[0] === b.at[0] && a.at[1] === b.at[1];
const samePoint = (a: { lon: number; lat: number }, b: { lon: number; lat: number }): boolean => a.lon === b.lon && a.lat === b.lat;

/** How far off the shown straight line, and how far back toward the start, a new start point may be and still be the same route (meters). */
const LINE_SLACK_METERS = 10;

/**
 * Whether `now` is the van's point further along the straight line `from` to `to` (an approximate leg: API-104 with no fromJob answers the van's
 * point on that line, which moves with the clock, so it is the same route). Compared in local meters; slack 10 m covers the wire's rounding of
 * a coordinate (about 1 m) and a read that lands a moment behind the shown one, and is far under any other start stop.
 */
function movedAlongLine(from: { lon: number; lat: number }, now: { lon: number; lat: number }, to: { lon: number; lat: number }): boolean {
  const k = Math.cos((to.lat * Math.PI) / 180);
  const M = 111_320;
  const lx = (to.lon - from.lon) * k * M;
  const ly = (to.lat - from.lat) * M;
  const nx = (now.lon - from.lon) * k * M;
  const ny = (now.lat - from.lat) * M;
  const len = Math.hypot(lx, ly);
  if (len === 0) return false;
  const along = (nx * lx + ny * ly) / len;
  const across = Math.abs(nx * ly - ny * lx) / len;
  // F-1317: on the line, no farther from the destination (along >= -slack) and not past it (along <= len + slack).
  return across <= LINE_SLACK_METERS && along >= -LINE_SLACK_METERS && along <= len + LINE_SLACK_METERS;
}

/**
 * Whether a re-read is the rest of the route shown (CTL-TEC-08-08: a re-read that only drops passed steps is not announced). It is not
 * when a routed leg and an approximate one replace each other, when the destination differs, or, on a routed leg, when the steps after
 * the van's own step are not the last steps of the route shown (another start stop, another way). On an approximate leg the new start is the
 * same route when it lies on the shown straight line, no farther from the destination. The van's own step keeps its kind
 * but its point and length follow the van, so it is not compared.
 */
export function isRestOf(shown: ShownRoute, next: ShownRoute): boolean {
  if ((shown.leg.track === null) !== (next.leg.track === null)) return false;
  if (!samePoint(shown.leg.to, next.leg.to)) return false;
  if (next.leg.track === null) return samePoint(shown.leg.from, next.leg.from) || movedAlongLine(shown.leg.from, next.leg.from, shown.leg.to);
  const a = shown.steps;
  const b = next.steps;
  if (b.length === 0 || a.length === 0) return a.length === b.length;
  if (b.length > a.length) return false;
  const off = a.length - b.length;
  if ((a[off] as RouteStep).kind !== (b[0] as RouteStep).kind) return false;
  for (let i = 1; i < b.length; i += 1) if (!sameStep(a[off + i] as RouteStep, b[i] as RouteStep)) return false;
  return true;
}

/**
 * The destination's street address, the words the arrival names (UI-SPECIFICATION SCR-TEC-08 Step words: "Arrive at 2271 Cobblestone Dr"):
 * the day's address up to its town (API-100 writes "<house number> <street>, <town>"). The Approximate state names the whole address.
 */
export const streetOf = (address: string): string => address.split(',')[0]?.trim() ?? address;

/** The step meters add up to the leg's length (a guarantee of the step mapping, SD-49), so the list and the drive line agree: the sum the screen states. */
export const stepsMeters = (steps: readonly RouteStep[]): number => steps.reduce((n, s) => n + s.distanceMeters, 0);
