// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-GATE-02's read of API-15 (CTL-GATE-02-04), as a state the start page draws. F-552: a session that has not entered the
// hosted demo's access code (a password session passes the page's gate, F-288) is answered access_code_required, and the list
// and install line stay hidden (UI-SPECIFICATION CTL-GATE-02-04, "shown only when ... the access code is entered (or off)"),
// the same mapping SignInScreen gives API-04. Only another failure is the read-failed panel with Try again.
import type { Reader } from '../shell/reads.ts';

export interface TechSignIn {
  name: string;
  branch: string;
  language: 'en' | 'es';
  email: string;
  password: string;
}
export interface TechSignIns {
  signIns: TechSignIn[];
  iosAppLink: string | null;
}
/** `hidden`: API-15 answered access_code_required, so the list is not shown until the code is entered. */
export type SignInList = 'loading' | 'error' | 'hidden' | TechSignIns;

export async function readSignInList(reader: Reader): Promise<Exclude<SignInList, 'loading'>> {
  const r = await reader.read<TechSignIns>('API-15');
  return r.ok ? r.data : r.code === 'access_code_required' ? 'hidden' : 'error';
}
