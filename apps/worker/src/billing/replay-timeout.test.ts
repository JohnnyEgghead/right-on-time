// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner ruling b3abd03a (F-386): during a clock jump's replay each billing try still really calls billing, and gives
// up after about 2 seconds instead of FR-BILL-6's 30; outside a replay it keeps the normal wait. No database: the split
// handler's call step with a client that records what it was asked.
import { describe, expect, it } from 'vitest';
import { createLogger } from '@bw/log';
import { Temporal } from '@bw/time';
import type { BillingClient, SendOptions } from './client.ts';
import { billingSplitHandler, REPLAY_BILLING_TIMEOUT_MS, type PreparedSend } from './link.ts';

describe('the billing try during a replay (F-386)', () => {
  // why: F-386, FR-DEMO-3
  it('calls billing with a 2 s wait inside a replay and the normal wait outside it', async () => {
    const asked: (SendOptions | undefined)[] = [];
    const client = { sendInvoice: async (_inv: unknown, o?: SendOptions) => { asked.push(o); return { outcome: 'timed_out', httpStatus: null }; } } as unknown as BillingClient;
    const handler = billingSplitHandler({ client, log: createLogger({ process: 'worker', write: () => undefined }), timeoutMs: 30_000 });
    const prepared = { jobNumber: 24801, epoch: 3, tries: 0, invoice: { jobNumber: 24801 }, dataError: null } as unknown as PreparedSend;
    const now = Temporal.Instant.from('2026-09-15T22:00:00Z');
    const event = { id: 'e', dueAt: now, kind: 'billing.send', subject: '24801', payload: {} };
    await handler.call(prepared, event, now, { target: Temporal.Instant.from('2026-09-16T12:00:00Z') });
    await handler.call(prepared, event, now);
    expect(REPLAY_BILLING_TIMEOUT_MS).toBe(2_000);
    expect(asked).toEqual([{ worldEpoch: 3, timeoutMs: 2_000 }, { worldEpoch: 3, timeoutMs: 30_000 }]);
  });
});
