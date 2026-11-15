// SPDX-License-Identifier: AGPL-3.0-or-later
// The words of 1 turn-by-turn step (UI-SPECIFICATION v0.15 SCR-TEC-08, Step words; SPECIFICATIONS v0.13 section 6.3 Directions, SD-49;
// FR-TECH-5). 1 function words a step by its kind and direction (with heading, exit and side where set) in the user's language, and
// 1 says its distance, so the web technician app and the native app word a step alike. Pure: the caller passes its formatter (the
// page's t, the native app's t, the server's formatterFor), as billing-rows.ts does.
//
// A road name shows as the map data holds it and is never translated; a step with no road leaves out its "on <road>" or
// "onto <road>" part; an arrive step names the destination's street address (CTL-TEC-08-02), with its side when set.
// Every key below is a literal, so the native catalog subset (ci/native/catalog-subset.ts) sees each one if native code imports this.
import type { MessageKey } from './catalog.ts';
import type { RowT } from './billing-rows.ts';

/** The step fields the words read: API-104's step without `at` and `distanceMeters` (SD-49). Strings, so any value can be checked. */
export interface StepWords {
  kind: string;
  direction: string | null;
  heading: string | null;
  road: string | null;
  exit: number | null;
  side: string | null;
}

const KEY_OF_KIND: Readonly<Record<string, MessageKey>> = {
  depart: 'tech.step.depart',
  turn: 'tech.step.turn',
  continue: 'tech.step.continue',
  new_name: 'tech.step.newName',
  merge: 'tech.step.merge',
  ramp: 'tech.step.ramp',
  exit: 'tech.step.exit',
  fork: 'tech.step.fork',
  end_of_road: 'tech.step.endOfRoad',
  roundabout: 'tech.step.roundabout',
  uturn: 'tech.step.uturn',
  arrive: 'tech.step.arrive',
};

const HEADINGS: ReadonlySet<string> = new Set(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);
const DIRECTIONS: ReadonlySet<string> = new Set(['left', 'right', 'slight_left', 'slight_right', 'sharp_left', 'sharp_right', 'straight']);

/** The side a fork or the end of a road turns to: the 3 left and 3 right directions collapse to left or right; straight and none keep on. */
const sideward = (d: string | null): string => (d === null ? 'none' : d.endsWith('left') ? 'left' : d.endsWith('right') ? 'right' : 'none');

/**
 * The words of 1 step, for example "Turn right onto E Schrock Rd" or "Arrive at 2271 Cobblestone Dr, on the right".
 * Answers null for a step the catalog has no wording for (a kind, direction or heading outside SD-49's mapping), which the word test
 * over the real tracks file fails on (SPECIFICATIONS section 6.3), so a reader never draws an empty or half-worded step.
 *
 * @param address the destination's street address, for the arrive step's words
 */
export function stepText(step: StepWords, t: RowT, address: string): string | null {
  const key = KEY_OF_KIND[step.kind];
  if (!key) return null;
  if (step.direction !== null && !DIRECTIONS.has(step.direction)) return null;
  const road = step.road ?? '';
  const values: Record<string, string | number> = { hasRoad: road === '' ? 'no' : 'yes', road };
  switch (step.kind) {
    case 'depart':
      if (step.heading === null || !HEADINGS.has(step.heading)) return null;
      values['heading'] = step.heading;
      break;
    case 'turn':
      values['direction'] = step.direction ?? 'none';
      break;
    case 'fork':
    case 'end_of_road':
      values['direction'] = sideward(step.direction);
      break;
    case 'roundabout':
      values['hasExit'] = step.exit === null ? 'no' : 'yes';
      values['exit'] = step.exit ?? 0;
      break;
    case 'arrive':
      if (step.side !== null && step.side !== 'left' && step.side !== 'right') return null;
      values['address'] = address;
      values['side'] = step.side ?? 'none';
      break;
    default:
      break;
  }
  return t(key, values);
}

/** Meters in a mile, as the app counts miles (CTL-TEC-15-09). */
const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.280839895;

/**
 * A step's distance (SCR-TEC-08, Step words): under 0.1 mi in feet, rounded to 50 ft ("400 ft"); from 0.1 mi in miles to 1 decimal
 * ("1.2 mi"), as CTL-TEC-15-09 counts miles.
 */
export function stepDistanceText(meters: number, t: RowT): string {
  const mi = meters / METERS_PER_MILE;
  if (mi < 0.1) return t('tech.step.ft', { n: Math.round((meters * FEET_PER_METER) / 50) * 50 });
  return t('tech.step.mi', { n: mi.toFixed(1) });
}
