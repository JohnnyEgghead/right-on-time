// SPDX-License-Identifier: AGPL-3.0-or-later
// Page gating (UI-SPECIFICATION 2.4 and 4.2; SPECIFICATIONS SD-47 OI-18; FR-AUTH-1). The page-serving process (the
// Next.js app of apps/web) asks this function before it renders any page; the verdict names what the person sees:
//   render       the page
//   gate         SCR-GATE-01 in place of the page (the access code is on and not entered)
//   redirect     a sign-in page with a return path: a signed-out person on a staff page, and SD-47 step 3's technician
//                app open with no code, which goes straight to SCR-TEC-01 (never to the gate, so the gate's staff sign-in
//                link cannot loop back to the gate)
//   forbidden    SCR-SHR-01 (403): a signed-in person whose role the page does not admit
//   not_found    SCR-SHR-02 (404): no policy entry, deny by default
// A render verdict is status 200, except the live map link page after its link ended: status 410 (API-115, FR-TEXT-4), the same route's
// content, which then reads the live map data call's 410 (API-116) and shows the ended live map page (SCR-CUS-05).
// A token page (`token`, `one_time`) renders its shell; its data comes only from its token contract, which the kernel
// refuses with not_found for a bad token (mount.ts), so the page shows SCR-SHR-02.
import type { Clock } from '@bw/time';
import type { Caller, PagePolicyEntry, PolicyEntry } from '../types.ts';
import { ACCESS_COOKIE, accessCookieValid } from './access-code.ts';
import { authorize, type GateState } from './authorize.ts';
import { compilePath, specificity, type CompiledPath } from './route.ts';
import { parseCookies, presentedToken, resolveCaller, type SessionStore } from './sessions.ts';

export type PageVerdict =
  | { kind: 'render'; screen: string; status: 200 | 410 }
  | { kind: 'gate'; screen: string; status: 403 }
  | { kind: 'redirect'; to: string; status: 303 }
  | { kind: 'forbidden'; screen: 'SCR-SHR-01'; status: 403 }
  | { kind: 'not_found'; screen: 'SCR-SHR-02'; status: 404 };

export const OFFICE_SIGN_IN = '/sign-in';
export const TECH_SIGN_IN = '/tech/sign-in';
/** The technician app's install page sits behind the code (SD-47 step 3); every other /tech page opens SCR-TEC-01 first. */
const TECH_INSTALL = '/tech/install';

const isTechPath = (p: string) => p === '/tech' || p.startsWith('/tech/');

export interface PageGate {
  match(path: string): PagePolicyEntry | null;
  /** The link token in a page path (for `/m/{liveMapToken}`, the part where the braces stand); null when the matched route carries none. */
  tokenOf(path: string): string | null;
  verdict(path: string, caller: Caller, gate: GateState): PageVerdict;
}

export function pageGate(table: readonly PolicyEntry[]): PageGate {
  const pages: { entry: PagePolicyEntry; compiled: CompiledPath }[] = table
    .filter((e): e is PagePolicyEntry => e.kind === 'page')
    .sort((a, b) => specificity(a.path) - specificity(b.path))
    .map((entry) => ({ entry, compiled: compilePath(entry.path) }));
  const match = (path: string) => pages.find((p) => p.compiled.match(path))?.entry ?? null;
  return {
    match,
    tokenOf(path) {
      const hit = pages.find((p) => p.compiled.match(path));
      const params = hit?.compiled.match(path);
      const name = hit ? /\{(\w*[tT]oken)\}/.exec(hit.entry.path)?.[1] : undefined;
      return (name && params?.[name]) || null;
    },
    verdict(path, caller, gate) {
      const entry = match(path);
      if (!entry) return { kind: 'not_found', screen: 'SCR-SHR-02', status: 404 };
      const v = authorize(entry, caller, gate);
      if (v.ok) return { kind: 'render', screen: entry.screen, status: 200 };
      const back = `?return=${encodeURIComponent(path)}`;
      switch (v.code) {
        case 'access_code_required':
          if (isTechPath(path) && path !== TECH_INSTALL) return { kind: 'redirect', to: `${TECH_SIGN_IN}${back}`, status: 303 };
          return { kind: 'gate', screen: 'SCR-GATE-01', status: 403 };
        case 'unauthenticated':
          return { kind: 'redirect', to: `${isTechPath(path) ? TECH_SIGN_IN : OFFICE_SIGN_IN}${back}`, status: 303 };
        case 'forbidden':
          return { kind: 'forbidden', screen: 'SCR-SHR-01', status: 403 };
      }
    },
  };
}

/** What a page request's verdict needs: the session store, the clock and the access-code switch and key. */
export interface PageRequestDeps {
  sessions: SessionStore;
  clock: Pick<Clock, 'realNow'>;
  codeOn: boolean;
  accessKey: string;
  /**
   * Has the link a token page serves ended (FR-TEXT-4)? Asked for the live map page (SCR-CUS-04) only, after the gate renders it; true gives
   * status 410 in place of 200. The rule is handlers/live-map.ts liveMapLinkState, wired in web.ts.
   */
  linkEnded?: (screen: string, token: string) => Promise<boolean>;
}

/**
 * The verdict for 1 page request (its path and headers): the caller and the access-code state resolved from its cookies
 * exactly as an API call resolves them (mount.ts), then the gate's verdict.
 */
export function pageRequestVerdict(gate: PageGate, deps: PageRequestDeps): (path: string, headers: Headers) => Promise<PageVerdict> {
  return async (path, headers) => {
    const cookies = parseCookies(headers.get('cookie'));
    const state: GateState = { codeOn: deps.codeOn, codeEntered: accessCookieValid(cookies.get(ACCESS_COOKIE), deps.accessKey, deps.clock) };
    const caller = await resolveCaller(deps.sessions, deps.clock, presentedToken(headers), !state.codeOn || state.codeEntered);
    const verdict = gate.verdict(path, caller, state);
    if (verdict.kind === 'render' && verdict.screen === 'SCR-CUS-04' && deps.linkEnded) {
      const token = gate.tokenOf(path);
      if (token !== null && (await deps.linkEnded(verdict.screen, token))) return { ...verdict, status: 410 };
    }
    return verdict;
  };
}
