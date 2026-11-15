// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { NameSequencer } from './sequencer.ts';
import { junitReporters } from '../../vitest.reporters.ts';

// The P5-TWA-MAP-ME stack suite (ci/mapme-stack.sh sets BW_MAPME_STACK_URL): Playwright on Chromium and WebKit against the Compose stack. The files
// are *.stack.ts so neither the merge-set run nor the browser config picks them up. The files run in file-name order (sequencer.ts, F-1334: they share 1 world): the suite moves the shared demo clock
// to Tue, Sep 15, 10:26 AM and pauses it there, and moves two of Maria's jobs away and back.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../..', import.meta.url).pathname,
    include: ['ci/mapme-stack/*.stack.ts'],
    fileParallelism: false,
    sequence: { concurrent: false, sequencer: NameSequencer },
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
