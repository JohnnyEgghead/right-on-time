// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI8's database cases: the office text's 1-message rule through its real route (API-143, F-443), on the real migrated
// schema (PostgreSQL 18 from @bw/db's test server). Run by ci/gates/G-CI8.sh step 3; the merge set excludes *.db.test.ts.
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../../vitest.reporters.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..', '..'),
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: ['ci/gates/G-CI8/**/*.db.test.ts'],
    exclude: ['**/node_modules/**'],
    globalSetup: ['packages/db/src/testing/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
