// SPDX-License-Identifier: AGPL-3.0-or-later
// The 1 reader of the system clock in the whole repo (SPECIFICATIONS section 4.2, SD-10; FR-DEMO-2).
// The lint no-system-clock allows Date.now(), new Date() without arguments and performance.timeOrigin in this file
// only (eslint.config.mjs). Every caller names its use (section 11.3); ci/gates/G-CI4/realnow-sites.ts lists them.
import { Temporal } from 'temporal-polyfill';
import { assertRealTimeUse, type RealTimeUse } from './uses.ts';

export function realNow(use: RealTimeUse): Temporal.Instant {
  assertRealTimeUse(use);
  return Temporal.Instant.fromEpochMilliseconds(Date.now());
}
