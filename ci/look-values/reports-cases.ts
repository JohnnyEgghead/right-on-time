// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-REPORTS (BUILD_PLAN P4-REPORTS Acceptance, look clause): SCR-OFC-11 Reports against mockups/pages/office-reports.html (DK-96),
// in each state its frames show (light theme). A frame state is picked by its frozen caption (UI-DESIGN-KIT section 4.1), the way health-cases.ts
// picks them: the setup tags the element each caption labels with data-bw-cap. App states are the harness build's /shell-preview/reports routes,
// each fixed to its frame's data. The demo strip, the office top bar and the footer are the shell cases'; this file holds the screen under them.
import type { SelectorPair } from './compare.ts';
import { CHROME, cap, within } from './billing-cases.ts';
import type { WidthFrom } from './shell-cases.ts';

export interface ReportsCase {
  name: string;
  /** The captions the case compares (every captioned state of the frame has a case, or a reason in NOT_COMPARED). */
  captions: string[];
  app: string;
  pairs: SelectorPair[];
  /** App elements sized to their frame twin before values are read (a tile is a narrow body; the page is wide). */
  widthFrom?: WidthFrom[];
}

export const REPORTS_FRAME = 'mockups/pages/office-reports.html';
const R = 'SCR-OFC-11 Reports: ';
const ROOT = '.r1-screen[data-screen="SCR-OFC-11"]';
const FOOT = ['.r1-foot', '.r1-foot a', '.r1-foot a code', '.r1-foot [data-ctl="CTL-CMP-04-02"]', '.r1-foot .demo'];

const HEADER = [
  '.rh', '.rh h1', '.rh .sim', '.rh .sim .chip', '.rh .sim > span:last-child', '.rh .filters',
  '.rh .sel', '.rh .sel .k', '.rh .sel b', '.rh .sel .ic', '.rh .sel.dis', '.rh .wks', '.rh .btn', '.rh .btn .ic',
];
const CARDS = ['.wrap', '.kpis', '.kpi', '.kpi .l', '.kpi .v', '.kpi .s', '.kpi .s span'];
const PANELS = [
  '.grid', '.col', '.panel', '.panel .ph', '.panel h3', '.panel .ph > span', '.panel .lg', '.panel .lg span', '.panel .lg i', '.tbt',
  'svg.chart', 'svg.chart text', 'svg.chart circle', 'svg.chart path', 'svg.chart line', 'svg.chart rect',
];
// The chart data tables (hidden unless asked for, CTL-OFC-11-07) are also table.t: the by-technician table is picked by its control id.
const T = 'table[data-ctl="CTL-OFC-11-10"]';
const TABLE = [T, `${T} th`, `${T} td`, `${T} tr`, `${T} .who`, `${T} .who .av`, '.meter', '.meter i'];

export const REPORTS_CASES: ReportsCase[] = [
  {
    name: 'SCR-OFC-11 Success (header, cards, 3 charts, by-technician table)',
    captions: [`${R}Success`], app: '/shell-preview/reports/success',
    pairs: within(ROOT, cap(`${R}Success`), [...CHROME, ...HEADER, ...CARDS, ...PANELS, ...TABLE, ...FOOT]),
  },
  // The state tiles draw only the part of the screen that changes, in the states board's own box (a narrow body, the board's rules): each case
  // compares that part, sized to its tile where the page's box differs.
  {
    name: 'SCR-OFC-11 Loading (the skeleton rows under the label)',
    captions: [`${R}Loading`], app: '/shell-preview/reports/loading',
    // The tile's rows fill its padded body: the app's row block takes the width of the tile's full-width row.
    widthFrom: [{ app: `${ROOT} .bw-rp-skel-rows`, frame: `${cap(`${R}Loading`)} .r1-skel:nth-of-type(2)` }],
    pairs: [{ app: `${ROOT} .bw-rp-state .r1-skel`, frame: `${cap(`${R}Loading`)} .r1-skel` }],
  },
  {
    name: 'SCR-OFC-11 Exporting (the busy Export to spreadsheet button)',
    captions: [`${R}Exporting`], app: '/shell-preview/reports/exporting',
    pairs: [{ app: `${ROOT} .rh .btn.busy`, frame: `${cap(`${R}Exporting`)} .btn.busy` }, { app: `${ROOT} .rh .btn.busy .r1-spin`, frame: `${cap(`${R}Exporting`)} .btn.busy .r1-spin` }],
  },
  {
    name: 'SCR-OFC-11 Error (the error panel and its Try again)',
    captions: [`${R}Error`], app: '/shell-preview/reports/error',
    widthFrom: [{ app: `${ROOT} .r1-errpanel`, frame: `${cap(`${R}Error`)} .r1-errpanel` }],
    pairs: within(ROOT, cap(`${R}Error`), ['.r1-errpanel', '.r1-errpanel b', '.r1-errpanel .btn.sm']),
  },
  {
    name: 'SCR-OFC-11 Empty (the note)',
    captions: [`${R}Empty`], app: '/shell-preview/reports/empty',
    widthFrom: [{ app: `${ROOT} .r1-note`, frame: `${cap(`${R}Empty`)} .r1-note` }],
    pairs: [{ app: `${ROOT} .r1-note`, frame: `${cap(`${R}Empty`)} .r1-note` }],
  },
];

/**
 * Captioned frame states with no look case of their own, each with the reason. The coverage test checks every caption the frame shows is compared
 * by a case or named here, and that each named one is a caption of the frame.
 */
export const NOT_COMPARED: Record<string, { frame: string; why: string }> = {};

/** Captions the frame shows (read by the pw test) that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncovered(captions: Record<string, string[]>): string[] {
  const compared = new Set(REPORTS_CASES.flatMap((c) => c.captions.map((x) => `${REPORTS_FRAME} | ${x}`)));
  const problems: string[] = [];
  for (const [frame, caps] of Object.entries(captions)) {
    for (const c of caps) {
      if (!c.startsWith('SCR-OFC-11 ')) continue;
      if (compared.has(`${frame} | ${c}`)) continue;
      const n = NOT_COMPARED[c];
      if (n && n.frame === frame) continue;
      problems.push(`no case compares ${frame} | ${c}`);
    }
  }
  for (const [c, n] of Object.entries(NOT_COMPARED)) if (!(captions[n.frame] ?? []).includes(c)) problems.push(`NOT_COMPARED names a caption its frame does not show: ${n.frame} | ${c}`);
  return problems;
}
