// SPDX-License-Identifier: AGPL-3.0-or-later
// How many page-walk checks run at the same time in ci/page-walkers/app.pw.test.ts (owner ruling Nov 10, 2026, item 4a). One named setting.
// Each running check holds its own browser (a pool of this many per engine) and opens a fresh guarded context per check, as before.
// The ruling's pre-set rule: keep 4 if the next 3 nightlies show page-walkers-nightly step 1 at 15 minutes or less and no new walk reds;
// drop to 2 if a WebKit "Page crashed" red shows in 2 of the 3. To drop it, change WALK_CONCURRENCY below (or set BW_WALK_CONCURRENCY for a probe).
// The upper bound is vitest's own default maxConcurrency (5): above it the extra tests would only wait.
export const WALK_CONCURRENCY = 4;
export const WALK_CONCURRENCY_MAX = 5;

/** The setting in force: BW_WALK_CONCURRENCY when set (a whole number, 1 to 5), else WALK_CONCURRENCY. Anything else is an error, never a silent default. */
export function walkConcurrency(env: string | undefined = process.env.BW_WALK_CONCURRENCY): number {
  if (env === undefined || env === '') return WALK_CONCURRENCY;
  const n = Number(env);
  if (!Number.isInteger(n) || n < 1 || n > WALK_CONCURRENCY_MAX) throw new Error(`BW_WALK_CONCURRENCY=${env} is not a whole number from 1 to ${WALK_CONCURRENCY_MAX}`);
  return n;
}
