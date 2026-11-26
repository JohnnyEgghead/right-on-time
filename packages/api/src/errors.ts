// SPDX-License-Identifier: AGPL-3.0-or-later
// The error catalog: docs/UI-SPECIFICATION.md section 4.3, plus rate_limited (SPECIFICATIONS 7.1, 7.4).
// Codes are stable wire identifiers; the user-facing message is a catalog key resolved by @bw/i18n later
// (this package does not depend on it). `offline` is client only and never on the wire.
// HTTP statuses are not in the specification table; the choice below is this package's (reported in the lane report).

export const ERROR_STATUS = {
  unauthenticated: 401,
  access_code_required: 403,
  forbidden: 403,
  not_found: 404,
  gone: 410,
  validation_failed: 422,
  version_conflict: 409,
  window_full: 409,
  booking_closed: 409,
  rule_refused: 409,
  parts_required: 422,
  text_value_breaks_limit: 422,
  message_too_long: 422,
  texts_off: 409,
  no_mobile: 409,
  technician_no_room: 409,
  time_overlap: 409,
  capacity_below_bookings: 409,
  not_forward: 409,
  replay_running: 409,
  cooldown: 429,
  run_in_progress: 409,
  real_run_exists: 409,
  already_decided: 409,
  already_undone: 409,
  already_handled: 409,
  not_waiting_for_person: 409,
  not_retrying: 409,
  not_on_billing_list: 409,
  not_retryable: 409,
  already_on_call_list: 409,
  already_a_user: 409,
  account_turned_off: 403,
  day_closed: 409,
  day_past: 409,
  code_invalid: 403,
  credentials_invalid: 401,
  demo_mode_off: 403,
  rate_limited: 429,
  server_error: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]];

/** Codes every call can answer (UI-SPECIFICATION 12.1 item 7), except the health check (SESSIONLESS_CONTRACTS). */
export const COMMON_ERRORS: readonly ErrorCode[] = ['unauthenticated', 'forbidden', 'not_found', 'validation_failed', 'server_error'];

/**
 * The calls that answer without the access code (UI-SPECIFICATION 12.1 item 7, SPECIFICATIONS SD-47 step 1): the 5
 * marked `beforeAccessCode` (API-01 enter the code, API-02 app info, API-03 sign in, API-10 the clock, API-105 the
 * native server check) and API-171, the health check. Every other call can also answer `access_code_required`.
 */
export const BEFORE_ACCESS_CODE: ReadonlySet<string> = new Set(['API-01', 'API-02', 'API-03', 'API-10', 'API-105']);
export const CODE_FREE_CONTRACTS: ReadonlySet<string> = new Set([...BEFORE_ACCESS_CODE, 'API-171']);

/** Calls with no session and nothing to forbid (SPECIFICATIONS 7.4: no access code, no session): no unauthenticated or forbidden. */
export const SESSIONLESS_CONTRACTS: ReadonlySet<string> = new Set(['API-171']);

/** The calls SPECIFICATIONS 7.1 rate-limits by name; every link-token route is rate-limited too (contract.ts isLinkTokenRoute). */
export const RATE_LIMITED_CONTRACTS: ReadonlySet<string> = new Set(['API-01', 'API-03', 'API-165']);

/** The client-only code of section 4.3; never sent by a server. */
export const CLIENT_ONLY_CODE = 'offline';

export const PROBLEM_TYPE_PREFIX = 'https://bw.j7l.io/errors/';

export function problemType(code: ErrorCode): `https://bw.j7l.io/errors/${ErrorCode}` {
  return `${PROBLEM_TYPE_PREFIX}${code}`;
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_STATUS, value);
}

/** The title a Problem answer carries for a code, shaped like a catalog key (error.<code>); pages choose their own words by code. */
export function errorMessageKey(code: ErrorCode): `error.${ErrorCode}` {
  return `error.${code}`;
}
