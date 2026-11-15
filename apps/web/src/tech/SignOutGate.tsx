// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The owed sign-out on every /tech page (F-1004; CTL-TEC-10-04 "fails offline with nothing waiting: the local session is cleared anyway").
// A Sign out with no signal leaves the httpOnly session cookie (only API-06's answer clears it, F-230) and a mark on the phone (session.ts).
// With the mark set this page renders nothing of the person: no screen mounts, so no read runs and no copy is kept; a line says why
// (no signal, signing out) instead of a blank page. It calls API-06 at once and again every RETRY_MS and on the browser's online event; on
// the first answer the mark goes, the phone forgets the person's copies and kept pages again, and the sign-in page opens. With no mark the
// page renders as before. The mark is also a cookie (session.ts, F-1014) that layout.tsx reads on the server, so the server render and the
// first client render are already the page or the owed frame, never a blank frame; the gate still checks localStorage after hydration.
// The sign-in page and the install page hold nothing of a person, so even an owed frame draws them. While a sign-out is owed they stay drawn with the line above them and cannot be used
// (`inert`) until API-06 has answered, so a new session is never signed out by the old one's retry.
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../shell/intl.tsx';
import { createReader } from '../shell/reads.ts';
import { forgetPerson } from './local.ts';
import { clearSignOutOwed, endSession, forgetShell, SIGN_OUT_OWED, signOutOwed } from './session.ts';

export const SIGN_IN_PATH = '/tech/sign-in';
/** The pages that hold nothing of a person: the gate never blanks them. */
const OPEN_PATHS: readonly string[] = [SIGN_IN_PATH, '/tech/install'];
const RETRY_MS = 5_000;

export function SignOutGate({ children, owed = false }: { children: ReactNode; owed?: boolean }) {
  const t = useT();
  const pathname = usePathname();
  const open = pathname !== null && OPEN_PATHS.includes(pathname);
  const [state, setState] = useState<'owed' | 'clear'>(owed ? 'owed' : 'clear');
  useEffect(() => {
    if (!signOutOwed()) {
      clearSignOutOwed(); // a cookie left without its mark (F-1014) must not draw the owed frame
      setState('clear');
      return;
    }
    setState('owed');
    void forgetPerson();
    const reader = createReader({ baseUrl: window.location.origin });
    let done = false;
    let busy = false;
    const attempt = async () => {
      if (done || busy) return;
      // F-1013: the mark may have gone since the last try (a sign-in elsewhere overwrote the old cookie): API-06 must not end that new session.
      if (!signOutOwed()) {
        done = true;
        return;
      }
      busy = true;
      try {
        if (!(await endSession(() => reader.read('API-06')))) return;
        done = true;
        await forgetPerson();
        await forgetShell();
        if (open) setState('clear');
        else window.location.assign(SIGN_IN_PATH);
      } finally {
        busy = false;
      }
    };
    void attempt();
    const timer = window.setInterval(() => void attempt(), RETRY_MS);
    const online = () => void attempt();
    window.addEventListener('online', online);
    // The mark removed by another tab (its API-06 answered, or a person signed in there): stop here, and open this page afresh.
    const stored = (e: StorageEvent) => {
      if (e.key !== SIGN_OUT_OWED || e.newValue !== null || done) return;
      done = true;
      window.location.reload();
    };
    window.addEventListener('storage', stored);
    return () => {
      window.removeEventListener('storage', stored);
      done = true;
      window.clearInterval(timer);
      window.removeEventListener('online', online);
    };
  }, [pathname, open]);
  if (state === 'clear') return children;
  const line = (
    <div className="bw-tech-sign-out-owed" data-bw-sign-out-owed="" role="status">
      {state === 'owed' ? t('tech.signout.owed') : null}
    </div>
  );
  if (!open) return state === 'owed' ? line : null;
  return (
    <>
      {state === 'owed' ? line : null}
      <div {...(state === 'owed' ? { inert: true } : {})}>{children}</div>
    </>
  );
}
