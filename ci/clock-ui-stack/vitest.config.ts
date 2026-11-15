// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The P4-CLOCK stack suite (ci/clock-ui-stack.sh sets BW_CLOCK_UI_URL): Playwright on Chromium and WebKit against the Compose stack after a fresh
// setup. The file is *.stack.ts so neither the merge-set run nor the browser config picks it up. The cases share 1 world and run in order.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/clock-ui-stack/*.stack.ts'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
