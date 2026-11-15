// SPDX-License-Identifier: AGPL-3.0-or-later
// The slot formatter (SPECIFICATIONS section 6.4, SD-17): every label is GSM-7 basic and inside its SD-17 maximum, in both
// languages, from the REAL catalog (FR-TEXT-9, FR-TEXT-10, FR-TEXT-18).
import { describe, expect, it } from 'vitest';
import { isGsm7BasicChar, SLOT_MAX } from '@bw/sms';
import { Temporal } from '@bw/time';
import { catalogs } from '../../i18n/src/catalog.ts';
import { allArrivals, allWindows, realSlotValues } from './testing/real-slots.ts';
import { arrivalLabel, foreignHosts, textLink, visitDayLabels, weekdayLabel, windowLabel } from './slots.ts';

const I = (s: string) => Temporal.Instant.from(s);
const basic = (s: string) => [...s].every((ch) => isGsm7BasicChar(ch));

describe('slot labels', () => {
  // why: FR-TEXT-10, F-419
  it('words Spanish Saturday as "sáb", never a stand-in word, and no Spanish text template prints a weekday (the reword)', () => {
    expect(weekdayLabel(catalogs, 'es', 6)).toBe('sáb');
    expect(weekdayLabel(catalogs, 'es', 3)).toBe('mié');
    expect(weekdayLabel(catalogs, 'en', 6)).toBe('Sat');
    for (const kind of ['confirmation', 'reminder', 'on_the_way', 'late', 'r_reply']) {
      expect(catalogs.es[`text.${kind}`]).not.toContain('{weekday}');
    }
    for (const d of [1, 2, 3, 4, 5]) expect(basic(weekdayLabel(catalogs, 'es', d))).toBe(true);
  });

  // why: FR-TEXT-10
  it('renders every month label in GSM-7 basic, both languages', () => {
    for (const lang of ['en', 'es'] as const) {
      for (let m = 1; m <= 12; m++) expect(basic(catalogs[lang][`time.month.${m}`] as string)).toBe(true);
    }
  });

  // why: FR-TEXT-9
  it('formats the visit day as SD-17 writes it: "Sep 15" and "15 de sep", Tue and mar', () => {
    const labels = visitDayLabels(catalogs);
    expect(labels('2026-09-15', 'en')).toEqual({ weekday: 'Tue', date: 'Sep 15' });
    expect(labels('2026-09-15', 'es')).toEqual({ weekday: 'mar', date: '15 de sep' });
    expect(labels('2026-09-19', 'es')).toEqual({ weekday: 'sáb', date: '19 de sep' });
  });

  // why: FR-TEXT-10
  it('writes windows with AM and PM in both languages', () => {
    expect([windowLabel(8, 10), windowLabel(10, 12), windowLabel(12, 14), windowLabel(16, 18), windowLabel(8, 12), windowLabel(14, 18)]).toEqual([
      '8-10 AM', '10 AM-12 PM', '12-2 PM', '4-6 PM', '8 AM-12 PM', '2-6 PM',
    ]);
  });

  // why: FR-LANG-1 the Spanish window is the approved frame's wording, "de 2 a 4 PM", with the start's AM or PM left out where it matches the end's (SD-17, DK-127; F-1153)
  it('writes the Spanish window as de, the start, a, the end', () => {
    expect([windowLabel(14, 16, 'es'), windowLabel(10, 12, 'es'), windowLabel(8, 10, 'es'), windowLabel(8, 12, 'es'), windowLabel(12, 14, 'es')]).toEqual([
      'de 2 a 4 PM', 'de 10 AM a 12 PM', 'de 8 a 10 AM', 'de 8 AM a 12 PM', 'de 12 a 2 PM',
    ]);
  });

  // why: FR-TEXT-3
  it('rounds the arrival time to 5 minutes in the visit zone and prints AM or PM', () => {
    expect(arrivalLabel(I('2026-09-15T14:42:10Z'), 'America/New_York', 'en')).toMatchObject({ label: '10:40 AM', rounded: I('2026-09-15T14:40:00Z') });
    expect(arrivalLabel(I('2026-09-15T16:48:00Z'), 'America/New_York', 'es').label).toBe('12:50 PM');
  });

  // why: FR-TEXT-18
  it('writes a link on the text link host with no scheme in SD-17 shapes, 20 characters', () => {
    const link = textLink('bw.j7l.io', 'map', '7Hk2Ab9Q');
    expect(link).toBe('bw.j7l.io/m/7Hk2Ab9Q');
    expect(link).toHaveLength(SLOT_MAX.mapLink.en);
    expect(textLink('bw.j7l.io', 'reschedule', '7Hk2Ab9Q')).toBe('bw.j7l.io/r/7Hk2Ab9Q');
  });

  // why: FR-TEXT-18
  it('finds a host other than the text link host, and none in a text that holds only it', () => {
    expect(foreignHosts('Follow Maria live: bw.j7l.io/m/7Hk2Ab9Q', 'bw.j7l.io')).toEqual([]);
    expect(foreignHosts('Follow Maria live: example.com/m/7Hk2Ab9Q', 'bw.j7l.io')).toEqual(['example.com']);
    expect(foreignHosts('see https://evil.example/x or bw.j7l.io/r/AbC12345', 'bw.j7l.io')).toEqual(['evil.example']);
    expect(foreignHosts('Brightwater: Tune-up. Reply C to confirm. Call (614) 555-0100.', 'bw.j7l.io')).toEqual([]);
  });
});

