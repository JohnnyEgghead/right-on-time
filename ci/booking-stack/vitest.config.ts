// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The P5-BOOKING stack suite (ci/booking-stack.sh sets BW_BOOKING_STACK_URL and runs this): Playwright on Chromium and WebKit against the Compose stack.
// The files are *.stack.ts so neither the merge-set run nor the browser config picks them up. One file, run in order: it sets the shared demo clock by
// SQL and puts it back after.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/booking-stack/*.stack.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
