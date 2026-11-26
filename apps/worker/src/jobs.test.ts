// SPDX-License-Identifier: AGPL-3.0-or-later
// The worker's job registry (F-357): 1 dispatcher with 2 claim lanes, billing in the parallel lane through the
// production factory, its width below the worker's pool, and no kind in both lanes. No database: the registry entries
// are built, not started.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@bw/config';
import { BILLING_EVENT_KINDS } from '@bw/domain';
import { createLogger } from '@bw/log';
import { BILLING_CONCURRENCY, billingLaneFor, WORKER_POOL_MAX } from './billing/link.ts';
import { eventHandlers, eventLanes, giveUpsFor, type WorkerDeps } from './jobs.ts';

const deps = { settings: loadConfig({}), log: createLogger({ process: 'worker', write: () => undefined }) } as unknown as WorkerDeps;

describe('the worker registry wires billing as the dispatcher billing lane (F-357)', () => {
  // why: F-357, F-269
  it('registers the production billing lane factory, with the 2 billing kinds, in eventLanes and not in eventHandlers', () => {
    expect(eventLanes).toContain(billingLaneFor);
    const lanes = eventLanes.map((make) => make(deps));
    const billing = lanes.find((l) => l.name === 'billing');
    expect([...(billing?.kinds ?? [])].sort()).toEqual([...BILLING_EVENT_KINDS].sort());
    const serial = new Set(eventHandlers.map(([kind]) => kind));
    for (const lane of lanes) for (const kind of lane.kinds) expect(serial.has(kind)).toBe(false);
  });

  // why: F-382, F-357
  it('keeps the billing lane narrower than the worker pool, and main.ts builds its pool with that size', () => {
    const billing = billingLaneFor(deps);
    expect(billing.concurrency).toBe(BILLING_CONCURRENCY);
    expect(BILLING_CONCURRENCY).toBeLessThan(WORKER_POOL_MAX);
    expect(BILLING_CONCURRENCY).toBeGreaterThanOrEqual(1);
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/createPool\(\{[^}]*max: WORKER_POOL_MAX[,\s]/);
  });

  // why: F-1844, F-368: a serial kind with no give-up retried a failing event every pass for ever with no end record.
  it('gives every serial-lane kind a give-up, and no kind outside the serial lane', () => {
    const serial = eventHandlers.map(([kind]) => kind).sort();
    expect(Object.keys(giveUpsFor(deps)).sort()).toEqual(serial);
    expect(serial).toEqual(['alert.check', 'autopilot.step', 'eta.sweep', 'text.reminder', 'text.try']);
  });

  // why: F-357
  it('keys billing events by job, so 1 job runs 1 at a time and 2 jobs run apart', () => {
    const lane = billingLaneFor(deps);
    const ev = (subject: string, payload: Record<string, unknown>) => ({ id: 'e', dueAt: undefined as never, kind: 'billing.send', subject, payload });
    expect(lane.keyOf(ev('24825', { jobNumber: 24825 }))).toBe(lane.keyOf(ev('24825', {})));
    expect(lane.keyOf(ev('24825', { jobNumber: 24825 }))).not.toBe(lane.keyOf(ev('24826', { jobNumber: 24826 })));
  });
});
