// SPDX-License-Identifier: AGPL-3.0-or-later
// The shapes the customer screens read, from the contract rows (packages/api/src/contracts/customers.ts).
import type { customerDetail, jobsList, searchCustomers, z } from '@bw/api';

export type CustomerPage = z.infer<typeof searchCustomers.response>;
export type SearchHit = CustomerPage['customers'][number];
/** The 4 members of a jobs row that the Also found in jobs line prints (CTL-OFC-05-15). */
export type JobHit = Pick<z.infer<typeof jobsList.response>['rows'][number], 'jobNumber' | 'customer' | 'service' | 'day'>;
export type Detail = z.infer<typeof customerDetail.response>;
