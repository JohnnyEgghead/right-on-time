// SPDX-License-Identifier: AGPL-3.0-or-later
// The database test set (P2-SCHEMA): every *.db.test.ts, against 1 real PostgreSQL 18 server that globalSetup starts
// (or BW_TEST_PG_URL names), each file in its own fresh database. Run by ci/gates/schema-gates.sh (wave gate
// schema-gates); the merge-set unit tests exclude these files (vitest.config.ts).
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..'),
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: ['packages/db/src/**/*.db.test.ts', 'ci/gates/schema-gates/**/*.db.test.ts'],
    exclude: ['**/node_modules/**'],
    globalSetup: ['packages/db/src/testing/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
