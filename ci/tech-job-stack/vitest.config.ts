// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The web technician app's job screens (ci/tech-job-stack.sh sets BW_TECH_JOB_STACK_URL): Playwright on WebKit and Chromium against the
// Compose stack. The file is *.stack.ts so neither the merge-set run nor the browser config picks it up. One file, run in order on 1 shared
// world: the engines take turns on Harold Jenkins's jobs, each with its own notes, photos and Sep 15 finish job.
export default defineConfig({
  test: {
    reporters: junitReporters(), // F-1038: the gate runner's BW_JUNIT_DIR junit file, so these tests reach the per-test history (F-974)
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/tech-job-stack/*.stack.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 300_000,
    hookTimeout: 240_000,
  },
});
