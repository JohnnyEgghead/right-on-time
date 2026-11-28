// SPDX-License-Identifier: AGPL-3.0-or-later
// F-2006 K-10.2, J-24, K-10.8: the worker's failure ends with no database: a stop that rejects, a heartbeat whose write
// fails and an idle connection's error each log 1 line with the cause code; the worker's pool carries the service timeouts.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVICE_LOCK_TIMEOUT_MS, SERVICE_STATEMENT_TIMEOUT_MS } from '@bw/db';
import { createLogger } from '@bw/log';
import { startAlertJobs } from './alerts/jobs.ts';
import { stopWorker, type RunningJob } from './jobs.ts';
import { workerPool } from './pool.ts';

const coded = (code: string) => Object.assign(new Error('Harold Jenkins 6145550100'), { code });
const lines: Record<string, unknown>[] = [];
const log = createLogger({ process: 'worker', write: (l) => void lines.push(JSON.parse(l) as Record<string, unknown>) });
afterEach(() => void lines.splice(0));

describe('the worker stop (F-2006 J-24)', () => {
  // why: F-2006 J-24 a stop that rejected was dropped and the worker still exited 0, so a lost drain looked like a clean stop
  it('logs each rejected stop with its cause code and exits 1', async () => {
    const running: RunningJob[] = [
      { name: 'dispatcher', stop: async () => { throw coded('57P01'); } },
      { name: 'heartbeat', stop: async () => undefined },
    ];
    const exits: number[] = [];
    await stopWorker({ running, pool: { end: async () => { throw coded('ECONNRESET'); } }, log, exit: (c) => void exits.push(c) });
    expect(exits).toEqual([1]);
    expect(lines.map((l) => [l.status, l.errorCode])).toEqual([['stop failed', '57P01'], ['stop failed', 'ECONNRESET']]);
    expect(JSON.stringify(lines)).not.toMatch(/Harold|6145550100/);
  });

  // why: F-2006 J-24 the clean stop still exits 0
  it('exits 0 with no line when every stop and the pool end resolve', async () => {
    const exits: number[] = [];
    await stopWorker({ running: [{ name: 'dispatcher', stop: async () => undefined }], pool: { end: async () => undefined }, log, exit: (c) => void exits.push(c) });
    expect([exits, lines]).toEqual([[0], []]);
  });
});

describe('the heartbeat write that fails (F-2006 K-10.2)', () => {
  // why: F-2006 K-10.2 a failed heartbeat logged a fixed word with no cause, so the health page's 503 had no reason in the log
  it('logs 1 line with the cause code and keeps the job running', async () => {
    const pool = { query: async () => { throw coded('57P01'); } } as unknown as Parameters<typeof startAlertJobs>[0]['pool'];
    const job = await startAlertJobs({ pool, clock: { realNow: () => ({ toString: () => '2026-11-27T12:00:00Z' }) as never }, log });
    await job.stop();
    expect(lines.map((l) => [l.level, l.status, l.errorCode])).toEqual([['error', 'heartbeat failed', '57P01']]);
  });
});

describe('the worker pool (F-2006 K-10.2, K-10.8)', () => {
  // why: F-2006 K-10.8 no production pool set lock_timeout or statement_timeout, so a held row lock held a worker connection without end
  it('carries the service lock and statement timeouts on every connection', async () => {
    const pool = workerPool('postgres://nobody@127.0.0.1:1/none', log);
    try {
      expect(pool.options).toMatchObject({ lock_timeout: SERVICE_LOCK_TIMEOUT_MS, statement_timeout: SERVICE_STATEMENT_TIMEOUT_MS });
    } finally {
      await pool.end();
    }
  });

  // why: F-2006 K-10.2 an idle connection's error was logged with a fixed word and no cause code
  it('logs an idle connection error with its cause code and does not throw', async () => {
    const pool = workerPool('postgres://nobody@127.0.0.1:1/none', log);
    try {
      expect(() => (pool as unknown as EventEmitter).emit('error', coded('57P01'))).not.toThrow();
      expect(lines.map((l) => [l.status, l.errorCode])).toEqual([['unhandled error', '57P01']]);
    } finally {
      await pool.end();
    }
  });
});
