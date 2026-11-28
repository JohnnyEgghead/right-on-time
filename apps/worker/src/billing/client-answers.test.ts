// SPDX-License-Identifier: AGPL-3.0-or-later
// F-2006 J-22: a pbs answer of the wrong shape (JSON null on a 200) through the real HttpBillingClient over HTTP.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InvoiceRequest } from '@bw/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { BillingUnavailableError, HttpBillingClient } from './client.ts';

const open: http.Server[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

/** A pbs that answers every route 200 with the JSON body `body`. */
async function pbsAnswering(body: string): Promise<string> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(body));
  });
  open.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('a billing answer of the wrong shape (F-2006 J-22)', () => {
  // why: F-2006 J-22 a null mode answer was returned as a PbsMode, so the health page's read of its mode threw a TypeError
  it('reads as no mode: the health page\'s read of the mode gives null, never a TypeError', async () => {
    const client = new HttpBillingClient(await pbsAnswering('null'));
    // The health page's own read (packages/api-server/src/handlers/health-page.ts): the mode's name, or null when pbs gave none.
    await expect(client.getMode().then((m) => String(m.mode), () => null)).resolves.toBeNull();
    await expect(client.getMode()).rejects.toBeInstanceOf(BillingUnavailableError);
    await expect(client.setMode({ mode: 'up' })).rejects.toBeInstanceOf(BillingUnavailableError);
    await expect(client.reset(2)).rejects.toBeInstanceOf(BillingUnavailableError);
    await expect(client.listInvoices()).rejects.toBeInstanceOf(BillingUnavailableError);
  });

  // why: F-2006 J-22 a null send answer threw a TypeError out of sendInvoice instead of an outcome
  it('a send answered null is the down outcome with the HTTP status, never a throw', async () => {
    const client = new HttpBillingClient(await pbsAnswering('null'));
    const inv = { jobNumber: 24825 } as unknown as InvoiceRequest;
    await expect(client.sendInvoice(inv, { worldEpoch: 0 })).resolves.toEqual({ outcome: 'down', httpStatus: 200, reason: 'http_200' });
  });

  // why: F-2006 J-22 the shape check keeps a real answer
  it('keeps an answer of the right shape', async () => {
    const mode = { mode: 'reject_next_n', nLeft: 2, setBy: 'Dana', setAt: '2026-09-15T13:00:00.000Z', epoch: 3 };
    const client = new HttpBillingClient(await pbsAnswering(JSON.stringify(mode)));
    await expect(client.getMode()).resolves.toEqual(mode);
  });
});
