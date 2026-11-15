// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { formatterFor } from '@bw/i18n/src/format.ts';
import { DAYS, SETTINGS } from './preview-data.ts';
import {
  dayShort, dayText, draftOf, draftState, farDay, joinItems, joinSpans, otherSwitched, parseLimit, pickedOf, spanLabel, switchBar, switchRefusal, timeText, weeksOf, whenText,
} from './model.ts';

const en = formatterFor('en');
const es = formatterFor('es');
const day = (date: string) => DAYS.find((d) => d.date === date)!;

describe('the words of the arrival windows page', () => {
  // why: FR-BOOK-2 a day reads as the frame words it: "Wed, Sep 16", the calendar's "Sep 16", the window labels and the list the dialog names, in both languages
  it('words a day, a calendar day, a window and a list of windows in English and Spanish', () => {
    expect(dayText(en, '2026-09-16')).toBe('Wed, Sep 16');
    expect(dayShort(en, '2026-09-16')).toBe('Sep 16');
    expect(dayText(es, '2026-09-16')).toMatch(/16 de sep/);
    expect(spanLabel({ start: '16:00', end: '18:00' })).toBe('4-6 PM');
    expect(spanLabel({ start: '08:00', end: '12:00' })).toBe('8 AM-12 PM');
    expect(joinSpans(en, SETTINGS.fourHourWindows)).toBe('8 AM-12 PM, 10 AM-2 PM, 12-4 PM and 2-6 PM');
    expect(joinSpans(es, SETTINGS.twoHourWindows)).toBe('8-10 AM, 10 AM-12 PM, 12-2 PM, 2-4 PM y 4-6 PM');
    expect(joinItems(en, ['Wed, Sep 16', 'Fri, Sep 18'])).toBe('Wed, Sep 16 and Fri, Sep 18');
    expect(timeText('17:00')).toBe('5:00 PM');
  });

  // why: FR-BOOK-2 (F-748, F-589) a day the address asks for past the 2 calendar weeks is read as well, the panel opens on it and the calendar still draws 14 days; a calendar day, a past day and no day read nothing more
  it('names the far day to read, and the far day joins the page without joining the calendar', () => {
    expect(farDay(DAYS, '2026-10-07', '2026-09-15')).toBe('2026-10-07');
    expect(farDay(DAYS, '2026-09-17', '2026-09-15')).toBeNull();
    expect(farDay(DAYS, '2026-09-01', '2026-09-15')).toBeNull();
    expect(farDay(DAYS, null, '2026-09-15')).toBeNull();
    const far = { ...day('2026-09-16'), date: '2026-10-07', mode: 'four_hour' as const };
    const withFar = [...DAYS, far];
    expect(pickedOf(withFar, '2026-10-07', '2026-09-15')?.date).toBe('2026-10-07');
    expect(weeksOf(withFar).flat()).toHaveLength(14);
    expect(otherSwitched(withFar, '2026-09-17')).toEqual(otherSwitched(DAYS, '2026-09-17'));
  });

  // why: FR-BOOK-18 who and when read in the switch's own zone: the stored wall time, never the device's
  it('words the time a day was switched from its own zone', () => {
    expect(whenText(en, '2026-09-14T16:10:00-04:00[America/New_York]')).toBe('Mon, Sep 14, 4:10 PM');
  });
});

describe('the number fields (FR-BOOK-17)', () => {
  // why: FR-BOOK-17 a number is a whole number from 0 to 999: letters, a sign, a fraction, a blank and 1000 are not
  it('accepts whole numbers from 0 to 999 only', () => {
    expect(parseLimit('0')).toEqual({ ok: true, value: 0 });
    expect(parseLimit(' 12 ')).toEqual({ ok: true, value: 12 });
    expect(parseLimit('999')).toEqual({ ok: true, value: 999 });
    for (const bad of ['', '-1', '2.5', 'x', '1000', '1e2']) expect(parseLimit(bad).ok, bad).toBe(false);
  });

  // why: FR-BOOK-17 Save changes is on only when a number changed and every field is valid; Discard returns the saved numbers; the body holds the changed windows only
  it('marks the changed windows, the invalid ones, and builds the save from the changed valid ones', () => {
    const saved = draftOf(SETTINGS.windows);
    expect(draftState(SETTINGS.windows, saved)).toMatchObject({ changed: false, canSave: false });
    const last = SETTINGS.windows[4]!.windowId;
    const edited = draftState(SETTINGS.windows, { ...saved, [last]: '9' });
    expect(edited).toMatchObject({ changed: true, canSave: true, limits: [{ windowId: last, limit: 9 }] });
    const bad = draftState(SETTINGS.windows, { ...saved, [last]: '9.5' });
    expect([bad.changed, bad.canSave, [...bad.invalid]]).toEqual([true, false, [last]]);
    expect(draftState(SETTINGS.windows, { ...saved, [last]: '10' }).changed).toBe(false);
  });
});

describe('the peak days calendar and the picked day (CTL-OFC-12-11, CTL-OFC-12-12)', () => {
  // why: FR-BOOK-2 the calendar is 2 weeks, drawn in 2 rows of 7 (the server picks the range, F-755)
  it('draws the 2 weeks in 2 rows', () => {
    expect(weeksOf(DAYS).map((w) => w.length)).toEqual([7, 7]);
  });

  // why: FR-BOOK-2 a day cannot be switched when it is before today, closed or a Saturday (X-2a: no 4-hour windows on a half-day), and is otherwise switchable
  it('bars the past, a closed day and a Saturday from the switch', () => {
    expect(switchBar(day('2026-09-14'), '2026-09-15')).toBe('past');
    expect(switchBar(day('2026-09-20'), '2026-09-15')).toBe('closed');
    expect(switchBar(day('2026-09-19'), '2026-09-15')).toBe('saturday');
    expect(switchBar(day('2026-09-15'), '2026-09-15')).toBeNull();
    expect(switchBar(day('2026-09-16'), '2026-09-15')).toBeNull();
  });

  // why: FR-BOOK-18 the picked-day panel names the week's other switched days; it opens on the day asked for, else today
  it('opens on the asked-for day, else today, and lists the other switched days', () => {
    expect(pickedOf(DAYS, '2026-09-17', '2026-09-15')?.date).toBe('2026-09-17');
    expect(pickedOf(DAYS, null, '2026-09-15')?.date).toBe('2026-09-15');
    expect(pickedOf(DAYS, '2030-01-01', '2026-09-15')?.date).toBe('2026-09-15');
    expect(otherSwitched(DAYS, '2026-09-16')).toEqual(['2026-09-18']);
  });

  // why: F-754 CTL-OFC-12-12 lists the picked day's week, Monday to Sunday: Tue, Sep 22 is next week's, so Wed, Sep 16 does not name it
  it('names only the switched days of the picked day week', () => {
    const withNext = DAYS.map((d) => (d.date === '2026-09-22' ? { ...d, mode: 'four_hour' as const } : d));
    expect(otherSwitched(withNext, '2026-09-16')).toEqual(['2026-09-18']);
    expect(otherSwitched(withNext, '2026-09-22')).toEqual([]);
  });

  // why: FR-BOOK-2 each refusal of the switch reads as its own message (a Saturday's, a closed day's, a past day's, else the general one)
  it('maps each refusal of the switch to its message', () => {
    expect(switchRefusal('rule_refused')).toBe('windows.sat');
    expect(switchRefusal('day_closed')).toBe('windows.dlg.dayClosed');
    expect(switchRefusal('day_past')).toBe('windows.dlg.dayPast');
    expect(switchRefusal('server_error')).toBe('windows.dlg.failed');
  });
});
