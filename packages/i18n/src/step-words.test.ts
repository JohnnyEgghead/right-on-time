// SPDX-License-Identifier: AGPL-3.0-or-later
// The step words (UI-SPECIFICATION v0.15 SCR-TEC-08 Step words; SPECIFICATIONS v0.13 section 6.3): every kind and direction SD-49's
// mapping can answer is worded in English and Spanish, and a step outside it answers no words. The same words over every step of the
// real tracks file run in packages/maps/src/steps.maps.test.ts (the gate map-manifest).
import { describe, expect, it } from 'vitest';
import { STEP_DIRECTIONS, STEP_HEADINGS, STEP_KINDS, STEP_SIDES } from '../../maps/src/steps.ts';
import { formatterFor } from './format.ts';
import { stepDistanceText, stepText, type StepWords } from './step-words.ts';

const en = formatterFor('en');
const es = formatterFor('es');
const ADDRESS = '2271 Cobblestone Dr';
const base: StepWords = { kind: 'turn', direction: null, heading: null, road: null, exit: null, side: null };

/** Every step SD-49's mapping can make: each kind with each value its fields can take there. */
function everyStep(): StepWords[] {
  const out: StepWords[] = [];
  for (const road of ['E Schrock Rd', null]) {
    for (const kind of STEP_KINDS) {
      if (kind === 'depart') for (const heading of STEP_HEADINGS) out.push({ ...base, kind, heading, road });
      else if (kind === 'arrive') for (const side of [...STEP_SIDES, null]) out.push({ ...base, kind, side, road });
      else if (kind === 'roundabout') for (const exit of [1, 2, null]) out.push({ ...base, kind, exit, road });
      else if (kind === 'uturn') out.push({ ...base, kind, road });
      else for (const direction of [...STEP_DIRECTIONS, null]) out.push({ ...base, kind, direction, road });
    }
  }
  return out;
}

describe('step words, every kind and direction of SD-49 in both languages', () => {
  // why: FR-TECH-5, FR-LANG-1
  it('words every step the mapping can make, with its road when set and without it when not', () => {
    const steps = everyStep();
    expect(steps.length).toBeGreaterThan(150);
    for (const t of [en, es]) {
      for (const s of steps) {
        const w = stepText(s, t, ADDRESS);
        expect(w, JSON.stringify(s)).toBeTruthy();
        expect(w).not.toMatch(/[{}]|\s{2}|\s$|^\s|\s,/);
        if (s.kind === 'arrive') expect(w).toContain(ADDRESS);
        else if (s.road) expect(w).toContain(s.road);
        else expect(w).not.toMatch(/ (on|onto|por|en|a|hacia)$/);
      }
    }
  });

  // why: FR-TECH-5
  it('says the UI specification and the approved frames words for their sample steps', () => {
    expect(stepText({ ...base, kind: 'depart', heading: 'n', road: 'Cleveland Ave' }, en, ADDRESS)).toBe('Head north on Cleveland Ave');
    expect(stepText({ ...base, kind: 'turn', direction: 'right', road: 'E Schrock Rd' }, en, ADDRESS)).toBe('Turn right onto E Schrock Rd');
    expect(stepText({ ...base, kind: 'turn', direction: 'slight_right', road: 'X' }, en, ADDRESS)).toBe('Turn slightly right onto X');
    expect(stepText({ ...base, kind: 'turn', direction: 'sharp_left', road: 'X' }, en, ADDRESS)).toBe('Turn sharply left onto X');
    expect(stepText({ ...base, kind: 'continue', road: 'X' }, en, ADDRESS)).toBe('Continue on X');
    expect(stepText({ ...base, kind: 'new_name', road: 'X' }, en, ADDRESS)).toBe('Continue onto X');
    expect(stepText({ ...base, kind: 'merge', road: 'X' }, en, ADDRESS)).toBe('Merge onto X');
    expect(stepText({ ...base, kind: 'ramp', road: 'X' }, en, ADDRESS)).toBe('Take the ramp onto X');
    expect(stepText({ ...base, kind: 'exit', road: 'X' }, en, ADDRESS)).toBe('Take the exit onto X');
    expect(stepText({ ...base, kind: 'fork', direction: 'slight_left', road: 'X' }, en, ADDRESS)).toBe('Keep left at the fork onto X');
    expect(stepText({ ...base, kind: 'end_of_road', direction: 'right', road: 'X' }, en, ADDRESS)).toBe('At the end of the road, turn right onto X');
    expect(stepText({ ...base, kind: 'roundabout', exit: 2, road: 'X' }, en, ADDRESS)).toBe('At the roundabout, take exit 2 onto X');
    expect(stepText({ ...base, kind: 'uturn', road: 'X' }, en, ADDRESS)).toBe('Make a U-turn onto X');
    expect(stepText({ ...base, kind: 'arrive', side: 'right', road: 'Cobblestone Dr' }, en, ADDRESS)).toBe('Arrive at 2271 Cobblestone Dr, on the right');
    expect(stepText({ ...base, kind: 'arrive', side: null }, en, ADDRESS)).toBe('Arrive at 2271 Cobblestone Dr');
    expect(stepText({ ...base, kind: 'turn', direction: 'left', road: null }, en, ADDRESS)).toBe('Turn left');
    // DK-117, the Spanish frame
    expect(stepText({ ...base, kind: 'depart', heading: 'n', road: 'Cleveland Ave' }, es, ADDRESS)).toBe('Siga hacia el norte por Cleveland Ave');
    expect(stepText({ ...base, kind: 'turn', direction: 'right', road: 'E Schrock Rd' }, es, ADDRESS)).toBe('Gire a la derecha en E Schrock Rd');
    expect(stepText({ ...base, kind: 'turn', direction: 'left', road: 'Cobblestone Dr' }, es, ADDRESS)).toBe('Gire a la izquierda en Cobblestone Dr');
    expect(stepText({ ...base, kind: 'arrive', side: 'right' }, es, ADDRESS)).toBe('Llegue a 2271 Cobblestone Dr, a la derecha');
  });

  // why: FR-TECH-5
  it('answers no words for a step outside the mapping, so the real-file test can fail on it', () => {
    expect(stepText({ ...base, kind: 'teleport' }, en, ADDRESS)).toBeNull();
    expect(stepText({ ...base, kind: 'turn', direction: 'backwards' }, en, ADDRESS)).toBeNull();
    expect(stepText({ ...base, kind: 'depart', heading: null }, en, ADDRESS)).toBeNull();
    expect(stepText({ ...base, kind: 'arrive', side: 'middle' }, es, ADDRESS)).toBeNull();
  });

  // why: FR-TECH-5
  it('says a distance under 0.1 mi in feet rounded to 50 ft, and from 0.1 mi in miles to 1 decimal', () => {
    expect(stepDistanceText(122, en)).toBe('400 ft');
    expect(stepDistanceText(122, es)).toBe('400 pies');
    expect(stepDistanceText(160, en)).toBe('500 ft');
    expect(stepDistanceText(161, en)).toBe('0.1 mi');
    expect(stepDistanceText(1931, en)).toBe('1.2 mi');
    expect(stepDistanceText(483, es)).toBe('0.3 mi');
    expect(stepDistanceText(0, en)).toBe('0 ft');
  });
});
