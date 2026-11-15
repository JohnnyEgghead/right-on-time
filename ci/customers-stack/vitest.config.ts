// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The customers stack suite (P4-CUSTOMERS Acceptance), run by ci/shell-stack.sh after the week board suite and before the clock banner
// suite, on the same stack. It writes customers, so it runs its files and engines one after the other.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/customers-stack/*.stack.ts'],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
