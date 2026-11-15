// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-NEWJOB (BUILD_PLAN P4-NEWJOB Acceptance, look clause): SCR-OFC-04 against DK-89 (mockups/pages/office-new-job.html),
// in each of the 7 states its frames show (light theme). A frame is picked by its frozen caption (UI-DESIGN-KIT 4.1), the way
// job-cases.ts does. App states are the harness build's /shell-preview/newjob/<state> routes (apps/web/src/newjob/NewJobPreview.tsx), each
// the page itself on the frame's own customer (Harold Jenkins, a water heater visit on Thu, Sep 17, 12-2 PM). The demo strip, the office top
// bar and the footer are the shell cases' (shell-cases.ts); this file holds the screen under them.
import type { SelectorPair } from './compare.ts';
import type { WidthFrom } from './shell-cases.ts';

export const NEWJOB_FRAME = 'mockups/pages/office-new-job.html';

export interface NewJobCase {
  name: string;
  /** The frame captions the case compares. */
  captions: string[];
  app: string;
  pairs: SelectorPair[];
  widthFrom?: WidthFrom[];
  /** An app selector to wait for (a read that answers after mount). */
  ready?: string;
}

const cap = (caption: string) => `[data-bw-cap="${caption}"]`;
export const NEWJOB_SCREEN = '.r1-screen[data-screen="SCR-OFC-04"]';
const N = 'SCR-OFC-04 New job: ';
const PICKED = cap(`${N}Customer picked`);
const tileOf = (caption: string) => `${cap(caption)} .b`;
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`.trim(), frame: `${frameRoot} ${s}`.trim() }));
const READY = `${NEWJOB_SCREEN} .tc .why`;

/** The header (breadcrumb, title, Cancel). */
const HEADER = ['.jh', '.jh .crumbs', '.jh .crumbs a', '.jh .crumbs .ic', '.jh .crumbs > span', '.jh h1', '.jh .acts', '.jh .acts .btn'];
/** The body grid, the cards' headers and the step numbers. */
const FRAME_ = ['.body', '.left', '.right', '.card', '.card .card-h', '.card .card-h h3', '.card .card-h .stepn', '.card .card-h .stepn .ic', '.card .card-h .btn', '.in'];
/** Step 1: the picked customer. */
const CUSTOMER = ['.cust', '.cust .av', '.cust .nm', '.cust .nm .chip', '.cust .d', '.cust .side', '.cust .side b'];
/** Step 2: the service and the 2 fields. */
const SERVICE = ['.svcs', '.svc', '.svc .ico', '.svc .ico .ic', '.svc.sel', '.svc.sel .ico', '.twof', '.lbl', '.fld', '.fld .ic'];
/** Step 3: the days, the windows and the room note. */
const DAYS = [
  '.card-h .muted', '.dw', '.days', '.dy', '.dy .r', '.dy .pk', '.dy.sel', '.dy.sel .r', '.wins', '.win', '.win .radio', '.win .cap', '.win .cap .bar', '.win .cap .bar i',
  '.win.sel', '.win.sel .radio', '.win.full', '.win.full .radio', '.win.full .cap .tag', '.win.full .cap .bar i', '.winnote',
];
/** Step 4: the suggested technicians, and No technician yet. */
const TECHS = [
  '.sug', '.sug .card-h', '.sug .sub', '.tc', '.tc.top', '.tc .h', '.tc .rank', '.tc.top .rank', '.tc .av', '.tc .pick', '.tc .why', '.tc .fac', '.tc .f',
  '.tc .f .v', '.tc.no', '.tc.no .av',
];
/** The Schedule card: the summary, the button and the notice. */
const GO = ['.go', '.go .sum', '.go .sum b', '.go .bb', '.go .bb .btn.primary', '.go .bb .btn.primary .ic', '.go .tx', '.go .tx .ic', '.go .tx div'];

const in1 = (name: string, state: string, caption: string, pairs: SelectorPair[], extra: Partial<NewJobCase> = {}): NewJobCase => ({ name, captions: [caption], app: `/shell-preview/newjob/${state}`, pairs, ...extra });
const tile = (caption: string) => tileOf(`${N}${caption}`);
/** The first card of the page against the card the tile draws. */
const FIRST_CARD = `${NEWJOB_SCREEN} .left > .card:nth-child(1)`;

export const NEWJOB_CASES: NewJobCase[] = [
  in1(`${N}Customer picked (header)`, 'picked', `${N}Customer picked`, within(NEWJOB_SCREEN, PICKED, HEADER), { ready: READY }),
  in1(`${N}Customer picked (cards, customer and service)`, 'picked', `${N}Customer picked`, within(NEWJOB_SCREEN, PICKED, [...FRAME_, ...CUSTOMER, ...SERVICE]), { ready: READY }),
  in1(`${N}Customer picked (day and window)`, 'picked', `${N}Customer picked`, within(NEWJOB_SCREEN, PICKED, DAYS), { ready: READY }),
  in1(`${N}Customer picked (technicians and Schedule)`, 'picked', `${N}Customer picked`, within(NEWJOB_SCREEN, PICKED, [...TECHS, ...GO]), { ready: READY }),
  in1(`${N}Start`, 'start', `${N}Start`, within(FIRST_CARD, `${tile('Start')} .card`, ['', '.card-h', '.card-h .stepn', '.card-h h3', '.card-h .btn', '.card-h .btn .ic', '.in', '.find', '.find .ic']), {
    widthFrom: [{ app: FIRST_CARD, frame: `${tile('Start')} .card` }],
  }),
  in1(`${N}No match`, 'no-match', `${N}No match`, [
    ...within(FIRST_CARD, `${tile('No match')} .card`, ['', '.card-h', '.in', '.find', '.find .ic', '.find .x']),
    { app: `${NEWJOB_SCREEN} .left > p.r1-note`, frame: `${tile('No match')} > p.r1-note` },
  ], {
    widthFrom: [{ app: FIRST_CARD, frame: `${tile('No match')} .card` }, { app: `${NEWJOB_SCREEN} .left > p.r1-note`, frame: `${tile('No match')} > p.r1-note` }],
  }),
  in1(`${N}No windows`, 'no-windows', `${N}No windows`, [
    { app: `${NEWJOB_SCREEN} .dw .days .dy.sel`, frame: `${tile('No windows')} .days .dy.sel` },
    { app: `${NEWJOB_SCREEN} .dw .days .dy.sel .pk`, frame: `${tile('No windows')} .days .dy.sel .pk` },
    { app: `${NEWJOB_SCREEN} .dw .days .dy.sel .r`, frame: `${tile('No windows')} .days .dy.sel .r` },
    { app: `${NEWJOB_SCREEN} .dw .wins`, frame: `${tile('No windows')} .wins` },
    { app: `${NEWJOB_SCREEN} .dw .wins .r1-note`, frame: `${tile('No windows')} .wins .r1-note` },
  ], {
    widthFrom: [{ app: `${NEWJOB_SCREEN} .dw .days`, frame: `${tile('No windows')} .days` }, { app: `${NEWJOB_SCREEN} .dw .wins`, frame: `${tile('No windows')} .wins` }],
    ready: `${NEWJOB_SCREEN} .dw .wins .r1-note`,
  }),
  in1(`${N}Saving`, 'saving', `${N}Saving`, [
    { app: `${NEWJOB_SCREEN} .jh .acts .btn.ghost.dis`, frame: `${tile('Saving')} .row .btn.ghost.dis` },
  ], {
    ready: `${NEWJOB_SCREEN} .go .btn.busy`,
  }),
  in1(`${N}Done`, 'done', `${N}Done`, [
    { app: '[data-bw-hosted="done"] .crumbs', frame: `${tile('Done')} .crumbs` },
    { app: '[data-bw-hosted="done"] .crumbs a', frame: `${tile('Done')} .crumbs a` },
    { app: '[data-bw-hosted="done"] .crumbs span', frame: `${tile('Done')} .crumbs span` },
    { app: '[data-bw-hosted="done"] .r1-toast', frame: `${tile('Done')} .r1-toast` },
    { app: '[data-bw-hosted="done"] .r1-toast span', frame: `${tile('Done')} .r1-toast span` },
  ], {
    // The toast's words are the catalog's (CTL-OFC-04-09: CMP-11 states the server's answer), not the tile's sample words: it takes the tile toast's width.
    // The trail's box fills what holds it, a small tile there and the page here: it takes the tile's width too.
    widthFrom: [{ app: '[data-bw-hosted="done"] .r1-toast', frame: `${tile('Done')} .r1-toast` }, { app: '[data-bw-hosted="done"] .r1-toast span', frame: `${tile('Done')} .r1-toast span` }, { app: '[data-bw-hosted="done"] .crumbs', frame: `${tile('Done')} .crumbs` }],
    ready: '[data-bw-hosted="done"] .r1-toast',
  }),
  in1(`${N}Input kept`, 'input-kept', `${N}Input kept`, [
    { app: `${NEWJOB_SCREEN} .go .msgb`, frame: `${tile('Input kept')} .msgb` },
    { app: `${NEWJOB_SCREEN} .go .msgb .ic`, frame: `${tile('Input kept')} .msgb .ic` },
    { app: `${NEWJOB_SCREEN} .go .msgb span`, frame: `${tile('Input kept')} .msgb span` },
    // 12-2 PM turned Full (the window that just filled) and 2-4 PM still has room.
    { app: `${NEWJOB_SCREEN} .wins .win:nth-child(3)`, frame: `${tile('Input kept')} .wins .win.full` },
    { app: `${NEWJOB_SCREEN} .wins .win:nth-child(3) .cap .tag`, frame: `${tile('Input kept')} .wins .win.full .cap .tag` },
    { app: `${NEWJOB_SCREEN} .wins .win:nth-child(4)`, frame: `${tile('Input kept')} .wins .win:not(.full)` },
  ], {
    widthFrom: [{ app: `${NEWJOB_SCREEN} .go .msgb`, frame: `${tile('Input kept')} .msgb` }, { app: `${NEWJOB_SCREEN} .wins`, frame: `${tile('Input kept')} .wins` }],
    ready: `${NEWJOB_SCREEN} .go .msgb`,
  }),
];

/**
 * Captioned states with no look case of their own, each with the reason. The coverage test checks that every caption of the screen on the
 * frame is compared by a case or named here, and that each named one is a caption. All 7 captions are compared (in part, see LEFT_OUT).
 */
export const NOT_COMPARED: Record<string, string> = {};

/** Parts of a compared state that its case leaves out, each with the reason (read with the cases; no gate reads this record). */
export const LEFT_OUT: Record<string, string> = {
  'Start and Customer picked: the customer search results list (CTL-OFC-04-01)': 'DK-89 draws no results list, so there is nothing to compare it with; the search and the click on a result are exercised by ci/newjob-stack (F-809 item c)',
  'Start: the placeholder span (.find .muted)': 'the tile draws the placeholder words as a span; the page draws a text field, whose placeholder is the field\'s own (the field and its box, .find, are compared)',
  'Customer picked: the technician cards\' names, van and skill lines and the Distance and Load values (.tc .nm, .tc .nm small, .tc .f .v b)': 'boxes that shrink to their words, which are the API\'s data here (names, the skill words, minutes and jobs of capacity), not the frame\'s sample words; the cards, their rows and the fact boxes around them are compared',
  'Saving: the summary and the spinner (.sum, .sum b, .r1-spin)': 'the tile draws them outside the Schedule card, so they lack the rules the card gives them (.go .sum at 13.5 px, ink-700, and the 15 px button the spinner sits in); the page draws them inside it as the Customer picked frame does, and the summary is compared in the Customer picked case',
  'Input kept: the windows list box (.wins)': 'its height follows the count of windows: the tile draws 2 of the day\'s 5 (12-2 PM and 2-4 PM); each window row is compared',
  'Input kept: the 2-4 PM room text (.win .cap)': 'the tile draws the window without the room bar the Customer picked frame draws in every open window; the window row is compared, and the cap in the Customer picked case',
  'Saving and Input kept: the Schedule button (.btn.primary, .btn.busy)': 'the tiles draw it in a plain row at the kit\'s default button size; the page keeps its 44 px Schedule button in the Schedule card in every state (CTL-OFC-04-09), as the Customer picked frame draws it, and that button is compared in the Customer picked case. The spinner and the disabled Cancel are compared',
  'Input kept: the summary (.sum)': 'the tile draws a stand-in sentence for "every field keeps its value"; the page keeps its own fields as the Customer picked case draws them and draws no summary line while the window is unpicked (CTL-OFC-04-18)',
  'Done: the title and the note (h3, p.r1-note)': 'the tile is a stand-in for the new job\'s page, SCR-OFC-03, which opens in this state: P4-JOB\'s job-cases.ts holds that page\'s title and body. The trail and the toast are compared, and ci/newjob-stack proves the trail on the real page Schedule opens',
  'Customer picked: the booked-visit line\'s sample words and the technician cards\' order': 'text is not compared; the frame ranks Greg Hoffman before Marcus Bell, whom SD-26 puts first by minutes from the stop before, so the page draws the answer\'s order and every card is compared by its place',
};

const OWN = /^SCR-OFC-04 /;

/** Captions of the screen the frame shows that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncoveredNewJob(captions: readonly string[]): string[] {
  const compared = new Set(NEWJOB_CASES.flatMap((c) => c.captions));
  const problems: string[] = [];
  for (const c of captions) if (OWN.test(c) && !compared.has(c) && !NOT_COMPARED[c]) problems.push(`no case compares ${c}`);
  for (const c of Object.keys(NOT_COMPARED)) if (!captions.includes(c)) problems.push(`NOT_COMPARED names a caption the frame does not show: ${c}`);
  return problems;
}
