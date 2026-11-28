// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from './vitest.reporters.ts';

// F-311: the merge set runs 3 more times under G-CI4's host zones on a loaded container; its ESLint- and CLI-starting tests sit at the
// 5 s default there and timed out in 2 of 3 closing-pass wave runs, so a slow test is given room instead of failing the zone run.
const timeouts = { testTimeout: 60_000, hookTimeout: 60_000 };

export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    projects: [
      {
        test: {
          name: 'unit',
          ...timeouts,
          include: ['ci/**/*.test.ts', 'infra/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'apps/*/src/**/*.test.tsx', 'apps/*/app/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
          // Browser tests run in the page-walkers wave gate (vitest.browser.config.ts), not here.
          // Database tests (*.db.test.ts, a real PostgreSQL 18) run in each gate's own vitest.db.config.ts: packages/db/vitest.db.config.ts for schema-gates, ci/gates/<gate>/vitest.db.config.ts for the others (G-CI7 runs the K-07 suites of packages/api-server).
          // ci/gates/contract-gates/** are live contract tests against a running stack (that gate's own config runs them; F-136).
          // P3-BACKUP's local proofs (*.stack.test.ts) run against their own Compose stack (infra/backup/tests/vitest.stack.config.ts).
          // The real map files and track set (*.maps.test.ts, FR-MAP-1/4/5) run in the map-manifest wave gate, which fetches them (packages/maps/vitest.maps.config.ts).
          exclude: ['**/node_modules/**', '**/*.pw.test.ts', '**/*.db.test.ts', '**/*.stack.test.ts', '**/*.maps.test.ts', 'ci/gates/contract-gates/**'],
        },
      },
    ],
  },
});
