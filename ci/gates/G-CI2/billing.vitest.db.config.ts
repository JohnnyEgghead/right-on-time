// SPDX-License-Identifier: AGPL-3.0-or-later
// The G-CI2 billing case's own config (P3-BILLING): a real PostgreSQL 18 from @bw/db's test server, for running the
// billing case alone. G-CI2's runner (P3-OUTBOX) runs every test file in ci/gates/G-CI2/ with its own config, which
// must also start that server (packages/db/src/testing/global-setup.ts), since the billing case is a database test.
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../../vitest.reporters.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..', '..'),
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: ['ci/gates/G-CI2/billing-never-dropped.db.test.ts'],
    exclude: ['**/node_modules/**'],
    globalSetup: ['packages/db/src/testing/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
