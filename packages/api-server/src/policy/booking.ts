// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy of the booking area: the public booking site (UI-SPECIFICATION 2.4, FR-AUTH-2: no customer account).
import { bookingSummary, bookOnline, onlineAvailability } from '@bw/api';
import type { PolicyEntry } from '../types.ts';
import { api, page, PUBLIC } from './entry.ts';

export const bookingPolicy: PolicyEntry[] = [
  page('SCR-CUS-01', '/book', PUBLIC),
  page('SCR-CUS-03', '/book/done/{bookingToken}', PUBLIC),
  page('SCR-CUS-07', '/book/heating', PUBLIC),
  page('SCR-CUS-07', '/book/cooling', PUBLIC),
  page('SCR-CUS-07', '/book/plumbing', PUBLIC),
  page('SCR-CUS-07', '/book/comfort-club', PUBLIC),
  page('SCR-CUS-07', '/book/about-us', PUBLIC),
  api(onlineAvailability, PUBLIC), // CTL-CUS-01-05, CTL-CUS-01-06, CTL-CUS-02-02, CTL-CUS-02-05
  api(bookOnline, PUBLIC), // CTL-CUS-01-13, CTL-CUS-02-03
  api(bookingSummary, PUBLIC), // public by its link token (12.2 names it a public call); CTL-CUS-03-01 to CTL-CUS-03-03, -03-06, -03-10
];
