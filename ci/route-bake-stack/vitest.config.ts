// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The P6-ROUTE-BAKE stack suite (ci/route-bake-stack.sh sets BW_ROUTE_STACK_URL): API-104 and the baked steps against the Compose stack. The
// file is *.stack.ts so neither the merge-set run nor the browser config picks it up. 1 file, run in order: the suite moves the shared demo
// clock, puts 1 of Maria's jobs on the way and back, and resets the world last.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/route-bake-stack/*.stack.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
