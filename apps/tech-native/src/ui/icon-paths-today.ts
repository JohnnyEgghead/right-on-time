// SPDX-License-Identifier: AGPL-3.0-or-later
// The DK-70 line icons the Today stack and its confirm sheets draw (P6-NATIVE-TODAY), copied from apps/web/src/shell/icon-paths.ts like the
// shell's (icon-paths.ts spreads this in; assets.test.ts holds each one equal to the web app's). Kept in its own file so the native
// lanes that add icons at the same time do not edit the same lines.
export const TODAY_ICON_PATHS = {
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  message: '<path d="M4 5.5h16v11H9l-5 4z"/>',
  flame: '<path d="M12.5 3.5c.8 3.5 5 5.3 5 10A5.5 5.5 0 0 1 6.5 14c0-2.6 1.6-4.3 2.9-5.4 0 1.9.8 3.1 2 3.6-.4-2.9.1-6.1 1.1-8.7z"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/>',
  drop: '<path d="M12 3.5S6 10 6 14.2a6 6 0 0 0 12 0C18 10 12 3.5 12 3.5z"/>',
} as const;
