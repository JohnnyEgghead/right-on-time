// SPDX-License-Identifier: AGPL-3.0-or-later
// The worker's pool (main.ts). F-2006 K-10.8: every connection carries the service timeouts of @bw/db, so a held lock or
// a runaway statement fails 1 pass (counted and logged) instead of holding 1 of the WORKER_POOL_MAX connections without
// end; the import job's own pool copies these options (./import/job.ts). F-2006 K-10.2: an idle connection's error is
// logged with its cause code, never a fixed word, and never ends the process.
import { createPool, SERVICE_TIMEOUTS } from '@bw/db';
import { logErrorEvents, type Logger } from '@bw/log';
import { WORKER_POOL_MAX } from './billing/link.ts';

export function workerPool(connectionString: string, log: Pick<Logger, 'error'>): ReturnType<typeof createPool> {
  const pool = createPool({
    connectionString, application_name: 'bw-worker', max: WORKER_POOL_MAX, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, ...SERVICE_TIMEOUTS,
  });
  logErrorEvents(pool, log);
  return pool;
}
