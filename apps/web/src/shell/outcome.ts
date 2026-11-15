// SPDX-License-Identifier: AGPL-3.0-or-later
// What a page shows when its read answers a Problem (UI-SPECIFICATION section 4.2), keyed on the error CODE, never on
// the HTTP status (F-129): 5 codes share 403 (forbidden, access_code_required, account_turned_off, code_invalid,
// demo_mode_off), and only `forbidden` is SCR-SHR-01 No access; `access_code_required` is Code needed (SCR-GATE-01).
export type PageOutcome =
  | 'no-access' // SCR-SHR-01
  | 'not-found' // SCR-SHR-02
  | 'failed' // SCR-SHR-03
  | 'code-needed' // SCR-GATE-01 in place of the page (P2-AUTH builds the gate)
  | 'signed-out' // the sign-in page with a return path
  | 'region-error'; // any other code: the region shows CMP-12, the rest of the page stays

export function pageOutcome(problem: { code?: string | undefined; status?: number | undefined }): PageOutcome {
  switch (problem.code) {
    case 'forbidden':
      return 'no-access';
    case 'access_code_required':
      return 'code-needed';
    case 'not_found':
    case 'gone':
      return 'not-found';
    case 'unauthenticated':
      return 'signed-out';
    case 'server_error':
      return 'failed';
    case undefined:
      // No Problem body at all: a 5xx from a proxy or a dead process is the server's failure.
      return problem.status !== undefined && problem.status >= 500 ? 'failed' : 'region-error';
    default:
      return 'region-error';
  }
}
