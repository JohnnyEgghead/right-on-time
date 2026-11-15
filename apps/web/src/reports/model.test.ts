// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { formatterFor } from '@bw/i18n/src/format.ts';
import { REPORTS_EMPTY, REPORTS_SUCCESS } from './preview-data.ts';
import {
  barAxis, dayText, decimal, filtersOf, initialsOf, linePath, meterClass, pct, periodSpan, queryOf, rangeText, rateAxis, requestOf, spanText, spreadLabels,
  weekEnd, weeksInverted, fallbackWeeks, NO_FILTERS, isEmptyReport,
} from './model.ts';

const en = formatterFor('en');
const es = formatterFor('es');

describe('the filters of the Reports page (the address)', () => {
  // why: FR-REP-5 the branch, technician and week range are kept in the page's address and read back from it
  it('keeps only what differs from the defaults and reads it back', () => {
    expect(queryOf(NO_FILTERS)).toBe('');
    const f = { branch: 'columbus', technician: 'a1', from: '2026-07-06', to: '2026-08-24' };
    expect(queryOf(f)).toBe('?branch=columbus&technician=a1&from=2026-07-06&to=2026-08-24');
    expect(filtersOf(new URLSearchParams(queryOf(f)))).toEqual(f);
    // a malformed week is dropped, not sent
    expect(filtersOf(new URLSearchParams('from=soon&to=2026-08-24'))).toEqual({ ...NO_FILTERS, to: '2026-08-24' });
  });

  // why: FR-REP-5 API-50 takes the branch, the technician (for a single branch only) and the weeks; All sends none of them
  it('builds API-50 requests: no technician without a branch, no filter for All', () => {
    expect(requestOf(NO_FILTERS)).toEqual({});
    expect(requestOf({ branch: 'all', technician: 'a1', from: '', to: '' })).toEqual({});
    expect(requestOf({ branch: 'dayton', technician: 'a1', from: '2026-07-06', to: '2026-07-13' })).toEqual({ branch: 'dayton', technicianId: 'a1', fromWeek: '2026-07-06', toWeek: '2026-07-13' });
  });

  // why: FR-REP-5 a last week before the first week is held on the page, not sent
  it('finds a week range that ends before it starts', () => {
    expect(weeksInverted('2026-07-13', '2026-07-06')).toBe(true);
    expect(weeksInverted('2026-07-06', '2026-07-06')).toBe(false);
    expect(weeksInverted('', '2026-07-06')).toBe(false);
  });
});

describe('the words of the Reports page', () => {
  // why: FR-REP-5 the table heading names the week range from the first week's Monday to the last week's Sunday, in both languages
  it('words a week, a range and a span ("Jul 6 to Aug 30")', () => {
    expect(weekEnd('2026-08-24')).toBe('2026-08-30');
    expect(dayText('2026-07-06', en)).toBe('Jul 6');
    expect(spanText('2026-07-06', '2026-08-24', en)).toBe('Jul 6 to Aug 30');
    expect(spanText('2026-07-06', '2026-08-24', es)).toBe('6 de jul a 30 de ago');
    expect(rangeText('2026-07-06', '2026-07-27', en)).toBe('Jul 6 to Jul 27');
  });

  // why: FR-REP-1 a rate is written with up to 1 decimal as the answer holds it, 96.0 as 96, and a week with no visits as n/a
  it('writes a percent in the page language, without a trailing .0', () => {
    expect(pct(89.6, 'en', en)).toBe('89.6%');
    expect(pct(96, 'en', en)).toBe('96%');
    expect(pct(5, 'en', en)).toBe('5%');
    expect(pct(89.6, 'es', es)).toBe('89,6%');
    expect(pct(null, 'en', en)).toBe('n/a');
    expect(pct(null, 'es', es)).toBe('n/d');
    expect(decimal(12.5, 'en')).toBe('12.5');
  });

  // why: FR-REP-7 the table's avatar is the first letters of the first and last name
  it('takes 2 letters of a name', () => {
    expect(initialsOf('Maria Santos')).toBe('MS');
    expect(initialsOf('Old Tech')).toBe('OT');
    expect(initialsOf('Cher')).toBe('C');
  });

  // why: FR-REP-7 the by-technician bar is drawn by a class of its whole percent (the page CSP allows no style attribute)
  it('names the meter class by whole percent', () => {
    expect(meterClass(96)).toBe('bw-mw-96');
    expect(meterClass(91.7)).toBe('bw-mw-92');
    expect(meterClass(null)).toBe('bw-mw-0');
    expect(meterClass(140)).toBe('bw-mw-100');
  });
});

