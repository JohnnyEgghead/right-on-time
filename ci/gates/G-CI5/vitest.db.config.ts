// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI5's database cases: the live map's page and data on the real migrated schema (PostgreSQL 18 from @bw/db's test server, as
// packages/db/vitest.db.config.ts starts it), through the production web kernel. A later lane adds its own *.db.test.ts file here.
// Run by ci/gates/G-CI5.sh; the merge set excludes *.db.test.ts.
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../../vitest.reporters.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..', '..'),
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: ['ci/gates/G-CI5/**/*.db.test.ts'],
    exclude: ['**/node_modules/**'],
    globalSetup: ['packages/db/src/testing/global-setup.ts'],
    setupFiles: ['ci/gates/G-CI7/outside-fetch-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
