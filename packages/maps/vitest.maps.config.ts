// SPDX-License-Identifier: AGPL-3.0-or-later
// The real-file test set (P3-MAPS-BAKE): every *.maps.test.ts, over the verified map files and track set in
// $MAPS_DIR (default .build/data/maps). Run by ci/gates/map-manifest.sh (wave gate map-manifest); the merge-set unit
// tests exclude these files (vitest.config.ts).
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, '..', '..'),
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    include: ['packages/maps/src/**/*.maps.test.ts', 'infra/tests/**/*.maps.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
