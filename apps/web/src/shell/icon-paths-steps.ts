// SPDX-License-Identifier: AGPL-3.0-or-later
// The turn arrows of SCR-TEC-08's Steps list, Next turn card and next-turn marker (P6-WEB-STEPS; DK-113 kit 0.9, F-1233): the kit draws them
// from its own set, not the shared DK-70 icons (mockups/src/design-options/r1-common.js R1.icon: turnRight, turnLeft, exitRight). The native app
// holds the same strings (apps/tech-native/src/ui/icon-paths-steps.ts); the arrow up and the pin are DK-70's.
export const STEP_ICON_PATHS = {
  turnRight: '<path d="M7 20v-7a4 4 0 0 1 4-4h8"/><path d="M15 5l4 4-4 4"/>',
  turnLeft: '<path d="M17 20v-7a4 4 0 0 0-4-4H5"/><path d="M9 5L5 9l4 4"/>',
  exitRight: '<path d="M9 20v-6l7-7"/><path d="M10 7h6v6"/>',
} as const;
