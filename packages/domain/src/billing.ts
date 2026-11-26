// SPDX-License-Identifier: AGPL-3.0-or-later
// The billing link's shared words (SPECIFICATIONS section 3 `billing_item`, `pbs.*`; section 4.5; SD-12, SD-44): the
// HTTP contract between the billing client and pbs, the modes and their counts, and the queue states. Pure constants
// and types, imported by apps/pbs, the worker's billing link and the web handlers that call them.

/** The modes the pbs billing stand-in can be set to: it answers, does not answer, is down, or rejects the next n requests (FR-BILL-5). */
export const PBS_MODES = ['up', 'not_answering', 'down', 'reject_next_n'] as const;
export type PbsModeName = (typeof PBS_MODES)[number];

/** SD-44: N for "Reject the next N as data errors" is a whole number from 1 to 20. */
export const REJECT_N_MIN = 1;
export const REJECT_N_MAX = 20;

export interface PbsMode {
  mode: PbsModeName;
  /** 1 to 20 for reject_next_n, else null. */
  nLeft: number | null;
  setBy: string | null;
  setAt: string | null;
  /** The world epoch of the last reset pbs applied (SD-12). */
  epoch: number;
}

/** pbs.call.answer (section 3): what pbs answered each POST /invoices. */
export const CALL_ANSWERS = ['stored', 'stored_late', 'already_have', 'down', 'data_error', 'wrong_epoch'] as const;
export type CallAnswer = (typeof CALL_ANSWERS)[number];

/** The headers of POST /invoices (section 4.5): the idempotency key and the sender's world epoch (SD-12). */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const EPOCH_HEADER = 'x-world-epoch';

export const idempotencyKey = (jobNumber: number): `job-${number}` => `job-${jobNumber}`;

/** The client's real-time timeout (FR-BILL-6) and pbs's Not answering hold (FR-BILL-5), in real milliseconds. */
export const BILLING_TIMEOUT_MS = 30_000;
export const NOT_ANSWERING_HOLD_MS = 60_000;

/** The retry interval in demo minutes (FR-BILL-6). */
export const RETRY_DEMO_MINUTES = 15;

/** billing_item.state and job.billing_state (section 3; FR-BILL-2). */
export const BILLING_STATES = ['not_sent', 'sending', 'retrying', 'waiting_person', 'in_billing', 'marked_fixed'] as const;
export type BillingState = (typeof BILLING_STATES)[number];

/** The result stored on 1 billing_attempt row: success, timeout, down or data_error (section 3; invariant 2). */
export type AttemptResult = 'success' | 'timeout' | 'down' | 'data_error';

export const BILLING_EVENT_KINDS = ['billing.send', 'billing.retry'] as const;
export type BillingEventKind = (typeof BILLING_EVENT_KINDS)[number];

/** The longest Mark fixed reason, in characters. */
export const MARK_FIXED_REASON_MAX = 500;
