// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy of the billing area: the billing queue and the pretend billing system's screens (UI-SPECIFICATION 2.4, UD-5).
import { billingExport, billingQueue, correctFinish, markFixed, pbsInvoice, pbsInvoices, pbsMode, retryAll, retryNow, sendAgain, setPretendBillingMode } from '@bw/api';
import type { PolicyEntry } from '../types.ts';
import { api, OFFICE, page } from './entry.ts';

export const billingPolicy: PolicyEntry[] = [
  api(sendAgain, OFFICE), // CTL-OFC-10-05
  api(correctFinish, OFFICE), // CTL-OFC-22-09, -19-02
  api(retryNow, OFFICE), // CTL-OFC-10-07
  api(retryAll, OFFICE), // CTL-OFC-10-08
  api(markFixed, OFFICE), // CTL-OFC-47-03
  api(setPretendBillingMode, OFFICE), // CTL-PBS-01-03
  api(billingQueue, OFFICE), // SCR-OFC-10
  api(billingExport, OFFICE), // CTL-OFC-10-11
  api(pbsInvoices, OFFICE), // SCR-PBS-01
  api(pbsInvoice, OFFICE), // SCR-PBS-02
  api(pbsMode, OFFICE), // SCR-PBS-01
  page('SCR-OFC-10', '/office/billing', OFFICE),
  page('SCR-PBS-01', '/billing-system', OFFICE),
  page('SCR-PBS-02', '/billing-system/invoices/{jobNumber}', OFFICE),
];
