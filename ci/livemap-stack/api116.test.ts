// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1420, F-1269 (the live map stack suite paces its cases by the web log's API-116 count, never past the link-token limit)
// The count and the wait of ci/livemap-stack/api116.ts against the limiter itself (packages/api-server/src/kernel/rate-limit.ts): the busiest window
// is over the limit exactly when the limiter refuses a call, and a case that starts after the wait and makes at most `room` calls is never refused.
import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../packages/api-server/src/kernel/rate-limit.ts';
import { busiest, LIMIT, parseWebLog, waitFor, WINDOW_MS } from './api116.ts';

const RULE = { scope: 'address' as const, limit: LIMIT, windowMs: WINDOW_MS };
/** The limiter's answers to calls at these times (epoch ms), 1 address. */
function refused(times: readonly number[]): number {
  let now = 0;
  const limiter = new RateLimiter({ realNow: () => ({ epochMilliseconds: now }) as never });
  let n = 0;
  for (const t of times) {
    now = t;
    if (!limiter.hit('API-116', RULE, '203.0.113.9')) n++;
  }
  return n;
}
/** A seeded run of call times: bursts of calls, as a case's page loads and reads make them, with gaps between. */
function burstyTimes(seed: number, count: number): number[] {
  let s = seed;
  const next = () => ((s = (s * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  const out: number[] = [];
  let t = 1_000_000;
  for (let i = 0; i < count; i++) {
    t += next() < 0.8 ? Math.floor(next() * 400) : Math.floor(next() * 9_000);
    out.push(t);
  }
  return out;
}

describe('the API-116 count of the web log (F-1420)', () => {
  // why: F-1420
  it('reads only API-116 answers, at the time the limiter counted them, and the newest stamp of any line', () => {
    const text = [
      'Listening on port 3000',
      '{"realTime":"2026-11-11T12:20:00.500Z","level":"info","process":"web","contract":"API-116","route":"/m/:t/data","status":200,"durationMs":120}',
      '{"realTime":"2026-11-11T12:20:01.000Z","level":"info","process":"web","contract":"API-12","route":"/api/v1/clock","status":200,"durationMs":3}',
      '{"realTime":"2026-11-11T12:19:59.000Z","level":"info","process":"web","contract":"API-116","route":"/m/:t/data","status":410,"durationMs":0}',
      '{not json',
      '',
    ].join('\n');
    const log = parseWebLog(text);
    expect(log.hits).toEqual([Date.parse('2026-11-11T12:19:59.000Z'), Date.parse('2026-11-11T12:20:00.380Z')]);
    expect(log.newest).toBe(Date.parse('2026-11-11T12:20:01.000Z'));
  });

  // why: F-1269
  it('finds a window over the limit exactly when the limiter refuses a call', () => {
    const over = new Set<boolean>();
    for (let seed = 1; seed <= 40; seed++) {
      const times = burstyTimes(seed, 150);
      expect(busiest(times) > LIMIT, `seed ${seed}`).toBe(refused(times) > 0);
      over.add(busiest(times) > LIMIT);
    }
    expect(over, 'the seeds hold runs over the limit and runs under it').toEqual(new Set([true, false]));
    // The window's edge: a call exactly WINDOW_MS old no longer counts, 1 ms younger it does.
    const full = Array.from({ length: LIMIT }, (_, i) => i);
    expect([busiest([...full, WINDOW_MS]), refused([...full, WINDOW_MS])]).toEqual([LIMIT, 0]);
    expect([busiest([...full, WINDOW_MS - 1]), refused([...full, WINDOW_MS - 1])]).toEqual([LIMIT + 1, 1]);
  });

  // why: F-1420, F-1269
  it('waits just long enough that a case of at most room calls is never refused', () => {
    const room = 20;
    let waited = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const before = burstyTimes(seed, 90);
      const now = before[before.length - 1]! + 500;
      const wait = waitFor(before, now, room);
      if (wait > 0) waited++;
      const start = now + wait;
      expect(before.filter((t) => start - t < WINDOW_MS).length, `seed ${seed}`).toBeLessThanOrEqual(LIMIT - room);
      if (wait > 0) expect(before.filter((t) => start - 1 - t < WINDOW_MS).length, `seed ${seed}: 1 ms sooner`).toBeGreaterThan(LIMIT - room);
      // The case's calls all at once, the worst a case can do: the limiter takes every one.
      expect(refused([...before, ...Array.from({ length: room }, () => start)]) - refused(before), `seed ${seed}`).toBe(0);
    }
    expect(waited, 'seeds whose last minute left too little room').toBeGreaterThan(0);
    expect(waitFor([], 1_000, room)).toBe(0);
  });
});
