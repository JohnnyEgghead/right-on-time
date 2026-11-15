// SPDX-License-Identifier: AGPL-3.0-or-later
// The send triggers SD-47 names, apart from React Native so a unit test can drive them with fake timers (F-991 item b): a send on open,
// on focus (the app back in the foreground) and every SYNC_EVERY_MS while the app is open. The entry's own send is the engine's.
export interface TriggerTarget {
  open(): Promise<void>;
  sync(): Promise<unknown>;
}

export interface TriggerPorts {
  /** Calls `fn` with the app's new state ('active' when it returns to the foreground). */
  onAppState: (fn: (state: string) => void) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
}

export function startTriggers(app: TriggerTarget, ports: TriggerPorts, everyMs: number): void {
  void app.open();
  ports.onAppState((s) => {
    if (s === 'active') void app.sync();
  });
  ports.setInterval(() => void app.sync(), everyMs);
}
