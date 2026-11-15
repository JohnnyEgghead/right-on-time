// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// CMP-11 announcement region (CTL-CMP-11-01): a polite live region that is always in the page, and inside it the kit's
// visible toast (DK-37 .r1-toast) for 6 seconds. It announces the results of the user's own actions only, never routine
// refreshes. The 6 seconds are a display duration (a timer), not a reading of the clock.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import type { IconName } from './icon-paths.ts';

export const TOAST_MS = 6_000;

type Toast = { id: number; text: string; icon: IconName };
const Ctx = createContext<(text: string, icon?: IconName) => void>(() => {});

export function useAnnounce() {
  return useContext(Ctx);
}

/** The visible toast (DK-37); inside the live region it is announced. */
export function ToastView({ text, icon = 'check' }: { text: string; icon?: IconName }) {
  return (
    <div className="r1-toast" role="status" data-ctl="CTL-CMP-11-01">
      <Icon name={icon} />
      <span>{text}</span>
    </div>
  );
}

export function Announcer({ children, initial }: { children: ReactNode; initial?: { text: string; icon?: IconName } }) {
  const [toast, setToast] = useState<Toast | null>(initial ? { id: 0, text: initial.text, icon: initial.icon ?? 'check' } : null);
  const seq = useRef(0);
  const announce = useCallback((text: string, icon: IconName = 'check') => {
    seq.current += 1;
    setToast({ id: seq.current, text, icon });
  }, []);
  useEffect(() => {
    if (!toast || initial) return;
    const h = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(h);
  }, [toast, initial]);
  return (
    <Ctx.Provider value={announce}>
      {children}
      <div className="bw-toast-host" aria-live="polite" data-cmp="CMP-11">
        {toast ? <ToastView key={toast.id} text={toast.text} icon={toast.icon} /> : null}
      </div>
    </Ctx.Provider>
  );
}
