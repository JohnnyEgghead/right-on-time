// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../vitest.reporters.ts';

// The P3-IMPORT-WORKER stack suite (ci/import-stack.sh sets BW_IMPORT_STACK_URL): the worker's import job against the
// Compose stack after a fresh setup. The file is *.stack.ts so neither the merge-set run nor the browser config picks it
// up. The cases share 1 world and run in order (sequence.concurrent off is vitest's default within a file).
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/import-stack/*.stack.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
