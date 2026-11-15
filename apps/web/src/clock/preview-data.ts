// SPDX-License-Identifier: AGPL-3.0-or-later
// The data the demo clock frame shows (mockups/pages/r1-admin-clock.html), for the preview routes (harness build only) and the model tests: the
// running clock after the nightly reset, the 6 presets of API-11, and each state's answer. Never imported by a release route.
import type { ClockAnswer } from '../shell/clock.ts';
import type { Preset } from './model.ts';

const Z = '[America/New_York]';

/** Running at Tue, Sep 15, 10:28 AM EDT, last moved by the nightly reset to 7:00 AM (the frame's main screen). */
export const RUNNING: ClockAnswer = {
  demoNow: `2026-09-15T10:28:00-04:00${Z}`,
  rate: 1,
  paused: false,
  worldEpoch: 1,
  lastMove: { by: 'nightly', kind: 'reset', toDemo: `2026-09-15T07:00:00-04:00${Z}` },
  replay: { running: false, done: 0, total: 0 },
  resetAvailableInSeconds: 0,
};
export const PAUSED: ClockAnswer = { ...RUNNING, paused: true, lastMove: { by: 'Dana Ruiz', kind: 'pause', toDemo: `2026-09-15T10:28:00-04:00${Z}` } };
export const CATCHING_UP: ClockAnswer = { ...RUNNING, demoNow: `2026-09-15T18:05:00-04:00${Z}`, lastMove: { by: 'Dana Ruiz', kind: 'jump', toDemo: `2026-09-15T18:05:00-04:00${Z}` }, replay: { running: true, done: 120, total: 340 } };
export const COOLDOWN: ClockAnswer = { ...RUNNING, demoNow: `2026-09-15T07:00:00-04:00${Z}`, worldEpoch: 2, resetAvailableInSeconds: 240 };
export const JUMPED: ClockAnswer = { ...RUNNING, demoNow: `2026-09-15T18:05:00-04:00${Z}`, lastMove: { by: 'Dana Ruiz', kind: 'jump', toDemo: `2026-09-15T18:05:00-04:00${Z}` } };

/** API-11's 6 presets in screen order (SPECIFICATIONS 6.9): `reachable` is whether the target is after demo now. */
export function presetsAt(reachable: (id: Preset['presetId']) => boolean = () => true): Preset[] {
  const rows: [Preset['presetId'], string][] = [
    ['reminder_6pm', `2026-09-15T18:05:00-04:00${Z}`],
    ['tomorrow_8am', `2026-09-16T08:00:00-04:00${Z}`],
    ['sat_oct_31', `2026-10-31T07:00:00-04:00${Z}`],
    ['sun_nov_1', `2026-11-01T17:55:00-05:00${Z}`],
    ['sat_mar_13_2027', `2027-03-13T07:00:00-05:00${Z}`],
    ['sun_mar_14_2027', `2027-03-14T07:00:00-04:00${Z}`],
  ];
  return rows.map(([presetId, target]) => ({ presetId, labelKey: `clock.preset.${presetId}`, target, reachable: reachable(presetId) }));
}
