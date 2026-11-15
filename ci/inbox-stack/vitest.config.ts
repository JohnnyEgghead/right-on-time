// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The P5-INBOX stack suite (ci/inbox-stack.sh sets BW_INBOX_STACK_URL): Playwright on Chromium and WebKit against the Compose stack. The files
// are *.stack.ts so neither the merge-set run nor the browser config picks them up. One file, run in order: the suite moves the shared demo clock
// forward for the text tries.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/inbox-stack/*.stack.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
