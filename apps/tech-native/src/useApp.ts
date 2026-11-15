// SPDX-License-Identifier: AGPL-3.0-or-later
// The controller's state for a screen (core.ts through boot.ts), and the triggers SD-47 names for the technician apps: a send on open,
// on focus (the app back in the foreground), after each entry (the engine's own) and every 60 s while the app is open.
import { useEffect, useSyncExternalStore } from 'react';
import { AppState as RNAppState } from 'react-native';
import { SYNC_EVERY_MS } from '@bw/outbox/src/items/native.ts';
import { nativeApp } from './boot.ts';
import type { AppState, NativeApp } from './core.ts';
import { startTriggers } from './triggers.ts';

let started = false;

function start(app: NativeApp): void {
  if (started) return;
  started = true;
  startTriggers(app, { onAppState: (fn) => RNAppState.addEventListener('change', fn), setInterval: (fn, ms) => setInterval(fn, ms) }, SYNC_EVERY_MS);
}

export function useApp(): { app: NativeApp; state: AppState } {
  const app = nativeApp();
  const state = useSyncExternalStore((fn) => app.subscribe(fn), () => app.snapshot);
  useEffect(() => start(app), [app]);
  return { app, state };
}
