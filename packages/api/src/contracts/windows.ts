// SPDX-License-Identifier: AGPL-3.0-or-later
// P4-ADMIN-WINDOWS: the arrival windows page's rows (SCR-OFC-12, SCR-OFC-24; FR-BOOK-2, FR-BOOK-8, FR-BOOK-17, FR-BOOK-18, UC-13):
// API-90 reads the branch's booking settings, API-91 switches a day's windows, API-155 sets the per-window capacities. Times are
// branch-local clock values ("HH:MM", "YYYY-MM-DD"); a wire time (RFC 9557) only where a moment is meant (when a day was switched).
import { z } from 'zod';
import { defineContract, type ContractRow } from '../contract.ts';
import { localDate, localTime } from './shapes.ts';
import { ruleRefusedDetail } from './dispatch.ts';

const wireTime = z.string().min(1);
const count = z.number().int().min(0);
const branchParam = z.string().min(1).max(40);

/** The days API-90 answers at most: the page asks for 2 weeks, the horizon (SD-27, GAP-9) is 60 days. */
export const SETTINGS_DAYS_MAX = 70;
/** The reason of a 4-hour switch (FR-BOOK-18): typed text, at most this long. */
export const DAY_REASON_MAX = 120;
/** A per-window limit (FR-BOOK-17): a whole number from 0 to this. */
export const WINDOW_LIMIT_MAX = 999;

const windowSpan = z.object({ start: localTime, end: localTime });

/** The day as the calendar and the picked-day panel show it. `closed` is a Sunday, or a Saturday no technician works. */
export const settingsDay = z.object({
  date: localDate,
  mode: z.enum(['two_hour', 'four_hour', 'closed']),
  /** The day's live jobs (the Unassigned ones too): the customers already booked (CTL-OFC-24-01). */
  booked: count,
  /** The working technicians' capacity that day (FR-BOOK-5); 0 on a closed day. */
  capacity: count,
  /** The distinct customers with a live job that day (CTL-OFC-24-01, "The 14 customers already booked"). */
  bookedCount: count,
  /** The windows the day offers, in start order: only 8-10 AM and 10 AM-12 PM on a Saturday half-day. */
  windows: z.array(windowSpan),
  /** For a 4-hour day: why, who switched it and when; otherwise null. */
  reason: z.string().nullable(),
  switchedBy: z.string().nullable(),
  switchedAt: wireTime.nullable(),
});

export const bookingSettings = defineContract({
  id: 'API-90',
  name: 'Booking settings',
  method: 'GET',
  path: '/branches/{branchId}/booking-settings',
  /** `from` and `to` together name the days wanted; with neither, the 2 weeks the calendar draws (the week holding today and the next). */
  request: z.object({ branchId: branchParam, from: localDate.optional(), to: localDate.optional() }),
  response: z.object({
    branch: z.string(),
    /** The demo clock's local date in the branch zone. */
    today: localDate,
    /** The 2-hour windows with their limits (CTL-OFC-12-01). */
    windows: z.array(z.object({
      windowId: z.uuid(),
      start: localTime,
      end: localTime,
      /** The technicians who work today (no time off), the pool every window draws on. */
      technicians: count,
      limit: count,
      /** Live jobs in this window today. */
      bookedToday: count,
    })),
    /** The fixed rules the page states in words (CTL-OFC-12-02), from the constants the writes use. */
    rules: z.object({
      onlineCutoff: localTime,
      reminder: localTime,
      quietFrom: localTime,
      quietTo: localTime,
      capacities: z.object({ twoHour: count, fourHour: count, saturday: count }),
    }),
    /** The 4 windows a 4-hour day offers, and the 5 a 2-hour day offers (the dialog's message names them). */
    twoHourWindows: z.array(windowSpan),
    fourHourWindows: z.array(windowSpan),
    days: z.array(settingsDay),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { branchId: 'columbus', from: '2026-09-14', to: '2026-09-27' }, expectStatus: 401 }],
});

export const setDayMode = defineContract({
  id: 'API-91',
  name: "Set a day's mode",
  method: 'PUT',
  path: '/branches/{branchId}/days/{date}/mode',
  request: z.object({
    branchId: branchParam,
    date: localDate,
    mode: z.enum(['two_hour', 'four_hour']),
    /** Required for four_hour (FR-BOOK-18); ignored for two_hour. */
    reason: z.string().trim().min(1).max(DAY_REASON_MAX).optional(),
  }),
  response: z.object({ day: settingsDay }),
  errors: ['day_closed', 'day_past', 'rule_refused'],
  errorDetails: { rule_refused: ruleRefusedDetail },
  labels: [],
  examples: [{ name: 'signed out', input: { branchId: 'columbus', date: '2026-09-17', mode: 'four_hour', reason: 'Heat advisory' }, expectStatus: 401 }],
});

/** capacity_below_bookings' members (API-155): the window, the upcoming day with the most bookings in it, and that count. */
export const capacityBelowDetail = z.object({ windowId: z.uuid(), start: localTime, end: localTime, date: localDate, bookings: count });

export const setWindowLimits = defineContract({
  id: 'API-155',
  name: 'Set window capacities',
  method: 'PUT',
  path: '/branches/{branchId}/window-limits',
  request: z.object({
    branchId: branchParam,
    limits: z.array(z.object({ windowId: z.uuid(), limit: z.number().int().min(0).max(WINDOW_LIMIT_MAX) })).min(1).max(20),
  }),
  response: z.object({ windows: z.array(z.object({ windowId: z.uuid(), start: localTime, end: localTime, limit: count })) }),
  errors: ['capacity_below_bookings'],
  errorDetails: { capacity_below_bookings: capacityBelowDetail },
  labels: [],
  examples: [{ name: 'signed out', input: { branchId: 'columbus', limits: [{ windowId: '00000000-0000-7000-8000-000000000000', limit: 9 }] }, expectStatus: 401 }],
});

export const windowsContracts: ContractRow[] = [bookingSettings, setDayMode, setWindowLimits];
