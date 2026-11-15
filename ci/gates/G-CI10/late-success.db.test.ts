// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI10 at production timing (FR-BILL-5, FR-BILL-6, FR-BILL-8; invariant 10): the link's real 30-second timeout
// against pbs's real 60-second Not answering hold, so the late success order is the deployed one, not a scaled copy.
// About 61 s of real time.
import { describe, expect, it } from 'vitest';
import { BILLING_TIMEOUT_MS, NOT_ANSWERING_HOLD_MS } from '../../../packages/domain/src/index.ts';
import { Temporal } from '../../../packages/time/src/index.ts';
import { DEMO_START, useBillingWorld } from '../../../apps/worker/src/billing/testing.ts';

// No timeoutMs: the link is the production billing lane (billingLaneFor, the factory the worker registry wires), so the
// 30 s under test is the client's own default, as deployed; a changed default fails this case (F-383).
const w = useBillingWorld({ holdMs: NOT_ANSWERING_HOLD_MS });
const at = (m: number) => Temporal.Instant.from(DEMO_START).add({ minutes: m }).toString();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('G-CI10: a late success then a retry leaves 1 invoice (production timing)', () => {
  // why: FR-BILL-8, FR-BILL-6, invariant 10
  it('times out at 30 s, pbs stores at 60 s, the retry 15 demo minutes later answers already_have: 1 invoice', async () => {
    expect([BILLING_TIMEOUT_MS, NOT_ANSWERING_HOLD_MS]).toEqual([30_000, 60_000]);
    await w.setDemo(at(0));
    await w.setMode('not_answering');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    const t0 = performance.now();
    expect(await w.link().runDue()).toBe(1);
    const waited = performance.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(BILLING_TIMEOUT_MS - 50);
    expect(waited).toBeLessThan(NOT_ANSWERING_HOLD_MS);
    const first = await w.rows<{ result: string }>('SELECT result FROM world.billing_attempt WHERE job_number = $1', [job]);
    expect(first).toEqual([{ result: 'timeout' }]);
    expect(await w.rows('SELECT 1 FROM pbs.invoice WHERE job_number = $1', [job])).toEqual([]);
    await pause(NOT_ANSWERING_HOLD_MS - waited + 1_000);
    expect(await w.rows<{ how: string }>('SELECT how FROM pbs.invoice WHERE job_number = $1', [job])).toEqual([{ how: 'received' }]);
    await w.setMode('up');
    await w.setDemo(at(15));
    await w.link().runDue();
    expect(await w.rows<{ n: string }>('SELECT count(*) AS n FROM pbs.invoice WHERE job_number = $1', [job])).toEqual([{ n: '1' }]);
    const answers = await w.rows<{ answer: string }>('SELECT answer FROM pbs."call" WHERE job_number = $1 ORDER BY at, id', [job]);
    expect(answers.map((a) => a.answer)).toEqual(['stored_late', 'already_have']);
    const item = await w.rows<{ state: string; left_how: string }>('SELECT state, left_how FROM world.billing_item WHERE job_number = $1', [job]);
    expect(item).toEqual([{ state: 'in_billing', left_how: 'automatic_retry' }]);
  });
});
