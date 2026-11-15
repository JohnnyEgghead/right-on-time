// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The P4-BOARD stack suite (ci/board-stack.sh sets BW_BOARD_STACK_URL): Playwright on Chromium and WebKit against the
// Compose stack. The files are *.stack.ts so neither the merge-set run nor the browser config picks them up. One file,
// run in order: the suite moves the shared demo clock forward (7:00 AM, 10:00 AM, 10:30 AM, then 2:00 PM).
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/board-stack/*.stack.ts'],
    fileParallelism: false,
    // F-854: expect.poll waits 1 s by default; a Playwright read on a loaded host (the map panel cases, load 40 to 150) needs longer.
    expect: { poll: { timeout: 30_000, interval: 100 } },
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
