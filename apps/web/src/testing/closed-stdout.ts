// SPDX-License-Identifier: AGPL-3.0-or-later
// A process for process-errors.test.ts (F-1939): the web hook installed, then the parent closes this process's stdout pipe and the
// next write fails with EPIPE. A process that does not spin uses little CPU in the pause and exits 0.
import { createLogger } from '@bw/log';
import { logProcessErrorsAndKeepServing } from '../process-errors.ts';

const log = createLogger({ process: 'web' });
logProcessErrorsAndKeepServing(log);
// The writes the closed pipe refuses; each failure comes back as an uncaught exception.
log.info({ status: 'listening' });
setTimeout(() => log.info({ status: 'stopping' }), 300);
setTimeout(() => {
  // The CPU time used so far goes to the parent over the IPC channel (stdout is closed); a process caught in the loop has used all of the wall time.
  process.send?.(process.cpuUsage(), () => process.exit(0));
}, 1500);
