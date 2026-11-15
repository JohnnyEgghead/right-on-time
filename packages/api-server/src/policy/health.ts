// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy of the health area: the health check (SPECIFICATIONS 7.4: no access code, no session) and the System health
// page (UI-SPECIFICATION 2.4: managers only, FR-HLTH-1).
import { alertEmailLink, boardDelaySample, checkNow, dismissAlert, healthz, officeAlerts, setAlertSwitch, setTextSimulator, systemHealth } from '@bw/api';
import type { PolicyEntry } from '../types.ts';
import { api, MANAGER, OFFICE, page, PUBLIC } from './entry.ts';

export const healthPolicy: PolicyEntry[] = [
  api(healthz, PUBLIC),
  api(boardDelaySample, OFFICE),
  api(officeAlerts, OFFICE), // CTL-CMP-07-06, SCR-OFC-28
  api(systemHealth, MANAGER), // SCR-OFC-16
  api(setTextSimulator, MANAGER), // CTL-OFC-16-02
  api(checkNow, MANAGER), // CTL-OFC-16-12
  api(setAlertSwitch, MANAGER), // CTL-OFC-16-21, -22
  api(alertEmailLink, MANAGER), // CTL-OFC-16-23, CTL-OFC-28-04
  api(dismissAlert, OFFICE), // CTL-OFC-16-28 (manager), CTL-OFC-28-05 (office, manager)
  page('SCR-OFC-16', '/office/admin/health', MANAGER),
];
