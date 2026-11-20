// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The P9-UG-WEB stack suite (ci/job-stack.sh sets BW_JOB_STACK_URL): Playwright on Chromium and WebKit against the job stack, after its
// other suites. The files are *.stack.ts so neither the merge-set run nor the browser config picks them up. One file, run in order.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/ug-web-stack/*.stack.ts'],
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 180_000,
  },
});
