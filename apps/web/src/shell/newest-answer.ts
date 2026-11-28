// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';
// The newest-answer hook (F-2007, K-05): a screen whose read changes with something the person does (the branch, a filter, a page of a
// list) shows the answer to the newest read only. A slow answer to an earlier read that lands after a newer read began is dropped,
// never shown. It is createLatest (search-latest.ts, the top-bar search's guard, F-229) held for the life of one screen, so the screens
// share 1 mechanism with the search. (demo-day.ts is looser: it shows the newest answer that landed, so an older answer that lands first still shows until a newer lands; this hook drops every answer once a newer read began.)
import { useEffect, useRef } from 'react';
import { createLatest, type Latest } from './search-latest.ts';

/**
 * One newest-answer guard for one read of one screen: `newest.run(read, apply)` hands the read's answer to `apply` only when no newer
 * `run` (or `invalidate`) began while it was waiting, and resolves true when it was applied.
 *
 * Use 1 hook per read that has its own request (a branch's windows, a list's filter). Do the awaiting in `read` and every state change
 * in `apply`: a stale answer, an error answer too, then changes nothing. `read` should catch its own failure and return it as an answer
 * (a failed read of the newest request must show as a failure, never as nothing). The same object is returned on every render, so it is
 * safe in a dependency list; leaving the screen makes every read still waiting stale.
 */
export function useNewestAnswer(): Latest {
  const held = useRef<Latest | null>(null);
  held.current ??= createLatest();
  const latest = held.current;
  useEffect(() => () => latest.invalidate(), [latest]);
  return latest;
}
