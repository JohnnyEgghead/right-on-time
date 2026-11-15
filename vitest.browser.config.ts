// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from './vitest.reporters.ts';

// Browser tests (Chromium and WebKit): every ci/**/*.pw.test.ts. Each gate script passes its own directory as a filter
// (page-walkers.sh: ci/page-walkers, look-values-comparator.sh: ci/look-values). Never run by the unit-tests gate.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: ['ci/**/*.pw.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
