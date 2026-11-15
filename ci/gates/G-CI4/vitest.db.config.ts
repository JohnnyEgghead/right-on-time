// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI4's database test: DbClock on the real system.demo_clock (PostgreSQL 18 from @bw/db's test server, as
// packages/db/vitest.db.config.ts starts it). Run by ci/gates/G-CI4.sh; the merge set excludes *.db.test.ts.
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../../vitest.reporters.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..', '..'),
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: ['ci/gates/G-CI4/**/*.db.test.ts'],
    exclude: ['**/node_modules/**'],
    globalSetup: ['packages/db/src/testing/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
