// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract rows of the billing area. A new row is added here with defineContract (from ../contract.ts) and its examples;
// its handler and policy entry are in packages/api-server.
// The reads are API-60, API-65 to API-67 and API-159. The write rows are API-61 Send again, API-62 Correct a finish and
// send again, API-156 Retry now, API-157 Retry all, API-158 Mark fixed and API-68 Set pretend billing mode
// (SPECIFICATIONS section 6.6 FR-BILL-5, FR-BILL-7, FR-BILL-10, FR-BILL-11).
import { z } from 'zod';
import { defineContract, type ContractRow } from '../contract.ts';
import { versionConflictDetail } from './dispatch.ts';

// F-260: job_number is a PostgreSQL integer, so a larger number is refused here, not left to answer 500.
const jobNumberParam = z.coerce.number().int().min(1).max(2_147_483_647);

/** The billing queue item as the writes answer it (API-61, API-62, API-156): where the item stands after the write. */
export const queueItem = z.object({
  jobNumber: z.number().int(),
  state: z.enum(['sending', 'retrying', 'waiting_person', 'in_billing', 'marked_fixed']),
  tries: z.number().int(),
});

const SAMPLE_JOB = 24825;

export const sendAgain = defineContract({
  id: 'API-61',
  name: 'Send again',
  method: 'POST',
  path: '/billing/queue/{jobNumber}/resend',
  request: z.object({ jobNumber: jobNumberParam }),
  response: z.object({ item: queueItem }),
  successStatus: [202],
  errors: ['not_waiting_for_person'],
  labels: [],
  examples: [{ name: 'signed out', input: { jobNumber: SAMPLE_JOB }, expectStatus: 401 }],
});

export const correctFinish = defineContract({
  id: 'API-62',
  name: 'Correct a finish and send again',
  method: 'POST',
  path: '/billing/queue/{jobNumber}/correction',
  // The lines are the finish item's (tech.ts finishPayload): the finishLines validator decides them, not the schema (FR-BILL-3).
  request: z.object({
    jobNumber: jobNumberParam,
    parts: z.array(z.object({ partId: z.string().min(1).max(64), quantity: z.number() })).max(50),
    noPartsUsed: z.boolean(),
    laborMinutes: z.number(),
    baseVersion: z.number().int().min(1),
  }),
  response: z.object({ item: queueItem, job: z.object({ jobNumber: z.number().int(), version: z.number().int() }) }),
  successStatus: [202],
  errors: ['not_waiting_for_person', 'parts_required', 'version_conflict'],
  errorDetails: { version_conflict: versionConflictDetail },
  labels: [],
  examples: [{
    name: 'signed out',
    input: { jobNumber: SAMPLE_JOB, parts: [], noPartsUsed: true, laborMinutes: 30, baseVersion: 1 },
    expectStatus: 401,
  }],
});

export const retryNow = defineContract({
  id: 'API-156',
  name: 'Retry now',
  method: 'POST',
  path: '/billing/queue/{jobNumber}/retry',
  request: z.object({ jobNumber: jobNumberParam }),
  response: z.object({ item: queueItem }),
  successStatus: [202],
  errors: ['not_retrying', 'not_on_billing_list'],
  labels: [],
  examples: [{ name: 'signed out', input: { jobNumber: SAMPLE_JOB }, expectStatus: 401 }],
});

export const retryAll = defineContract({
  id: 'API-157',
  name: 'Retry all',
  method: 'POST',
  path: '/billing/queue/retries',
  request: z.object({ branch: z.string().min(1).max(40) }),
  response: z.object({ retried: z.number().int() }),
  successStatus: [202],
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { branch: 'columbus' }, expectStatus: 401 }],
});

