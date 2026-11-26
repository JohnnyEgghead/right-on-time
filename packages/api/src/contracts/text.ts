// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the text area. The lane that builds the area adds its API-<nn> rows here (defineContract from ../contract.ts)
// and its examples; its handler and policy entry are in packages/api-server.
//
// P4-MESSAGES: the office Messages page. API-40 Text log and API-41 Text detail feed SCR-OFC-08; API-144 Try now, API-145 Add to call
// list and API-146 Text log export are its writes and export; API-42 Call list feeds SCR-OFC-09 and API-38 Record a call outcome is its
// write (UI-SPECIFICATION 12.2; SPECIFICATIONS section 6.4 FR-TEXT-12, FR-TEXT-13, FR-TEXT-15, FR-TEXT-24, FR-TEXT-25).
import { z } from 'zod';
import { defineContract } from '../contract.ts';
import type { ContractRow } from '../contract.ts';
import { localDate } from './shapes.ts';

const wireTime = z.string().min(1);
const count = z.number().int().nonnegative();
const branchParam = z.string().min(1).max(40);
const dateParam = localDate;
const uuid = z.string().uuid();
const language = z.enum(['en', 'es']);

/** CTL-OFC-08-04: the Type select. `replies` is the customer replies; `office` the office's free texts. */
export const TEXT_LOG_TYPES = ['confirmation', 'reminder', 'on_the_way', 'late', 'r_reply', 'office', 'replies'] as const;
/** CTL-OFC-08-05: the Status select: each text status and each reply handling. `queued` is the Sent word (waiting for delivery). */
export const TEXT_LOG_STATUSES = ['queued', 'held', 'delivered', 'retrying', 'gave_up', 'canceled', 'confirmed', 'reschedule_sent', 'not_understood'] as const;
export const REPLY_HANDLINGS = ['confirmed', 'reschedule_sent', 'not_understood'] as const;
export const SIMULATOR_MODE_NAMES = ['up', 'all_fail', 'fail_customer', 'fail_next_n'] as const;
export const CALL_OUTCOMES = ['confirmed', 'no_answer', 'reschedule'] as const;
export const CALL_REASONS = ['no_mobile', 'texts_off'] as const;
export const FAILED_TEXT_REASONS = ['text_gave_up', 'added_by_office'] as const;

/** Where a text or a reply sits: the customer's area, the visit's technician and day and window (CTL-OFC-08-24). */
const placeShape = z.object({
  area: z.string(),
  technician: z.string().nullable(),
  visitDay: dateParam.nullable(),
  window: z.object({ start: wireTime, end: wireTime }).nullable(),
  bookedAt: wireTime.nullable(),
});

const textRow = z.object({
  id: uuid,
  at: wireTime,
  customerId: uuid,
  customer: z.string(),
  type: z.enum(['confirmation', 'reminder', 'on_the_way', 'late', 'r_reply', 'office']),
  language,
  body: z.string(),
  status: z.enum(['queued', 'held', 'sending', 'delivered', 'retrying', 'gave_up', 'canceled']),
  reasonKey: z.string().nullable(),
  /** The release time of a held text, in the customer's zone, with that zone's name. */
  heldUntil: wireTime.nullable(),
  tries: count,
  nextTryAt: wireTime.nullable(),
  jobNumber: z.number().int().nullable(),
  context: placeShape,
});

const replyRow = z.object({
  id: uuid,
  at: wireTime,
  customerId: uuid,
  customer: z.string(),
  language,
  body: z.string(),
  handling: z.enum(REPLY_HANDLINGS),
  jobNumber: z.number().int().nullable(),
  context: placeShape,
});

const nextReminders = z.object({
  visitDay: dateParam,
  /** The branch's live visits on that day. */
  visits: count,
  /** Of them, the reminder texts (a mobile and texts on). */
  reminderTexts: count,
  /** 6:00 PM the day before, in the branch zone (each customer's own 6:00 PM is in their zone, FR-TEXT-2). */
  at: wireTime,
  /** The rest: the call list. */
  callListCount: count,
});

