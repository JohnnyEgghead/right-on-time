// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { formatterFor } from '@bw/i18n/src/format.ts';
import {
  daysText, draftOf, MAX_TIME_OFF_DAYS, spanDays, filterRows, hoursLine, hoursText, loadStep, nameMessage, NO_FILTERS, offDayJobsText, plainLetter, rightNowChip, sameWeek, shownApp, skillTags, spanText, START_FILTERS, subtitle,
  weekHours, weekOf, weekProblem, weekRows, withDayOff, type T, type TechRow, type WorkWeek,
} from './model.ts';
import { DOYLE, MARIA, SKILL_WORDS, TECH_EMPTY, TECH_SUCCESS } from './tech-fixtures.ts';

/** The page's translator (ClientT): the formatter with the language it carries. */
const en = Object.assign(formatterFor('en'), { lang: 'en' as const }) as unknown as T;
const es = Object.assign(formatterFor('es'), { lang: 'es' as const }) as unknown as T;
const row = (name: string): TechRow => TECH_SUCCESS.technicians.find((r) => r.name === name)!;

describe('the working hours editor (CTL-OFC-07-10, CTL-OFC-41-06)', () => {
  const week: WorkWeek = { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5], saturdays: 'none' };

  // why: FR-DISP-33 an end not after the start stops the save with a field message, as does a cleared time; a week with no weekday cannot be stored
  it('finds what stops a week being saved', () => {
    expect(weekProblem(week)).toBeNull();
    expect(weekProblem({ ...week, end: '08:00' })).toBe('times');
    expect(weekProblem({ ...week, end: '07:00' })).toBe('times');
    expect(weekProblem({ ...week, start: '' })).toBe('times');
    expect(weekProblem({ ...week, days: [] })).toBe('days');
  });

  // why: FR-DISP-33 a weekday goes Off and comes back in order, and the saved hours are what the draft starts from
  it('turns a weekday off and on, and starts from the saved week', () => {
    expect(withDayOff(week, 3, true).days).toEqual([1, 2, 4, 5]);
    expect(withDayOff({ ...week, days: [2, 4] }, 3, false).days).toEqual([2, 3, 4]);
    const yoder = row('Chris Yoder');
    expect(draftOf(yoder).week).toEqual({ start: '07:30', end: '18:00', days: [1, 2, 3, 4], saturdays: 'none' });
    expect(draftOf(yoder).hoursOpen).toBe(false);
    expect(sameWeek(weekOf(yoder), { ...weekOf(yoder), days: [4, 3, 2, 1] })).toBe(true);
    expect(sameWeek(weekOf(yoder), { ...weekOf(yoder), start: '08:00' })).toBe(false);
    expect(sameWeek(weekOf(yoder), { ...weekOf(yoder), saturdays: 'odd_weeks' })).toBe(false);
  });

  // why: FR-DISP-33 the resting hours are the week being edited: an Off day reads Off, and a Saturday pattern shows the branch's half day
  it('draws a week as the frame writes hours', () => {
    const half = { start: '08:00', end: '12:00' };
    const rows = weekRows({ ...week, start: '09:30', days: [1, 3], saturdays: 'even_weeks' }, half);
    expect(rows.map((r) => r.text)).toEqual(['9:30-5:30', null, '9:30-5:30', null, null, '8-12', null]);
  });
});

describe('the page\'s start and the jobs left on a day off', () => {
  // why: FR-DISP-33 the page starts on Working today, so a technician off today is not listed until the filter is changed; the subtitle counts from the whole list
  it('starts on Working today', () => {
    const rows = TECH_SUCCESS.technicians.map((r, i) => (i === 0 ? { ...r, workingToday: false } : r));
    expect(filterRows(rows, START_FILTERS)).toHaveLength(rows.length - 1);
    expect(filterRows(rows, NO_FILTERS)).toHaveLength(rows.length);
    expect(subtitle({ ...TECH_SUCCESS, technicians: rows }, 'Columbus', '10:28 AM', en)).toContain('12 technicians, 11 working today');
  });

  // why: F-764 the save names each job left on a day off with its day and window, in both languages
  it('names a job left on a day off with its day', () => {
    const jobs = [{ jobNumber: 27006, date: '2026-09-21', window: { start: 's', end: 'e' } }];
    const text = (l: T) => offDayJobsText(jobs, l, () => '10 AM-12 PM');
    expect(text(en)).toBe('job 27006, Mon, Sep 21, 10 AM-12 PM');
    expect(en('technicians.savedJobs', { name: 'Zoe', count: 1, jobs: text(en) })).toBe('Technician saved. Zoe had 1 job on a day off, now Unassigned: job 27006, Mon, Sep 21, 10 AM-12 PM. Reassign it on the board.');
    expect(es('technicians.savedJobs', { name: 'Zoe', count: 2, jobs: 'x' })).toBe('Técnico guardado. Zoe tenía 2 trabajos en un día libre, ahora Sin asignar: x. Reasígnelos en el tablero.');
  });
});

