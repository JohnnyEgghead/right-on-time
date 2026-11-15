// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P5-BOOKING-PAGES (BUILD_PLAN P5-BOOKING-PAGES Acceptance, look clause): SCR-CUS-07 at its 5 routes against DK-122
// (mockups/pages/r1-book-c-club.html, option C), in each state the frame shows, and the unknown-page tile of DK-133 (r1-shr-404). A frame state is picked
// by its frozen caption (UI-DESIGN-KIT section 4.1): the setup tags the element each caption labels with data-bw-cap. App states are the harness build's
// /shell-preview/bookmenu routes (apps/web/app/shell-preview/bookmenu), one per route, each fixed to the frame's clock and footer data.
import type { SelectorPair } from './compare.ts';

export interface BookmenuCase {
  name: string;
  caption: string;
  app: string;
  frame: string;
  pairs: SelectorPair[];
  /** App elements given the width their frame element has (the tile's text column is not the page's), so the text wraps alike. */
  widthFrom?: { app: string; frame: string }[];
}

export const BOOKMENU_FRAME = 'mockups/pages/r1-book-c-club.html';
export const UNKNOWN_FRAME = 'mockups/pages/r1-shr-404.html';
const cap = (c: string) => `[data-bw-cap="${c}"]`;
const root = '.r1-screen[data-screen="SCR-CUS-07"]';
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`, frame: `${frameRoot} ${s}` }));

const P = 'SCR-CUS-07 Booking site page, ';

/** The strip, the header with the page's own item current, the text column and its strip, the drawing and the footer of the full screen. */
const SCREEN = [
  '.r1-demobar', '.r1-demobar .clk', '.r1-demobar .clk .lbl', '.r1-demobar .clk b', '.r1-demobar .run',
  '.site', '.site .brand .word', '.site .brand .word small', '.site nav a', '.site nav a.on', '.site .tel', '.site .tel .ic', '.site .btn.primary',
  '.kicker', '.txt h1', '.txt .lead', '.strip', '.sq', '.sq .yi', '.sq .yi .ic', '.sq b', '.sq > span:last-child', '.btn.cta', '.btn.cta .ic', '.join',
  '.art2', '.art2 svg',
  '.r1-foot', '.r1-foot a', '.r1-foot a code', '.r1-foot .demo',
];

/**
 * A route's tile: the header's current item, and the text column and its strip (the tile's header is a narrower box than the page's). The heading is not
 * compared: the tile draws the compact 34 px heading of its 300 px drawing layout (.b-c.rt), the page the 40 px heading of the full layout, which the Comfort
 * Club case holds on the same markup.
 */
const TILE = ['.site nav a.on', '.kicker', '.txt .lead', '.strip', '.sq', '.sq .yi', '.sq .yi .ic', '.sq b', '.sq > span:last-child', '.btn.cta', '.btn.cta .ic'];

const tile = (label: string, slug: string): BookmenuCase => ({
  name: `SCR-CUS-07 ${label} (the page of /book/${slug}: header item, text column without its heading, 4 squares, Book a visit)`,
  caption: `${P}${label}: Shown`,
  app: `/shell-preview/bookmenu/${slug}`,
  frame: BOOKMENU_FRAME,
  pairs: within(root, `${cap(`${P}${label}: Shown`)} .rt`, TILE),
  widthFrom: [{ app: `${root} .txt`, frame: `${cap(`${P}${label}: Shown`)} .rt .txt` }],
});

export const BOOKMENU_CASES: BookmenuCase[] = [
  {
    name: 'SCR-CUS-07 Comfort Club (the whole screen: strip, header, text column, 4 squares, Book a visit, join line, drawing, footer)',
    caption: `${P}Comfort Club: Shown`,
    app: '/shell-preview/bookmenu/comfort-club',
    frame: BOOKMENU_FRAME,
    pairs: within(root, cap(`${P}Comfort Club: Shown`), SCREEN),
  },
  tile('Heating', 'heating'),
  tile('Cooling', 'cooling'),
  tile('Plumbing', 'plumbing'),
  tile('About us', 'about-us'),
];

/**
 * Captioned frame states, and tile titles, with no look case of their own, each with the reason. The coverage test checks every caption and tile title the
 * frames show is compared by a case or named here, and that each named one is on its frame. The page's own boxes `.pg` and `.split` are not compared in any
 * case: the frame draws them as the fixed rows of a 1440 x 900 picture, which the page replaces with a row that fills the screen and grows (bookmenu.css).
 */
export const NOT_COMPARED: Record<string, { frame: string; why: string }> = {
  'SCR-CUS-07 Booking site page: Unknown page': {
    frame: UNKNOWN_FRAME,
    why: 'the tile draws one sentence and no element: /book/<other name> answers SCR-SHR-02 under the booking site header; the header is held by the Comfort Club case, the card by the shell look case for SCR-SHR-02, and the stack suite checks the 404 and the header',
  },
  'Unknown page': {
    frame: BOOKMENU_FRAME,
    why: 'the tile draws one sentence and no element (SCR-SHR-02 opens under this header); held as the caption row of the shared pages frame above',
  },
  'Narrow screen': {
    frame: BOOKMENU_FRAME,
    why: 'the tile draws a stand-in row (brand, Book a visit, Menu) that keeps Book a visit beside Menu, while UI-SPECIFICATION CTL-CMP-15-05 moves it into the Menu list: reported as a frame and specification disagreement, not decided here; the stack suite checks the narrow header has no overflow and its Menu opens the 5 pages',
  },
  'Office phone on a computer': {
    frame: BOOKMENU_FRAME,
    why: 'the tile draws one sentence and no element; the Call control on a computer (CMP-16) is held by the shell look case "CMP-16 number shown"',
  },
};

export const BOOKMENU_FRAMES = [BOOKMENU_FRAME, UNKNOWN_FRAME];

/** What the pw test reads on each frame: the p.frame-cap texts and the bold tile titles (a tile without a caption). */
export type FrameStates = { captions: string[]; titles: string[] };

/** States the frames show that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncovered(states: Record<string, FrameStates>): string[] {
  const compared = new Set(BOOKMENU_CASES.map((c) => `${BOOKMENU_FRAME} | ${c.caption}`));
  const problems: string[] = [];
  for (const [frame, s] of Object.entries(states)) {
    for (const c of s.captions) {
      if (!c.startsWith('SCR-CUS-07')) continue;
      if (compared.has(`${frame} | ${c}`)) continue;
      const n = NOT_COMPARED[c];
      if (n && n.frame === frame) continue;
      problems.push(`no case compares ${frame} | ${c}`);
    }
    for (const t of s.titles) {
      const n = NOT_COMPARED[t];
      if (n && n.frame === frame) continue;
      problems.push(`no case compares the tile ${frame} | ${t}`);
    }
  }
  for (const [c, n] of Object.entries(NOT_COMPARED)) {
    const s = states[n.frame];
    if (!s || ![...s.captions, ...s.titles].includes(c)) problems.push(`NOT_COMPARED names a state its frame does not show: ${n.frame} | ${c}`);
  }
  return problems;
}
