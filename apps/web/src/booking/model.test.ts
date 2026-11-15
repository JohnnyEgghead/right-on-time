// SPDX-License-Identifier: AGPL-3.0-or-later
// The booking site's pure rules (P5-BOOKING): what each step needs, the calendar's day words, the places-left words, the nearest-window words of the
// Window just taken page, the texts rule for a missing mobile, the house number, and the service price line, in both languages.
import { catalogs } from '@bw/i18n';
import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { OnlineDay } from '@bw/api';
import type { ClientT } from '../shell/intl.tsx';
import {
  dayKind, dayName, dayShort, emptyDraft, firstOpenStep, firstPickable, hasMobile, houseNumber, mobileDigits, monthGrid, optionWords, phoneText, pickable, roomWords, serviceLine,
  stepComplete, textsOn, windowLabel, type Draft, type Nearest, type ServiceItem,
} from './model.ts';
import { HAROLD, PICKED_DAY, previewDays, SERVICES, STREET, TODAY } from './preview-data.ts';

const tOf = (lang: 'en' | 'es') => {
  const intl = createIntl({ locale: lang, messages: catalogs[lang] as Record<string, string>, onError: () => undefined });
  return ((key: string, values?: Record<string, string | number>) => intl.formatMessage({ id: key }, values)) as unknown as ClientT;
};
const en = tOf('en');
const es = tOf('es');
const days = new Map<string, OnlineDay>(previewDays().map((d) => [d.date, d]));

describe('the steps (FR-BOOK-1, FR-BOOK-12)', () => {
  // why: FR-BOOK-1 each step is complete only when its own fields are: service, street and house number, day, window, name
  it('completes step 1 with a service, step 2 with a listed street and a house number, step 3 with a day, step 4 with a window, step 5 with a name', () => {
    const d = emptyDraft('en');
    expect([1, 2, 3, 4, 5].map((s) => stepComplete(s as 1, d))).toEqual([false, false, false, false, false]);
    expect(stepComplete(1, { ...d, serviceId: 'furnace_tune_up' })).toBe(true);
    expect(stepComplete(2, { ...d, street: STREET, house: '' })).toBe(false);
    expect(stepComplete(2, { ...d, street: STREET, house: '418' })).toBe(true);
    expect(stepComplete(2, { ...d, street: null, streetText: 'Maple Hollow Ct', house: '418' })).toBe(false);
    expect(stepComplete(3, { ...d, date: PICKED_DAY })).toBe(true);
    expect(stepComplete(4, { ...d, windowId: 'w10' })).toBe(true);
    expect(stepComplete(5, { ...d, name: '  ' })).toBe(false);
    expect(stepComplete(5, { ...d, name: 'Harold' })).toBe(true);
  });

  // why: FR-BOOK-12 a house number is a whole number from 1 to 99999; the street gives the branch, so a draft without a listed street is not complete
  it('accepts a house number from 1 to 99999 only', () => {
    expect([houseNumber('418'), houseNumber('99999'), houseNumber('0'), houseNumber('100000'), houseNumber('4a'), houseNumber('')]).toEqual([418, 99999, null, null, null, null]);
  });

  // why: FR-BOOK-1 a restored draft lands on its first incomplete step
  it('lands a restored draft on its first incomplete step', () => {
    expect(firstOpenStep(emptyDraft('en'))).toBe(1);
    expect(firstOpenStep({ ...emptyDraft('en'), serviceId: 'furnace_tune_up' })).toBe(2);
    expect(firstOpenStep(HAROLD)).toBe(6);
    expect(firstOpenStep({ ...HAROLD, name: '' })).toBe(5);
  });
});

