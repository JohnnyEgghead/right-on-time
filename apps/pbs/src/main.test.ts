// SPDX-License-Identifier: AGPL-3.0-or-later
// F-2006 J-21, K-10.8: the pretend billing service's pool, with no database (main.ts runs its start-up only as the entry).
import type { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { SERVICE_LOCK_TIMEOUT_MS, SERVICE_STATEMENT_TIMEOUT_MS } from '@bw/db';
import { createLogger } from '@bw/log';
import { pbsPool } from './main.ts';

describe('the pbs pool (F-2006 J-21)', () => {
  // why: F-2006 J-21 the pbs pool had no error listener, so an idle connection's error (a database restart) ended the process
  it('logs an idle connection error with its cause code and does not end the process', async () => {
    const lines: Record<string, unknown>[] = [];
    const pool = pbsPool('postgres://nobody@127.0.0.1:1/none', createLogger({ process: 'pbs', write: (l) => void lines.push(JSON.parse(l) as Record<string, unknown>) }));
    try {
      const e = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
      expect((pool as unknown as EventEmitter).listenerCount('error')).toBe(1);
      expect(() => (pool as unknown as EventEmitter).emit('error', e)).not.toThrow();
      expect(lines.map((l) => [l.process, l.status, l.errorCode])).toEqual([['pbs', 'unhandled error', '57P01']]);
    } finally {
      await pool.end();
    }
  });

  // why: F-2006 K-10.8 the pbs pool set no lock or statement timeout
  it('carries the service lock and statement timeouts', async () => {
    const pool = pbsPool('postgres://nobody@127.0.0.1:1/none', createLogger({ process: 'pbs', write: () => undefined }));
    try {
      expect(pool.options).toMatchObject({ lock_timeout: SERVICE_LOCK_TIMEOUT_MS, statement_timeout: SERVICE_STATEMENT_TIMEOUT_MS });
    } finally {
      await pool.end();
    }
  });
});
