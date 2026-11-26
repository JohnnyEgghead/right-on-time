// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The end-to-end suite (ci/e2e-stack.sh sets BW_E2E_BASE_URL and runs this; the sign-off run sets it to the hosted demo): Playwright on Chromium and WebKit.
// The file is *.stack.ts so neither the merge-set run nor the browser config picks it up. One file, run in order: the 7 steps share 1 world and 1 clock.
export default defineConfig({
  test: {
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/e2e-stack/*.stack.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 180_000,
  },
});
