// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The P6-LIVE-ROUTING stack suite (ci/live-routing-stack.sh sets BW_LR_STACK_URL): SD-49's route source against the Compose stack with the
// routing service up. The file is *.stack.ts so neither the merge-set run nor the browser config picks it up. 1 file, run in order: the suite
// moves the shared demo clock, stops, pauses and starts the routing service, and resets the world last.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/live-routing-stack/*.stack.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
