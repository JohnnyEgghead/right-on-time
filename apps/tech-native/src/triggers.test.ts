// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-4, FR-IOS-1, F-991 item b: the 60 s timer trigger, which the simulator suite never waits for (it sends on focus).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTriggers } from './triggers.ts';

afterEach(() => vi.useRealTimers());

describe('startTriggers (SD-47: open, focus, every 60 s)', () => {
  // why: FR-TECH-4 the timer alone drives a send, with no focus change
  it('sends on open, on focus, and on every timer tick without a focus change', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let focus: (s: string) => void = () => undefined;
    startTriggers(
      { open: async () => void calls.push('open'), sync: async () => void calls.push('sync') },
      { onAppState: (fn) => { focus = fn; }, setInterval: (fn, ms) => setInterval(fn, ms) },
      60_000,
    );
    expect(calls).toEqual(['open']);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls).toEqual(['open']);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['open', 'sync']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toEqual(['open', 'sync', 'sync', 'sync']);
    focus('background');
    expect(calls).toHaveLength(4);
    focus('active');
    expect(calls).toHaveLength(5);
  });
});
