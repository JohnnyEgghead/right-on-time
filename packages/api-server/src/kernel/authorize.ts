// SPDX-License-Identifier: AGPL-3.0-or-later
// authorize (SPECIFICATIONS 6.8 FR-AUTH-1, SD-7, SD-47 OI-18): the 1 decision every API call and every page makes, in
// the route gating order of SD-47:
//   (1) the 2 sign-in routes, the gate, /healthz and the 5 contracts marked before the access code answer without the code;
//   (2) every other route needs the code (a valid bw_access cookie) or a password session;
//   (3) the web technician app's first open in a browser with no code goes straight to its sign-in page (pages.ts).
// Then the entry's access: public, a link token, a one-time link, or a role list. Deny by default: an unknown route is
// refused before this function is reached (mount.ts, pages.ts), and a role list never admits an anonymous caller.
import { CODE_FREE_CONTRACTS } from '@bw/api';
import type { Caller, PolicyEntry } from '../types.ts';

export interface GateState {
  /** ACCESS_CODE_ON (section 11.1). */
  codeOn: boolean;
  /** The request carries a valid bw_access cookie. */
  codeEntered: boolean;
}

export type Verdict =
  | { ok: true; needs: 'nothing' | 'token' | 'one_time' }
  | { ok: false; code: 'access_code_required' | 'unauthenticated' | 'forbidden' };

/** Does the entry answer without the access code (SD-47 step 1)? */
export function codeFree(entry: PolicyEntry): boolean {
  return entry.beforeAccessCode || (entry.kind === 'api' && CODE_FREE_CONTRACTS.has(entry.contract));
}

/** Has the caller passed the gate (SD-47 step 2): the code is off, entered, or the caller holds a password session. */
export function codePassed(caller: Caller, gate: GateState): boolean {
  return !gate.codeOn || gate.codeEntered || (caller.kind === 'staff' && caller.via === 'password');
}

export function authorize(entry: PolicyEntry, caller: Caller, gate: GateState): Verdict {
  if (!codeFree(entry) && !codePassed(caller, gate)) return { ok: false, code: 'access_code_required' };
  const a = entry.access;
  switch (a.kind) {
    case 'public':
      return { ok: true, needs: 'nothing' };
    case 'token':
      return { ok: true, needs: 'token' };
    case 'one_time':
      return { ok: true, needs: 'one_time' };
    case 'roles':
      if (caller.kind !== 'staff') return { ok: false, code: 'unauthenticated' };
      return a.roles.includes(caller.role) ? { ok: true, needs: 'nothing' } : { ok: false, code: 'forbidden' };
    default: {
      const never: never = a;
      throw new Error(`unknown access ${JSON.stringify(never)}`);
    }
  }
}
