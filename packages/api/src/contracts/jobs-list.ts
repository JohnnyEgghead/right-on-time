// SPDX-License-Identifier: AGPL-3.0-or-later
// API-133 Jobs list and API-134 Jobs export (UI-SPECIFICATION 12.2; SPECIFICATIONS section 6.2 "Jobs list", SD-31; FR-DISP-24, FR-DISP-14,
// NFR-05): the Jobs page's one read (SCR-OFC-30) and its spreadsheet. The search text arrives in the request body only (a POST; never a URL or a log).
// Additive over the row's printed fields: `today` (the demo clock's local date, so the page groups Today and Upcoming without reading
// the device clock), `technicianId` (the filter's value beside the name), `billingTries` and `billedAt` (the Billing cell's words), `filters` (the selects' options), and `asOf` (the demo time of the read, the page's "Updated").
import { z } from 'zod';
import { defineContract } from '../contract.ts';
import { localDate } from './shapes.ts';

/** An RFC 9557 time: a timestamp string that carries its zone (UI-SPECIFICATION 12.1 item 5). */
const wireTime = z.string().min(1);

export const JOB_TABS = ['all', 'unassigned', 'at-risk', 'late', 'not-in-billing'] as const;
export const JOB_STATUSES = ['scheduled', 'on_the_way', 'on_site', 'done', 'no_one_home', 'canceled'] as const;
export type JobTab = (typeof JOB_TABS)[number];

const filters = {
  tab: z.enum(JOB_TABS).optional(),
  /** Job number, customer, street or phone, sent exactly as typed and trimmed (NFR-05). */
  query: z.string().trim().max(100).optional(),
  /** `upcoming` (Today and upcoming), `today`, or a picked day. */
  date: z.union([z.enum(['upcoming', 'today']), localDate]).optional(),
  branch: z.string().min(1).max(40),
  technicianId: z.uuid().optional(),
  status: z.enum(JOB_STATUSES).optional(),
  serviceId: z.string().min(1).max(60).optional(),
  /** `attention`: jobs needing attention first (UD-52), the default; `window`: by day and window only. */
  sort: z.enum(['attention', 'window']).optional(),
};

export const jobsList = defineContract({
  id: 'API-133',
  name: 'Jobs list',
  method: 'POST',
  path: '/job-searches',
  request: z.object({ ...filters, page: z.number().int().min(1).max(100_000).optional() }),
  response: z.object({
    branch: z.string(),
    /** The demo clock's local date in the branch zone. */
    today: localDate,
    /** The demo time of this read. */
    asOf: wireTime,
    /** The count of each tab for the current search and filters (the tab itself is not applied; Not in billing ignores the day). */
    counts: z.object({
      all: z.number().int(), unassigned: z.number().int(), atRisk: z.number().int(), late: z.number().int(), notInBilling: z.number().int(),
    }),
    rows: z.array(z.object({
      jobNumber: z.number().int(),
      customer: z.string(),
      /** The area the page shows: the neighborhood of a ZIP that has one (Clintonville), the customer's city otherwise. */
      area: z.string(),
      /** The service type's id; the page shows its catalog word. */
      service: z.string(),
      /** The job's own problem words (F-1652); the page shows them in the service cell when set, the catalog word otherwise. */
      problem: z.string().nullable(),
      /** The job's local date. */
      day: localDate,
      window: z.object({ start: wireTime, end: wireTime }),
      technicianId: z.uuid().nullable(),
      technician: z.string().nullable(),
      status: z.enum(JOB_STATUSES),
      /** SD-15 timing of an open job whose estimate is known (today's, with a technician); otherwise null. */
      timing: z.enum(['on_time', 'at_risk', 'late']).nullable(),
      eta: wireTime.nullable(),
      arrivedAt: wireTime.nullable(),
      endedAt: wireTime.nullable(),
      lateTextSentAt: wireTime.nullable(),
      dayMode: z.enum(['two_hour', 'four_hour']),
      bookedVia: z.enum(['online', 'office', 'seed']),
      /** The person who booked it (an office booking); otherwise null. */
      bookedBy: z.string().nullable(),
      billingState: z.enum(['not_sent', 'sending', 'retrying', 'waiting_person', 'in_billing', 'marked_fixed']),
      /** The billing item's tries (0 with no item). */
      billingTries: z.number().int(),
      /** When the job reached billing (in_billing or marked_fixed); otherwise null. */
      billedAt: wireTime.nullable(),
      /** Whether the job belongs in the Needs attention group: open and late, at risk, unassigned, or flagged while scheduled (UD-52). */
      needsAttention: z.boolean(),
    })),
    /** What the Technician and Service selects offer: each technician of the branch and each service type. */
    filters: z.object({ technicians: z.array(z.object({ id: z.uuid(), name: z.string() })), services: z.array(z.string()) }),
    /** The first and last day the Date filter covers (section 12.4). */
    range: z.object({ from: localDate, to: localDate }),
    /** Rows of the picked tab. */
    total: z.number().int(),
    pages: z.number().int().min(0),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { branch: 'columbus' }, expectStatus: 401 }],
});

export const jobsExport = defineContract({
  id: 'API-134',
  name: 'Jobs export',
  method: 'POST',
  path: '/job-searches/export',
  // As API-133 without page; lang is the page's language: the header row is written in it (SPECIFICATIONS section 7.5).
  request: z.object({ ...filters, lang: z.enum(['en', 'es']).optional() }),
  /** The CSV text: a header row, then every matching row with the on-screen columns. */
  response: z.string(),
  envelope: false,
  file: { contentType: 'text/csv', name: 'jobs.csv' },
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { branch: 'columbus' }, expectStatus: 401 }],
});

export const jobsListContracts = [jobsList, jobsExport];
