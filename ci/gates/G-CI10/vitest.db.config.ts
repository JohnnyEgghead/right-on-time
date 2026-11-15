// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI10's database tests: pbs and the billing link on the real migrated schema (PostgreSQL 18 from @bw/db's test
// server, as packages/db/vitest.db.config.ts starts it), pbs over real HTTP as bw_pbs, the link as bw_worker.
// Run by ci/gates/G-CI10.sh; the merge set excludes *.db.test.ts.
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../../vitest.reporters.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..', '..'),
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: ['apps/pbs/src/**/*.db.test.ts', 'apps/worker/src/billing/**/*.db.test.ts', 'ci/gates/G-CI10/**/*.db.test.ts'],
    exclude: ['**/node_modules/**'],
    globalSetup: ['packages/db/src/testing/global-setup.ts'],
    testTimeout: 150_000,
    hookTimeout: 120_000,
  },
});
