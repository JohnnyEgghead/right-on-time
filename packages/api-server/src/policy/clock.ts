// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy of the clock moves (API-11 to API-14): managers only, after the access code (UI-SPECIFICATION 2.4: SCR-OFC-17
// and SCR-OFC-27 are managers' pages; REQUIREMENTS C4: anyone signed in as a manager can move or reset the clock).
import { clockPresets, jumpClock, pauseClock, resetWorldRow } from '@bw/api';
import type { PolicyEntry } from '../types.ts';
import { api, MANAGER } from './entry.ts';

export const clockPolicy: PolicyEntry[] = [
  api(clockPresets, MANAGER),
  api(jumpClock, MANAGER),
  api(pauseClock, MANAGER),
  api(resetWorldRow, MANAGER),
];
