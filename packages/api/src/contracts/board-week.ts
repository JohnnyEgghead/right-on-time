// SPDX-License-Identifier: AGPL-3.0-or-later
// API-132 Board week (UI-SPECIFICATION 12.2; SPECIFICATIONS SD-27 and section 6.1 "Week board"; FR-DISP-23, FR-BOOK-18):
// SCR-OFC-34's one read. Monday to Saturday of the week for one branch: the days (mode, booked of capacity, peak, what the
// booking site still accepts, the Saturday half-day's span, and for a 4-hour day who switched it and why), the technicians'
// cells, the Unassigned counts and the unassigned jobs. Additive over the row's printed fields: `today` (the demo clock's
// local date, so the page marks Today and Done without reading the device clock), `technicians[].primarySkill` (the word
// the row shows beside the van), `days[].unassigned` (the day's Unassigned count, which the totals include) and
// `fourHourWindows` (the 4 windows the Peak days panel names).
import { z } from 'zod';
import { defineContract } from '../contract.ts';
import { isMonday, localDate, localTime } from './shapes.ts';

/** An RFC 9557 time (UI-SPECIFICATION 12.1 item 5). */
const wireTime = z.string().min(1);


export const boardWeek = defineContract({
  id: 'API-132',
  name: 'Board week',
  method: 'GET',
  path: '/board/week',
  request: z.object({ branch: z.string().min(1).max(40), week: localDate.refine(isMonday, 'week is a Monday') }),
  response: z.object({
    branch: z.string(),
    week: localDate,
    /** The demo clock's local date in the branch zone. */
    today: localDate,
    /** The branch's 4-hour windows, in start order: what a peak day offers (CTL-OFC-34-09). */
    fourHourWindows: z.array(z.object({ start: localTime, end: localTime })),
    days: z.array(z.object({
      date: localDate,
      mode: z.enum(['two_hour', 'four_hour']),
      /** The day's jobs booked, the Unassigned ones counted (CTL-OFC-34-18). */
      booked: z.number().int(),
      /** The working technicians' capacity that day (FR-BOOK-5). */
      capacity: z.number().int(),
      /** The day's mode is four_hour. */
      peak: z.boolean(),
      /** The further bookings the online channel accepts that day; 0 once the site no longer offers it (SD-27, FR-BOOK-9). */
      openOnline: z.number().int(),
      /** On a Saturday half-day, its first window's start and last window's end; otherwise null. */
      span: z.object({ start: localTime, end: localTime }).nullable(),
      /** The day's jobs with no technician. */
      unassigned: z.number().int(),
      /** For a 4-hour day: why, who switched it and when; otherwise null. */
      reason: z.string().nullable(),
      switchedBy: z.string().nullable(),
      switchedAt: wireTime.nullable(),
    })),
    technicians: z.array(z.object({
      id: z.uuid(),
      name: z.string(),
      van: z.string().nullable(),
      skills: z.array(z.string()),
      primarySkill: z.string(),
      installer: z.boolean(),
      /** One cell per day, in the order of `days`. */
      cells: z.array(z.object({
        date: localDate,
        booked: z.number().int(),
        capacity: z.number().int(),
        /** The technician's live install jobs that day (an installer's whole day, FR-BOOK-5). */
        installs: z.number().int(),
        state: z.enum(['has_room', 'full', 'day_off']),
      })),
    })),
    unassigned: z.array(z.object({ date: localDate, count: z.number().int() })),
    unassignedJobs: z.array(z.object({
      jobNumber: z.number().int(),
      /** The job's local date. */
      day: localDate,
      window: z.object({ start: wireTime, end: wireTime }),
      customer: z.string(),
      /** The customer's city. */
      area: z.string(),
      /** The service type's id; the page shows its catalog word. */
      service: z.string(),
    })),
  }),
  errors: [],
  labels: [],
  examples: [
    { name: 'signed out', input: { branch: 'columbus', week: '2026-09-14' }, expectStatus: 401 },
  ],
});

export const boardWeekContracts = [boardWeek];
