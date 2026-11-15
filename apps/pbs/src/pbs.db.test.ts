// SPDX-License-Identifier: AGPL-3.0-or-later
// The pretend billing service over real HTTP, signed in as bw_pbs (role pbs) on real PostgreSQL 18 (SPECIFICATIONS
// section 6.6 FR-BILL-4, FR-BILL-5, FR-BILL-8; SD-12, SD-44). Run by gate G-CI10 (ci/gates/G-CI10/vitest.db.config.ts).
import { describe, expect, it } from 'vitest';
import type { InvoiceRequest } from '@bw/domain';
import { useBillingWorld } from '../../worker/src/billing/testing.ts';

const HOLD_MS = 500;
const w = useBillingWorld({ holdMs: HOLD_MS, timeoutMs: 150 });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const invoice = (jobNumber: number): InvoiceRequest => ({
  jobNumber, customerName: 'Ann Lee', doneAt: '2026-09-15T14:00:00Z', sentAt: '2026-09-15T14:01:00Z', totalCents: 8900,
  lines: [{ kind: 'service', label: 'Furnace tune-up', code: null, quantity: 1, unitCents: 8900, amountCents: 8900 },
    { kind: 'labor', label: 'Hours worked: 1 hr', code: null, quantity: null, unitCents: 0, amountCents: 0 }],
});
const post = (jobNumber: number, epoch: number, body: unknown = invoice(jobNumber), key = `job-${jobNumber}`) =>
  fetch(`${w.pbsUrl()}/invoices`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-world-epoch': String(epoch) }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: (await r.json()) as { answer?: string; reason?: string; error?: string } }));
const calls = async (job: number) => (await w.rows<{ answer: string }>('SELECT answer FROM pbs."call" WHERE job_number = $1 ORDER BY at, id', [job])).map((c) => c.answer);
const stored = async (job: number) => (await w.rows('SELECT 1 FROM pbs.invoice WHERE job_number = $1', [job])).length;
const epochNow = async () => (await w.client().getMode()).epoch;

describe('POST /invoices and the modes (FR-BILL-5)', () => {
  // why: FR-BILL-5, FR-BILL-8, FR-BILL-4
  it('Up stores the invoice once; the same key again answers already_have', async () => {
    await w.setMode('up');
    expect(await post(9001, await epochNow())).toEqual({ status: 200, body: { answer: 'stored' } });
    expect(await post(9001, await epochNow())).toEqual({ status: 200, body: { answer: 'already_have' } });
    expect(await stored(9001)).toBe(1);
    expect(await calls(9001)).toEqual(['stored', 'already_have']);
  });

  // why: FR-BILL-5
  it('Down answers 503 and stores nothing', async () => {
    await w.setMode('down');
    expect(await post(9002, await epochNow())).toEqual({ status: 503, body: { answer: 'down' } });
    expect(await stored(9002)).toBe(0);
    await w.setMode('up');
  });

  // why: FR-BILL-5, SD-44
  it('Reject the next N answers N data errors, counting down, then accepts again', async () => {
    await w.setMode('reject_next_n', 2);
    expect((await w.client().getMode())).toMatchObject({ mode: 'reject_next_n', nLeft: 2 });
    expect(await post(9003, await epochNow())).toMatchObject({ status: 422, body: { answer: 'data_error' } });
    expect((await w.client().getMode())).toMatchObject({ mode: 'reject_next_n', nLeft: 1 });
    expect(await post(9003, await epochNow())).toMatchObject({ status: 422, body: { answer: 'data_error' } });
    expect((await w.client().getMode())).toMatchObject({ mode: 'up', nLeft: null });
    expect(await post(9003, await epochNow())).toEqual({ status: 200, body: { answer: 'stored' } });
  });

  // why: SD-44
  it('takes N only as a whole number from 1 to 20, and only for Reject the next N', async () => {
    const put = (body: unknown) => fetch(`${w.pbsUrl()}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
    for (const n of [0, 21, 1.5, '3', null]) expect(await put({ mode: 'reject_next_n', n }), String(n)).toBe(422);
    expect(await put({ mode: 'reject_next_n', n: 20 })).toBe(200);
    expect(await put({ mode: 'reject_next_n', n: 1 })).toBe(200);
    expect(await put({ mode: 'down', n: 2 })).toBe(422);
    expect(await put({ mode: 'sideways' })).toBe(422);
    expect(await put({ mode: 'up' })).toBe(200);
  });

  // why: FR-BILL-5, FR-BILL-8
  it('Not answering holds the request past the client timeout, then stores it late', async () => {
    await w.setMode('not_answering');
    const p = post(9004, await epochNow());
    await pause(100);
    expect(await stored(9004)).toBe(0);
    expect(await p).toEqual({ status: 200, body: { answer: 'stored_late' } });
    expect(await stored(9004)).toBe(1);
    expect(await calls(9004)).toEqual(['stored_late']);
    await w.setMode('up');
  });

  // why: FR-BILL-7
  it('answers an invoice whose total is not its lines as a data error with the reason', async () => {
    expect(await post(9005, await epochNow(), { ...invoice(9005), totalCents: 1 })).toEqual({
      status: 422, body: { answer: 'data_error', reason: 'the total does not equal the sum of the priced lines' },
    });
    expect(await stored(9005)).toBe(0);
  });

  // why: FR-BILL-4
  it('refuses a request without its key or epoch, or whose body names another job, with 400 and no call row', async () => {
    expect((await post(9006, await epochNow(), invoice(9006), 'nine')).status).toBe(400);
    expect((await post(9006, await epochNow(), invoice(9007))).status).toBe(400);
    const r = await fetch(`${w.pbsUrl()}/invoices`, { method: 'POST', headers: { 'idempotency-key': 'job-9006' }, body: JSON.stringify(invoice(9006)) });
    expect(r.status).toBe(400);
    expect(await calls(9006)).toEqual([]);
  });
});

describe('the world epoch (SD-12)', () => {
  // why: SD-12, invariant 10
  it('answers a request with an old epoch wrong_epoch on receipt and never stores it', async () => {
    await w.setMode('up');
    const e = await epochNow();
    expect(await post(9101, e - 1)).toEqual({ status: 503, body: { answer: 'wrong_epoch' } });
    expect(await post(9101, e + 1)).toEqual({ status: 503, body: { answer: 'wrong_epoch' } });
    expect(await stored(9101)).toBe(0);
    expect(await calls(9101)).toEqual(['wrong_epoch', 'wrong_epoch']);
  });

  // why: SD-12, invariant 10
  it('checks the epoch again at store: a request held across a reset is answered wrong_epoch and never stored', async () => {
    const e = await epochNow();
    await w.setMode('not_answering');
    const p = post(9102, e);
    await pause(100);
    expect(await w.client().reset(e + 1)).toEqual({ applied: true, epoch: e + 1 });
    expect(await p).toEqual({ status: 503, body: { answer: 'wrong_epoch' } });
    expect(await stored(9102)).toBe(0);
    expect(await calls(9102)).toEqual(['wrong_epoch']);
  });

  // why: SD-12
  it('applies a reset once per epoch: a repeat changes nothing; a later epoch applies even when one was skipped', async () => {
    const e = await epochNow();
    await w.setMode('up');
    expect(await post(9103, e)).toMatchObject({ body: { answer: 'stored' } });
    await w.setMode('down');
    expect(await w.client().reset(e)).toEqual({ applied: false, epoch: e });
    expect(await stored(9103)).toBe(1);
    expect((await w.client().getMode()).mode).toBe('down');
    expect(await w.client().reset(e + 2)).toEqual({ applied: true, epoch: e + 2 });
    expect(await stored(9103)).toBe(0); // emptied to the day-start copy, which holds no invoices here
    expect(await w.client().getMode()).toMatchObject({ mode: 'up', nLeft: null, epoch: e + 2 });
  });

  // why: SD-12
  it("restores pbs's day-start snapshot when one exists, and refuses a reset it cannot read rather than lose it", async () => {
    const a = w.admin();
    await a.query(`CREATE TABLE pbs_snapshot.invoice AS SELECT * FROM pbs.invoice WHERE false`);
    // Migration 0011 grants pbs SELECT on every snapshot table the owner creates (F-359); take it away to see the refusal.
    await a.query('REVOKE SELECT ON pbs_snapshot.invoice FROM pbs');
    await a.query(`INSERT INTO pbs_snapshot.invoice (job_number, received_at, how, total_cents, customer_name, done_at) VALUES (24781, '2026-09-14T20:52:00Z', 'received', 15640, 'Carmen Reyes', '2026-09-14T20:52:00Z')`);
    const e = await epochNow();
    const r = await fetch(`${w.pbsUrl()}/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ epoch: e + 1 }) });
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'snapshot_unreadable' });
    expect(await epochNow()).toBe(e);
    await a.query('GRANT SELECT ON pbs_snapshot.invoice TO pbs');
    expect(await w.client().reset(e + 1)).toEqual({ applied: true, epoch: e + 1 });
    expect(await w.rows('SELECT job_number, how FROM pbs.invoice')).toEqual([{ job_number: 24781, how: 'received' }]);
    await a.query('DROP TABLE pbs_snapshot.invoice');
  });

  // why: F-359
  it('reads a snapshot table the owner login creates after the migrations, with no grant of its own, so a reset applies', async () => {
    const a = w.admin();
    // As setup's writeSnapshot does (packages/setup/src/snapshot.ts): CREATE TABLE AS, by the owner login, after 0007.
    await a.query(`CREATE TABLE pbs_snapshot.invoice AS SELECT * FROM pbs.invoice WHERE false`);
    await a.query(`INSERT INTO pbs_snapshot.invoice (job_number, received_at, how, total_cents, customer_name, done_at) VALUES (24782, '2026-09-14T21:10:00Z', 'received', 8900, 'Ann Lee', '2026-09-14T21:10:00Z')`);
    const e = await epochNow();
    expect(await w.client().reset(e + 1)).toEqual({ applied: true, epoch: e + 1 });
    expect(await w.rows('SELECT job_number, how FROM pbs.invoice')).toEqual([{ job_number: 24782, how: 'received' }]);
    await a.query('DROP TABLE pbs_snapshot.invoice');
  });
});

describe('reads (API-65, API-66)', () => {
  // why: FR-BILL-4, FR-BILL-8
  it('lists invoices newest job first and shows 1 invoice with its lines and every call received', async () => {
    await w.setMode('up');
    const e = await epochNow();
    await post(9201, e);
    await post(9201, e);
    const list = await w.client().listInvoices() as unknown as { items: { jobNumber: number }[]; next: string | null };
    expect(list.items.map((i) => i.jobNumber)).toContain(9201);
    expect(list.next).toBeNull();
    const inv = await w.client().getInvoice(9201) as { lines: unknown[]; calls: { answer: string }[] };
    expect(inv.lines).toHaveLength(2);
    expect(inv.calls.map((c) => c.answer)).toEqual(['stored', 'already_have']);
    expect((await fetch(`${w.pbsUrl()}/invoices/1`)).status).toBe(404);
  });
});
