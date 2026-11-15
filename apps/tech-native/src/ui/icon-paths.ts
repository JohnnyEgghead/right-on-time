// SPDX-License-Identifier: AGPL-3.0-or-later
// The DK-70 line icons the native shell draws, copied from apps/web/src/shell/icon-paths.ts (itself ported from the kit's
// mockups/src/assets/icons.js); icons.test.ts holds each one equal to the web app's. The native app imports no web code (SD-2).
import { STEP_ICON_PATHS } from './icon-paths-steps.ts';
import { TODAY_ICON_PATHS } from './icon-paths-today.ts';

export const NATIVE_ICON_PATHS = {
  list: '<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  map: '<path d="M3.5 6.5l5.5-2 6 2 5.5-2v13l-5.5 2-6-2-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/>',
  box: '<path d="M4 8l8-4 8 4v8.5l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8.5"/>',
  user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.6 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.6-3.5-8.5s1-5.9 3.5-8.5z"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19 4.5v4h-4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  signal: '<path d="M5 18v-3M9.5 18v-6M14 18V9M18.5 18V6"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.2v.01"/>',
  cloud: '<path d="M7.5 18.5a4 4 0 0 1-.4-8 5.5 5.5 0 0 1 10.6 1.5 3.3 3.3 0 0 1-.2 6.5z"/><path d="M9.5 14l2 2 3.5-3.5"/>',
  chevRight: '<path d="M9 6l6 6-6 6"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="10" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  // The job screens' icons (P6-NATIVE-JOB), each the web app's.
  chevLeft: '<path d="M15 6l-6 6 6 6"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4.5-2.2 1.4a11 11 0 0 0 5.8 5.8l1.4-2.2 4.5 1.5v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/>',
  pin: '<path d="M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 1 1 13 0C18.5 14.8 12 21 12 21z"/><circle cx="12" cy="9.8" r="2.3"/>',
  nav: '<path d="M4 11.5L20 4l-7.5 16-2-6.5z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  truck: '<path d="M2.5 6.5h11v9h-11zM13.5 9.5h4l3 3v3h-7z"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  home: '<path d="M4 11l8-6.5 8 6.5M6.5 9.5V20h11V9.5"/>',
  note: '<path d="M6 3.5h9l3 3V20.5H6z"/><path d="M9 10h6M9 13.5h6M9 17h4"/>',
  camera: '<path d="M4 8h3.5l1.5-2.5h6L16.5 8H20v11H4z"/><circle cx="12" cy="13" r="3.4"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.01"/>',
  more: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  send: '<path d="M4 12l16-7.5-6 16-2.5-6.5z"/>',
  sheet: '<rect x="4.5" y="3.5" width="15" height="17" rx="2"/><path d="M4.5 9h15M4.5 14.5h15M10 9v11.5"/>',
  chevDown: '<path d="M6 9l6 6 6-6"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  // SCR-TEC-08's straight-on step (P6-NATIVE-STEPS), the web app's.
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  ...TODAY_ICON_PATHS,
} as const;

/** Every icon the app draws: the DK-70 icons above (each the web app's) and the kit's own turn arrows (icon-paths-steps.ts). */
export const ALL_ICON_PATHS = { ...NATIVE_ICON_PATHS, ...STEP_ICON_PATHS } as const;

export type NativeIcon = keyof typeof ALL_ICON_PATHS;