const textFilters = z.object({
  date: dateParam,
  branch: branchParam,
  type: z.enum(TEXT_LOG_TYPES).optional(),
  status: z.enum(TEXT_LOG_STATUSES).optional(),
  language: language.optional(),
  customerId: uuid.optional(),
  /** The customer name typed in the text log's Customer filter (CTL-OFC-08-07), matched on the folded customer name. */
  customer: z.string().max(80).optional(),
});

export const textLog = defineContract({
  id: 'API-40',
  name: 'Text log',
  method: 'POST',
  path: '/text-searches',
  request: textFilters.extend({
    /** `o:<epoch ms>:<id>` for the older page, `n:<epoch ms>:<id>` for the newer; absent for the newest page. */
    cursor: z.string().min(1).max(80).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  response: z.object({
    asOf: wireTime,
    texts: z.array(textRow),
    replies: z.array(replyRow),
    counts: z.object({
      texts: count, delivered: count, held: count, failedRetrying: count, notSent: count, replies: count,
      confirmations: count, confirmationsOnTime: count, repliesConfirmed: count, repliesReschedule: count, gaveUp: count,
    }),
    nextReminders,
    simulatorMode: z.enum(SIMULATOR_MODE_NAMES),
    /** How many rows match the day and the filters (the footer's "11 of 130 today"). */
    total: count,
    cursors: z.object({ newer: z.string().nullable(), older: z.string().nullable() }),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { date: '2026-09-15', branch: 'columbus' }, expectStatus: 401 }],
});

export const textDetail = defineContract({
  id: 'API-41',
  name: 'Text detail',
  method: 'GET',
  path: '/texts/{textId}',
  request: z.object({ textId: uuid }),
  response: z.object({
    id: uuid,
    type: z.enum(['confirmation', 'reminder', 'on_the_way', 'late', 'r_reply', 'office']),
    customerId: uuid,
    customer: z.string(),
    language,
    encoding: z.enum(['gsm7', 'ucs2']),
    body: z.string(),
    status: z.enum(['queued', 'held', 'sending', 'delivered', 'retrying', 'gave_up', 'canceled']),
    reasonKey: z.string().nullable(),
    heldUntil: wireTime.nullable(),
    attempts: z.array(z.object({ number: z.number().int(), at: wireTime, result: z.enum(['delivered', 'failed']), reasonKey: z.string().nullable() })),
    sentBy: z.string().nullable(),
    canTryNow: z.boolean(),
    nextTryAt: wireTime.nullable(),
    /** The tries after the next, each moved to 8:00 AM the customer's time when quiet hours fall on it (SPECIFICATIONS 12.4). */
    plannedTries: z.array(z.object({ number: z.number().int(), at: wireTime })),
    onCallList: z.object({ by: z.string().nullable(), at: wireTime }).nullable(),
    job: z.object({
      jobNumber: z.number().int(), service: z.string(), area: z.string(), day: dateParam, window: z.object({ start: wireTime, end: wireTime }),
      technician: z.string().nullable(), bookedVia: z.enum(['online', 'office', 'seed']), bookedAt: wireTime, bookedBy: z.string().nullable(),
    }).nullable(),
    customerContact: z.object({ phone: z.string().nullable(), mobileEnd: z.string().nullable(), zone: z.string() }),
  }),
  errors: ['not_found'],
  labels: [],
  examples: [{ name: 'signed out', input: { textId: '00000000-0000-4000-8000-000000000000' }, expectStatus: 401 }],
});

export const tryTextNow = defineContract({
  id: 'API-144',
  name: 'Try a text now',
  method: 'POST',
  path: '/texts/{textId}/tries',
  request: z.object({ textId: uuid }),
  response: z.object({
    text: z.object({
      id: uuid,
      status: z.enum(['queued', 'held', 'sending', 'delivered', 'retrying', 'gave_up', 'canceled']),
      attempts: z.array(z.object({ number: z.number().int(), at: wireTime, result: z.enum(['delivered', 'failed']) })),
      /** Set when the try fell in quiet hours: it waits until this 8:00 AM (the customer's time). */
      heldUntil: wireTime.nullable(),
      nextTryAt: wireTime.nullable(),
    }),
  }),
  errors: ['not_retryable', 'not_found'],
  labels: [],
  examples: [{ name: 'signed out', input: { textId: '00000000-0000-4000-8000-000000000000' }, expectStatus: 401 }],
});

export const addToCallList = defineContract({
  id: 'API-145',
  name: 'Add to call list',
  method: 'POST',
  path: '/texts/{textId}/call-list',
  request: z.object({ textId: uuid }),
  response: z.object({ entry: z.object({ id: uuid, by: z.string().nullable(), at: wireTime }) }),
  successStatus: [201],
  errors: ['already_on_call_list', 'rule_refused', 'not_found'],
  labels: [],
  examples: [{ name: 'signed out', input: { textId: '00000000-0000-4000-8000-000000000000' }, expectStatus: 401 }],
});

export const textLogExport = defineContract({
  id: 'API-146',
  name: 'Text log export',
  method: 'POST',
  path: '/text-searches/export',
  request: textFilters.extend({ lang: language.optional() }),
  /** The CSV text: a header row, then the rows the page shows for the day and the filters (FR-TEXT-24: the export's rows equal the log). */
  response: z.string(),
  envelope: false,
  file: { contentType: 'text/csv', name: 'text-log.csv' },
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { date: '2026-09-15', branch: 'columbus' }, expectStatus: 401 }],
});

