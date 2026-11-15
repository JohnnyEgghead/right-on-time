// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The P4-BILLING-UI stack suite (ci/billing-stack.sh sets BW_BILLING_STACK_URL): Playwright on Chromium and WebKit against the Compose
// stack. The files are *.stack.ts so neither the merge-set run nor the browser config picks them up.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/billing-stack/*.stack.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The tests share one database, one pretend billing mode and one worker: they run in order, one at a time.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