describe('the real slot values the check enumerates', () => {
  // why: FR-TEXT-9
  it('stay inside SD-17 maxima and GSM-7 basic for every slot and language', () => {
    const v = realSlotValues(catalogs, 'bw.j7l.io');
    for (const lang of ['en', 'es'] as const) {
      for (const slot of Object.keys(v.values) as (keyof typeof v.values)[]) {
        expect(v.values[slot][lang].length).toBeGreaterThan(0);
        for (const value of v.values[slot][lang]) {
          expect([...value].length, `${slot} ${lang} "${value}"`).toBeLessThanOrEqual(SLOT_MAX[slot][lang]);
          expect(basic(value), `${slot} ${lang} "${value}"`).toBe(true);
        }
      }
    }
  });

  // why: FR-TEXT-3
  it('cover every time of day at 5 minutes: 288 arrival values, the longest 8 characters', () => {
    const all = allArrivals('en');
    expect(all).toHaveLength(288);
    expect(Math.max(...all.map((a) => a.length))).toBe(8);
    expect(all[0]).toBe('12:00 AM');
    expect(all.at(-1)).toBe('11:55 PM');
  });
});

describe('the window population of text-budget-check (F-1270)', () => {
  // why: F-1270 the windows come from windowLabelZoned over each branch zone, summer and winter, not from a fixed list of abbreviations
  it('has every window with EDT (summer) and EST (winter) in the branch zone, and nothing else', () => {
    const all = allWindows('en');
    expect(all).toHaveLength(2 * (5 + 4));
    expect(all).toContain('10 AM-12 PM EDT');
    expect(all).toContain('10 AM-12 PM EST');
    expect(all.every((w) => /(EDT|EST)$/.test(w))).toBe(true);
  });

  // why: F-1270 a branch in another zone changes the population, so a 4-letter abbreviation reaches the budget check (the AKDT plant)
  it('follows the zone: a branch in Alaska adds the 4-letter AKDT and AKST windows', () => {
    const all = allWindows('en', ['America/Anchorage']);
    expect(all).toContain('10 AM-12 PM AKDT');
    expect(all).toContain('10 AM-12 PM AKST');
    expect(Math.max(...all.map((w) => w.length))).toBe(Math.max(...allWindows('en').map((w) => w.length)) + 1);
  });
});

describe('the Spanish window population (SD-17 slot max 20)', () => {
  // why: FR-LANG-1 the longest Spanish window label is "de 10 AM a 12 PM EDT", 20 characters, the SD-17 Spanish maximum (F-1443)
  it('has every Spanish window in the branch zones within 20 characters, and the longest is exactly 20', () => {
    const all = allWindows('es');
    expect(all).toContain('de 2 a 4 PM EDT');
    expect(all).toContain('de 10 AM a 12 PM EST');
    expect(Math.max(...all.map((w) => w.length))).toBe(20);
  });
});
