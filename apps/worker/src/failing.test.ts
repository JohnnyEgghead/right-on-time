// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1846: a background loop step that keeps failing is seen as it lasts and when it ends. The reporter alone (./failing.ts),
// then through the real loops that use it: the dispatcher's pass (startDispatcher) and the clock job's replay step
// (startClockJobs), each with a fake real-time source so 25 real minutes pass in a few ms. No database: the dispatcher
// has no handlers, so a pass that starts makes no query, and the clock job's pool is a stand-in that throws, then answers
// no clock row.
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@bw/log';
import { Temporal } from '@bw/time';
import type { createPool } from '@bw/db';
import { startClockJobs } from './clock/index.ts';
import { startDispatcher } from './dispatcher.ts';
import { failingStep, REPEAT_FAILING_EVERY_MS } from './failing.ts';

const MIN = 60_000;

function capture() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ process: 'worker', write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });
  return { lines, log };
}

/** A thrown error whose message holds record text: the line must carry its code, never the words. */
const privateError = () => Object.assign(new Error('Harold Jenkins 6145550100 at 12 Oak St'), { code: '57P01' });

describe('a failing loop step is logged at once, every 10 real minutes, and on recovery (F-1846)', () => {
  // why: F-1846: a dispatcher pass that failed for hours logged 1 line and then nothing, so the outage looked over.
  it('logs the first failure, repeats once per 10 real minutes with the count since the last line, and recovers once', () => {
    const { lines, log } = capture();
    let t = 0;
    const step = failingStep(log, { failed: 'dispatcher pass failed', recovered: 'dispatcher pass recovered' }, () => t);
    for (; t < 25 * MIN; t += MIN) step.failed(privateError());
    step.ok();
    step.ok();
    expect(REPEAT_FAILING_EVERY_MS).toBe(10 * MIN);
    expect(lines.map((l) => [l.level, l.status, l.errorCode, l.failures])).toEqual([
      ['error', 'dispatcher pass failed', '57P01', 1],
      ['error', 'dispatcher pass failed', '57P01', 10],
      ['error', 'dispatcher pass failed', '57P01', 10],
      ['info', 'dispatcher pass recovered', undefined, 25],
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/Harold|6145550100|Oak/);
  });

  // why: F-1846: after a recovery the next outage must be seen at once, not 10 minutes into it.
  it('starts a new outage with its own first line after a recovery, and logs nothing for a healthy step', () => {
    const { lines, log } = capture();
    let t = 0;
    const step = failingStep(log, { failed: 'cleanup failed', recovered: 'cleanup recovered' }, () => t);
    step.ok();
    step.failed(new TypeError('x'));
    t += MIN;
    step.ok();
    t += MIN;
    step.failed(new RangeError('y'));
    expect(lines.map((l) => [l.status, l.errorCode, l.failures])).toEqual([
      ['cleanup failed', 'TypeError', 1],
      ['cleanup recovered', undefined, 1],
      ['cleanup failed', 'RangeError', 1],
    ]);
  });

  // why: F-1846 acceptance: a pass that fails for 25 real minutes logs 3 lines, then 1 recovery line, through the real loop.
  it('a dispatcher pass that fails for 25 real minutes logs 3 lines, then 1 recovery line', async () => {
    const { lines, log } = capture();
    let t = 0;
    const clock = {
      async worldEpoch() {
        // Each pass reads the epoch first: 1 real minute per pass, failing for the first 25 minutes.
        const now = t;
        t += MIN;
        if (now < 25 * MIN) throw privateError();
        return 1;
      },
      async demoNow() {
        return Temporal.Instant.from('2026-09-15T14:00:00Z');
      },
    };
    const d = startDispatcher({ pool: {} as never, clock, handlers: {}, log, intervalMs: 1, realMs: () => t - MIN });
    try {
      await vi.waitFor(() => expect(lines.some((l) => l.status === 'dispatcher pass recovered')).toBe(true), { timeout: 5000 });
    } finally {
      await d.stop();
    }
    expect(lines.map((l) => [l.level, l.status, l.errorCode, l.failures])).toEqual([
      ['error', 'dispatcher pass failed', '57P01', 1],
      ['error', 'dispatcher pass failed', '57P01', 10],
      ['error', 'dispatcher pass failed', '57P01', 10],
      ['info', 'dispatcher pass recovered', undefined, 25],
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/Harold|6145550100|Oak/);
  });

  // why: F-1846: a clock job step (the replay) that keeps failing repeats its line every 10 real minutes and logs its recovery.
  it('the clock job repeats a failing replay step every 10 real minutes and logs its recovery', async () => {
    const { lines, log } = capture();
    let t = 0;
    let down = true;
    const pool = {
      async query() {
        if (down) throw privateError();
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        throw privateError();
      },
    } as unknown as ReturnType<typeof createPool>;
    const clock = { realNow: () => Temporal.Instant.from('2026-11-16T12:00:00Z') } as never;
    const replay = (l: Record<string, unknown>) => String(l.status).startsWith('clock replay');
    const jobs = startClockJobs({
      pool, clock, log, realMs: () => t,
      settings: { PBS_URL: 'http://127.0.0.1:1', PHOTOS_DIR: '/nonexistent', IDLE_RESET_MINUTES: 60, NIGHTLY_RESET: false },
      dispatcher: { kinds: [], drainThrough: async () => ({ ran: 0, skipped: 0, failed: [] }) },
      billing: { reset: async () => { throw privateError(); } },
    });
    try {
      await vi.waitFor(() => expect(lines.filter(replay)).toHaveLength(1), { timeout: 5000 });
      t = 10 * MIN;
      await vi.waitFor(() => expect(lines.filter(replay)).toHaveLength(2), { timeout: 5000 });
      down = false;
      await vi.waitFor(() => expect(lines.filter(replay)).toHaveLength(3), { timeout: 5000 });
    } finally {
      await jobs.stop();
    }
    const got = lines.filter(replay);
    expect(got.map((l) => [l.level, l.status, l.errorCode])).toEqual([
      ['error', 'clock replay failed', '57P01'],
      ['error', 'clock replay failed', '57P01'],
      ['info', 'clock replay recovered', undefined],
    ]);
    expect(got[1]!.failures).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(lines)).not.toMatch(/Harold|6145550100|Oak/);
  });
});
