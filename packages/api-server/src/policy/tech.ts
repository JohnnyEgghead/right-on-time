// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy of the tech area: the web technician app's pages (UI-SPECIFICATION 2.4: technicians only, own jobs only), and the
// technician item calls (P3-ITEMS): API-102, API-103 and API-162 for technicians (callers CTL-TEC-*, CMP-10), and API-39,
// the office's Mark handled of a flagged item (caller CTL-OFC-02-16), for office staff and managers.
import { dayRoute, markHandled, myJob, reportSync, sendItems, serverInfo, storedFile, techRoute, todayJobs, uploadBlob } from '@bw/api';
import type { PolicyEntry } from '../types.ts';
import { api, OFFICE, page, PUBLIC, roles, TECHNICIAN } from './entry.ts';

export const techPolicy: PolicyEntry[] = [
  page('SCR-TEC-02', '/tech', TECHNICIAN),
  page('SCR-TEC-04', '/tech/jobs/{jobNumber}', TECHNICIAN),
  page('SCR-TEC-05', '/tech/jobs/{jobNumber}/note', TECHNICIAN),
  page('SCR-TEC-06', '/tech/jobs/{jobNumber}/photo', TECHNICIAN),
  page('SCR-TEC-07', '/tech/jobs/{jobNumber}/finish', TECHNICIAN),
  page('SCR-TEC-08', '/tech/jobs/{jobNumber}/directions', TECHNICIAN),
  page('SCR-TEC-09', '/tech/waiting', TECHNICIAN),
  page('SCR-TEC-10', '/tech/me', TECHNICIAN),
  page('SCR-TEC-15', '/tech/map', TECHNICIAN),
  page('SCR-TEC-16', '/tech/parts', TECHNICIAN),
  api(todayJobs, TECHNICIAN), // CTL-TEC-02-01, -02, -07, -08, -10, -11, -15, CTL-TEC-03-04: the Today screen's read (P5-TWA-TODAY); CTL-TEC-10-06, -10-07, -10-10, CTL-TEC-08-02: the Me and Directions share (P5-TWA-MAP-ME)
  api(sendItems, TECHNICIAN), // CTL-TEC-03-02, -13-02, -14-02, -05-02, -07-08, -09-02, -10-03, CTL-CMP-10-04
  api(uploadBlob, TECHNICIAN), // CTL-TEC-06-03, -07-08, -09-02, -10-03, CTL-CMP-10-04
  api(reportSync, TECHNICIAN), // CTL-CMP-10-02
  api(markHandled, OFFICE), // CTL-OFC-02-16
  api(serverInfo, PUBLIC), // CTL-TEC-12-02 (P6-NATIVE-SHELL): before the access code and with no session
  api(myJob, TECHNICIAN), // CTL-TEC-04-02 to -08, -10, -19, CTL-TEC-07-16, -17 (own jobs only: the handler answers forbidden)
  // F-707, F-727: the stored photo and signature files (CTL-OFC-03-14 to -16, -30; CTL-TEC-04-10, -11); a technician only their own job's.
  api(storedFile, roles('manager', 'office', 'technician')),
  api(techRoute, TECHNICIAN), // CTL-TEC-08-01, -08-03, CTL-TEC-02-03, -04-04
  api(dayRoute, TECHNICIAN), // CTL-TEC-15-01 to -15-03, -15-08, -15-09
];
