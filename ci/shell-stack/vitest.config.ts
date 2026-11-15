// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The P2-SHELL stack suite (ci/shell-stack.sh sets BW_SHELL_STACK_URL): Playwright on Chromium and WebKit against the
// Compose stack. The files are *.stack.ts so neither the merge-set run nor the browser config picks them up.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/shell-stack/*.stack.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
