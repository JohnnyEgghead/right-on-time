// SPDX-License-Identifier: AGPL-3.0-or-later
// The page gate's refusals, as the web process (src/server.ts) hands them to the pages: it asks the kernel's page gate
// (pages.verdict) before every page and, when the gate refuses one, sets this request header (it drops any copy a client
// sends) and the answer's status. The root layout then renders the shared page in place of the route, so no route's own
// content renders for a person the gate refused (UI-SPECIFICATION 2.4, 4.2; SPECIFICATIONS SD-47).
export const PAGE_VERDICT_HEADER = 'x-bw-page-verdict';

export type RefusedVerdict = 'forbidden' | 'not_found' | 'gate';

/** The shared page each refusal shows; the access-code gate shows SCR-GATE-01 (src/auth/AccessCodeScreen.tsx, layout.tsx). */
export const REFUSED_PAGE: Readonly<Record<Exclude<RefusedVerdict, 'gate'>, 'no-access' | 'not-found'>> = {
  forbidden: 'no-access',
  not_found: 'not-found',
};

export function refusedVerdict(value: string | null | undefined): RefusedVerdict | null {
  return value === 'forbidden' || value === 'not_found' || value === 'gate' ? value : null;
}
