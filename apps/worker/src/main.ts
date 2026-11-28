// SPDX-License-Identifier: AGPL-3.0-or-later
// The worker process (SPECIFICATIONS section 2, SD-3: web, worker and pbs are 1 image with 3 entry points). It signs in
// as bw_worker, reads demo time from the 1 clock (@bw/time DbClock), starts every job of the registry (./jobs.ts) and
// stops them on SIGTERM. A job joins in jobs.ts, never here (F-269).
import { configOrExit, databasePasswordOrExit, exitWithMessage } from '@bw/config';
import { causeCodeOf, createLogger, exitOnUncaughtException, exitOnUnhandledRejection } from '@bw/log';
import { DbClock } from '@bw/time';
import { configureRouting, ROUTING_SERVICE_URL } from '../../../packages/maps/src/route-source.ts';
import { startJobs, stopWorker, type RunningJob } from './jobs.ts';
import { workerPool } from './pool.ts';

const settings = configOrExit();
const password = databasePasswordOrExit(settings);
if (!settings.DATABASE_URL) exitWithMessage('invalid setting DATABASE_URL: the worker process needs a database', 78);
// The password goes into the in-memory URL: pg lets the URL's (absent) password override a separate `password` field.
const url = new URL(settings.DATABASE_URL);
if (password !== undefined) url.password = encodeURIComponent(password);

// Lines go through @bw/log (log-allowlist, F-234), so each carries the real-time stamp (NFR-05, F-190).
const log = createLogger({ process: 'worker', level: settings.LOG_LEVEL });
// F-1845: a rejection no code handled is an error line with its cause code, then exit 1 (Compose restarts the process).
exitOnUnhandledRejection(log);
// F-1870: the same for an exception no code caught, so Node's default (the message and stack on stderr) never prints.
exitOnUncaughtException(log);
// F-2006 K-10.8, K-10.2: the pool's timeouts and its error line with the cause code (./pool.ts).
const pool = workerPool(url.toString(), log);
const clock = new DbClock(pool);
// SD-49: the ETA sweep's and the autopilot's legs a stored track does not cover are asked of the routing service (P6-LIVE-ROUTING).
configureRouting({ url: ROUTING_SERVICE_URL, log });

let running: RunningJob[] = [];
try {
  running = await startJobs({ pool, clock, log, settings });
} catch (e) {
  // F-2006 J-24: the cause code of the job that could not start.
  log.error({ status: 'job start failed', errorCode: causeCodeOf(e) });
  await pool.end().catch(() => undefined);
  process.exit(1);
}
log.info({ status: 'started' });

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  log.info({ status: 'stopping' });
  // F-2006 J-24: a stop that rejects is logged and exits 1.
  void stopWorker({ running, pool, log, exit: (code) => process.exit(code) });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