export const markFixed = defineContract({
  id: 'API-158',
  name: 'Mark fixed',
  method: 'POST',
  path: '/billing/queue/{jobNumber}/fixed',
  request: z.object({ jobNumber: jobNumberParam, reason: z.string().trim().min(1).max(500).regex(/^[^\u0000]*$/) }),
  response: z.object({ left: z.object({ jobNumber: z.number().int(), by: z.string(), at: z.string(), reason: z.string() }) }),
  errors: ['not_on_billing_list'],
  labels: [],
  examples: [{ name: 'signed out', input: { jobNumber: SAMPLE_JOB, reason: 'Entered by hand in the billing system' }, expectStatus: 401 }],
});

export const PRETEND_BILLING_MODES = ['up', 'not_answering', 'down', 'reject_next_n'] as const;

export const setPretendBillingMode = defineContract({
  id: 'API-68',
  name: 'Set pretend billing mode',
  method: 'PUT',
  path: '/pretend-billing/mode',
  // n is 1 to 20 for reject_next_n and absent or null otherwise; the handler checks the pair (validation_failed, SD-44).
  request: z.object({ mode: z.enum(PRETEND_BILLING_MODES), n: z.number().int().nullable().optional() }),
  response: z.object({ mode: z.enum(PRETEND_BILLING_MODES), nLeft: z.number().int().nullable() }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { mode: 'up' }, expectStatus: 401 }],
});

// P4-BILLING-UI: the billing reads. API-60 Billing queue and API-159 Billing list export feed SCR-OFC-10; API-65 Pretend billing
// invoices, API-66 Pretend billing invoice and API-67 Pretend billing mode feed SCR-PBS-01 and SCR-PBS-02 (SPECIFICATIONS section
// 6.6 FR-BILL-2, FR-BILL-4, FR-BILL-5, FR-BILL-12; UI-SPECIFICATION 12.2).
const wireTime = z.string().min(1);
const count = z.number().int().nonnegative();
const branchParam = z.string().min(1).max(40);

/** Why a billing try failed (billing_attempt.result): billing did not answer in time, billing was down, or billing refused the invoice. */
export const BILLING_REASON_KINDS = ['timeout', 'down', 'data_error'] as const;
export const LEFT_HOW = ['automatic_retry', 'sent_again', 'corrected', 'marked_fixed'] as const;

export const billingQueue = defineContract({
  id: 'API-60',
  name: 'Billing queue',
  method: 'GET',
  path: '/billing/queue',
  request: z.object({ branch: branchParam }),
  response: z.object({
    // asOf is demo now in the branch's zone: the page's "updated" time and the "Today" under a done-at time.
    asOf: wireTime,
    // mode is null when the billing service does not answer the mode read: the card then says it cannot tell (CTL-OFC-10-01).
    link: z.object({
      mode: z.enum(PRETEND_BILLING_MODES).nullable(),
      lastSentAt: wireTime.nullable(),
      finishedToday: count,
      inBillingToday: count,
    }),
    items: z.array(z.object({
      jobNumber: z.number().int(),
      customer: z.string(),
      area: z.string(),
      service: z.string(),
      technician: z.string().nullable(),
      doneAt: wireTime,
      state: z.enum(['sending', 'retrying', 'waiting_person']),
      reasonKind: z.enum(BILLING_REASON_KINDS).nullable(),
      reason: z.string().nullable(),
      tries: count,
      lastTry: wireTime.nullable(),
      nextTry: wireTime.nullable(),
    })),
    leftLast7Days: z.array(z.object({
      jobNumber: z.number().int(),
      reasonKind: z.enum(BILLING_REASON_KINDS).nullable(),
      reason: z.string().nullable(),
      how: z.enum(LEFT_HOW),
      tries: count,
      by: z.string().nullable(),
      markedReason: z.string().nullable(),
      at: wireTime,
    })),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { branch: 'columbus' }, expectStatus: 401 }],
});

