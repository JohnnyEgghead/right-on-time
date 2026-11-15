// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI1's database tests: the server cases of invariant 1 (the 36 conflict-table cells, a repeated key, and the item
// protocol's own tests in packages/api-server/src/tech-items) on the real migrated schema (PostgreSQL 18 from @bw/db's
// test server, as packages/db/vitest.db.config.ts starts it). Run by ci/gates/G-CI1.sh; the merge set excludes
// *.db.test.ts. P5-TWA-OUTBOX adds the client cases as their own files under ci/gates/G-CI1/ (BUILD_PLAN D-15).
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../../vitest.reporters.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..', '..'),
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: ['ci/gates/G-CI1/**/*.db.test.ts', 'packages/api-server/src/tech-items/**/*.db.test.ts'],
    exclude: ['**/node_modules/**'],
    globalSetup: ['packages/db/src/testing/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
