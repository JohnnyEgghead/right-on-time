// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-CUSTOMERS (BUILD_PLAN P4-CUSTOMERS Acceptance, look clause): SCR-OFC-05, SCR-OFC-38, SCR-OFC-06, SCR-OFC-39 and
// SCR-OFC-40 of the app against their frame pages (mockups/pages/office-customer-search.html, DK-90; mockups/pages/office-customer.html,
// DK-91) in each state a frame shows. A frame state is picked by its frozen caption (UI-DESIGN-KIT section 4.1): the setup tags the
// element each caption labels with data-bw-cap. App states are the harness build's /shell-preview/customers/<state> and
// /shell-preview/customer/<state> routes (apps/web/app/shell-preview), each fixed to its frame's data. The demo strip, the office top bar and
// the footer are the shell cases' (shell-cases.ts); this file holds the screens under the top bar.
import type { SelectorPair } from './compare.ts';

export interface CustomersCase {
  name: string;
  screen: string;
  captions: string[];
  app: string;
  frame: string;
  pairs: SelectorPair[];
  /** The frame draws this state in a tile narrower than the page: the app element is given the frame element's width before reading. */
  widthFrom?: { app: string; frame: string }[];
}

const SEARCH_FRAME = 'mockups/pages/office-customer-search.html';
const CUSTOMER_FRAME = 'mockups/pages/office-customer.html';
const S = 'SCR-OFC-05 Customer search: ';
const N = 'SCR-OFC-38 New customer: ';
const P = 'SCR-OFC-06 Customer page: ';
const E = 'SCR-OFC-39 Edit customer: ';
const M = 'SCR-OFC-40 Address on the map: ';
const cap = (c: string) => `[data-bw-cap="${c}"]`;
const root = (screen: string) => `.r1-screen[data-screen="${screen}"]`;
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`, frame: `${frameRoot} ${s}` }));

/** The page header, filters and hint of the customers page (SCR-OFC-05). `.q` carries the caret and the typed word in the frame (text-length bound): its box is compared, its inside is not. */
const SEARCH_HEAD = [
  '.pgh', '.pgh h1', '.pgh .row', '.pgh .acts .btn', '.pgh .acts .btn .ic', '.qrow', '.q', '.q .ic', '.sel', '.sel .k', '.sel .ic', '.hint', '.hint .ic', '.qrow > .btn.sm',
];
// The member chip is pinned on the preview panel (.pv .top .chip.club, CTL-OFC-05-16 says the Comfort Club chip), not on the table's plan
// cell: DK-90 draws that cell "Comfort Club", and FR-DISP-32 and CTL-OFC-05-03 say "Comfort Club member". UI-SPECIFICATION section 17:
// where a mockup disagrees with REQUIREMENTS, REQUIREMENTS wins (F-797), so the table cell's word and its chip's box are left out.
// F-843: so is that column's head and cells (the 5th child): the table sizes its columns from their words, and the plan cell's longer
// words take a second line and make the column 1.33 px wider on the Spectre rig (119.95 px frame, 121.28 px app; under 0.5 px on the
// Mac). No owner ruling lets the comparator skip a width (wordsRuled), so the boxes are left out, as import-cases.ts does (F-625).
const SEARCH_RESULTS = [
  '.card .card-h', '.card .card-h h3', 'table', 'thead th:not(:nth-child(5))', 'tbody tr', 'tbody td:not(:nth-child(5))', 'tbody td .two', 'tbody td .two b', 'tbody td .two small',
  '.also', '.also .ic', 'tr.pick', '.pv .top .chip.club', '.pv .top', '.pv .top .av', '.pv .top b', '.pv .kv dt:nth-of-type(-n+3)', '.pv h4', '.pv .nx', '.pv .hist .h', '.pv .hist .h .d', '.pv .acts', '.pv .acts .btn',
];
const DLG = ['.r1-dlg', '.r1-dlg-h', '.r1-dlg-h h2', '.r1-x', '.r1-x .ic', '.r1-dlg-b', '.r1-dlg-f', '.r1-dlg-f .btn'];
const FORM = ['.row', '.r1-field', '.r1-field label', '.r1-field .r1-input', '.g2f', '.ck', '.ck .bx', '.r1-hint'];

const CUSTOMER_HEAD = [
  '.jh', '.crumbs', '.crumbs .ic', '.jh h1', '.jh .row', '.jh .acts .btn', '.jh .meta', '.jh .meta span', '.jh .meta .ic', '.chip.club', '.chip.club .ic',
];
const CUSTOMER_BODY = [
  '.card .card-h', '.card .card-h h3', '.kv', '.kv dt', '.kv.tz', '.club ul', '.club .ren',
  '.eq .ico', '.imp', '.up', '.up .top', '.up .top .s', '.up .top .big', '.up .tech', '.up .tech .av', '.up .tech .btn',
  '.note', '.note .by', '.feed', '.ev', '.ev .dot',
];

export const CUSTOMERS_CASES: CustomersCase[] = [
  {
    name: 'SCR-OFC-05 Results (the page: header and filters, the table, the preview panel)',
    screen: 'SCR-OFC-05', captions: [`${S}Results`], app: '/shell-preview/customers/results', frame: SEARCH_FRAME,
    pairs: within(root('SCR-OFC-05'), cap(`${S}Results`), [...SEARCH_HEAD, ...SEARCH_RESULTS]),
  },
  {
    name: 'SCR-OFC-05 Empty (the note under the search)',
    screen: 'SCR-OFC-05', captions: [`${S}Empty`], app: '/shell-preview/customers/empty', frame: SEARCH_FRAME,
    widthFrom: [{ app: `${root('SCR-OFC-05')} .left`, frame: `${cap(`${S}Empty`)} p.r1-note` }],
    pairs: [{ app: `${root('SCR-OFC-05')} p.r1-note`, frame: `${cap(`${S}Empty`)} p.r1-note` }],
  },
  {
    name: 'SCR-OFC-05 Preview loading (the panel skeleton and its two buttons)',
    screen: 'SCR-OFC-05', captions: [`${S}Preview loading`], app: '/shell-preview/customers/preview-loading', frame: SEARCH_FRAME,
    pairs: [
      { app: `${root('SCR-OFC-05')} .pv[aria-busy="true"] .acts .btn.primary`, frame: `${cap(`${S}Preview loading`)} .pv .acts .btn.primary` },
      { app: `${root('SCR-OFC-05')} .pv[aria-busy="true"] .acts .btn:not(.primary)`, frame: `${cap(`${S}Preview loading`)} .pv .acts .btn:not(.primary)` },
    ],
  },
  {
    name: 'SCR-OFC-05 Preview error (CMP-12 inside the panel)',
    screen: 'SCR-OFC-05', captions: [`${S}Preview error`], app: '/shell-preview/customers/preview-error', frame: SEARCH_FRAME,
    widthFrom: [{ app: `${root('SCR-OFC-05')} .pv .r1-errpanel`, frame: `${cap(`${S}Preview error`)} .pv .r1-errpanel` }],
    pairs: within(`${root('SCR-OFC-05')} .pv`, `${cap(`${S}Preview error`)} .pv`, ['.r1-errpanel', '.r1-errpanel b', '.r1-errpanel .btn']),
  },
  {
    name: 'SCR-OFC-05 No results (the note and Clear filters)',
    screen: 'SCR-OFC-05', captions: [`${S}No results`], app: '/shell-preview/customers/none', frame: SEARCH_FRAME,
    widthFrom: [{ app: `${root('SCR-OFC-05')} .left`, frame: `${cap(`${S}No results`)} p.r1-note` }],
    pairs: [{ app: `${root('SCR-OFC-05')} .left p.r1-note`, frame: `${cap(`${S}No results`)} p.r1-note` }],
  },
  {
    name: 'SCR-OFC-05 Error (CMP-12 in the results)',
    screen: 'SCR-OFC-05', captions: [`${S}Error`], app: '/shell-preview/customers/error', frame: SEARCH_FRAME,
    widthFrom: [{ app: `${root('SCR-OFC-05')} .left .r1-errpanel`, frame: `${cap(`${S}Error`)} .r1-errpanel` }],
    pairs: within(`${root('SCR-OFC-05')} .left`, cap(`${S}Error`), ['.r1-errpanel', '.r1-errpanel b', '.r1-errpanel .btn']),
  },
  {
    name: 'SCR-OFC-38 Empty (the dialog opened with empty fields)',
    screen: 'SCR-OFC-38', captions: [`${N}Empty`], app: '/shell-preview/customers/new-empty', frame: SEARCH_FRAME,
    pairs: within('.r1-scrim.in', cap(`${N}Empty`), [...DLG, ...FORM]),
  },
  {
    name: 'SCR-OFC-38 No street match (the message and the disabled Save)',
    screen: 'SCR-OFC-38', captions: [`${N}No street match`], app: '/shell-preview/customers/new-nomatch', frame: SEARCH_FRAME,
    pairs: within('.r1-scrim.in', cap(`${N}No street match`), [...DLG, '.r1-fmsg', '.r1-input.bad', '.r1-dlg-f .btn.dis']),
  },
  {
    name: 'SCR-OFC-38 Saving (Save customer busy)',
    screen: 'SCR-OFC-38', captions: [`${N}Saving`], app: '/shell-preview/customers/new-saving', frame: SEARCH_FRAME,
    pairs: within('.r1-scrim.in', cap(`${N}Saving`), [...DLG, '.r1-dlg-f .btn.busy', '.r1-dlg-f .btn.busy .r1-spin']),
  },
  {
    name: 'SCR-OFC-06 Success (the page: header, contact, address, Comfort Club, equipment, history, upcoming visit, notes, texts)',
    screen: 'SCR-OFC-06', captions: [`${P}Success`], app: '/shell-preview/customer/success', frame: CUSTOMER_FRAME,
    // F-853: the 4 controls of P4-CUSTOMER-ACTIONS the frame draws (Open text inbox, Text, Add equipment, Add note) are paired by their control id; Edit equipment (CTL-OFC-06-18) is in no frame state of this tile
    pairs: within(root('SCR-OFC-06'), cap(`${P}Success`), [...CUSTOMER_HEAD, ...CUSTOMER_BODY, ...['02', '14', '17', '19'].map((n) => `[data-ctl="CTL-OFC-06-${n}"]`)]),
  },
  {
    name: 'SCR-OFC-06 Loading (the skeleton)',
    screen: 'SCR-OFC-06', captions: [`${P}Loading`], app: '/shell-preview/customer/loading', frame: CUSTOMER_FRAME,
    widthFrom: [0, 1, 2, 3, 4, 5].map((i) => ({ app: `${root('SCR-OFC-06')} .body .r1-skel:nth-child(${i + 1})`, frame: `${cap(`${P}Loading`)} .r1-skel:nth-child(${i + 1})` })),
    pairs: [{ app: `${root('SCR-OFC-06')} .body .r1-skel`, frame: `${cap(`${P}Loading`)} .r1-skel` }],
  },
  {
    name: 'SCR-OFC-06 Editing zone (select, Save, Cancel)',
    screen: 'SCR-OFC-06', captions: [`${P}Editing zone`], app: '/shell-preview/customer/zone-edit', frame: CUSTOMER_FRAME,
    widthFrom: [{ app: `${root('SCR-OFC-06')} .kv.tz`, frame: `${cap(`${P}Editing zone`)} .kv.tz` }],
    pairs: [
      { app: `${root('SCR-OFC-06')} .kv.tz .tzrow`, frame: `${cap(`${P}Editing zone`)} .kv.tz .tzrow` },
      { app: `${root('SCR-OFC-06')} .kv.tz .tzsel`, frame: `${cap(`${P}Editing zone`)} .kv.tz .tzsel` },
      { app: `${root('SCR-OFC-06')} .kv.tz .btn.primary`, frame: `${cap(`${P}Editing zone`)} .kv.tz .btn.primary` },
      { app: `${root('SCR-OFC-06')} .kv.tz .btn:not(.primary)`, frame: `${cap(`${P}Editing zone`)} .kv.tz .btn:not(.primary)` },
    ],
  },
  {
    name: 'SCR-OFC-06 Saving zone (Save busy, Cancel off)',
    screen: 'SCR-OFC-06', captions: [`${P}Saving zone`], app: '/shell-preview/customer/zone-saving', frame: CUSTOMER_FRAME,
    widthFrom: [{ app: `${root('SCR-OFC-06')} .kv.tz`, frame: `${cap(`${P}Saving zone`)} .kv.tz` }],
    pairs: [
      { app: `${root('SCR-OFC-06')} .kv.tz .btn.busy`, frame: `${cap(`${P}Saving zone`)} .kv.tz .btn.busy` },
      { app: `${root('SCR-OFC-06')} .kv.tz .btn.dis`, frame: `${cap(`${P}Saving zone`)} .kv.tz .btn.dis` },
    ],
  },
  {
    name: 'SCR-OFC-39 Editing (the dialog with the current values)',
    screen: 'SCR-OFC-39', captions: [`${E}Editing`], app: '/shell-preview/customer/edit-editing', frame: CUSTOMER_FRAME,
    pairs: within('.r1-scrim.in', cap(`${E}Editing`), [...DLG, ...FORM]),
  },
  {
    name: 'SCR-OFC-39 Saving (Save busy, Cancel off)',
    screen: 'SCR-OFC-39', captions: [`${E}Saving`], app: '/shell-preview/customer/edit-saving', frame: CUSTOMER_FRAME,
    pairs: within('.r1-scrim.in', cap(`${E}Saving`), [...DLG, '.r1-dlg-f .btn.busy', '.r1-dlg-f .btn.dis']),
  },
  {
    name: 'SCR-OFC-40 Shown (the dialog: title, map box, address, Close)',
    screen: 'SCR-OFC-40', captions: [`${M}Shown`], app: '/shell-preview/customer/map', frame: CUSTOMER_FRAME,
    // The tile is 634 px wide and the page's dialog 720 px: the dialog is given the tile's width, and what is left is the look (F-674).
    widthFrom: [{ app: '.r1-scrim.in .r1-dlg', frame: `${cap(`${M}Shown`)} .r1-dlg` }],
    pairs: within('.r1-scrim.in', cap(`${M}Shown`), DLG),
  },
  {
    name: 'SCR-OFC-05 Searching (the skeleton rows under the search box)',
    screen: 'SCR-OFC-05', captions: [`${S}Searching`], app: '/shell-preview/customers/searching', frame: SEARCH_FRAME,
    widthFrom: [0, 1, 2, 3].map((i) => ({ app: `${root('SCR-OFC-05')} .bw-cu-skel .r1-skel:nth-child(${i + 1})`, frame: `${cap(`${S}Searching`)} .r1-skel:nth-child(${i + 1})` })),
    pairs: [{ app: `${root('SCR-OFC-05')} .bw-cu-skel .r1-skel`, frame: `${cap(`${S}Searching`)} .r1-skel` }],
  },
];

/**
 * Captioned frame states with no look case of their own, each with the reason. The coverage test checks every caption the 2 frames show is
 * compared by a case or named here, and that each named one is a caption of its frame.
 */
const FRAGMENT = 'the tile draws a fragment inside a 560 px tile (padding 14 px, widths from the tile); the page draws the same pieces in its own layout, which the Success case holds';
export const NOT_COMPARED: Record<string, { frame: string; why: string }> = {
  [`${N}Saved`]: { frame: SEARCH_FRAME, why: 'the dialog closes and the customer page opens: the page is the SCR-OFC-06 Success case; the tile is a heading and a note' },
  [`${P}Zone saved`]: { frame: CUSTOMER_FRAME, why: `the new zone and the CMP-11 toast: ${FRAGMENT}; the toast is held by the shell case. The app has no preview route for the saved zone yet, so no case compares the tile (F-674)` },
  [`${P}Changed`]: { frame: CUSTOMER_FRAME, why: `a note card and the CMP-11 toast: ${FRAGMENT}; the toast is held by the shell case. The state is live (the page re-reads after Add note and announces it) and no case compares the tile because it draws the new note with a teal inset bar (office-customer.html, the Changed tile) that the app does not draw; whether that bar is a kit state or a frame note is a doc batch question (F-853)` },
  [`${P}Not found`]: { frame: CUSTOMER_FRAME, why: 'the Page not found page (SCR-SHR-02) opens: held by the shared pages case' },
  [`${E}Saved`]: { frame: CUSTOMER_FRAME, why: 'the dialog closes, the page re-reads and the CMP-11 toast: the page is the Success case, the toast the shell case' },
  [`${M}Loading`]: { frame: CUSTOMER_FRAME, why: 'the map skeleton inside CMP-05: no look case holds it (shell-cases.ts has the CMP-05 failed case and no loading case, F-674); the map component draws it itself and no look defect is known' },
  [`${M}Map failed`]: { frame: CUSTOMER_FRAME, why: 'CMP-05\'s own failure message: held by the map component\'s own cases (the file failing is a map state)' },
};

export const CUSTOMERS_FRAMES = [SEARCH_FRAME, CUSTOMER_FRAME];

/** Captions the 2 frames show (read by the pw test) that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncovered(captions: Record<string, string[]>): string[] {
  const compared = new Set(CUSTOMERS_CASES.flatMap((c) => c.captions.map((x) => `${c.frame} | ${x}`)));
  const problems: string[] = [];
  for (const [frame, caps] of Object.entries(captions)) {
    for (const c of caps) {
      if (!/^(SCR-OFC-05|SCR-OFC-06|SCR-OFC-38|SCR-OFC-39|SCR-OFC-40)/.test(c)) continue;
      if (compared.has(`${frame} | ${c}`)) continue;
      const n = NOT_COMPARED[c];
      if (n && n.frame === frame) continue;
      problems.push(`no case compares ${frame} | ${c}`);
    }
  }
  for (const [c, n] of Object.entries(NOT_COMPARED)) if (!(captions[n.frame] ?? []).includes(c)) problems.push(`NOT_COMPARED names a caption its frame does not show: ${n.frame} | ${c}`);
  return problems;
}
