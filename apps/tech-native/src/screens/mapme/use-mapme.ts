// SPDX-License-Identifier: AGPL-3.0-or-later
// The Today, Map, Parts, Me and Directions screens' one set of reads (reads.ts) on the phone: made once per signed-in person over the app's
// own directory, read on open, when the app comes back to the foreground and every 60 s (GAP-7), and shared by the 5 screens. Each read
// asks for a fresh answer (no-store): a day the phone already holds is never answered from a cache.
import { createClient } from '@bw/api';
import { useSyncExternalStore } from 'react';
import { AppState as RNAppState } from 'react-native';
import { answeredOrNetwork, type AppState, type NativeApp } from '../../core.ts';
import { expoDir } from '../../store/expo-dir.ts';
import { useApp } from '../../useApp.ts';
import { MapMeLifecycle } from './lifecycle.ts';
import { KeptRecords, MapMeReads, READ_EVERY_MS, type MapMeData } from './reads.ts';

const DIR = 'bw-mapme';

let life: MapMeLifecycle | null = null;
let watching: (() => void) | null = null;

function lifecycle(app: NativeApp): MapMeLifecycle {
  life ??= new MapMeLifecycle({
    make: (session) => {
      const client = createClient({ baseUrl: session.origin, fetch: answeredOrNetwork((input, init) => fetch(input, { ...init, cache: 'no-store' })), headers: { authorization: `Bearer ${session.token}` } });
      return new MapMeReads(client, expoDir(DIR), session.userId);
    },
    onForeground: (fn) => {
      const sub = RNAppState.addEventListener('change', (next) => {
        if (next === 'active') fn();
      });
      return () => sub.remove();
    },
    every: (fn, ms) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
    forget: () => KeptRecords.forgetAll(expoDir(DIR)),
    endSession: () => void app.sessionRefused(),
    everyMs: READ_EVERY_MS,
  });
  // F-1069: the reads follow the app's session, not the screens: sign-out or a 401 stops them whichever screen is showing (none, after sign-out).
  watching ??= app.subscribe((state) => void life?.follow(state.session));
  return life;
}

function reads(app: NativeApp, state: AppState): MapMeReads | null {
  return lifecycle(app).follow(state.session);
}

const NONE: MapMeData = {
  day: null, route: null, parts: null, routes: null, online: true, settled: false, failed: false, signedOut: false, now: null, notices: [], noticesOn: true, textSize: 'standard', newDay: false,
};

/** The reads' state for a screen; the person's reads start with the first screen that asks. */
export function useMapMe(): { app: NativeApp; state: AppState; reads: MapMeReads | null; data: MapMeData } {
  const { app, state } = useApp();
  const r = reads(app, state);
  const data = useSyncExternalStore((fn) => (r ? r.subscribe(fn) : () => undefined), () => r?.snapshot ?? NONE);
  return { app, state, reads: r, data };
}

/** Sign-out: every copy the reads kept on the phone goes (a copy kept for the next person to find is a leak). */
export function forgetMapMe(): void {
  KeptRecords.forgetAll(expoDir(DIR));
}
