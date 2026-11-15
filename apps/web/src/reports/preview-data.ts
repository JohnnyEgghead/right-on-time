// SPDX-License-Identifier: AGPL-3.0-or-later
// The sample data of the Reports frame (mockups/pages/office-reports.html, "TEST DATA ONLY"), for the harness build's preview routes and the look
// comparator. Never read by a release route. The frame draws the before period as Jul 6 to Jul 27 and the after period as Aug 3 to Aug 24; the
// live page's periods are SD-25's (before Jun 1 to Jul 13, after Jul 20 to Sep 14), so the preview carries the frame's own.
import type { Report } from './model.ts';

const WEEKS = ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24'];
const ON_TIME = {
  columbus: [78.1, 77.6, 79.0, 78.4, 88.6, 89.9, 90.4, 89.9],
  dayton: [76.8, 77.9, 78.3, 77.5, 86.9, 87.8, 88.6, 88.0],
  springfield: [79.4, 78.8, 80.1, 79.6, 89.8, 90.6, 91.2, 90.6],
} as const;
const CALLS = [1312, 1288, 1347, 1275, 1301, 1259, 1322, 1264];
const NO_HOME = [6.1, 5.8, 6.4, 5.9, 6.2, 5.7, 6.0, 5.8];
/** Visits behind each week's no-one-home rate: the last week is the frame's "111 of 1,912". */
const VISITS = [1900, 1905, 1898, 1910, 1915, 1920, 1908, 1912];

const TECHS: [string, number, number, number, number, number][] = [
  ['Maria Santos', 24, 96, 4, 0, 3],
  ['Tom Reinhart', 21, 95, 5, 1, 4],
  ['Luis Ortega', 23, 91, 9, 1, 6],
  ['Ashley Nguyen', 20, 90, 11, 2, 7],
  ['Jamal Carter', 22, 86, 14, 2, 9],
  ['Greg Hoffman', 19, 84, 18, 1, 11],
];

export const REPORTS_SUCCESS: Report = {
  labelKey: 'simulated_pilot_data',
  branch: 'all',
  technicianId: null,
  fromWeek: '2026-07-06',
  toWeek: '2026-08-24',
  weeks: WEEKS,
  choices: { weeks: ['2026-06-01', ...WEEKS, '2026-08-31', '2026-09-07', '2026-09-14'], branches: ['columbus', 'dayton', 'springfield'], technicians: [] },
  periods: { before: { from: '2026-07-06', to: '2026-07-27' }, after: { from: '2026-08-03', to: '2026-08-24' } },
  goals: { onTime: { rate: 90, labelKey: 'reports.goal.onTime' }, noOneHome: { rate: 3, labelKey: 'reports.goal.noOneHome' } },
  totals: { visits: 15348 },
  onTime: (['columbus', 'dayton', 'springfield'] as const).map((branch) => ({
    branch,
    points: WEEKS.map((week, i) => ({ week, rate: ON_TIME[branch][i]!, onTime: 0, visits: 0 })),
  })),
  calls: WEEKS.map((week, i) => ({ week, calls: CALLS[i]!, perDay: Math.round(CALLS[i]! / 5) })),
  noOneHome: WEEKS.map((week, i) => ({ week, rate: NO_HOME[i]!, count: Math.round((NO_HOME[i]! * VISITS[i]!) / 100), visits: VISITS[i]! })),
  lateTexts: WEEKS.map((week, i) => ({ week, count: i === 7 ? 74 : 60 + i })),
  headline: {
    week: '2026-08-24',
    onTime: { rate: 89.6, before: 78.4, after: 89.6 },
    calls: { count: 1264, perDay: 253, before: 1610, after: 1264 },
    noOneHome: { rate: 5.8, count: 111, visits: 1912, before: 7.9, after: 5.8 },
    lateTexts: 74,
  },
  technicians: TECHS.map(([name, visits, rate, late, noh, calls]) => ({
    technicianId: null, name, visits, onTimeRate: rate, averageMinutesLate: late, noOneHome: noh, calls,
  })),
};

/** Springfield with one technician and no visits: the frame's Empty state. */
export const REPORTS_EMPTY: Report = {
  ...REPORTS_SUCCESS,
  branch: 'springfield',
  technicianId: '00000000-0000-4000-8000-000000000001',
  totals: { visits: 0 },
  // No row of the report view at all (F-1133): every week's denominator is 0.
  noOneHome: REPORTS_SUCCESS.noOneHome.map((p) => ({ ...p, rate: null, count: 0, visits: 0 })),
  technicians: [],
  choices: { ...REPORTS_SUCCESS.choices, technicians: [{ id: '00000000-0000-4000-8000-000000000001', name: 'Chris Yoder' }] },
};

export const REPORTS_STATES = ['success', 'loading', 'empty', 'exporting', 'error', 'tip', 'tables'] as const;
