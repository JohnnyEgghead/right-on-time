// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy of the demo area: the clock read (every web surface's header, before the access code: SPECIFICATIONS 4.1) and
// the demo clock page (UI-SPECIFICATION 2.4: managers only, FR-DEMO-5).
import { eventStreamRow, readClock } from '@bw/api';
import type { PolicyEntry } from '../types.ts';
import { clockPolicy } from './clock.ts';
import { api, MANAGER, page, PUBLIC, roles } from './entry.ts';

export const demoPolicy: PolicyEntry[] = [
  // API-09 (F-344): every signed-in role, after the access code (SPECIFICATIONS 7.3: filtered by the caller's role and branch).
  api(eventStreamRow, roles('manager', 'office', 'technician')),
  api(readClock, PUBLIC),
  page('SCR-OFC-17', '/office/admin/clock', MANAGER),
  // P3-REPLAY: the clock moves API-11 to API-14 (./clock.ts, managers only).
  ...clockPolicy,
];
