// SPDX-License-Identifier: AGPL-3.0-or-later
// The worker process (SPECIFICATIONS section 2, SD-3: web, worker and pbs are 1 image with 3 entry points). It signs in
// as bw_worker, reads demo time from the 1 clock (@bw/time DbClock), starts every job of the registry (./jobs.ts) and
// stops them on SIGTERM. A job joins in jobs.ts, never here (F-269).
import { configOrExit, ConfigError, databasePassword, exitWithMessage } from '@bw/config';
import { createPool } from '@bw/db';
import { createLogger } from '@bw/log';
import { DbClock } from '@bw/time';
import { configureRouting, ROUTING_SERVICE_URL } from '../../../packages/maps/src/route-source.ts';
import { WORKER_POOL_MAX } from './billing/link.ts';
import { startJobs, stopJobs, type RunningJob } from './jobs.ts';

const settings = configOrExit();
let password: string | undefined;
try {
  password = databasePassword(settings);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  exitWithMessage(`${e.name}: ${e.message}`, 78);
}
if (!settings.DATABASE_URL) exitWithMessage('invalid setting DATABASE_URL: the worker process needs a database', 78);
// The password goes into the in-memory URL: pg lets the URL's (absent) password override a separate `password` field.
const url = new URL(settings.DATABASE_URL);
if (password !== undefined) url.password = encodeURIComponent(password);

// Lines go through @bw/log (log-allowlist, F-234), so each carries the real-time stamp (NFR-05, F-190).
const log = createLogger({ process: 'worker', level: settings.LOG_LEVEL });
const pool = createPool({ connectionString: url.toString(), application_name: 'bw-worker', max: WORKER_POOL_MAX, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
pool.on('error', () => log.error({ status: 'unhandled error', errorCode: 'server_error' }));
const clock = new DbClock(pool);
// SD-49: the ETA sweep's and the autopilot's legs a stored track does not cover are asked of the routing service (P6-LIVE-ROUTING).
configureRouting({ url: ROUTING_SERVICE_URL, log });

let running: RunningJob[] = [];
try {
  running = await startJobs({ pool, clock, log, settings });
} catch {
  log.error({ status: 'unhandled error', errorCode: 'job_start_failed' });
  await pool.end().catch(() => undefined);
  process.exit(1);
}
log.info({ status: 'started' });

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  log.info({ status: 'stopping' });
  void stopJobs(running)
    .then(() => pool.end())
    .finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
