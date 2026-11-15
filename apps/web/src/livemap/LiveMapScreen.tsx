// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// SCR-CUS-04 / SCR-CUS-05 at the live map link path (UI-SPECIFICATION 2.3): the page that reads API-116 every 10 seconds and again whenever it is
// shown (`pageshow`, including a restore from the phone's back-forward cache, and the tab coming back), so a link that ended while the page
// sat in the cache shows the ended page the moment it is shown (FR-TEXT-4). On any failed read the van is removed, never kept (NFR-04). Once the
// answer is 410 the page is the ended page and reads no more; the history entry is replaced, not added.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { AppInfo } from '../shell/Footer.tsx';
import { createReader } from '../shell/reads.ts';
import { liveMapApi, type LiveMapApi } from './api.ts';
import { LiveMapView } from './LiveMapView.tsx';
import { endedHistoryState, nextState, POLL_MS, shownState, type LiveState } from './model.ts';

/** `officePhone` is the branch office number the page carries from its first load (API-115, CTL-CUS-04-06); null when the server could not read it. */
export function LiveMapScreen({ token, api: given, officePhone = null }: { token: string; api?: LiveMapApi; officePhone?: string | null }) {
  const api = useMemo(() => given ?? liveMapApi(), [given]);
  const [state, setState] = useState<LiveState>({ kind: 'loading' });
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const kind = useRef<LiveState['kind']>('loading');
  kind.current = state.kind;

  // A restore from the page cache holds the kept live view back until the read it starts answers (an older read in flight does not count).
  const [restoring, setRestoring] = useState(false);
  const seq = useRef(0);
  const restoreFrom = useRef(0);

  const read = useCallback(
    async (restored = false) => {
      // Ended and not valid are final: a later read never brings the van back.
      if (kind.current === 'ended' || kind.current === 'not_found') return;
      const id = ++seq.current;
      if (restored) {
        restoreFrom.current = id;
        setRestoring(true);
      }
      const r = await api.read(token);
      setState((prev) => nextState(prev, r));
      if (restoreFrom.current > 0 && id >= restoreFrom.current) {
        restoreFrom.current = 0;
        setRestoring(false);
      }
    },
    [api, token],
  );

  useEffect(() => {
    void read();
    const every = setInterval(() => void read(), POLL_MS);
    const shown = (e: PageTransitionEvent) => void read(e.persisted);
    const visible = () => {
      if (document.visibilityState === 'visible') void read();
    };
    // F-956: the page cache freezes the snapshot as it is at pagehide. Hiding the van there (a synchronous commit) makes the frozen
    // snapshot the loading view, so a restore never paints the kept van before the pageshow read answers; the read clears it.
    const hidden = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      restoreFrom.current = seq.current + 1;
      flushSync(() => setRestoring(true));
    };
    window.addEventListener('pageshow', shown);
    window.addEventListener('pagehide', hidden);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(every);
      window.removeEventListener('pageshow', shown);
      window.removeEventListener('pagehide', hidden);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [read]);

  useEffect(() => {
    if (state.kind === 'ended') window.history.replaceState(endedHistoryState(window.history.state), '', window.location.href);
  }, [state.kind]);

  useEffect(() => {
    void createReader({ baseUrl: window.location.origin }).read<AppInfo>('API-02').then((r) => {
      if (r.ok) setAppInfo(r.data);
    });
  }, []);

  return <LiveMapView state={shownState(state, restoring)} fixed={{ appInfo }} officePhone={officePhone} />;
}
