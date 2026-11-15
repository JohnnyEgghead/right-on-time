// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G-CI2's test set (inv2-never-dropped): every case file in ci/gates/G-CI2/ by glob (texts from P3-OUTBOX,
// billing from P3-BILLING: a lane's case joins by being a *.test.ts file here, with no edit to this file or the script),
// plus the outbox's own database tests (the try handler, the dispatcher, Try now, reply intake). Each file gets 1 fresh
// migrated database on 1 PostgreSQL 18 server that globalSetup starts (or BW_TEST_PG_URL names). Run by ci/gates/G-CI2.sh.
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../../vitest.reporters.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..', '..'),
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: [
      'ci/gates/G-CI2/**/*.test.ts',
      'packages/outbox/src/**/*.db.test.ts',
      'apps/worker/src/*.db.test.ts',
      'apps/worker/src/outbox/**/*.db.test.ts',
      'apps/worker/src/alerts/**/*.db.test.ts',
    ],
    exclude: ['**/node_modules/**'],
    globalSetup: ['packages/db/src/testing/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
