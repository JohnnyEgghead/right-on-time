// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { formatterFor } from '@bw/i18n/src/format.ts';
import { JOBS_SERVICE_WORDS, JOBS_SUCCESS } from './jobs-fixtures.ts';
import {
  chipOf, countOf, dateOptions, dayCell, dayText, detailText, groupText, initialsOf, pageButtons, sections, subtitle, tabOf, windowText, type JobRow,
} from './jobs-model.ts';

const en = formatterFor('en');
const es = formatterFor('es');
const row = (n: number): JobRow => JOBS_SUCCESS.rows.find((r) => r.jobNumber === n)!;

describe('the Jobs list model (SCR-OFC-30)', () => {
  // why: FR-DISP-24 the tab is the URL's ?tab=, and anything else is All
  it('reads the tab from the URL and the count of each tab from the answer', () => {
    expect(tabOf('late')).toBe('late');
    expect(tabOf('not-in-billing')).toBe('not-in-billing');
    expect(tabOf('nonsense')).toBe('all');
    expect(tabOf(null)).toBe('all');
    expect(['all', 'unassigned', 'at-risk', 'late', 'not-in-billing'].map((t) => countOf(JOBS_SUCCESS, t as 'all'))).toEqual([226, 3, 2, 1, 2]);
  });

  // why: CTL-OFC-30-18 the subtitle names the branch, the days the list covers and the time of the read, in both languages
  it('writes the page subtitle for each Date pick', () => {
    expect(subtitle(JOBS_SUCCESS, 'upcoming', 'Columbus', '10:28 AM', en)).toBe('Columbus - today and the next 4 days, Tue, Sep 15 to Sat, Sep 19. Updated 10:28 AM.');
    expect(subtitle({ ...JOBS_SUCCESS, range: { from: '2026-09-15', to: '2026-09-15' } }, 'today', 'Columbus', '10:28 AM', en)).toBe('Columbus - today, Tue, Sep 15. Updated 10:28 AM.');
    expect(subtitle({ ...JOBS_SUCCESS, range: { from: '2026-09-17', to: '2026-09-17' } }, '2026-09-17', 'Columbus', '10:28 AM', es)).toContain('jue');
    expect(dayText('2026-09-16', en)).toBe('Wed, Sep 16');
  });

  // why: FR-DISP-14 CTL-OFC-30-16 the status word is Late or At risk over the job's own status, Unassigned for an open job with no technician
  it('picks the status word of a row', () => {
    expect(chipOf(row(24805))).toBe('late');
    expect(chipOf(row(24797))).toBe('at_risk');
    expect(chipOf(row(24840))).toBe('unassigned');
    expect(chipOf(row(24830))).toBe('on_the_way');
    expect(chipOf(row(24791))).toBe('on_site');
    expect(chipOf(row(24800))).toBe('done');
    expect(chipOf({ ...row(24800), technicianId: null, technician: null })).toBe('done'); // a closed job is never Unassigned
  });

  // why: CTL-OFC-30-16 the status detail line gives each status its time and the 4-hour day its note, as the frame words them
  it('writes the status detail line of each status', () => {
    const d = (n: number) => detailText(row(n), en, 'en');
    expect(d(24805)).toBe('ETA 12:25 PM, late text sent');
    expect(d(24797)).toBe('ETA 11:50 AM');
    expect(d(24830)).toBe('ETA 10:40 AM');
    expect(d(24791)).toBe('Since 9:55 AM');
    expect(d(24800)).toBe('Done 9:50 AM');
    expect(d(24871)).toBe('4-hour window, peak day');
    expect(d(24866)).toBe('');
    expect(d(24840)).toBe('');
    expect(detailText(row(24805), es, 'es')).toContain('12:25');
  });

  // why: FR-DISP-24 the arrival window reads "10 AM-12 PM" and the day under it reads Today or the weekday and date
  it('writes the window and the day of a row', () => {
    expect(windowText(row(24805))).toBe('10 AM-12 PM');
    expect(windowText(row(24840))).toBe('12-2 PM');
    expect(windowText(row(24871))).toBe('8 AM-12 PM');
    expect(dayCell(row(24805), '2026-09-15', en)).toBe('Today');
    expect(dayCell(row(24871), '2026-09-15', en)).toBe('Wed, Sep 16');
    expect(initialsOf('Greg Hoffman')).toBe('GH');
  });

  // why: CTL-OFC-30-17 under the default sort the jobs needing attention are their own group first, then Today and Upcoming
  it('groups the frame\'s 12 rows into Needs attention, Today and Upcoming', () => {
    const s = sections(JOBS_SUCCESS.rows, '2026-09-15', 'attention');
    expect(s.showGroups).toBe(true);
    expect(s.sections.map((x) => [x.group, x.rows.length])).toEqual([['attention', 6], ['today', 4], ['upcoming', 2]]);
    expect(groupText('today', '2026-09-15', en)).toBe('Today, Tue, Sep 15');
    expect(groupText('attention', '2026-09-15', en)).toBe('Needs attention');
  });

  // why: CTL-OFC-30-17 under Arrival window there is no Needs attention group, and a group row shows only when 2 or more groups are shown
  it('has no Needs attention group under Arrival window, and no group row when the rows fall in 1 group', () => {
    const w = sections([...JOBS_SUCCESS.rows].sort((a, b) => (a.day + a.window.start < b.day + b.window.start ? -1 : 1)), '2026-09-15', 'window');
    expect(w.sections.map((x) => x.group)).toEqual(['today', 'upcoming']);
    const one = sections(JOBS_SUCCESS.rows.slice(0, 6), '2026-09-15', 'attention');
    expect(one.showGroups).toBe(false);
    expect(sections(JOBS_SUCCESS.rows.slice(6, 10), '2026-09-15', 'attention').showGroups).toBe(false);
  });

  // why: CTL-OFC-30-12 the page buttons show the first 3 pages, the last and the neighbors of the current page, with gaps between
  it('draws the page buttons with gaps', () => {
    expect(pageButtons(1, 19)).toEqual([1, 2, 3, 'gap', 19]);
    expect(pageButtons(10, 19)).toEqual([1, 2, 3, 'gap', 9, 10, 11, 'gap', 19]);
    expect(pageButtons(19, 19)).toEqual([1, 2, 3, 'gap', 18, 19]);
    expect(pageButtons(2, 3)).toEqual([1, 2, 3]);
    expect(pageButtons(1, 1)).toEqual([1]);
  });

  // why: CTL-OFC-30-03 the Date select offers a week back and 2 weeks ahead of demo today, and keeps a picked day outside that
  it('lists the days the Date select offers', () => {
    const days = dateOptions('2026-09-15', 'upcoming');
    expect(days[0]).toBe('2026-09-08');
    expect(days.at(-1)).toBe('2026-09-29');
    expect(days).toHaveLength(22);
    expect(dateOptions('2026-09-15', '2026-12-01')).toContain('2026-12-01');
  });

  // why: FR-DISP-24 the fixture's service words are the frame's own words, kept apart from the catalog's
  it('keeps the frame\'s service words for the preview only', () => {
    expect(JOBS_SERVICE_WORDS.en.water_softener_service).toBe('Water softener service');
    expect(Object.keys(JOBS_SERVICE_WORDS.es)).toEqual(Object.keys(JOBS_SERVICE_WORDS.en));
  });
});
