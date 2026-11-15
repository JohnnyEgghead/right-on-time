// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The clock banner suite (P3-REPLAY Acceptance), run by ci/shell-stack.sh after the shell suite, on the same stack: it
// jumps the shared clock, so it runs after every test that reads the fixture's 10:41 AM.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/clock-banner/*.stack.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
