// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { junitReporters } from '../../../vitest.reporters.ts';

// contract-tests against a running Compose stack (ci/gates/contract-gates.sh sets BW_CONTRACT_BASE_URL).
// The files are *.contract.test.ts so test-reason-check sees them (F-136); the root vitest.config.ts excludes
// ci/gates/contract-gates/** so the merge-set run never picks them up.
export default defineConfig({
  test: {
    // F-974: per-test times. The gate runner sets BW_JUNIT_DIR; each vitest run then also writes a junit file there (ci/test-times.sh records it).
    reporters: junitReporters(),
    root: new URL('../../..', import.meta.url).pathname,
    include: ['ci/gates/contract-gates/*.contract.test.ts'],
    // F-315: explicit, not vitest's 5 s / 10 s defaults; a hook gets the same 20 s bound as a test (the files have none today).
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
