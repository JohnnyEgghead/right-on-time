// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The billing pages' live updates (CMP-13; SPECIFICATIONS 4.3 EVT-07 billing.changed): a billing.changed notice on the branch's event
// stream makes the page re-read. After a lost stream the page re-reads in full, and while the stream is lost the indicator says so.
import { subscribeEvents, type StreamState } from '@bw/api';
import { useEffect, useRef, useState } from 'react';
import type { LiveState } from '../shell/Panels.tsx';

const LIVE: Record<StreamState, LiveState> = { connecting: 'live', live: 'live', reconnecting: 'reconnecting', closed: 'paused' };

export function useBillingLive(branch: string | null, reread: (notice?: { jobNumber: number }) => void): LiveState {
  const [state, setState] = useState<LiveState>('live');
  const latest = useRef(reread);
  latest.current = reread;
  useEffect(() => {
    // No subscription before the branch is known (F-594): the notices are the shown branch's, and a new branch subscribes anew.
    if (branch === null) return;
    const handle = subscribeEvents({
      branch,
      onEvent: (e) => {
        if (e.name === 'billing.changed') latest.current({ jobNumber: Number(e.ids.jobNumber) });
      },
      onReconnect: () => latest.current(),
      onState: (s) => setState(LIVE[s]),
    });
    return () => handle.close();
  }, [branch]);
  return state;
}
