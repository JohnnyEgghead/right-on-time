// SPDX-License-Identifier: AGPL-3.0-or-later
// Test support (not product code; the image leaves out **/src/testing): the worker as main.ts starts it, through the
// real job registry, with the real pool login bw_worker and DbClock on the real system.demo_clock row. Only the
// clock's cache is off (so a test that moves the clock row is read at once) and log lines are kept for the test.
import { loadConfig } from '@bw/config';
import { createLogger } from '@bw/log';
import { DbClock, Temporal, type Clock, type Instant } from '@bw/time';
import { loginPool } from '../../../../packages/outbox/src/testing/world.ts';
import type { Dispatcher } from '../dispatcher.ts';
import { startJobs, stopJobs, type RunningJob } from '../jobs.ts';

export interface TestWorker {
  pool: ReturnType<typeof loginPool>;
  dispatcher: Dispatcher;
  logs: string[];
  /** Run 1 dispatcher pass at the clock row's current time. */
  drain: Dispatcher['drain'];
  stop(): Promise<void>;
}

/**
 * `real`: the real time every job reads (the clock's own reading and each named real-time use), for a test that moves
 * the clock through the clock job (P3-REPLAY). Absent: the clock reads a fixed real anchor and the named uses read the
 * wall, as before.
 */
export async function startTestWorker(databaseUrl: string, env: Record<string, string> = {}, opts: { real?: () => Instant } = {}): Promise<TestWorker> {
  const pool = loginPool(databaseUrl, 'bw_worker');
  const logs: string[] = [];
  const log = createLogger({ process: 'worker', level: 'debug', write: (l) => logs.push(l) });
  // A fixed real anchor: the clock row is paused, so demo now is its demo_anchor (section 4.2: no wall time in a test).
  const db = new DbClock(pool, { cacheMs: 0, real: opts.real ?? (() => Temporal.Instant.from('2026-11-01T16:00:00Z')) });
  const real = opts.real;
  const clock: Clock = real ? { demoNow: () => db.demoNow(), worldEpoch: () => db.worldEpoch(), realNow: () => real() } : db;
  const running: RunningJob[] = await startJobs({ pool, clock, log, settings: loadConfig(env) });
  const dispatcher = running.find((j) => j.name === 'event-dispatcher') as Dispatcher | undefined;
  if (!dispatcher) throw new Error('the job registry starts no event dispatcher');
  return {
    pool,
    dispatcher,
    logs,
    drain: () => dispatcher.drain(),
    async stop() {
      await stopJobs(running);
      await pool.end();
    },
  };
}