describe('the Technicians page model (SCR-OFC-07)', () => {
  // why: FR-DISP-33 a shift and the days worked are written as the frame writes them
  it('writes hours and days as the frame does', () => {
    expect(hoursText('08:00', '17:30')).toBe('8-5:30');
    expect(hoursText('07:30', '18:00')).toBe('7:30-6');
    expect(hoursText('08:00', '12:00')).toBe('8-12');
    expect(daysText([1, 2, 3, 4, 5], en)).toBe('Mon-Fri');
    expect(daysText([1, 2, 3, 4], es)).toBe('lun-jue');
    expect(daysText([1, 3, 5], en)).toBe('Mon, Wed, Fri');
    expect(hoursLine(row('Chris Yoder'), en)).toBe('Mon-Thu, 7:30-6');
  });

  // why: FR-DISP-33 the panel's week shows each weekday's hours or Off, Saturday as the half day when worked, and marks today
  it('lists the 7 weekdays of the panel with Saturday as the half day', () => {
    const w = weekHours(MARIA, TECH_SUCCESS.saturdayHours, TECH_SUCCESS.today);
    expect(w.map((d) => d.text)).toEqual(['8-5:30', '8-5:30', '8-5:30', '8-5:30', '8-5:30', '8-12', null]);
    expect(w.filter((d) => d.today).map((d) => d.day)).toEqual([2]);
    expect(weekHours(row('Marcus Bell'), TECH_SUCCESS.saturdayHours, TECH_SUCCESS.today)[5]!.text).toBeNull();
  });

  // why: FR-DISP-33 the load bar's width is the day's jobs of its capacity, in the steps the sheet draws
  it('steps the load bar', () => {
    expect([loadStep(5, 5), loadStep(4, 5), loadStep(0, 5), loadStep(1, 1), loadStep(1, 3), loadStep(2, 3), loadStep(7, 5), loadStep(1, 0)]).toEqual([100, 80, 0, 100, 33, 67, 100, 0]);
  });

  // why: FR-DISP-33 a technician with more than 3 skills shows 2 and how many more
  it('shows up to 3 skills and then 2 and a count', () => {
    expect(skillTags(row('Marcus Bell'), en, SKILL_WORDS)).toEqual(['Plumbing', 'Drains', 'Water heaters']);
    expect(skillTags(MARIA, en, SKILL_WORDS)).toEqual(['Heating & cooling', 'Heat pumps', '+3']);
    expect(skillTags(MARIA, es, SKILL_WORDS)[0]).toBe('Calefacción y aire');
  });

  // why: FR-DISP-33 Right now is On the way, On site or Between jobs, with the timing word beside it when the job is so timed; none shows nothing
  it('picks the Right now chip', () => {
    expect(rightNowChip(MARIA)).toEqual({ cls: 'way', key: 'status.job.onTheWay', timing: null });
    expect(rightNowChip({ ...MARIA, rightNow: { status: 'on_site', timing: 'late', jobNumber: 1, customerName: 'A' } })).toEqual({ cls: 'site', key: 'status.job.onSite', timing: 'late' });
    expect(rightNowChip({ ...MARIA, rightNow: { status: 'between_jobs', timing: 'atRisk', jobNumber: null, customerName: null } })).toEqual({ cls: 'sched', key: 'technicians.betweenJobs', timing: 'risk' });
    expect(rightNowChip({ ...MARIA, rightNow: null })).toBeNull();
  });

  // why: FR-DISP-33 the Phone app cell shows the app with items waiting, else the one that synced last; no report shows none
  it('chooses the app report a row shows', () => {
    expect(shownApp(DOYLE)).toMatchObject({ kind: 'web', report: { waitingCount: 2 } });
    expect(shownApp(MARIA)).toMatchObject({ kind: 'native' });
    expect(shownApp(row('Chris Yoder'))).toBeNull();
    const both = { ...MARIA, apps: { web: { ...MARIA.apps.native!, lastSyncAt: '2026-09-15T09:00:00-04:00[America/New_York]' }, native: MARIA.apps.native } };
    expect(shownApp(both)!.kind).toBe('native');
  });

  // why: CTL-OFC-07-25 the subtitle counts the page's own list: all working today, or how many
  it('writes the subtitle for a full list, a list with some off, and an empty branch', () => {
    expect(subtitle(TECH_SUCCESS, 'Columbus', '10:28 AM', en)).toBe('Columbus - 12 technicians, all working today. Updated 10:28 AM.');
    const some = { ...TECH_SUCCESS, technicians: TECH_SUCCESS.technicians.map((r, i) => (i < 2 ? { ...r, workingToday: false } : r)) };
    expect(subtitle(some, 'Columbus', '10:28 AM', en)).toBe('Columbus - 12 technicians, 10 working today. Updated 10:28 AM.');
    expect(subtitle(TECH_EMPTY, 'Springfield', '10:28 AM', en)).toBe('Springfield - no technicians yet. Updated 10:28 AM.');
    expect(subtitle(TECH_SUCCESS, 'Columbus', '10:28 AM', es)).toContain('todos trabajan hoy');
  });

  // why: CTL-OFC-07-14 CTL-OFC-07-17 the filters narrow the loaded list by name, van or phone, skill, working today and phone app
  it('filters the list by name, van, phone, skill, working and phone app', () => {
    const names = (f: Partial<typeof NO_FILTERS>) => filterRows(TECH_SUCCESS.technicians, { ...NO_FILTERS, ...f }).map((r) => r.name);
    expect(names({ query: 'santos' })).toEqual(['Maria Santos']);
    expect(names({ query: 'van 27' })).toEqual(['Kevin Doyle']);
    expect(names({ query: '555-0112' })).toEqual(['Maria Santos']);
    expect(names({ skill: 'boilers' })).toEqual(['Tom Reinhart', 'Maria Santos']);
    expect(names({ working: 'off' })).toEqual([]);
    expect(names({ working: 'today' })).toHaveLength(12);
    expect(names({ app: 'waiting' })).toEqual(['Kevin Doyle']);
    expect(names({ app: 'clear' })).toHaveLength(11);
    expect(names({ query: 'nobody' })).toEqual([]);
  });

  // why: FR-TEXT-11 the check names the character and the plain letter to use, or says the name fits
  it('writes the name check message with the problem and the plain letter', () => {
    expect(plainLetter('ó')).toBe('o');
    expect(plainLetter('€')).toBeNull();
    expect(nameMessage({ ok: false, problem: 'not_gsm7_basic', characters: ['ó'], length: 5, maximum: 10 }, en)).toEqual({
      ok: false, text: 'ó is not in the standard text character set, so texts would take 2 messages. Use o.',
    });
    expect(nameMessage({ ok: false, problem: 'not_gsm7_basic', characters: ['€'], length: 3, maximum: 10 }, en).text).toBe('€ is not in the standard text character set, so texts would take 2 messages.');
    expect(nameMessage({ ok: false, problem: 'too_long', characters: [], length: 12, maximum: 10 }, en).text).toBe('A name in texts holds at most 10 characters. This one has 12.');
    expect(nameMessage({ ok: true, problem: 'none', characters: [], length: 5, maximum: 10 }, en)).toEqual({ ok: true, text: 'Fits in 1 text.' });
    expect(nameMessage({ ok: true, problem: 'none', characters: [], length: 5, maximum: 10 }, es).text).toBe('Cabe en 1 texto.');
  });

  // why: CTL-OFC-07-11 a time off span is 1 date, or 2 dates joined with to
  it('writes a time off span', () => {
    expect(spanText('2026-09-21', '2026-09-21', en)).toBe('Mon, Sep 21');
    expect(spanText('2026-10-01', '2026-10-02', en)).toBe('Thu, Oct 1 to Fri, Oct 2');
    expect(spanText('2026-10-01', '2026-10-02', es)).toContain(' a ');
  });
});

describe('the length of a time off span (F-768)', () => {
  // why: F-768 a span over 366 days said To is before From; the page counts the days the server counts (ends included) so it can say so itself
  it('counts the days of a span with both ends, and 366 is the most', () => {
    expect(spanDays('2026-09-21', '2026-09-21')).toBe(1);
    expect(spanDays('2026-10-05', '2027-10-05')).toBe(366);
    expect(spanDays('2026-10-05', '2027-10-06')).toBe(367);
    expect(spanDays('', '2026-09-21')).toBe(0);
    expect(MAX_TIME_OFF_DAYS).toBe(366);
  });
});

describe('the board link label (CTL-OFC-07-07)', () => {
  // why: F-772 (owner ruling 466b3215): the link read "Her day on the board" for every technician, men included
  it('reads Day on the board in both languages, with no gendered word', () => {
    expect(en('technicians.board')).toBe('Day on the board');
    expect(es('technicians.board')).toBe('Día en el tablero');
  });
});
