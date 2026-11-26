// SPDX-License-Identifier: AGPL-3.0-or-later
// Policy of the customers area (P4-CUSTOMERS): the customer search and page and their dialogs. UI-SPECIFICATION 2.4 admits office
// staff and managers (O, M) to SCR-OFC-05, SCR-OFC-06 and the dialogs SCR-OFC-38 to SCR-OFC-40; every caller of API-34, API-35,
// API-36 and API-139 is a control on one of them (12.1 item 3), so each entry admits office and manager and a technician is refused.
// API-111 is the street picker: public, since the booking site (P5-BOOKING) calls the same row (CTL-CUS-01-04).
import { createCustomer, customerDetail, editCustomer, searchCustomers, searchStreets } from '@bw/api';
import type { PolicyEntry } from '../types.ts';
import { api, OFFICE, page, PUBLIC } from './entry.ts';

export const customersPolicy: PolicyEntry[] = [
  page('SCR-OFC-05', '/office/customers', OFFICE),
  page('SCR-OFC-06', '/office/customers/{customerId}', OFFICE),
  api(searchCustomers, OFFICE), // Search customers, from the Customers page and the new job page (CTL-OFC-05-01, -05-05 to -05-11, -05-17 to -05-20 (SCR-OFC-05), CTL-OFC-04-01 (SCR-OFC-04))
  api(customerDetail, OFFICE), // Read 1 customer: SCR-OFC-06 and its dialogs, CTL-OFC-05-16 (the preview panel), CTL-OFC-39-01, CTL-OFC-40-01
  api(editCustomer, OFFICE), // Edit a customer, with its time zone (CTL-OFC-06-07 (the time zone), CTL-OFC-39-07 (SCR-OFC-39))
  api(createCustomer, OFFICE), // Create a customer, from the new customer dialog (CTL-OFC-38-08 (SCR-OFC-38))
  api(searchStreets, PUBLIC), // Street picker search, for the customer dialogs and the booking site (CTL-OFC-38-03, CTL-OFC-39-03 (the street pickers), CTL-CUS-01-04)
];
