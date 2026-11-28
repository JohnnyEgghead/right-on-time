// SPDX-License-Identifier: AGPL-3.0-or-later
// The pbs process (SPECIFICATIONS SD-3: web, worker and pbs are 1 image with 3 entry points; section 6.6 FR-BILL-4):
// the pretend billing service on pbs:8090 inside the Compose network, signed in to the database as bw_pbs (role pbs,
// schemas pbs and pbs_snapshot only). It creates its 1 mode row when absent, then serves until SIGTERM.
import { configOrExit, databasePasswordOrExit, exitWithMessage } from '@bw/config';
import { createPool, SERVICE_TIMEOUTS } from '@bw/db';
import { createLogger, exitOnUncaughtException, exitOnUnhandledRejection, logErrorEvents, type Logger } from '@bw/log';
import { startPbs } from './server.ts';
import { ensureModeRow } from './store.ts';

/** The port of section 4.5 (`http://pbs:8090`). */
export const PBS_PORT = 8090;

/**
 * pbs's pool. F-2006 J-21: an idle connection's error event (the server ended it) is logged with its cause code; with no
 * listener it threw, and the process ended on it. F-2006 K-10.8: the service timeouts of @bw/db on every connection.
 */
export function pbsPool(connectionString: string, log: Pick<Logger, 'error'>): ReturnType<typeof createPool> {
  const pool = createPool({ connectionString, max: 10, ...SERVICE_TIMEOUTS });
  logErrorEvents(pool, log);
  return pool;
}

if (import.meta.main) {
  const settings = configOrExit();
  const password = databasePasswordOrExit(settings);
  if (!settings.DATABASE_URL) exitWithMessage('ConfigError: invalid setting DATABASE_URL: the pbs process needs a database', 78);
  // Lines go through @bw/log (log-allowlist, F-234), so each carries the real-time stamp (NFR-05, F-190).
  const log = createLogger({ process: 'pbs', level: settings.LOG_LEVEL });
  // F-1845: a rejection no code handled is an error line with its cause code, then exit 1 (Compose restarts the process).
  exitOnUnhandledRejection(log);
  // F-1870: the same for an exception no code caught, so Node's default (the message and stack on stderr) never prints.
  exitOnUncaughtException(log);
  // The password goes into the in-memory URL: pg lets the URL's (absent) password override a separate field.
  const url = new URL(settings.DATABASE_URL);
  if (password !== undefined) url.password = encodeURIComponent(password);
  const pool = pbsPool(url.toString(), log);
  log.info({ status: 'started' });
  try {
    await ensureModeRow(pool);
  } catch (e) {
    exitWithMessage(`pbs could not reach its database: ${(e as { code?: string }).code ?? 'error'}`, 1);
  }
  const pbs = await startPbs({ pool, log, host: '0.0.0.0', port: PBS_PORT });
  log.info({ status: 'listening' });
  const stop = () => {
    log.info({ status: 'stopping' });
    void pbs.close().finally(() => void pool.end().finally(() => process.exit(0)));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
