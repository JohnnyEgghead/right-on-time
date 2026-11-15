// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../../../vitest.reporters.ts';

// G-CI1's client cases (ci/outbox-stack.sh sets BW_OUTBOX_STACK_URL): Playwright on WebKit and Chromium against the Compose stack. The
// file is *.stack.ts so neither the merge-set run nor the browser config picks it up. One file, run in order on 1 shared world: each
// engine's items are its own (fresh keys), and the flagged items it lists it marks handled itself.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../../../..', import.meta.url).pathname,
    include: ['ci/gates/G-CI1/client/*.stack.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