export const billingExport = defineContract({
  id: 'API-159',
  name: 'Billing list export',
  method: 'GET',
  path: '/billing/queue/export',
  // lang is the page's language: the header row is written in it (SPECIFICATIONS section 7.5).
  request: z.object({ branch: branchParam, lang: z.enum(['en', 'es']).optional() }),
  /** The CSV text: a header row, then the waiting list, then the jobs that left it in the last 7 days. */
  response: z.string(),
  envelope: false,
  file: { contentType: 'text/csv', name: 'billing-list.csv' },
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { branch: 'columbus' }, expectStatus: 401 }],
});

const invoiceHow = z.enum(['received', 'entered_by_hand']);

export const pbsInvoices = defineContract({
  id: 'API-65',
  name: 'Pretend billing invoices',
  method: 'GET',
  path: '/pretend-billing/invoices',
  request: z.object({ cursor: z.string().min(1).max(20).optional() }),
  response: z.object({
    invoices: z.array(z.object({
      jobNumber: z.number().int(),
      customer: z.string(),
      doneAt: wireTime,
      receivedAt: wireTime,
      how: invoiceHow,
      totalCents: z.number().int(),
    })),
    next: z.string().nullable(),
    // The count of invoices billing holds, for "Showing 7 of 41 invoices" (the page's own count).
    total: count,
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', expectStatus: 401 }],
});

export const pbsInvoice = defineContract({
  id: 'API-66',
  name: 'Pretend billing invoice',
  method: 'GET',
  path: '/pretend-billing/invoices/{jobNumber}',
  request: z.object({ jobNumber: jobNumberParam }),
  response: z.object({
    jobNumber: z.number().int(),
    customer: z.string(),
    technician: z.string().nullable(),
    doneAt: wireTime,
    receivedAt: wireTime,
    how: invoiceHow,
    // The lines as billing received them (SD-20): service, 1 line per part (1 name each, D5a-4), labor, work done, discount.
    lines: z.array(z.object({
      kind: z.enum(['service', 'part', 'labor', 'work_done', 'discount']),
      label: z.string(),
      code: z.string().nullable(),
      quantity: z.number().nullable(),
      unitCents: z.number().int().nullable(),
      amountCents: z.number().int().nullable(),
      // What the service, labor and discount labels were composed from (UI-SPECIFICATION 12.2 API-66: service, labor hours, discount at
      // the member rate), so the page says those lines in its own language (F-593); null on a part or work-done line, and on a label
      // billing received that the link would not compose (the page then shows the label as received).
      words: z.union([
        z.object({ service: z.string() }).strict(),
        z.object({ laborMinutes: z.number().int().nonnegative() }).strict(),
        z.object({ ratePercent: z.number().int().positive() }).strict(),
      ]).nullable(),
    })),
    totalCents: z.number().int(),
    // The technician ticked No parts used (job.no_parts_used): the page draws the Parts group with a No parts used line (CTL-PBS-02-02, F-598).
    noPartsUsed: z.boolean(),
    callsReceived: count,
    // Set when the job was marked fixed: the page shows "Entered by hand", the reason, who and when instead of the lines.
    enteredByHand: z.object({ reason: z.string(), by: z.string().nullable(), at: wireTime }).nullable(),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', input: { jobNumber: SAMPLE_JOB }, expectStatus: 401 }],
});

export const pbsMode = defineContract({
  id: 'API-67',
  name: 'Pretend billing mode',
  method: 'GET',
  path: '/pretend-billing/mode',
  request: z.object({}),
  response: z.object({
    mode: z.enum(PRETEND_BILLING_MODES),
    nLeft: z.number().int().nullable(),
    setBy: z.string().nullable(),
  }),
  errors: [],
  labels: [],
  examples: [{ name: 'signed out', expectStatus: 401 }],
});

export const billingContracts: ContractRow[] = [
  sendAgain, correctFinish, retryNow, retryAll, markFixed, setPretendBillingMode, billingQueue, billingExport, pbsInvoices, pbsInvoice, pbsMode,
];
