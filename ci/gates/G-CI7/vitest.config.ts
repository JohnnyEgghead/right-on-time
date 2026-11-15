// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI7 step 2's config (F-683): the merge set's unit tests of the role-by-route test and packages/api-server, with the loopback-only
// fetch guard installed. The include and exclude are the root config's for those paths (vitest.config.ts).
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../../vitest.reporters.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..', '..'),
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: ['ci/gates/G-CI7/role-by-route.test.ts', 'packages/api-server/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.pw.test.ts', '**/*.db.test.ts', '**/*.stack.test.ts', '**/*.maps.test.ts'],
    setupFiles: ['ci/gates/G-CI7/outside-fetch-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