describe('Text me updates in (FR-BOOK-11, FR-TEXT-13)', () => {
  // why: FR-BOOK-11 without a mobile number the box is off whatever the draft says; with one it follows the box
  it('is off with no mobile number, and follows the box with one', () => {
    const d: Draft = { ...HAROLD, mobile: '', textsOn: true };
    expect([hasMobile(d), textsOn(d)]).toEqual([false, false]);
    expect(textsOn({ ...d, mobile: '(614) 555-0148' })).toBe(true);
    expect(textsOn({ ...d, mobile: '(614) 555-0148', textsOn: false })).toBe(false);
  });

  // why: FR-BOOK-11 a mobile number is 10 digits as typed with any punctuation, and prints as (614) 555-0148
  it('reads a mobile number typed any way and prints it as (614) 555-0148', () => {
    expect(mobileDigits('614-555-0148')).toBe('6145550148');
    expect(mobileDigits('+1 (614) 555 0148')).toBe('6145550148');
    expect(mobileDigits('555-0148')).toBeNull();
    expect(mobileDigits('abc')).toBeNull();
    expect(phoneText('614.555.0148')).toBe('(614) 555-0148');
    expect(phoneText('+16145550148')).toBe('(614) 555-0148');
  });

  // why: FR-BOOK-11 the text language follows the page's language until the customer picks one (the draft starts at the page's language)
  it('starts the text language at the page language', () => {
    expect(emptyDraft('es').textLanguage).toBe('es');
    expect(emptyDraft('en').languagePicked).toBe(false);
  });
});

describe('the calendar (FR-BOOK-9, FR-BOOK-10, FR-BOOK-15)', () => {
  // why: FR-BOOK-15 an open day with few windows left is marked; a Full day is Full; Sundays are Closed on Sundays; demo today is Today and cannot be picked
  it('names each day by what it is: past, today, open, a few left, Sunday, Full', () => {
    const kind = (date: string, map = days) => dayKind(date, TODAY, map);
    expect(kind('2026-09-09')).toBe('past');
    expect(kind(TODAY)).toBe('today');
    expect(kind('2026-09-11')).toBe('open');
    expect(kind('2026-09-16')).toBe('few');
    expect(kind('2026-09-13')).toBe('sunday');
    const full = new Map(days).set('2026-09-14', { ...(days.get('2026-09-14') as OnlineDay), state: 'full', reason: 'full' });
    expect(kind('2026-09-14', full)).toBe('full');
    expect(['open', 'few'].every((k) => pickable(k as 'open'))).toBe(true);
    expect(['past', 'today', 'sunday', 'full', 'closed', 'noTech', 'unknown'].some((k) => pickable(k as 'open'))).toBe(false);
  });

  // why: FR-BOOK-10 a Saturday with no working technician says No technicians this Saturday; FR-BOOK-9 a closed day says Booking closed
  it('says No technicians this Saturday, Booking closed and Closed on Sundays in both languages', () => {
    const map = new Map<string, OnlineDay>([
      ['2026-09-12', { date: '2026-09-12', mode: 'saturday', state: 'closed', reason: 'no_technicians', fewLeft: false, windows: [] }],
      ['2026-09-11', { date: '2026-09-11', mode: 'two_hour', state: 'closed', reason: 'booking_closed', fewLeft: false, windows: [] }],
    ]);
    expect(dayName(en, '2026-09-12', dayKind('2026-09-12', TODAY, map))).toBe('Sat, Sep 12, No technicians this Saturday');
    expect(dayName(en, '2026-09-11', dayKind('2026-09-11', TODAY, map))).toBe('Fri, Sep 11, Booking closed');
    expect(dayName(en, '2026-09-13', dayKind('2026-09-13', TODAY, days))).toBe('Sun, Sep 13, Closed on Sundays');
    expect(dayName(es, '2026-09-13', dayKind('2026-09-13', TODAY, days))).toBe('dom 13 sep, Cerrado los domingos');
  });

  // why: FR-BOOK-15 a past day's name ends "past, not bookable" (CTL-CUS-01-19)
  it('ends the name of a past day "past, not bookable"', () => {
    expect(dayName(en, '2026-09-03', 'past')).toBe('Thu, Sep 3, past, not bookable');
  });

  // why: FR-BOOK-15 the month's grid starts on the weekday of the 1st, Sunday first, and holds each day once
  it('draws September 2026 from a Tuesday: 2 blanks, then 30 days', () => {
    const grid = monthGrid('2026-09', TODAY, days);
    expect(grid.slice(0, 3).map((c) => c.day)).toEqual([null, null, 1]);
    expect(grid.filter((c) => c.day !== null)).toHaveLength(30);
  });

  // why: FR-BOOK-9 the first bookable day is where the calendar opens; with none the page says No open days right now
  it('finds the first bookable day, and none when nothing is open', () => {
    expect(firstPickable(previewDays())).toBe('2026-09-11');
    expect(firstPickable(previewDays().map((d) => ({ ...d, state: 'closed' as const, reason: 'booking_closed' as const })))).toBeNull();
  });
});

