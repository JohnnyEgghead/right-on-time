// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The Messages pages' live updates (CMP-13; EVT-03 text.changed for the text log, EVT-03 and EVT-01 job.changed for the call list): a notice
// for the shown branch on the event stream makes the page re-read, and the notice's text id lets the log update that row's panel too. After a
// lost stream the page re-reads in full, and while the stream is lost the indicator says so. The page follows the demo day (EVT-05, EVT-06;
// F-1930): the clock is read first, and then the list only if the day stayed, because a day that moved is read by the page itself.
import { subscribeEvents, type StreamState } from '@bw/api';
import { useEffect, useRef, useState } from 'react';
import { dayMoved, type FollowedDay } from '../shell/demo-day.ts';
import type { LiveState } from '../shell/Panels.tsx';

const LIVE: Record<StreamState, LiveState> = { connecting: 'live', live: 'live', reconnecting: 'reconnecting', closed: 'paused' };

export interface MessageNotice {
  name: string;
  textId: string | null;
}

export function useMessagesLive(branch: string | null, names: readonly string[], reread: (notice?: MessageNotice) => void, followed: FollowedDay): LiveState {
  const [state, setState] = useState<LiveState>('live');
  const latest = useRef(reread);
  latest.current = reread;
  const wanted = useRef(names);
  wanted.current = names;
  const day = useRef(followed);
  day.current = followed;
  useEffect(() => {
    // No subscription before the branch is known: the notices are the shown branch's, and a new branch subscribes anew.
    if (branch === null) return;
    let open = true;
    const clockFirst = async () => {
      if (!(await dayMoved(day.current)) && open) latest.current();
    };
    const handle = subscribeEvents({
      branch,
      onEvent: (e) => {
        if (e.name === 'clock.changed') void day.current.readDay();
        if (e.name === 'world.reset') void clockFirst();
        if (!wanted.current.includes(e.name)) return;
        latest.current({ name: e.name, textId: typeof e.ids.textId === 'string' ? e.ids.textId : null });
      },
      onReconnect: () => void clockFirst(),
      onState: (s) => setState(LIVE[s]),
    });
    return () => {
      open = false;
      handle.close();
    };
  }, [branch]);
  return state;
}
