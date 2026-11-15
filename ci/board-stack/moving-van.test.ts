// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling (the board stack suite's moving-van wait, F-974; no product requirement)
import { describe, expect, it } from 'vitest';
import { movingVanWithin, type Van } from './moving-van.ts';

const van = (position: number, status = 'on_the_way'): Van => ({ technicianId: 't1', status, position });

/** A clock the fake wait advances, so the test spends no real time. */
function clock() {
  let t = 0;
  return { now: () => t, wait: async (ms: number) => void (t += ms), at: () => t };
}

describe('movingVanWithin', () => {
  it('returns a van the moment its position differs from the first read, without waiting out the window', async () => {
    // why: F-974
    const c = clock();
    const reads = [[van(1)], [van(1)], [van(2)]];
    const got = await movingVanWithin(async () => reads.shift() ?? [van(2)], { withinMs: 2_500, everyMs: 250, now: c.now, wait: c.wait });
    expect(got?.position).toBe(2);
    expect(c.at()).toBe(250);
  });

  it('returns undefined for a parked van after the window, and for a moving position on a van that is not on the way', async () => {
    // why: F-974 the planted known-bad: a van that never moves must still fail the suite's toBeDefined
    const c = clock();
    const parked = await movingVanWithin(async () => [van(1)], { withinMs: 2_500, everyMs: 250, now: c.now, wait: c.wait });
    expect(parked).toBeUndefined();
    expect(c.at()).toBe(2_500);
    let n = 0;
    const c2 = clock();
    const idle = await movingVanWithin(async () => [van(n++, 'parked')], { withinMs: 2_500, everyMs: 250, now: c2.now, wait: c2.wait });
    expect(idle).toBeUndefined();
  });

  // why: F-1000 the read at the limit is made: a van that first moves late in the window is found, one that moves after it is not
  it.each([[2_250, true], [2_400, true], [2_500, true], [2_600, false]])('a van that first moves at %i ms is found: %s', async (movesAt, found) => {
    const c = clock();
    const got = await movingVanWithin(async () => [van(c.at() >= movesAt ? 2 : 1)], { withinMs: 2_500, everyMs: 250, now: c.now, wait: c.wait });
    expect(got !== undefined).toBe(found);
  });
});
