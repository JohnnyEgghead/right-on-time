// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixed data for the harness build's billing preview routes (apps/web/app/shell-preview/billing, pbs-list, pbs-invoice): each state of
// the frames mockups/pages/office-billing.html, r1-pbs-a-list.html and r1-pbs-a-invoice.html, with the frame's own values, for the look
// comparator (ci/look-values/billing.pw.test.ts). Never read by a release route.
import type { PbsInvoiceView } from './PbsInvoiceBody.tsx';
import type { PbsInvoices, PbsModeView } from './PbsListBody.tsx';
import type { Queue } from './BillingBody.tsx';

const Z = '[America/New_York]';
const e = (hhmm: string, day = '15') => `2026-09-${day}T${hhmm}:00-04:00${Z}`;

export const QUEUE_SUCCESS: Queue = {
  asOf: e('10:28'),
  link: { mode: 'up', lastSentAt: e('10:24'), finishedToday: 9, inBillingToday: 7 },
  items: [
    {
      jobNumber: 24800, customer: 'Paul Marsh', area: 'Gahanna', service: 'tankless_heater_flush', technician: 'Kevin Doyle', doneAt: e('09:50'),
      state: 'waiting_person', reasonKind: 'data_error', reason: 'Billing refused part code IVW-34', tries: 1, lastTry: e('09:51'), nextTry: null,
    },
    {
      jobNumber: 24825, customer: 'Ruth Whitman', area: 'Bexley', service: 'boiler_repair', technician: 'Tom Reinhart', doneAt: e('09:55'),
      state: 'retrying', reasonKind: 'timeout', reason: null, tries: 3, lastTry: e('10:20'), nextTry: e('10:35'),
    },
  ],
  leftLast7Days: [
    { jobNumber: 24768, reasonKind: 'timeout', reason: null, how: 'automatic_retry', tries: 2, by: null, markedReason: null, at: e('15:12', '14') },
    { jobNumber: 24755, reasonKind: 'data_error', reason: 'Refused part code', how: 'corrected', tries: 2, by: 'Keisha Turner', markedReason: null, at: e('16:40', '14') },
    { jobNumber: 24702, reasonKind: 'timeout', reason: null, how: 'automatic_retry', tries: 4, by: null, markedReason: null, at: e('11:05', '12') },
    { jobNumber: 24688, reasonKind: 'data_error', reason: 'Account closed', how: 'marked_fixed', tries: 1, by: 'Dana Ruiz', markedReason: 'Entered in billing by hand', at: e('14:18', '11') },
    { jobNumber: 24671, reasonKind: 'data_error', reason: 'Refused customer account', how: 'sent_again', tries: 1, by: 'Marco Perez', markedReason: null, at: e('09:47', '10') },
  ],
};

export const QUEUE_EMPTY: Queue = {
  ...QUEUE_SUCCESS,
  items: [],
  leftLast7Days: [
    { jobNumber: 24800, reasonKind: 'data_error', reason: 'Refused part code', how: 'corrected', tries: 2, by: 'Keisha Turner', markedReason: null, at: e('10:41') },
    { jobNumber: 24825, reasonKind: 'timeout', reason: null, how: 'automatic_retry', tries: 4, by: null, markedReason: null, at: e('10:35') },
  ],
};

const INVOICE_ROWS: PbsInvoices['invoices'] = [
  { jobNumber: 24812, customer: 'Whitaker', doneAt: e('10:15'), receivedAt: e('10:15'), how: 'received', totalCents: 13265 },
  { jobNumber: 24800, customer: 'Paul Marsh', doneAt: e('09:50'), receivedAt: e('10:21'), how: 'received', totalCents: 7900 },
  { jobNumber: 24790, customer: 'Hartley', doneAt: e('09:28'), receivedAt: e('09:40'), how: 'entered_by_hand', totalCents: 21400 },
  { jobNumber: 24781, customer: 'Carmen Reyes', doneAt: e('16:52', '14'), receivedAt: e('16:52', '14'), how: 'received', totalCents: 15640 },
  { jobNumber: 24776, customer: "Sean O'Brien", doneAt: e('15:35', '14'), receivedAt: e('15:35', '14'), how: 'received', totalCents: 8900 },
  { jobNumber: 24770, customer: 'Ruth Whitman', doneAt: e('14:10', '14'), receivedAt: e('14:10', '14'), how: 'received', totalCents: 31275 },
  { jobNumber: 24764, customer: 'Thanh Pham', doneAt: e('11:46', '14'), receivedAt: e('11:46', '14'), how: 'received', totalCents: 7900 },
];

export const INVOICES_SUCCESS: PbsInvoices = { invoices: INVOICE_ROWS, next: '24764', total: 41 };
export const INVOICES_EMPTY: PbsInvoices = { invoices: [], next: null, total: 0 };
export const MODE_UP: PbsModeView = { mode: 'up', nLeft: null, setBy: null };

// The lines as API-66 answers them: the label billing received (in English, as the link composes it) and, for the service, labor and
// discount lines, the facts it was composed from, which the page says in its own language (F-593). The work-done texts are a technician's.
export const INVOICE_SUCCESS: PbsInvoiceView = {
  jobNumber: 24812, customer: 'Whitaker', technician: 'Maria Santos', doneAt: e('10:15'), receivedAt: e('10:15'), how: 'received',
  lines: [
    { kind: 'service', label: 'AC tune-up', code: null, quantity: 1, unitCents: 8900, amountCents: 8900, words: { service: 'ac_tune_up' } },
    { kind: 'part', label: 'Run capacitor 45/5 MFD', code: 'CAP-455', quantity: 1, unitCents: 3800, amountCents: 3800, words: null },
    { kind: 'part', label: 'Furnace filter 16x25x1 MERV 8', code: 'FLT-16251', quantity: 2, unitCents: 950, amountCents: 1900, words: null },
    { kind: 'labor', label: 'Hours worked: 1 hr 5 min', code: null, quantity: 1.08, unitCents: 0, amountCents: 0, words: { laborMinutes: 65 } },
    { kind: 'discount', label: 'Comfort Club discount, 15% off the service line', code: null, quantity: null, unitCents: null, amountCents: -1335, words: { ratePercent: 15 } },
    { kind: 'work_done', label: 'Tune-up done, all readings normal', code: null, quantity: null, unitCents: null, amountCents: null, words: null },
    { kind: 'work_done', label: 'Replaced a weak run capacitor', code: null, quantity: null, unitCents: null, amountCents: null, words: null },
    { kind: 'work_done', label: 'Replaced 2 return filters', code: null, quantity: null, unitCents: null, amountCents: null, words: null },
  ],
  totalCents: 13265, noPartsUsed: false, callsReceived: 1, enteredByHand: null,
};

export const INVOICE_BY_HAND: PbsInvoiceView = {
  ...INVOICE_SUCCESS, jobNumber: 24790, customer: 'Hartley', how: 'entered_by_hand', lines: [], totalCents: 21400,
  enteredByHand: { reason: 'Billing refused part code DC-114. The invoice was entered in billing by hand.', by: 'Keisha Turner', at: e('09:40') },
};
