// SPDX-License-Identifier: AGPL-3.0-or-later
// API-50 Reports and API-51 Reports export (UI-SPECIFICATION 12.2; SPECIFICATIONS section 6.5 "REP", SD-25, SD-31; FR-REP-1 to FR-REP-8):
// The Reports page's one read (SCR-OFC-11) and its spreadsheet. Both read only the `report_visit` view (SD-25) for visits, plus `pilot_call` for the calls
// and `outbox_text` for the late texts (FR-REP-2, FR-REP-8). Every rate is a percent with 1 decimal, made from whole counts the answer also
// carries, so a person can check it; a week with no visits has a null rate. The goals are the contract's (FR-REP-6).
import { z } from 'zod';
import { defineContract } from '../contract.ts';
import { isMonday, localDate } from './shapes.ts';

const monday = localDate.refine(isMonday, 'a week is named by its Monday');
const count = z.number().int().min(0);
/** A percent with 1 decimal (92.5), or null with no visits behind it. */
const percent = z.number().nullable();

/** SD-25: the before period is the weeks starting Jun 1 to Jul 13, 2026; the after period the weeks starting Jul 20 to Sep 14, 2026. */
export const PILOT_FIRST_WEEK = '2026-06-01';
/** FR-REP-5: the default toWeek, the last whole pilot week (the week of Sep 14 holds only its first day, F-1157). */
export const PILOT_LAST_WHOLE_WEEK = '2026-09-07';
export const BEFORE_PERIOD = { from: '2026-06-01', to: '2026-07-13' } as const;
export const AFTER_PERIOD = { from: '2026-07-20', to: '2026-09-14' } as const;
/** The report goals, in percent: on time 90, no one home 3 (FR-REP-6). */
export const GOAL_ON_TIME = 90;
export const GOAL_NO_ONE_HOME = 3;

const filters = {
  /** A branch id, or `all` (the default). */
  branch: z.string().min(1).max(40).optional(),
  technicianId: z.uuid().optional(),
  /** The first and last week of the range, Mondays (FR-REP-5); the default is the first pilot week to the demo clock's week. */
  fromWeek: monday.optional(),
  toWeek: monday.optional(),
};

const rate = z.object({ rate: percent, count, visits: count });
const period = z.object({ before: z.number().nullable(), after: z.number().nullable() });

export const reports = defineContract({
  id: 'API-50',
  name: 'Reports',
  method: 'GET',
  path: '/reports',
  request: z.object(filters),
  response: z.object({
    /** FR-REP-4: the label's key; the page and the export say it in the page's language. */
    labelKey: z.literal('simulated_pilot_data'),
    branch: z.string(),
    technicianId: z.string().nullable(),
    fromWeek: localDate,
    toWeek: localDate,
    /** The Mondays of the range, in order: every series below has one point per week, in this order. */
    weeks: z.array(localDate),
    /** What the selects offer: every week from the first pilot week to the demo clock's week, the branches, and the branch's technicians (none for All). */
    choices: z.object({
      weeks: z.array(localDate),
      branches: z.array(z.string()),
      technicians: z.array(z.object({ id: z.uuid(), name: z.string() })),
    }),
    periods: z.object({
      before: z.object({ from: localDate, to: localDate }),
      after: z.object({ from: localDate, to: localDate }),
    }),
    /** FR-REP-6: the goals with their label keys. */
    goals: z.object({
      onTime: z.object({ rate: z.number(), labelKey: z.literal('reports.goal.onTime') }),
      noOneHome: z.object({ rate: z.number(), labelKey: z.literal('reports.goal.noOneHome') }),
    }),
    /** Visits with an arrival in the range, and the visits the table lists: 0 is the Empty state. */
    totals: z.object({ visits: count }),
    /** FR-REP-1: the on-time rate per week, one line per branch shown. */
    onTime: z.array(z.object({
      branch: z.string(),
      points: z.array(z.object({ week: localDate, rate: percent, onTime: count, visits: count })),
    })),
    /** FR-REP-2, FR-REP-8: calls per week and the per-day figure (the week's calls over its working days with a visit; null with none). */
    calls: z.array(z.object({ week: localDate, calls: count, perDay: z.number().int().nullable() })),
    /** FR-REP-2: no-one-home visits per week, live No one home visits included (FR-TECH-9); `visits` is the population of the no-one-home goal (SC-02), so live finished visits too. */
    noOneHome: z.array(z.object({ week: localDate, rate: percent, count, visits: count })),
    /** FR-REP-8: late texts delivered per week. */
    lateTexts: z.array(z.object({ week: localDate, count })),
    /** The cards (CTL-OFC-11-05, -12, -17): the range's last week, and each figure over the before and the after period within the range. */
    headline: z.object({
      week: localDate,
      onTime: z.object({ rate: percent, ...period.shape }),
      calls: z.object({ count, perDay: z.number().int().nullable(), ...period.shape }),
      noOneHome: z.object({ ...rate.shape, ...period.shape }),
      lateTexts: count,
    }),
    /** FR-REP-7: per technician, highest on-time rate first. */
    technicians: z.array(z.object({
      technicianId: z.uuid().nullable(),
      name: z.string(),
      visits: count,
      onTimeRate: percent,
      averageMinutesLate: z.number().nullable(),
      noOneHome: count,
      calls: count,
    })),
  }),
  errors: ['validation_failed'],
  labels: ['simulated_pilot_data'],
  examples: [{ name: 'signed out', expectStatus: 401 }],
});

export const reportsExport = defineContract({
  id: 'API-51',
  name: 'Reports export',
  method: 'GET',
  path: '/reports/export',
  // As API-50; language is the page's language: the header row and the Data source cell are written in it (SD-31, GAP-14).
  request: z.object({ ...filters, language: z.enum(['en', 'es']).optional() }),
  /** The CSV text: a header row, then one row per visit of the range, from the same query as the page. */
  response: z.string(),
  envelope: false,
  file: { contentType: 'text/csv', name: 'reports.csv' },
  errors: ['validation_failed'],
  labels: [],
  examples: [{ name: 'signed out', expectStatus: 401 }],
});

export const reportContracts = [reports, reportsExport];
