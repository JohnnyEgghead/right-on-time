// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The P5-TWA-TODAY stack suite (ci/today-stack.sh sets BW_TODAY_URL): Playwright on Chromium and WebKit against the Compose stack after a fresh
// setup. The file is *.stack.ts so neither the merge-set run nor the browser config picks it up. The cases share 1 world and run in order.
export default defineConfig({
  test: {
    reporters: junitReporters(), // F-1038: the gate runner's BW_JUNIT_DIR junit file, so these tests reach the per-test history (F-974)
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/today-stack/*.stack.ts'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
