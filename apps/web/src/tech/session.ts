// SPDX-License-Identifier: AGPL-3.0-or-later
// Sign-out on the Me screen (CTL-TEC-10-04; SPECIFICATIONS SD-47, F-937): what the phone drops with the session. The server ends the session
// (API-06 clears the httpOnly cookie in its answer); the phone forgets the person's copies (local.ts) and tells the technician service worker
// to drop the /tech pages it kept ({type: 'forget'}, src/tech/sw.js), so the next person on this phone finds no one's page in the cache.
//
// F-1004 (CTL-TEC-10-04 "fails offline with nothing waiting: the local session is cleared anyway"): the httpOnly cookie goes only with an
// answer of API-06 (F-230), so a sign-out with no signal leaves it. The phone then owes the sign-out: a mark written before API-06 is called
// and removed only when an answer comes. While it is set, every /tech page shows nothing of the person (SignOutGate.tsx) and calls API-06
// again until one answers, then opens the sign-in page. A replay is safe: API-06 on a session already gone answers 401 and clears the cookie.
import type { ReadResult } from '../shell/reads.ts';

/** The mark of a sign-out the server has not answered yet (with the phone's other keys, src/tech/local.ts). */
export const SIGN_OUT_OWED = 'bw.tech.signOutOwed';

/**
 * F-1014: the mark is also kept in a cookie the web server can read (not httpOnly: it holds no secret, only that a sign-out is owed), so
 * the server renders each /tech page as it will stand (the page, or the owed frame) and no page waits on hydration to know. The cookie
 * and the localStorage mark are set and removed together; the localStorage mark stays the record the gate trusts.
 */
export const SIGN_OUT_OWED_COOKIE = 'bw_tech_owed';

function owedCookie(on: boolean): void {
  try {
    if (typeof document === 'undefined') return;
    document.cookie = `${SIGN_OUT_OWED_COOKIE}=${on ? '1' : ''}; path=/tech; samesite=lax; max-age=${on ? 31_536_000 : 0}`;
  } catch {
    // cookies blocked: the page falls back to the gate's check after hydration
  }
}

/** The part of Storage the mark uses; a test passes its own, null is no storage. */
export type MarkStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const pageStorage = (): MarkStorage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

/** Whether a sign-out is owed on this phone. Blocked or missing storage holds no mark. */
export function signOutOwed(storage: MarkStorage | null = pageStorage()): boolean {
  try {
    return (storage?.getItem(SIGN_OUT_OWED) ?? null) !== null;
  } catch {
    return false;
  }
}

/**
 * A person signed in on this browser (API-03 or API-05): the old cookie is overwritten, so nobody can use the session the mark owes;
 * the mark goes, and no retry of another tab or a later /tech open ends the new session (F-1013).
 */
export function clearSignOutOwed(storage: MarkStorage | null = pageStorage()): void {
  owedCookie(false);
  try {
    storage?.removeItem(SIGN_OUT_OWED);
  } catch {
    // nothing to remove
  }
}

/**
 * Ends the server session: marks the sign-out owed, calls API-06 and settles the mark when the server answers (any answer clears the
 * cookie, F-230; a session already gone answers 401). True when it answered; false with no answer, the mark kept for the next start.
 */
export async function endSession(signOut: () => Promise<ReadResult<unknown>>, storage: MarkStorage | null = pageStorage()): Promise<boolean> {
  try {
    storage?.setItem(SIGN_OUT_OWED, '1');
  } catch {
    // storage blocked: nothing is kept, the sign-out goes on
  }
  owedCookie(true);
  const r = await signOut();
  // F-1012: an answer is the server's own. A status of 500 or more is a proxy's page (an nginx 502 or 504 while the web container is down
  // or restarting): API-06 never reached the kernel that clears the cookie, so the mark stays and the gate retries (a replay is safe).
  const answered = r.ok || (r.status !== undefined && r.status < 500);
  if (answered) {
    owedCookie(false);
    try {
      storage?.removeItem(SIGN_OUT_OWED);
    } catch {
      // nothing to remove
    }
  }
  return answered;
}

/** The worker scope (src/tech/TechAppFrame.tsx SW_SCOPE; restated here so the module needs no React). */
const SW_SCOPE = '/tech';

/** The part of ServiceWorkerContainer sign-out uses; a test passes its own. */
export interface WorkerContainer {
  getRegistration(scope?: string): Promise<{ active: { postMessage(message: unknown): void } | null } | undefined>;
}

/**
 * Posts {type: 'forget'} to the active technician worker. False when this browser has no worker or none is active (nothing was kept, or the
 * page is not under one); a refusal of the browser is the same: sign-out goes on either way.
 */
export async function forgetShell(container: WorkerContainer | undefined = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker): Promise<boolean> {
  if (!container) return false;
  try {
    const worker = (await container.getRegistration(SW_SCOPE))?.active ?? null;
    if (!worker) return false;
    worker.postMessage({ type: 'forget' });
    return true;
  } catch {
    return false;
  }
}