describe('windows and options (FR-BOOK-3, FR-BOOK-16)', () => {
  const near = (date: string, start: string, placesLeft: number | null): Nearest => ({ windowId: 'w', start: `${date}T${start}:00-04:00[America/New_York]`, end: `${date}T${start}:00-04:00[America/New_York]`, state: 'open', placesLeft, date });
  const filled = { date: PICKED_DAY, start: '2026-09-15T10:00:00-04:00[America/New_York]' };

  // why: FR-BOOK-3 an option is worded against the window that filled: same day later or earlier by hours, another window that day, the same time the next day, else the weekday
  it('words each option against the window that filled', () => {
    expect(optionWords(en, filled, near(PICKED_DAY, '12:00', 1))).toBe('Same day, 2 hours later');
    expect(optionWords(en, filled, near(PICKED_DAY, '08:00', 1))).toBe('Same day, 2 hours earlier');
    expect(optionWords(en, filled, near(PICKED_DAY, '16:00', null))).toBe('Same day');
    expect(optionWords(en, filled, near('2026-09-16', '10:00', null))).toBe('Same time, next day');
    expect(optionWords(en, filled, near('2026-09-17', '14:00', null))).toBe('Thu');
    expect(optionWords(es, filled, near('2026-09-16', '10:00', null))).toBe('A la misma hora, al día siguiente');
  });

  // why: FR-BOOK-16 an option says "<n> left" when the answer gives places left, else Open
  it('says "1 left" when places left are given, and Open otherwise', () => {
    expect(roomWords(en, { placesLeft: 1 })).toBe('1 left');
    expect(roomWords(en, { placesLeft: null })).toBe('Open');
    expect(roomWords(es, { placesLeft: 2 })).toBe('Quedan 2');
  });

  // why: FR-BOOK-1, FR-TEXT-17, F-1122 a window is worded as the board words it, with the branch zone named after it (UD-15): 8-10 AM EDT, 10 AM-12 PM EDT, 12-2 PM EDT
  it('words windows 8-10 AM, 10 AM-12 PM and 12-2 PM and names the zone, EST after the November change', () => {
    const w = (a: string, b: string, day = '2026-09-15', off = '-04:00') => windowLabel({ start: `${day}T${a}:00${off}[America/New_York]`, end: `${day}T${b}:00${off}[America/New_York]` });
    expect([w('08:00', '10:00'), w('10:00', '12:00'), w('12:00', '14:00')]).toEqual(['8-10 AM EDT', '10 AM-12 PM EDT', '12-2 PM EDT']);
    expect(w('10:00', '12:00', '2026-11-03', '-05:00')).toBe('10 AM-12 PM EST');
    expect(dayShort(en, PICKED_DAY)).toBe('Tue, Sep 15');
  });
});

describe('prices (FR-BOOK-14)', () => {
  const item = (id: string): ServiceItem => SERVICES.find((s) => s.serviceId === id) as ServiceItem;

  // why: FR-BOOK-14 a plain price takes its typical length ("$89, about 1 hr"); a fee or a repair-or-replace line stands as written, in both languages
  it('prints "$89, about 1 hr", "$79 visit fee" and "Repair or replace"', () => {
    expect(serviceLine(en, item('furnace_tune_up'))).toBe('$89, about 1 hr');
    expect(serviceLine(en, item('heating_or_ac_fix'))).toBe('$79 visit fee');
    expect(serviceLine(en, item('water_heater'))).toBe('Repair or replace');
    expect(serviceLine(es, item('plumbing_repair'))).toBe('$79 por la visita');
  });
});
