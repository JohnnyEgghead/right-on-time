// SPDX-License-Identifier: AGPL-3.0-or-later
// The turn arrows of SCR-TEC-08's Steps list and Next turn card (P6-NATIVE-STEPS; DK-117 kit 0.9, F-1233): the kit draws them from its own
// set, not the shared DK-70 icons (mockups/pages/r1-ios-b.html R1.icon: turnRight, turnLeft, exitRight), so the web app holds none of them
// yet. assets.test.ts holds each one equal to the kit frame's string. Kept in its own file, as icon-paths-today.ts is.
export const STEP_ICON_PATHS = {
  turnRight: '<path d="M7 20v-7a4 4 0 0 1 4-4h8"/><path d="M15 5l4 4-4 4"/>',
  turnLeft: '<path d="M17 20v-7a4 4 0 0 0-4-4H5"/><path d="M9 5L5 9l4 4"/>',
  exitRight: '<path d="M9 20v-6l7-7"/><path d="M10 7h6v6"/>',
} as const;
