// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// A world reset on every web screen (EVT-06; UI-SPECIFICATION 3.2 CTL-CMP-02-03, 4.2 World reset; FR-DEMO-4, FR-DEMO-7; F-646): the 1 place
// that makes it happen. API-10's worldEpoch rising is the fact. The demo strip reports every API-10 answer here, and reads at once when
// EVT-06 arrives, so a surface with no event stream (the public pages) still finds the reset at its next read.
//
// A reset re-mounts the page under this boundary, which is what makes every region of every screen re-read and every open dialog close
// without each screen handling it. The notice and the toast live above the boundary, so they stay.
import { useRouter } from 'next/navigation';
import { createContext, Fragment, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAnnounce } from './Announcer.tsx';
import type { ClockAnswer } from './clock.ts';
import { useT } from './intl.tsx';

/** CTL-CMP-02-03's demo time, and the last move that made it: the notice gives way to the next move (CTL-CMP-02-01). */
export interface ResetNotice {
  to: string;
  move: string;
}

const moveOf = (a: ClockAnswer): string => JSON.stringify(a.lastMove ?? null);

/** What one API-10 answer means, given the highest epoch seen: nothing, a reset, or the notice's end. Epochs only rise, so a late read of the old world is nothing. */
export function readWorld(seen: number | null, notice: ResetNotice | null, a: ClockAnswer): { reset: ResetNotice | null; ended: boolean } {
  if (seen !== null && a.worldEpoch > seen) {
    return { reset: { to: a.lastMove?.kind === 'reset' ? a.lastMove.toDemo : a.demoNow, move: moveOf(a) }, ended: false };
  }
  return { reset: null, ended: notice !== null && moveOf(a) !== notice.move };
}

interface WorldReset {
  notice: ResetNotice | null;
  /** Every API-10 answer the page gets. */
  observe: (a: ClockAnswer) => void;
}

const Ctx = createContext<WorldReset>({ notice: null, observe: () => undefined });

export const useWorldReset = (): WorldReset => useContext(Ctx);

export function WorldResetBoundary({ children }: { children: ReactNode }) {
  const t = useT();
  const announce = useAnnounce();
  const router = useRouter();
  const [notice, setNotice] = useState<ResetNotice | null>(null);
  const [round, setRound] = useState(0);
  const seen = useRef<number | null>(null);
  const shown = useRef<ResetNotice | null>(null);
  const say = useRef({ t, announce, router });
  say.current = { t, announce, router };

  const observe = useCallback((a: ClockAnswer) => {
    const { reset, ended } = readWorld(seen.current, shown.current, a);
    seen.current = Math.max(seen.current ?? a.worldEpoch, a.worldEpoch);
    if (ended) {
      shown.current = null;
      setNotice(null);
    }
    if (!reset) return;
    shown.current = reset;
    setNotice(reset);
    if (document.querySelector('[role="dialog"], [role="alertdialog"]')) say.current.announce(say.current.t('board.worldReset'), 'info');
    setRound((n) => n + 1);
    say.current.router.refresh(); // a page's server-rendered part re-reads too
  }, []);
  const value = useMemo(() => ({ notice, observe }), [notice, observe]);

  return (
    <Ctx.Provider value={value}>
      <Fragment key={round}>{children}</Fragment>
    </Ctx.Provider>
  );
}
