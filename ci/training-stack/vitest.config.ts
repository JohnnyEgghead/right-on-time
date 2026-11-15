// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The P7-TRAINING suite (ci/training-stack.sh sets BW_TRAINING_BASE_URL and runs this): Playwright on Chromium and WebKit.
// The file is *.stack.ts so neither the merge-set run nor the browser config picks it up. One file, run in order: the 10 tasks share 1 world and 1 page.
export default defineConfig({
  test: {
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/training-stack/*.stack.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
