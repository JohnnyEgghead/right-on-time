// SPDX-License-Identifier: AGPL-3.0-or-later
// The policy table (SPECIFICATIONS SD-7): 1 typed array of PolicyEntry, 1 per API-<nn> row plus the endpoints of
// section 7.4 and every page route, assembled from 1 file per area (policy/<area>.ts, the areas of @bw/api's
// contracts). A new contract row gets its entry in its area's file; the role-by-route test (G-CI7) fails a row, a page
// route or a handler with no entry.
import type { PolicyEntry } from './types.ts';
import { authPolicy } from './policy/auth.ts';
import { billingPolicy } from './policy/billing.ts';
import { bookingPolicy } from './policy/booking.ts';
import { customersPolicy } from './policy/customers.ts';
import { demoPolicy } from './policy/demo.ts';
import { dispatchPolicy } from './policy/dispatch.ts';
import { healthPolicy } from './policy/health.ts';
import { importPolicy } from './policy/import.ts';
import { mapPolicy } from './policy/map.ts';
import { reportPolicy } from './policy/report.ts';
import { techPolicy } from './policy/tech.ts';
import { textPolicy } from './policy/text.ts';

export const policyByArea = {
  auth: authPolicy,
  billing: billingPolicy,
  booking: bookingPolicy,
  customers: customersPolicy,
  demo: demoPolicy,
  dispatch: dispatchPolicy,
  health: healthPolicy,
  import: importPolicy,
  map: mapPolicy,
  report: reportPolicy,
  tech: techPolicy,
  text: textPolicy,
} satisfies Record<string, PolicyEntry[]>;

export const policyTable: readonly PolicyEntry[] = Object.freeze(Object.values(policyByArea).flat());