const visit = z.object({
  jobNumber: z.number().int(),
  day: dateParam,
  window: z.object({ start: wireTime, end: wireTime }),
  service: z.string(),
  technician: z.string().nullable(),
  /** The technician's name in texts: the script's first name (FR-TEXT-11). */
  technicianInTexts: z.string().nullable(),
  jobStatus: z.string(),
});

const outcome = z.object({ kind: z.enum(CALL_OUTCOMES), by: z.string().nullable(), at: wireTime }).nullable();

const callPerson = z.object({
  entryId: uuid,
  customerId: uuid,
  customer: z.string(),
  area: z.string(),
  phone: z.string().nullable(),
  language,
  visit,
  outcome,
});

export const callList = defineContract({
  id: 'API-42',
  name: 'Call list',
  method: 'GET',
  path: '/call-list',
  request: z.object({ branch: branchParam, date: dateParam }),
  response: z.object({
    asOf: wireTime,
    reminderCalls: z.array(callPerson.extend({ reason: z.enum(CALL_REASONS) })),
    failedTexts: z.array(callPerson.extend({
      reason: z.enum(FAILED_TEXT_REASONS),
      textId: uuid.nullable(),
      textType: z.enum(['confirmation', 'reminder', 'on_the_way', 'late', 'r_reply', 'office']).nullable(),
      failedAt: wireTime.nullable(),
      addedBy: z.string().nullable(),
      addedAt: wireTime.nullable(),
    })),
    progress: z.object({ total: count, called: count, confirmed: count, reschedule: count, noAnswer: count }),
    count,
    dayTotals: nextReminders,
  }),
  errors: ['not_found'],
  labels: [],
  examples: [{ name: 'signed out', input: { branch: 'columbus', date: '2026-09-15' }, expectStatus: 401 }],
});

export const recordCallOutcome = defineContract({
  id: 'API-38',
  name: 'Record a call outcome',
  method: 'POST',
  path: '/jobs/{jobNumber}/call-outcomes',
  request: z.object({
    jobNumber: z.coerce.number().int().min(1).max(2_147_483_647),
    outcome: z.enum(CALL_OUTCOMES),
    /** The call list row; absent, the job's latest entry. A job can be on the list for a reminder and for a failed text. */
    entryId: uuid.optional(),
  }),
  response: z.object({
    outcome: z.object({ kind: z.enum(CALL_OUTCOMES), by: z.string().nullable(), at: wireTime }),
    /** `confirmed` also gives the visit confirmation, the same one a C reply gives (FR-TEXT-8). */
    confirmedAt: wireTime.nullable(),
  }),
  errors: ['rule_refused', 'not_found'],
  labels: [],
  examples: [{ name: 'signed out', input: { jobNumber: 24800, outcome: 'no_answer' }, expectStatus: 401 }],
});

/** The office Messages rows: they sit in the dispatch area (their policy entries do, next to their pages), not in the customer-only text area. */
export const messagesContracts: ContractRow[] = [textLog, textDetail, tryTextNow, addToCallList, textLogExport, callList, recordCallOutcome];

export const textContracts: ContractRow[] = [];
