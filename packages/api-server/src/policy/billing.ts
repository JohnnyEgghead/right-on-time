// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy of the billing area: the billing queue and the pretend billing system's screens (UI-SPECIFICATION 2.4, UD-5).
import { billingExport, billingQueue, correctFinish, markFixed, pbsInvoice, pbsInvoices, pbsMode, retryAll, retryNow, sendAgain, setPretendBillingMode } from '@bw/api';
import type { PolicyEntry } from '../types.ts';
import { api, OFFICE, page } from './entry.ts';

export const billingPolicy: PolicyEntry[] = [
  api(sendAgain, OFFICE), // Send again for a billing record, from the Billing queue (CTL-OFC-10-05)
  api(correctFinish, OFFICE), // Correct a finished job's parts and labor and send it to billing again, from the billing page (CTL-OFC-22-09, -19-02)
  api(retryNow, OFFICE), // Retry 1 billing record now, from the Billing queue (CTL-OFC-10-07)
  api(retryAll, OFFICE), // Retry at once every retrying billing record of the branch; those waiting for a person are skipped (CTL-OFC-10-08)
  api(markFixed, OFFICE), // Mark a billing problem as fixed, from the Billing queue (CTL-OFC-47-03)
  api(setPretendBillingMode, OFFICE), // Set the pretend billing system's mode (CTL-PBS-01-03)
  api(billingQueue, OFFICE), // Read the Billing queue page (SCR-OFC-10)
  api(billingExport, OFFICE), // Export the Billing queue: the office billing page file (CTL-OFC-10-11)
  api(pbsInvoices, OFFICE), // List the pretend billing system's invoices (SCR-PBS-01)
  api(pbsInvoice, OFFICE), // Read 1 invoice of the pretend billing system (SCR-PBS-02)
  api(pbsMode, OFFICE), // Read the pretend billing system's mode (SCR-PBS-01)
  page('SCR-OFC-10', '/office/billing', OFFICE),
  page('SCR-PBS-01', '/billing-system', OFFICE),
  page('SCR-PBS-02', '/billing-system/invoices/{jobNumber}', OFFICE),
];
