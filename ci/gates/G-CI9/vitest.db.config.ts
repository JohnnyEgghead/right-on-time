// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G-CI9's test set (inv9-quiet-hours), run once per host zone of NFR-08's matrix by ci/gates/G-CI9.sh: the DST
// suite of NFR-08 (packages/time/src/dst.test.ts, whose host-zone probe proves each run's zone), every case file in
// ci/gates/G-CI9/ by glob (P3-REPLAY's clock-jump case joins as a *.test.ts file here, with no edit to this file or the
// script), and every outbox test, unit and database (the quiet-hours SQL among them, F-178 part b). 1 PostgreSQL 18
// server per run (globalSetup, or BW_TEST_PG_URL); each file gets its own fresh migrated database.
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../../vitest.reporters.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..', '..'),
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: [
      'packages/time/src/dst.test.ts',
      'ci/gates/G-CI9/**/*.test.ts',
      'packages/outbox/src/**/*.test.ts',
      'apps/worker/src/*.test.ts',
      'apps/worker/src/outbox/**/*.test.ts',
    ],
    // F-548: the import job's database test (P3-IMPORT-WORKER; 262 s in the nightly's UTC step, 3 host zones = 13 min) is no
    // quiet-hours case: it sets no text, quiet-hours or zone-dependent time. It runs once in G-CI2, whose config includes
    // apps/worker/src/*.db.test.ts. The glob above swept it in, and the gate hit its 300 s limit in the second zone.
    exclude: ['**/node_modules/**', 'apps/worker/src/import.db.test.ts'],
    globalSetup: ['packages/db/src/testing/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
