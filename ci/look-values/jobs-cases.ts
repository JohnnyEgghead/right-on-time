// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-JOBS (BUILD_PLAN P4-JOBS Acceptance, look clause): SCR-OFC-30 of the app against its frame page
// (mockups/pages/office-jobs.html, DK-88) in each state the frame shows. A frame state is picked by its frozen caption
// (UI-DESIGN-KIT section 4.1), the way week-cases.ts picks them; the app states are the harness build's /shell-preview/jobs/<state>
// routes (apps/web/app/shell-preview/jobs), each fixed to its frame's data. The demo strip, the office top bar and the footer are
// the shell cases' (shell-cases.ts); this file holds the screen under the top bar.
import type { SelectorPair } from './compare.ts';
import type { WidthFrom } from './shell-cases.ts';

export interface JobsCase {
  name: string;
  /** The frame captions the case compares. */
  captions: string[];
  app: string;
  frame: string;
  pairs: SelectorPair[];
  widthFrom?: WidthFrom[];
}

export const JOBS_FRAME = 'mockups/pages/office-jobs.html';
const J = 'SCR-OFC-30 Jobs: ';
export const JOBS_SCREEN = '.r1-screen[data-screen="SCR-OFC-30"]';
const cap = (caption: string) => `[data-bw-cap="${caption}"]`;
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`.trim(), frame: `${frameRoot} ${s}`.trim() }));

const HEADER = [
  '.pgh', '.pgh .row', '.pgh h1', '.pgh p', '.pgh .acts', '.pgh .acts .btn', '.pgh .acts .btn .ic', '.pgh .acts .r1-live',
  '.tabsrow', '.tabs', '.tabs a', '.tabs a .n', '.tabs a.on', '.tabs a.on .n', '.tabs a .n.unas', '.tabs a .n.risk', '.tabs a .n.late', '.tabs a .n.bill',
  '.sortb', '.sortb .cnt', '.sortb .sel', '.sortb .sel .k', '.sortb .sel b', '.sortb .sel .ic',
  '.filters', '.sbox', '.sbox .ic', '.filters .sel', '.filters .sel .k', '.filters .sel b', '.filters .sel .ic',
];
const TABLE = [
  '.tbl', 'table[data-ctl="CTL-OFC-30-10"]', 'th', 'tr', 'td', 'td.jn', 'td .jl', 'td .two', 'td .two b', 'td .two small', 'td .who', 'td .who .av', 'td .who.none', 'td .who.none .av',
  'td .chip', 'td .st', 'td .st small', 'td .by', 'td .by .ic', 'td .bl', 'td .bl.ok', 'td .bl .ic', 'td .chip.bill', 'tr.day td',
  '.pager', '.pager > span', '.pager .pp', '.pager .pp span.b', '.pager .pp span.b.on', '.pager .pp span.b .ic',
];

export const JOBS_CASES: JobsCase[] = [
  {
    name: 'SCR-OFC-30 Success (header, tabs, filters, table with group rows, pager)',
    captions: [`${J}Success`], app: '/shell-preview/jobs/success', frame: JOBS_FRAME,
    pairs: within(JOBS_SCREEN, cap(`${J}Success`), [...HEADER, ...TABLE]),
  },
  {
    name: 'SCR-OFC-30 Loading (skeleton rows under the tabs)',
    captions: [`${J}Loading`], app: '/shell-preview/jobs/loading', frame: JOBS_FRAME,
    widthFrom: [{ app: `${JOBS_SCREEN} .bw-jb-state`, frame: cap(`${J}Loading`) }],
    pairs: [{ app: `${JOBS_SCREEN} .bw-jb-state .r1-skel`, frame: `${cap(`${J}Loading`)} .r1-skel` }],
  },
  {
    name: 'SCR-OFC-30 Empty tab',
    captions: [`${J}Empty tab`], app: '/shell-preview/jobs/empty', frame: JOBS_FRAME,
    widthFrom: [{ app: `${JOBS_SCREEN} .bw-jb-state`, frame: cap(`${J}Empty tab`) }],
    pairs: [{ app: `${JOBS_SCREEN} .bw-jb-state p.r1-note`, frame: `${cap(`${J}Empty tab`)} p.r1-note` }],
  },
  {
    name: 'SCR-OFC-30 No results (the note and Clear filters)',
    captions: [`${J}No results`], app: '/shell-preview/jobs/noresults', frame: JOBS_FRAME,
    widthFrom: [{ app: `${JOBS_SCREEN} .bw-jb-state`, frame: cap(`${J}No results`) }],
    pairs: [
      { app: `${JOBS_SCREEN} .bw-jb-state p.r1-note`, frame: `${cap(`${J}No results`)} p.r1-note` },
      { app: `${JOBS_SCREEN} .filters .btn.sm`, frame: `${cap(`${J}No results`)} .filters .btn.sm` },
    ],
  },
  {
    name: 'SCR-OFC-30 Exporting (the busy button)',
    captions: [`${J}Exporting`], app: '/shell-preview/jobs/exporting', frame: JOBS_FRAME,
    pairs: [
      { app: `${JOBS_SCREEN} .pgh .acts .btn.busy`, frame: `${cap(`${J}Exporting`)} .btn.busy` },
      { app: `${JOBS_SCREEN} .pgh .acts .btn.busy .r1-spin`, frame: `${cap(`${J}Exporting`)} .btn.busy .r1-spin` },
    ],
  },
  {
    name: 'SCR-OFC-30 Error (the jobs could not load)',
    captions: [`${J}Error`], app: '/shell-preview/jobs/error', frame: JOBS_FRAME,
    widthFrom: [{ app: `${JOBS_SCREEN} .bw-jb-state`, frame: cap(`${J}Error`) }],
    pairs: within(`${JOBS_SCREEN} .bw-jb-state`, cap(`${J}Error`), ['.r1-errpanel', '.r1-errpanel b', '.r1-errpanel .btn']),
  },
  {
    name: 'SCR-OFC-30 Live row (the Not in billing tab re-read in place)',
    captions: [`${J}Live row`], app: '/shell-preview/jobs/live', frame: JOBS_FRAME,
    pairs: [
      { app: `${JOBS_SCREEN} .pgh .acts .r1-live`, frame: `${cap(`${J}Live row`)} .r1-live` },
      { app: `${JOBS_SCREEN} .bw-jb-linkp .r1-link`, frame: `${cap(`${J}Live row`)} .r1-link` },
    ],
  },
];

/** What the cases leave out, each with its reason (every captioned state has a case, or a reason here). */
export const NOT_COMPARED: Record<string, string> = {
  'the Live row tile table': 'the tile draws a 5-column table of 3 rows inside a states-board tile; the app draws the page\'s 8-column table, so the row\'s cells have other widths. The Success case holds the table\'s rules cell for cell, and the Playwright stack suite marks a re-read row',
  'the tab bar inside a tile': 'a tile sets its own tab padding and wrap (.r1-st .tabs); the app\'s tabs are the page\'s, compared in the Success case',
  'the search box and selects of the Success frame, inside': 'the frame draws the select values and the search text as plain text; the app puts a native control, invisible, over the same box. The boxes are compared; the control is held by the stack suite',
};

export const JOBS_CAPTIONS = [`${J}Success`, `${J}Loading`, `${J}Empty tab`, `${J}No results`, `${J}Exporting`, `${J}Error`, `${J}Live row`];

/** The captions of the frame that no case compares (empty when every state has a case). */
export function uncovered(frameCaptions: readonly string[]): string[] {
  const covered = new Set(JOBS_CASES.flatMap((c) => c.captions));
  return frameCaptions.filter((c) => c.startsWith(J) && !covered.has(c));
}
