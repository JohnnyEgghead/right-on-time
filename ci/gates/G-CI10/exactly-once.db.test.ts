// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI10 inv10-billing-exactly-once (SPECIFICATIONS section 14 item 10; invariant 10; FR-BILL-3, FR-BILL-8,
// FR-BILL-11): on real PostgreSQL 18 with pbs over real HTTP (as bw_pbs) and the billing link as bw_worker.
// The late success at production timing is late-success.db.test.ts; this file runs the scaled world.
import { describe, expect, it } from 'vitest';
import { Temporal } from '../../../packages/time/src/index.ts';
import { inTransaction } from '../../../packages/db/src/client.ts';
import { markFixed } from '../../../apps/worker/src/billing/fixed.ts';
import { billFinishedJob, retryAll } from '../../../apps/worker/src/billing/queue.ts';
import { DEMO_START, useBillingWorld } from '../../../apps/worker/src/billing/testing.ts';
import { FINISH_PROBES } from './finish-probes.ts';

const HOLD_MS = 600;
const w = useBillingWorld({ holdMs: HOLD_MS, timeoutMs: 200 });
const at = (m: number) => Temporal.Instant.from(DEMO_START).add({ minutes: m });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const invoices = (job: number) => w.rows<{ how: string }>('SELECT how FROM pbs.invoice WHERE job_number = $1', [job]);
const calls = async (job: number) => (await w.rows<{ answer: string }>('SELECT answer FROM pbs."call" WHERE job_number = $1 ORDER BY at, id', [job])).map((c) => c.answer);
const billingItems = (job: number) => w.rows('SELECT 1 FROM world.billing_item WHERE job_number = $1', [job]);

describe('G-CI10: a late success then a retry leaves 1 invoice (scaled)', () => {
  // why: FR-BILL-8, invariant 10
  it('timeout, late store, retry answered already_have: 1 invoice, the item in billing', async () => {
    await w.setDemo(at(0).toString());
    await w.setMode('not_answering');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    expect(await w.link().runDue()).toBe(1);
    await pause(HOLD_MS + 300);
    await w.setMode('up');
    await w.setDemo(at(15).toString());
    await w.link().runDue();
    expect(await invoices(job)).toEqual([{ how: 'received' }]);
    expect(await calls(job)).toEqual(['stored_late', 'already_have']);
    expect((await w.rows<{ state: string }>('SELECT state FROM world.billing_item WHERE job_number = $1', [job]))[0]?.state).toBe('in_billing');
  });
});

describe('G-CI10: Mark fixed records 1 entered-by-hand invoice', () => {
  // why: FR-BILL-11, invariant 10
  it('a job marked fixed while its request is held keeps 1 invoice, entered by hand, and Retry all makes none', async () => {
    await w.setDemo(at(100).toString());
    await w.setMode('not_answering');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    await w.link().runDue(); // timeout; pbs still holds the request
    const by = (await w.rows<{ id: string }>(`SELECT id FROM world."user" LIMIT 1`))[0]!.id;
    expect(await markFixed({ pool: w.worker(), client: w.client() }, { jobNumber: job, reason: 'Entered in billing by hand', by, at: at(101) })).toEqual({ ok: true });
    await pause(HOLD_MS + 300); // the held request reaches store and finds the job's invoice
    expect(await invoices(job)).toEqual([{ how: 'entered_by_hand' }]);
    expect(await calls(job)).toEqual(['already_have']);
    await w.setMode('up');
    expect(await inTransaction(w.worker(), (tx) => retryAll(tx, { at: at(102) }))).toBe(0);
    await w.setDemo(at(130).toString());
    await w.link().runDue();
    expect(await invoices(job)).toHaveLength(1);
  });
});

describe('G-CI10: an old epoch is never stored', () => {
  // why: SD-12, invariant 10
  it('a planted request with an old epoch is answered wrong_epoch and never stored; the link retries it as down', async () => {
    await w.setMode('up');
    const job = await w.newJob();
    const inv = { jobNumber: job, customerName: 'Ann Lee', doneAt: at(0).toString(), sentAt: at(1).toString(), totalCents: 8900,
      lines: [{ kind: 'service' as const, label: 'Furnace tune-up', code: null, quantity: 1, unitCents: 8900, amountCents: 8900 }] };
    expect(await w.client().sendInvoice(inv, { worldEpoch: 0 })).toEqual({ outcome: 'down', httpStatus: 503, reason: 'wrong_epoch' });
    expect(await invoices(job)).toEqual([]);
    expect(await calls(job)).toEqual(['wrong_epoch']);
  });
});

describe('G-CI10: every finish path refuses a finish with neither parts nor No parts used', () => {
  // why: FR-BILL-3, invariant 10
  it('refuses through the validator, and refuses in the billing entry a finish that skipped it, rolling the finish back', async () => {
    const job = await w.newJob();
    expect(await w.finish(job, { laborMinutes: 45 })).toEqual({ refused: 'parts_required' });
    const err = await inTransaction(w.worker(), async (tx) => {
      await tx.query(`UPDATE world.job SET status = 'done', ended_at = $2, labor_minutes = 45 WHERE job_number = $1`, [job, at(0).toString()]);
      return billFinishedJob(tx, { jobNumber: job, at: at(0) });
    }).then(() => 'committed', (e: Error) => e.name);
    expect(err).toBe('BillingRefusedError');
    expect((await w.rows<{ status: string }>('SELECT status FROM world.job WHERE job_number = $1', [job]))[0]?.status).toBe('on_site');
    expect(await billingItems(job)).toEqual([]);
  });

  // why: FR-BILL-3, invariant 10
  it('drives every registered finish route (finish-probes.ts) with neither and gets parts_required, the job unfinished and unbilled', async () => {
    for (const probe of FINISH_PROBES) {
      const job = await w.newJob();
      const r = await probe.run({ admin: w.admin(), databaseUrl: w.url(), newOnSiteJob: () => w.newJob() }, job);
      expect(r.code, probe.id).toBe('parts_required');
      expect((await w.rows<{ status: string }>('SELECT status FROM world.job WHERE job_number = $1', [job]))[0]?.status, probe.id).not.toBe('done');
      expect(await billingItems(job), probe.id).toEqual([]);
    }
  });

  // why: FR-BILL-9, OI-8
  it('a No one home job creates no billing item', async () => {
    const job = await w.newJob();
    expect(await w.finish(job, { status: 'no_one_home' })).toEqual({ queued: false, why: 'not_finished' });
    await w.link().runDue();
    expect(await billingItems(job)).toEqual([]);
    expect(await invoices(job)).toEqual([]);
  });
});
