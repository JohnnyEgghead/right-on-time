// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy of the map area: the customer's live map and reschedule link pages (UI-SPECIFICATION 2.4: a valid link token;
// SPECIFICATIONS SD-17 link paths /m/<token> and /r/<token>).
import { liveMapData, liveMapPreview } from '@bw/api';
import type { PolicyEntry } from '../types.ts';
import { api, page, token } from './entry.ts';

export const mapPolicy: PolicyEntry[] = [
  api(liveMapData, token('live_map')), // API-116
  api(liveMapPreview, token('live_map')), // API-164
  page('SCR-CUS-04', '/m/{liveMapToken}', token('live_map')),
  page('SCR-CUS-06', '/r/{rescheduleToken}', token('reschedule')),
];
