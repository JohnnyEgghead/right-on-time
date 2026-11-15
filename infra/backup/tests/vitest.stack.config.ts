// SPDX-License-Identifier: AGPL-3.0-or-later
// P3-BACKUP local proofs (infra/backup/tests/backup.stack.test.ts): against the Compose stack that
// infra/backup/tests/stack.sh starts (real PostgreSQL 18, the seeded world, an S3-compatible server). The merge set
// (vitest.config.ts) excludes *.stack.test.ts, as it excludes *.db.test.ts: they need that stack. The wave gate restore-test
// (ci/gates/restore-test.sh, F-387) runs them, with the stack under its own project; by hand:
//   bash infra/backup/tests/stack.sh up
//   pnpm exec vitest run -c infra/backup/tests/vitest.stack.config.ts
//   bash infra/backup/tests/stack.sh down
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../../vitest.reporters.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..', '..'),
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: ['infra/backup/tests/**/*.stack.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
