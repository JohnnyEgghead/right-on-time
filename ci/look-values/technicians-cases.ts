// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-TECHNICIANS (BUILD_PLAN P4-TECHNICIANS Acceptance, look clause): SCR-OFC-07 and its 2 dialogs SCR-OFC-41 and SCR-OFC-42 against
// DK-92 (mockups/pages/office-technicians.html), in each state its frames show (light theme). A frame is picked by its frozen caption
// (UI-DESIGN-KIT 4.1), the way job-cases.ts does. App states are the harness build's /shell-preview/technicians/<state> routes
// (apps/web/src/technicians/TechniciansPreview.tsx), each on the frame's own Columbus day (tech-fixtures.ts). The demo strip, the office top bar and
// the footer are the shell cases' (shell-cases.ts); this file holds the screen under them.
import type { SelectorPair } from './compare.ts';
import type { WidthFrom } from './shell-cases.ts';

export const TECH_FRAME = 'mockups/pages/office-technicians.html';

export interface TechCase {
  name: string;
  /** The frame captions the case compares. */
  captions: string[];
  app: string;
  pairs: SelectorPair[];
  widthFrom?: WidthFrom[];
  /** An app selector to wait for (a dialog whose reads answer after mount). */
  ready?: string;
}

const cap = (caption: string) => `[data-bw-cap="${caption}"]`;
export const TECH_SCREEN = '.r1-screen[data-screen="SCR-OFC-07"]';
const P = 'SCR-OFC-07 Technicians: ';
const A = 'SCR-OFC-41 Add technician: ';
const D = 'SCR-OFC-42 Add time off: ';
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`.trim(), frame: `${frameRoot} ${s}`.trim() }));
const tileOf = (caption: string) => `${cap(caption)} .b`;
const hosted = (state: string) => `[data-bw-hosted="${state}"]`;
const SUCCESS = cap(`${P}Success`);
const READY = `${TECH_SCREEN} .tbl tbody tr`;

/** The page header and the search and filters (the frame's Success screen, under the top bar). */
const HEADER = ['.pgh', '.pgh h1', '.pgh p', '.pgh .acts', '.pgh .acts .btn', '.pgh .acts .btn .ic'];
const FILTERS = ['.filters', '.sbox', '.sbox .ic', '.filters .sel', '.filters .sel .k', '.filters .sel b', '.filters .sel .ic'];
/** The table with its load bars and apps, and the phone app note. */
const TABLE = [
  '.body', '.lcol', '.tbl', '.tbl table', '.tbl th', '.tbl tbody tr', '.tbl td', '.who', '.who .av', '.two', '.two b', '.two small', '.us', '.tags', '.tag',
  '.load', '.load .n', '.load .bar', '.load .bar i', 'td .chip', 'td .chip .dot', '.app', '.app .ic', '.app > span', '.app small',
  '.foot', '.foot .ic',
];
/**
 * F-843: owner ruling 466b3215 (F-772) words the CTL-OFC-07-07 link "Day on the board" for every technician; the frozen frame says
 * "Her day on the board". The link's width follows its words and the spacer beside it takes the width the shorter words leave, so
 * those 2 widths are not compared; every other value of both is, and Cancel and Save are compared in full.
 */
const RULED_LINK = 'F-772, owner ruling 466b3215: the link reads Day on the board';
const PANEL_ACTS: SelectorPair[] = [
  { app: '.det .acts > .btn[data-ctl="CTL-OFC-07-07"]', wordsRuled: RULED_LINK },
  { app: '.det .acts > .btn:not([data-ctl="CTL-OFC-07-07"])' },
  { app: '.det .acts .grow', wordsRuled: `${RULED_LINK} (the spacer takes the width the shorter words leave)` },
];
/** The side panel on Maria Santos. */
const PANEL = [
  '.det', '.det .top', '.det .top .av', '.det .top b', '.det .top .s', '.det .top .x', '.det .dsc', '.det .kv dt:not(.bw-tc-emp)', '.det .kv dd:not(.bw-tc-emp)', '.det .kv dd.mob', '.det .kv .chip',
  '.det .kv .chip .dot', '.det .kv .call', '.det .kv small',
  '.det .g2', '.det .g2 > div', '.det .g2 label', '.det .inp', '.det .inp .ic', '.det .chk', '.det .chk .ic',
  '.det h4', '.det h4 a', '.det .cks', '.det .cks span:nth-child(-n+3)', '.det .hrs', '.det .hrs div', '.det .hrs div span',
  '.det .toff', '.det .toff div', '.det .toff b', '.det .toff .btn',
  '.det .acts',
];

/** A panel state drawn in its tile: the fields' fragment, the app's copy takes the tile's width. */
const panelTile = (state: string, caption: string, inner: (string | SelectorPair)[], extra: Partial<TechCase> = {}): TechCase => ({
  name: caption, captions: [caption], app: `/shell-preview/technicians/${state}`, ready: `${TECH_SCREEN} .det`,
  widthFrom: [{ app: `${TECH_SCREEN} .det`, frame: `${tileOf(caption)} .det` }],
  pairs: inner.map((s) => {
    const q = typeof s === 'string' ? { app: s, frame: s } : { app: s.app, frame: s.frame ?? s.app };
    return { app: `${TECH_SCREEN} .det ${q.app}`, frame: `${tileOf(caption)} .det ${q.frame}` };
  }),
  ...extra,
});
const NAME = ['.g2', '.g2 > div', '.g2 label', '.g2 .inp', '.g2 .inp .ic', '.g2 .chk'];
const SAVE_BTNS = [{ app: '.acts > button.btn', frame: '.acts > .btn' }];

/** A dialog or toast drawn in its tile: the app's copy takes the tile body's width. */
const inTile = (state: string, caption: string, inner: string[], box: string, extra: Partial<TechCase> = {}): TechCase => ({
  name: caption, captions: [caption], app: `/shell-preview/technicians/${state}`, ready: `${hosted(state)} ${box}`,
  widthFrom: [{ app: hosted(state), frame: tileOf(caption) }],
  pairs: within(hosted(state), tileOf(caption), [box, ...inner.map((s) => `${box} ${s}`)]),
  ...extra,
});
/** A toast's words are the catalog's (UI-SPECIFICATION: CTL-OFC-07-05 "Technician saved", CTL-OFC-42-03 names the jobs), so the toast takes the tile toast's width and every other value is compared. */
const toast = (state: string, caption: string): TechCase => inTile(state, caption, ['span'], '.r1-toast', {
  widthFrom: [{ app: `${hosted(state)} .r1-toast`, frame: `${tileOf(caption)} .r1-toast` }, { app: `${hosted(state)} .r1-toast span`, frame: `${tileOf(caption)} .r1-toast span` }],
});

const DLG = ['.r1-dlg-h', '.r1-dlg-h h2', '.r1-x', '.r1-dlg-b', '.r1-dlg-f', '.r1-dlg-f .btn'];
const ADD_FORM = ['.r1-field', '.r1-field label', '.r1-input', '.g2f', '.cks', '.cks span', '.hrs', '.hrs div', '.hrs div span'];
/** Saving: the frame's Email and Branch columns are as wide as the long address sets them (a div's min-content); a field's columns are equal in the app. */
const ADD_SAVING = ['> .r1-dlg-b > .r1-field:first-child', '.cks', '.cks span', '.hrs', '.hrs div', '.hrs div span', '.r1-dlg-b > div:nth-of-type(3)', '.r1-dlg-b > div:nth-of-type(4)', '.r1-dlg-b > div:nth-of-type(3) .r1-input', '.r1-dlg-b > div:nth-of-type(4) label'];
const WHEN = ['.g2f', '.r1-field', '.r1-field label', '.r1-input'];

export const TECH_CASES: TechCase[] = [
  { name: `${P}Success (header and filters)`, captions: [`${P}Success`], app: '/shell-preview/technicians/success', ready: READY, pairs: within(TECH_SCREEN, SUCCESS, [...HEADER, ...FILTERS]) },
  { name: `${P}Success (table)`, captions: [`${P}Success`], app: '/shell-preview/technicians/success', ready: READY, pairs: within(TECH_SCREEN, SUCCESS, TABLE) },
  { name: `${P}Success (side panel)`, captions: [`${P}Success`], app: '/shell-preview/technicians/success', ready: READY, pairs: [...within(TECH_SCREEN, SUCCESS, PANEL), ...PANEL_ACTS.map((x) => ({ ...x, app: `${TECH_SCREEN} ${x.app}`, frame: `${SUCCESS} ${x.frame ?? x.app}` }))] },
  {
    name: `${P}Loading`, captions: [`${P}Loading`], app: '/shell-preview/technicians/loading',
    widthFrom: [{ app: `${TECH_SCREEN} .bw-tc-state`, frame: tileOf(`${P}Loading`) }],
    pairs: [{ app: `${TECH_SCREEN} .bw-tc-state .r1-skel`, frame: `${tileOf(`${P}Loading`)} .r1-skel` }],
  },
  {
    name: `${P}Empty`, captions: [`${P}Empty`], app: '/shell-preview/technicians/empty', ready: `${TECH_SCREEN} .bw-tc-state .r1-note`,
    widthFrom: [{ app: `${TECH_SCREEN} .bw-tc-state`, frame: tileOf(`${P}Empty`) }],
    pairs: [
      { app: `${TECH_SCREEN} .bw-tc-state .r1-note`, frame: `${tileOf(`${P}Empty`)} .r1-note` },
      { app: `${TECH_SCREEN} .bw-tc-state .btn`, frame: `${tileOf(`${P}Empty`)} .btn` },
      { app: `${TECH_SCREEN} .bw-tc-state .btn .ic`, frame: `${tileOf(`${P}Empty`)} .btn .ic` },
    ],
  },
  {
    name: `${P}No match`, captions: [`${P}No match`], app: '/shell-preview/technicians/no-match', ready: `${TECH_SCREEN} .bw-tc-state .r1-note`,
    widthFrom: [{ app: `${TECH_SCREEN} .bw-tc-state`, frame: tileOf(`${P}No match`) }],
    pairs: [
      { app: `${TECH_SCREEN} .bw-tc-state .r1-note`, frame: `${tileOf(`${P}No match`)} .r1-note` },
      { app: `${TECH_SCREEN} .filters > span.sel:nth-of-type(2)`, frame: `${tileOf(`${P}No match`)} .sel:nth-of-type(1)` },
      { app: `${TECH_SCREEN} .filters > span.sel:nth-of-type(3)`, frame: `${tileOf(`${P}No match`)} .sel:nth-of-type(2)` },
    ],
  },
  panelTile('checking', `${P}Checking`, [...NAME, '.chk .r1-spin', ...SAVE_BTNS]),
  panelTile('problem', `${P}Problem`, [...NAME, ...SAVE_BTNS]),
  panelTile('saved', `${P}Saved`, [...NAME, { app: '.acts > button.btn:last-child', frame: '.acts > .btn:last-child' }]),
  toast('saved', `${P}Saved`),
  panelTile('time-off-removed', `${P}Time off removed`, [{ app: 'h4:last-of-type', frame: 'h4' }, { app: 'h4:last-of-type a', frame: 'h4 a' }, '.toff', '.toff .r1-note']),
  toast('time-off-removed', `${P}Time off removed`),
  {
    name: `${P}App offline`, captions: [`${P}App offline`], app: '/shell-preview/technicians/app-offline', ready: `${TECH_SCREEN} .det .app.wait`,
    widthFrom: [{ app: `${TECH_SCREEN} .det .kv dd .app.wait`, frame: `${tileOf(`${P}App offline`)} .app.wait` }],
    pairs: [
      { app: `${TECH_SCREEN} .det .kv .app.wait`, frame: `${tileOf(`${P}App offline`)} .app.wait` },
      { app: `${TECH_SCREEN} .det .kv .app.wait .ic`, frame: `${tileOf(`${P}App offline`)} .app.wait .ic` },
      { app: `${TECH_SCREEN} .det .kv .app.wait small`, frame: `${tileOf(`${P}App offline`)} .app.wait small` },
    ],
  },
  inTile('add-editing', `${A}Editing`, [...DLG, ...ADD_FORM], '.r1-dlg'),
  inTile('add-saving', `${A}Saving`, [...DLG, ...ADD_SAVING, '.r1-spin'], '.r1-dlg'),
  inTile('add-added', `${A}Added`, [...DLG, 'p', '.r1-link'], '.r1-dlg'),
  inTile('add-used', `${A}Link used`, [...DLG, 'p', '.r1-note'], '.r1-dlg'),
  inTile('timeoff-editing', `${D}Editing`, [...DLG, ...WHEN], '.r1-dlg'),
  inTile('timeoff-saving', `${D}Saving`, [...DLG, ...WHEN, '.r1-spin'], '.r1-dlg'),
  panelTile('time-off-saved', `${D}Saved`, [{ app: 'h4:last-of-type', frame: 'h4' }, '.toff', '.toff div', '.toff b', '.toff .btn']),
  toast('time-off-saved', `${D}Saved`),
];

/**
 * Captioned states with no look case of their own, each with the reason. The coverage test checks that every caption of the 3 screens on the frame
 * is compared by a case or named here, and that each named one is a caption.
 */
export const NOT_COMPARED: Record<string, string> = {};

/** Parts of a compared state that its case leaves out, each with the reason (read with the cases; no gate reads this record). */
export const LEFT_OUT: Record<string, string> = {
  'Success: the 4th and 5th skill chips of the panel': 'the frame draws Maria Santos with 5 skills in her table row ("+3" after 2 tags) but ticks only 3 of the 5 chips in the panel; the app draws what the row holds, all 5 ticked',
  'Add technician, Saving: the whole Email and Branch row (the second .g2f, its 2 fields, labels and inputs)': 'no pair reads anything inside it, not only widths (F-770): the frame\'s 2 columns are as wide as the long address sets them (a div\'s min-content, 244.64 and 223.36 px) and the app\'s inputs fit their column, so every pair under it would differ in width; the row\'s other values (fonts, colors, borders, padding, gaps) are compared in the Editing case, where both columns are equal',
  'App offline: the note under the report': 'the tile draws the note across its own 420 px; in the app it sits in the Phone apps line of the panel, 279 px wide',
  'Saved: the panel\'s Cancel button': 'the tile draws Cancel enabled after the save; the app disables it (nothing is changed after a save, CTL-OFC-07-06 "a field changed")',
  'Success: the employee number line, and the details list\'s own box (.det .kv) with its padding, row-gap and column-gap': 'SD-29 and GAP-27 show the number on this page and the frame draws no such line (F-763); it is the last row of the details list, in the same dt and dd, so the list is 1 row taller than the frame\'s and the comparator has no per-pair height exception: no pair reads the list itself (all 27 values of that box, F-821), and the 4 frame dt and dd rows above the number are still compared',
  'Panel and Add technician: the hours editor and its field message': 'no frame draws them (the frames show the hours as text, MD-52, F-763): pressing the hours opens the kit\'s check chip and field in the frame\'s hours box, the resting text is compared in the Success and Editing cases, and the page walkers read the 3 editor previews (hours-editing, hours-problem, add-hours)',
};

const OWN = /^(SCR-OFC-07|SCR-OFC-41|SCR-OFC-42) /;

/** Captions of the 3 screens the frame shows that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncoveredTech(captions: readonly string[]): string[] {
  const compared = new Set(TECH_CASES.flatMap((c) => c.captions));
  const problems: string[] = [];
  for (const c of captions) if (OWN.test(c) && !compared.has(c) && !NOT_COMPARED[c]) problems.push(`no case compares ${c}`);
  for (const c of Object.keys(NOT_COMPARED)) if (!captions.includes(c)) problems.push(`NOT_COMPARED names a caption the frame does not show: ${c}`);
  return problems;
}
