// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI7's database tests: the kernel's session store, the process logins and the production kernel on the real
// migrated schema (PostgreSQL 18 from @bw/db's test server, as packages/db/vitest.db.config.ts starts it).
// Run by ci/gates/G-CI7.sh; the merge set excludes *.db.test.ts.
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../../vitest.reporters.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..', '..'),
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: ['packages/api-server/src/**/*.db.test.ts'],
    exclude: ['**/node_modules/**'],
    globalSetup: ['packages/db/src/testing/global-setup.ts'],
    setupFiles: ['ci/gates/G-CI7/outside-fetch-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
