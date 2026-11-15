// SPDX-License-Identifier: AGPL-3.0-or-later
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BILLING_TIMEOUT_MS } from '@bw/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { BillingUnavailableError, HttpBillingClient, PBS_CALL_TIMEOUT_MS } from './client.ts';

const open: http.Server[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

/** A pbs that accepts the connection and never answers (the wedged pbs of F-508). */
async function wedgedPbs(): Promise<string> {
  const server = http.createServer(() => undefined);
  open.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('the calls with no retry of their own (F-508)', () => {
  // why: F-508 enterByHand and setMode ran inside the web kernel's transaction with the send's 30 s limit, so 10 presses on a wedged pbs
  // held all 10 pooled web connections for 30 s each and stalled every route
  it('give up on a pbs that accepts and never answers, well before the send\'s 30 s', async () => {
    const client = new HttpBillingClient(await wedgedPbs(), { callTimeoutMs: 150 });
    const started = performance.now();
    await expect(client.setMode({ mode: 'down' })).rejects.toBeInstanceOf(BillingUnavailableError);
    await expect(client.getMode()).rejects.toBeInstanceOf(BillingUnavailableError);
    await expect(client.listInvoices()).rejects.toBeInstanceOf(BillingUnavailableError);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  // why: F-508 the default limit is a few seconds, never the send's 30 s
  it('default to a limit far below the send timeout', () => {
    expect(PBS_CALL_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(PBS_CALL_TIMEOUT_MS).toBeLessThan(BILLING_TIMEOUT_MS);
  });
});
