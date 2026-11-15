// SPDX-License-Identifier: AGPL-3.0-or-later
import { configDefaults } from 'vitest/config';

// F-996: the reporter list every vitest config uses. Without BW_JUNIT_DIR it is vitest's own default (terse in an agent session,
// github-actions annotations under GITHUB_ACTIONS=true), so a run prints what vitest would print. The gate runner sets BW_JUNIT_DIR
// (ci/run-gates.ts); each run then also writes a junit file there, named by the process (ci/test-times.sh records it, F-974).
export function junitReporters(): (string | [string, { outputFile: string }])[] {
  const dir = process.env.BW_JUNIT_DIR;
  if (!dir) return [...configDefaults.reporters];
  return [...configDefaults.reporters, ['junit', { outputFile: `${dir}/vitest-${process.pid}.xml` }]];
}
