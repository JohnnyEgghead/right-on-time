// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The P4-ADMIN-WINDOWS stack suite (ci/windows-stack.sh sets BW_WINDOWS_STACK_URL): Playwright on Chromium and WebKit against the Compose stack. The
// files are *.stack.ts so neither the merge-set run nor the browser config picks them up. One file, run in order: the suite moves the shared demo
// clock forward (to 6:05 PM, for the reminder text), switches Wed, Sep 16 and edits a window's capacity, and puts each back before its engine ends.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/windows-stack/*.stack.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
