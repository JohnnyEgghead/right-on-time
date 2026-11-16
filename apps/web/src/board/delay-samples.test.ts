// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DELAY_BATCH_SIZE, DELAY_BATCH_WAIT_MS, delaySampler, type DelaySample, type SamplerEnv } from './delay-samples.ts';

/** A clock and timers the test moves by hand, and the page's hide. */
function fakeEnv() {
  let now = 1_000;
  let timer: { fn: () => void; at: number } | null = null;
  let hide: (() => void) | null = null;
  const env: SamplerEnv = {
    now: () => now,
    setTimer: (fn, ms) => (timer = { fn, at: now + ms }),
    clearTimer: () => { timer = null; },
    onHide: (fn) => {
      hide = fn;
      return () => { hide = null; };
    },
  };
  return {
    env,
    advance(ms: number) {
      now += ms;
      if (timer && timer.at <= now) {
        const t = timer;
        timer = null;
        t.fn();
      }
    },
    hide: () => hide?.(),
    hasHide: () => hide !== null,
  };
}
const recorder = () => {
  const sent: { samples: DelaySample[]; keepalive: boolean }[] = [];
  return { sent, send: async (samples: DelaySample[], keepalive: boolean) => { sent.push({ samples, keepalive }); } };
};

describe('the board tab\'s delay samples (API-172, SD-43)', () => {
  // why: F-885 the samples a tab holds leave in 1 request 5 s after the first, each with the ms it was held, not 1 post per seq
  it('sends the held samples in 1 request 5 s after the first, with each sample\'s held time', () => {
    const f = fakeEnv();
    const r = recorder();
    const s = delaySampler(r.send, f.env);
    s.hold([11, 12]);
    f.advance(1_200);
    s.hold([13, 0]);
    expect(r.sent).toEqual([]);
    f.advance(DELAY_BATCH_WAIT_MS - 1_200);
    expect(r.sent).toEqual([{ samples: [{ seq: 11, heldMs: 5_000 }, { seq: 12, heldMs: 5_000 }, { seq: 13, heldMs: 3_800 }], keepalive: false }]);
  });

  // why: F-885, F-640 a burst of 20 leaves at once in 1 request, so the slowest is not delayed by the sampler's own queue
  it('sends at once when it holds 20', () => {
    const f = fakeEnv();
    const r = recorder();
    const s = delaySampler(r.send, f.env);
    s.hold(Array.from({ length: DELAY_BATCH_SIZE }, (_, i) => i + 1));
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.samples).toHaveLength(DELAY_BATCH_SIZE);
    expect(r.sent[0]!.samples.every((x) => x.heldMs === 0)).toBe(true);
    f.advance(DELAY_BATCH_WAIT_MS);
    expect(r.sent).toHaveLength(1);
  });

  // why: F-885 a hidden page sends what it holds with keepalive; closing sends the rest and stops listening
  it('sends with keepalive when the page is hidden, and the rest on close', () => {
    const f = fakeEnv();
    const r = recorder();
    const s = delaySampler(r.send, f.env);
    s.hold([5]);
    f.advance(300);
    f.hide();
    expect(r.sent).toEqual([{ samples: [{ seq: 5, heldMs: 300 }], keepalive: true }]);
    s.hold([6]);
    s.close();
    expect(r.sent[1]).toEqual({ samples: [{ seq: 6, heldMs: 0 }], keepalive: false });
    expect(f.hasHide()).toBe(false);
  });

  // why: F-640, F-885 a failed send is only missed samples: later samples still go
  it('lets a failed send pass', () => {
    const f = fakeEnv();
    const sent: number[][] = [];
    const s = delaySampler(async (samples) => {
      sent.push(samples.map((x) => x.seq));
      if (sent.length === 1) throw new Error('down');
    }, f.env);
    s.hold([1]);
    s.flush();
    s.hold([2]);
    s.flush();
    expect(sent).toEqual([[1], [2]]);
  });
});
