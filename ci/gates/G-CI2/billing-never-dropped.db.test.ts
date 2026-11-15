// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI2 inv2-never-dropped, the billing case (P3-BILLING; SPECIFICATIONS section 14 item 2: "billing Down lists the job
// until Up"; invariant 2; FR-BILL-2, FR-BILL-7; UC-07). P3-OUTBOX owns the gate and its texts case; this
// file is the billing case only. Real PostgreSQL 18, pbs over real HTTP as bw_pbs, the billing link as bw_worker.
// At every step the job is accounted for: on the billing list with exactly 1 due billing event until it reaches
// billing, then sent once. Run in this lane by: pnpm exec vitest run --config ci/gates/G-CI2/billing.vitest.db.config.ts
import { describe, expect, it } from 'vitest';
import { Temporal } from '../../../packages/time/src/index.ts';
import { billingList } from '../../../apps/worker/src/billing/queue.ts';
import { DEMO_START, useBillingWorld } from '../../../apps/worker/src/billing/testing.ts';

const w = useBillingWorld({ holdMs: 600, timeoutMs: 200 });
const at = (m: number) => Temporal.Instant.from(DEMO_START).add({ minutes: m }).toString();

/** The job's account at 1 moment: listed or not, its state, its due billing events, its invoices. */
async function account(job: number, now: string) {
  const list = await billingList(w.worker(), { branchId: 'columbus', now: Temporal.Instant.from(now) });
  const due = await w.rows<{ kind: string; due_at: Date }>(`SELECT kind, due_at FROM world.scheduled_event WHERE subject = $1 AND kind LIKE 'billing.%' AND state = 'due'`, [String(job)]);
  const item = (await w.rows<{ state: string; tries: number }>('SELECT state, tries FROM world.billing_item WHERE job_number = $1', [job]))[0];
  const invoices = (await w.rows<{ n: string }>('SELECT count(*) AS n FROM pbs.invoice WHERE job_number = $1', [job]))[0]!.n;
  return { listed: list.waiting.some((x) => x.jobNumber === job), state: item?.state, tries: item?.tries, due: due.map((d) => [d.kind, d.due_at.toISOString()]), invoices: Number(invoices) };
}

describe('G-CI2 billing case: billing Down lists the job until Up, then sends it once', () => {
  // why: FR-BILL-2, UC-07, invariant 2
  it('with billing Down, the finished job is listed with 1 due retry at every 15-minute try, then Up sends it once', async () => {
    await w.setDemo(at(0));
    await w.setMode('down');
    const job = await w.newJob();
    expect(await w.finish(job, { parts: [{ code: 'FLT-16251', quantity: 1 }] })).toEqual({ queued: true });
    for (const [i, m] of [0, 15, 30, 45].entries()) {
      await w.setDemo(at(m));
      await w.link().runDue();
      expect(await account(job, at(m)), `try ${i + 1}`).toEqual({
        listed: true, state: 'retrying', tries: i + 1, due: [['billing.retry', new Date(at(m + 15)).toISOString()]], invoices: 0,
      });
    }
    await w.setMode('up');
    await w.setDemo(at(60));
    await w.link().runDue();
    expect(await account(job, at(60))).toEqual({ listed: false, state: 'in_billing', tries: 5, due: [], invoices: 1 });
    // Sent once: later passes make no call, and the 5 calls pbs received are 4 refusals and 1 store.
    await w.setDemo(at(120));
    await w.link().runDue();
    const calls = await w.rows<{ answer: string }>('SELECT answer FROM pbs."call" WHERE job_number = $1 ORDER BY at, id', [job]);
    expect(calls.map((c) => c.answer)).toEqual(['down', 'down', 'down', 'down', 'stored']);
  });

  // why: FR-BILL-2, invariant 2
  it('a stopped billing process (connection refused) also lists the job until pbs is back, then sends it once', async () => {
    await w.setDemo(at(200));
    await w.setMode('up');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    await w.stopPbs();
    await w.link().runDue();
    expect(await account(job, at(200))).toMatchObject({ listed: true, state: 'retrying', tries: 1, due: [['billing.retry', new Date(at(215)).toISOString()]] });
    const attempt = await w.rows<{ result: string; http_status: number | null; reason: string }>('SELECT result, http_status, reason FROM world.billing_attempt WHERE job_number = $1', [job]);
    expect(attempt).toEqual([{ result: 'down', http_status: null, reason: 'connection_failed' }]);
    await w.restartPbs();
    await w.setDemo(at(215));
    await w.link().runDue();
    expect(await account(job, at(215))).toEqual({ listed: false, state: 'in_billing', tries: 2, due: [], invoices: 1 });
  });

  // why: FR-BILL-7, invariant 2
  it('a data error stays listed for a person with no due event, never dropped and never retried by itself', async () => {
    await w.setDemo(at(300));
    await w.setMode('reject_next_n', 1);
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    for (const m of [300, 330, 360, 420]) {
      await w.setDemo(at(m));
      await w.link().runDue();
      expect(await account(job, at(m))).toEqual({ listed: true, state: 'waiting_person', tries: 1, due: [], invoices: 0 });
    }
  });
});
