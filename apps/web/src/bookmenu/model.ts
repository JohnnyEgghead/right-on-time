// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-CUS-07 Booking site page (UI-SPECIFICATION 2.3, FR-BOOK-13, OA-73): the 5 pages of the site menu and what each says, drawn from DK-122
// (mockups/pages/r1-book-c-club.html, option C). Plain data and no React, so a server route and a test can both read it. The text is the
// catalog's (`bookmenu.*`); the 4 squares of each page name an icon and 2 catalog keys, or, for the branch names, the reference data.
import type { MessageKey } from '@bw/i18n';
import { BRANCHES } from '../shell/branches.ts';
import type { IconName } from '../shell/icon-paths.ts';

export type MenuSlug = 'heating' | 'cooling' | 'plumbing' | 'comfort-club' | 'about-us';
export type MenuArt = 'house' | 'flame' | 'snow' | 'drop' | 'home';

export interface Square {
  icon: IconName;
  title: MessageKey;
  /** A catalog key, or the branch names (proper names, the same in both languages). */
  text: { key: MessageKey } | { branches: string };
}

export interface MenuPageData {
  slug: MenuSlug;
  /** The site menu's own label for the page: the kicker above the heading (CTL-CMP-15-02). */
  name: MessageKey;
  art: MenuArt;
  h1: MessageKey;
  lead: MessageKey;
  squares: readonly [Square, Square, Square, Square];
  /** Comfort Club only: the line that says the page signs nobody up (FR-DISP-32). */
  join: boolean;
}

const k = (s: string) => s as MessageKey;
const sq = (prefix: string, n: number, icon: IconName): Square => ({ icon, title: k(`bookmenu.${prefix}.s${n}.title`), text: { key: k(`bookmenu.${prefix}.s${n}.text`) } });

function page(slug: MenuSlug, prefix: string, name: MessageKey, art: MenuArt, icons: readonly [IconName, IconName, IconName, IconName], join = false): MenuPageData {
  return {
    slug,
    name,
    art,
    h1: k(`bookmenu.${prefix}.h1`),
    lead: k(`bookmenu.${prefix}.lead`),
    squares: [sq(prefix, 1, icons[0]), sq(prefix, 2, icons[1]), sq(prefix, 3, icons[2]), sq(prefix, 4, icons[3])],
    join,
  };
}

const ABOUT = page('about-us', 'about', 'shell.booking.about', 'home', ['pin', 'truck', 'clock', 'phone']);

export const MENU_PAGES: Readonly<Record<MenuSlug, MenuPageData>> = {
  heating: page('heating', 'heating', 'shell.booking.heating', 'flame', ['flame', 'wrench', 'heater', 'clock']),
  cooling: page('cooling', 'cooling', 'shell.booking.cooling', 'snow', ['snow', 'wrench', 'home', 'clock']),
  plumbing: page('plumbing', 'plumbing', 'shell.booking.plumbing', 'drop', ['drop', 'heater', 'wrench', 'clock']),
  'comfort-club': page('comfort-club', 'club', 'shell.booking.club', 'house', ['snow', 'flame', 'wrench', 'bell'], true),
  'about-us': {
    ...ABOUT,
    // The first square names the 3 branches from the reference data; the last is the office hours, the 1 catalog value every page uses.
    squares: [
      { ...ABOUT.squares[0], text: { branches: BRANCHES.map((b) => b.name).join(', ') } },
      ABOUT.squares[1],
      ABOUT.squares[2],
      { ...ABOUT.squares[3], text: { key: k('bookmenu.officeHours') } },
    ],
  },
};

/** The page of a `/book/<name>` route, or null for any other name (the unknown-page state shows SCR-SHR-02). */
export function menuPageFor(name: string): MenuPageData | null {
  return Object.prototype.hasOwnProperty.call(MENU_PAGES, name) ? MENU_PAGES[name as MenuSlug] : null;
}

/** The 5 booking menu page routes, in menu order (UI-SPECIFICATION 2.3). */
export const MENU_ROUTES: readonly string[] = (Object.keys(MENU_PAGES) as MenuSlug[]).map((s) => `/book/${s}`);