describe('the chart geometry of the Reports page', () => {
  // why: FR-REP-6 the line chart's axis is the frame's 75 to 95 for the frame's data, wider for a rate outside it, and always holds the 90% goal
  it('picks the rate axis', () => {
    const frame = REPORTS_SUCCESS.onTime.flatMap((l) => l.points.map((p) => p.rate));
    expect(rateAxis(frame)).toEqual({ lo: 75, hi: 95, ticks: [75, 80, 85, 90, 95] });
    expect(rateAxis([68.2, 100])).toEqual({ lo: 65, hi: 100, ticks: [65, 70, 75, 80, 85, 90, 95, 100] });
    expect(rateAxis([null])).toEqual({ lo: 75, hi: 95, ticks: [75, 80, 85, 90, 95] });
  });

  // why: FR-REP-2 the bar charts' axis has 4 equal round steps that hold the largest value and the 3% goal
  it('picks the bar axis (1,347 calls and 6.4% give 1,600 by 400 and 8 by 2)', () => {
    expect(barAxis(1347)).toEqual({ top: 1600, ticks: [0, 400, 800, 1200, 1600] });
    expect(barAxis(6.4)).toEqual({ top: 8, ticks: [0, 2, 4, 6, 8] });
    expect(barAxis(0)).toEqual({ top: 0.004, ticks: [0, 0.001, 0.002, 0.003, 0.004] });
    expect(barAxis(3).top).toBe(4);
  });

  // why: FR-REP-1 a week with no visits leaves a gap in the line, not a point at 0
  it('breaks a line at a week with no rate', () => {
    expect(linePath([{ x: 0, y: 10 }, { x: 10, y: null }, { x: 20, y: 30 }, { x: 30, y: 40 }])).toBe('M0.0 10.0 M20.0 30.0 L30.0 40.0');
    expect(linePath([{ x: 0, y: null }])).toBe('');
  });

  // why: FR-REP-1 the line-end labels (branch and last value) are nudged to at least 15 px apart
  it('spreads line-end labels apart', () => {
    expect(spreadLabels([{ key: 'a', y: 100 }, { key: 'b', y: 104 }, { key: 'c', y: 140 }])).toEqual([{ key: 'a', y: 100 }, { key: 'b', y: 115 }, { key: 'c', y: 140 }]);
  });

  // why: FR-REP-1 the before and after periods are marked only where the range holds their weeks
  it('finds the weeks of a period inside the range', () => {
    const weeks = ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27'];
    expect(periodSpan(weeks, { from: '2026-06-01', to: '2026-07-13' })).toEqual({ first: 0, last: 1 });
    expect(periodSpan(weeks, { from: '2026-07-20', to: '2026-09-14' })).toEqual({ first: 2, last: 3 });
    expect(periodSpan(weeks, { from: '2026-08-03', to: '2026-08-24' })).toBeNull();
  });
});

describe('the weeks the selects offer while the page holds no answer (F-741)', () => {
  // why: F-741 CTL-OFC-11-11 is enabled always: an address with a bad week must still have selects to repair it with, on Loading and Error
  it('offers Mondays from the first pilot week, to the address\'s last real Monday or 11 weeks on', () => {
    expect(fallbackWeeks(NO_FILTERS)).toHaveLength(12);
    expect(fallbackWeeks(NO_FILTERS)[0]).toBe('2026-06-01');
    expect(fallbackWeeks({ ...NO_FILTERS, from: '2026-02-30', to: '2026-07-06' }).at(-1)).toBe('2026-07-06');
    expect(fallbackWeeks({ ...NO_FILTERS, from: '2026-07-07' })).toHaveLength(12);
    expect(fallbackWeeks({ ...NO_FILTERS, to: '9999-12-27' })).toHaveLength(260);
  });
});

describe('the Empty state of the Reports page', () => {
  // why: SCR-OFC-11 Empty, F-1133 Empty is no row in the report view; a live finished visit is a row, so its figures show
  it('is empty with no view row, and not when only live finished visits stand in the denominator', () => {
    expect(isEmptyReport(REPORTS_EMPTY)).toBe(true);
    expect(isEmptyReport(REPORTS_SUCCESS)).toBe(false);
    const liveOnly = { ...REPORTS_EMPTY, noOneHome: REPORTS_EMPTY.noOneHome.map((p, i) => (i === 0 ? { ...p, visits: 3 } : p)) };
    expect(liveOnly.totals.visits).toBe(0);
    expect(isEmptyReport(liveOnly)).toBe(false);
  });
});
