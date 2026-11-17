// SPDX-License-Identifier: AGPL-3.0-or-later
// A process for process-errors.test.ts (F-1870, F-1872): the web hook installed as server.ts installs it, then Next.js's own
// installProcessErrorHandlers (the real code of the installed next, called as next-server.js and route-module.js call it), then
// afterNext(), then 1 real unhandled rejection and 1 real uncaught exception. A process that survives both prints 'still serving'.
// BW_TEST_NO_HOOK=1 leaves the hook out, so the same run shows what Next prints on its own (the control).
import { createRequire } from 'node:module';
import { createLogger } from '@bw/log';
import { logProcessErrorsAndKeepServing } from '../process-errors.ts';

const log = createLogger({ process: 'web' });
const hook = process.env.BW_TEST_NO_HOOK === '1' ? null : logProcessErrorsAndKeepServing(log);
const require = createRequire(import.meta.url);
const { installProcessErrorHandlers } = require('next/dist/server/node-environment-extensions/process-error-handlers') as {
  installProcessErrorHandlers(removeExisting: boolean): void;
};
installProcessErrorHandlers(false);
hook?.afterNext();
// A route module loaded after start adds Next's rejection listener again unless the hook's is the one it finds.
installProcessErrorHandlers(false);

void Promise.reject(new TypeError('private words 6145550100 at 1 Main St'));
setTimeout(() => {
  throw new RangeError('private words 2 at 2 Oak Ave');
}, 20);
setTimeout(() => {
  // The marker is the test script's own word to its parent test, not a product log line.
  // eslint-disable-next-line bw/log-allowlist
  console.log('still serving');
  process.exit(0);
}, 80);
