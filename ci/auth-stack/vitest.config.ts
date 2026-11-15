// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The P2-AUTH stack suite (ci/auth-stack.sh sets BW_AUTH_STACK_URL): Playwright on Chromium and WebKit against the Compose stack.
// The files are *.stack.ts so neither the merge-set run nor the browser config picks them up.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/auth-stack/*.stack.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Sign-in is rate limited by address (10 a minute, SPECIFICATIONS 7.1): the suites run one after the other.
    fileParallelism: false,
  },
});
