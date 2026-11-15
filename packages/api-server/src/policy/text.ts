// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy of the text area: the customer's text inbox page (UI-SPECIFICATION 2.4: a valid inbox token, UD-12) and its reads and
// reply (API-120, API-121), and the reschedule page's data and move (API-117, API-118: a valid reschedule link, SD-17). The
// reschedule page itself (SCR-CUS-06) is routed in policy/map.ts with the other link pages.
import { inboxMessages, inboxReply, reschedulePage, rescheduleVisit } from '@bw/api';
import type { PolicyEntry } from '../types.ts';
import { api, page, token } from './entry.ts';

export const textPolicy: PolicyEntry[] = [
  page('SCR-INB-01', '/inbox/{inboxToken}', token('inbox')),
  api(inboxMessages, token('inbox')),
  api(inboxReply, token('inbox')),
  api(reschedulePage, token('reschedule')),
  api(rescheduleVisit, token('reschedule')),
];
