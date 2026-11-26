// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy of the report area: the reports page and its 2 contracts (UI-SPECIFICATION 2.4 and 12.2: managers only, FR-REP-1).
import { reports, reportsExport } from '@bw/api';
import type { PolicyEntry } from '../types.ts';
import { api, MANAGER, page } from './entry.ts';

export const reportPolicy: PolicyEntry[] = [
  api(reports, MANAGER), // Read the Reports page, for managers (API-50, SCR-OFC-11)
  api(reportsExport, MANAGER), // Export the Reports page, for managers (API-51, CTL-OFC-11-04)
  page('SCR-OFC-11', '/office/reports', MANAGER),
];
