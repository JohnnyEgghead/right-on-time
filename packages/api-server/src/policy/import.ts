// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy of the import area: the import pages and API-80 to API-88. UI-SPECIFICATION 2.4 admits office staff and
// managers (O, M) to every import screen: the pages SCR-OFC-13 to SCR-OFC-15 and the dialogs SCR-OFC-25 and SCR-OFC-26.
// Each call's roles are its 12.2 callers' screens' roles (12.1 item 3; the rule G-CI7's oracle reads): every caller of
// API-80 to API-88 is a control on 1 of those 5 screens, so each entry admits office and manager, and a technician is
// refused (forbidden).
import { importRun, importRuns, likelyDuplicates, merges, problemList, startDryRun, startRealRun, decidePair, undoMerge } from '@bw/api';
import type { PolicyEntry } from '../types.ts';
import { api, OFFICE, page } from './entry.ts';

export const importPolicy: PolicyEntry[] = [
  page('SCR-OFC-13', '/office/admin/import', OFFICE),
  page('SCR-OFC-14', '/office/admin/import/duplicates', OFFICE),
  page('SCR-OFC-15', '/office/admin/import/history', OFFICE),
  api(startDryRun, OFFICE), // CTL-OFC-13-04 (SCR-OFC-13)
  api(importRun, OFFICE), // CTL-OFC-13-05, -06, -09 (SCR-OFC-13), CTL-OFC-25-01 (SCR-OFC-25)
  api(importRuns, OFFICE), // CTL-OFC-15-01 (SCR-OFC-15), CTL-OFC-13-08, -10 (SCR-OFC-13)
  api(problemList, OFFICE), // CTL-OFC-13-07 (SCR-OFC-13)
  api(startRealRun, OFFICE), // CTL-OFC-25-02 (SCR-OFC-25)
  api(likelyDuplicates, OFFICE), // CTL-OFC-13-02 (SCR-OFC-13), CTL-OFC-14-01, -02, -06, -08, -11 (SCR-OFC-14)
  api(decidePair, OFFICE), // CTL-OFC-14-04, -05, -09, -10 (SCR-OFC-14)
  api(merges, OFFICE), // CTL-OFC-15-03, -04, -06 (SCR-OFC-15)
  api(undoMerge, OFFICE), // CTL-OFC-26-02 (SCR-OFC-26)
];
