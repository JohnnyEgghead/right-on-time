// SPDX-License-Identifier: AGPL-3.0-or-later
// Planted known-bad for contract-diff (W-38): the committed good rows (packages/api/src/contracts/health.ts) with the
// response field `status` renamed to `state`. contract-diff must fail it against the committed baseline, every run.
import { defineContract, z, type ContractRow } from '../../../../packages/api/src/index.ts';

export const rows: ContractRow[] = [
  defineContract({
    id: 'API-171',
    name: 'Health check',
    method: 'GET',
    path: '/healthz',
    request: z.object({}),
    response: z.object({ state: z.literal('ok') }),
    errors: [],
    labels: [],
    envelope: false,
    examples: [{ name: 'database answers', expectStatus: 200 }],
  }),
];
