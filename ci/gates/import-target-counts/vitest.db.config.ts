// SPDX-License-Identifier: AGPL-3.0-or-later
// The import's database tests and the gate's own planted cases (P2-IMPORT), and setup's (P2-SETUP: the fresh end-to-end
// `pnpm run setup` and its planted known-bads, D-3 "runs a fresh setup end to end on every change"): the real import
// runner on the real generator output, on PostgreSQL 18 from @bw/db's test server (as packages/db/vitest.db.config.ts starts it), each
// file in its own fresh migrated database. Run by ci/gates/import-target-counts.sh; the merge set excludes *.db.test.ts.
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../../vitest.reporters.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..', '..'),
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: ['packages/import/src/**/*.db.test.ts', 'packages/setup/src/**/*.db.test.ts', 'ci/gates/import-target-counts/**/*.db.test.ts'],
    exclude: ['**/node_modules/**'],
    globalSetup: ['packages/db/src/testing/global-setup.ts'],
    // F-1549: about 2.2 times the slowest green hook or test on the Spectre CI rig (D-15 measured-value rule). The 7 files
    // build their worlds at once, so each hook pays for all of them: at 54a12538 (nightly, green) the runner file's world
    // took 158.2 s and setup-plants' customer_not_found case 114.1 s, against the 180 s that P2-IMPORT set when the whole
    // gate took 158 s; the nightly at 14a96fe1 ran about 1.4 times slower beside a push run and the runner hook timed out.
    testTimeout: 360_000,
    hookTimeout: 360_000,
  },
});
