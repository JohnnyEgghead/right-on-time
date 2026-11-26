// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-WEEK (BUILD_PLAN P4-WEEK Acceptance, look clause): SCR-OFC-34 of the app against its frame page
// (mockups/pages/office-board-week.html, DK-86) in each state the frame shows. A frame state is picked by its frozen caption
// (UI-DESIGN-KIT section 4.1), the way auth-cases.ts picks them; the app states are the harness build's /shell-preview/week/<state>
// routes (apps/web/app/shell-preview/week), each fixed to its frame's data. The demo strip, the office top bar and the footer are
// the shell cases' (shell-cases.ts); this file holds the screen under the top bar.
import type { SelectorPair } from './compare.ts';
import type { WidthFrom } from './shell-cases.ts';

export interface WeekCase {
  name: string;
  /** The frame captions the case compares. */
  captions: string[];
  app: string;
  frame: string;
  pairs: SelectorPair[];
  widthFrom?: WidthFrom[];
  /** The frame draws this state's grid as a mini grid (rows 48 px, header 62 px, no stretch): the app grid is set the same before reading. */
  miniGrid?: boolean;
}

export const WEEK_FRAME = 'mockups/pages/office-board-week.html';
const W = 'SCR-OFC-34 Week board: ';
const SCREEN = '.r1-screen[data-screen="SCR-OFC-34"]';
const cap = (caption: string) => `[data-bw-cap="${caption}"]`;
// The app's aside is `.bw-wk-side`, not `.side`: the app's body is .r1, whose kit rules for the CMP-08 side menu the frame's body does not take.
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] =>
  inner.map((s) => ({ app: `${appRoot} ${s.replace(/^\.side\b/, '.bw-wk-side')}`.trim(), frame: `${frameRoot} ${s}`.trim() }));

// The frame draws the technician in the 3rd row (Kevin Doyle) as "Water heaters", a skill the seed does not have (NOT_COMPARED).
const DOYLE_ROW = 29;
const NOT_DOYLE = `.wk > .who:not(:nth-child(${DOYLE_ROW}))`;

const SUMBAR = [
  '.sumbar', '.datenav', '.datenav .arrow', '.datenav .d', '.datenav .d b', '.datenav .d > span', '.tiles', '.tile', '.tile .num', '.tile .lb', '.tile .lb small',
  '.sumbar > .btn', '.sumbar > .btn .ic',
];
const BOARD = [
  '.boardp', '.boardp > .ph', '.ph h2', '.ph .muted', '.seg', '.seg span', '.r1-live', '.lgd', '.lgd span', '.lgd i.b',
  '.wk .corner', '.wk .hd', '.wk .hd b', '.wk .hd b .td', '.wk .hd b .pk', '.wk .hd .wsel', '.wk > .who.unas', '.wk > .who.unas .av', '.wk > .who.unas .nm', '.wk > .who.unas .sub',
  '.wk > .who.tot', '.wk > .who.tot .nm', '.wk > .who.tot .sub',
  `${NOT_DOYLE}`, `${NOT_DOYLE} .av`, `${NOT_DOYLE} .nm`, `${NOT_DOYLE} .sub`, `${NOT_DOYLE} > div`,
  '.wk .c', '.wk .c .t', '.wk .c .t b', '.wk .c .t .w', '.wk .c .bar', '.wk .c .bar i', '.wk .c.u .tag',
];
const SIDE = [
  '.side > .ph', '.side .ph h2', '.sec', '.sec h3', '.sec h3 .chip', '.pkd', '.pkd b', '.pkd small', '.sec p', '#satwhy', '.sec .btn', '.sec .btn .ic',
  '.ul .r', '.ul .r .d', '.ul .r .d small', '.ul .r .x', '.ul .r .x b', '.ul .r .x small', '.ob .r', '.ob .r .d', '.ob .r .bar', '.ob .r .bar i', '.ob .r .n',
];

export const WEEK_CASES: WeekCase[] = [
  {
    name: 'SCR-OFC-34 Success (week summary, grid, totals, peak days, Unassigned, online booking)',
    captions: [`${W}Success`], app: '/shell-preview/week/success', frame: WEEK_FRAME,
    pairs: within(SCREEN, cap(`${W}Success`), [...SUMBAR, ...BOARD, ...SIDE]),
  },
  {
    name: 'SCR-OFC-34 Loading (skeleton grid)',
    captions: [`${W}Loading`], app: '/shell-preview/week/loading', frame: WEEK_FRAME,
    widthFrom: [{ app: `${SCREEN} .bw-wk-body`, frame: `${cap(`${W}Loading`)}` }],
    pairs: [{ app: `${SCREEN} .bw-wk-body .r1-skel`, frame: `${cap(`${W}Loading`)} .r1-skel` }],
  },
  {
    name: 'SCR-OFC-34 No technicians',
    captions: [`${W}No technicians`], app: '/shell-preview/week/empty', frame: WEEK_FRAME,
    widthFrom: [{ app: `${SCREEN} .bw-wk-body`, frame: `${cap(`${W}No technicians`)}` }],
    pairs: [{ app: `${SCREEN} .bw-wk-body p.r1-note`, frame: `${cap(`${W}No technicians`)} p.r1-note` }],
  },
  {
    name: 'SCR-OFC-34 Error (the week could not load)',
    captions: [`${W}Error`], app: '/shell-preview/week/error', frame: WEEK_FRAME,
    widthFrom: [{ app: `${SCREEN} .bw-wk-body`, frame: `${cap(`${W}Error`)}` }],
    pairs: within(`${SCREEN} .bw-wk-body`, cap(`${W}Error`), ['.r1-errpanel', '.r1-errpanel b', '.r1-errpanel .btn']),
  },
  {
    name: 'SCR-OFC-34 Live (a changed cell is marked in place)',
    captions: [`${W}Live`], app: '/shell-preview/week/live', frame: WEEK_FRAME,
    widthFrom: [{ app: `${SCREEN} .bw-wk-scroll > .wk`, frame: `${cap(`${W}Live`)} .wk.mini` }],
    miniGrid: true,
    pairs: [
      ...['.c.chg', '.c.chg .t', '.c.chg .t b', '.c.chg .t .w', '.c.chg .bar', '.c.chg .bar i'].map((s) => ({ app: `${SCREEN} .wk ${s}`, frame: `${cap(`${W}Live`)} .wk ${s}` })),
      { app: `${SCREEN} .r1-live`, frame: `${cap(`${W}Live`)} .r1-live` },
    ],
  },
];

/** What the cases leave out, each with its reason (every captioned state has a case, or a reason here). */
export const NOT_COMPARED: Record<string, string> = {
  'Kevin Doyle row': 'the frame labels Doyle "Water heaters", a skill the seed does not have (his primary skill is plumbing)',
  'the side panel box': 'the frame draws the side panel as a fixed 748 px box that clips its last 12 px; the app\'s grows to show all of it, so its panels are compared and its own height is not',
  'the Day and Week controls': 'the frame draws the Day side as a span; the app draws a radio, whose box is the same and whose click is held by the Playwright suite',
};

/** The captions of the frame that no case compares (empty when every state has a case). */
export function uncovered(frameCaptions: readonly string[]): string[] {
  const covered = new Set(WEEK_CASES.flatMap((c) => c.captions));
  return frameCaptions.filter((c) => c.startsWith(W) && !covered.has(c));
}
