// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/setup (BUILD_PLAN P2-SETUP; section 3 D-3): `pnpm run setup`, the 6 steps in foreign-key order.
export { SETUP_ERRORS, SetupError, type SetupErrorCode } from './errors.ts';
export { parseFixture, type WorldFixture } from './fixture.ts';
export { assertFresh, generateChecked, runSetup, SETUP_LOCK_KEYS, SETUP_STAMPS, stampClock, streetListFile, type SetupEvent, type SetupOptions, type SetupResult } from './pipeline.ts';
export { RESET_DEMO_TIME, SETUP_MOVER_NAME, SNAPSHOT_LABEL, writeSnapshot } from './snapshot.ts';
export { MARCO, SAMPLE_BLOCK, seedWorld } from './world-seed.ts';
