// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-JOB (BUILD_PLAN P4-JOB Acceptance, look clause): SCR-OFC-03 and its 7 dialogs (SCR-OFC-20, -21, -22, -23,
// -35, -36, -37) against DK-87 (mockups/pages/office-job.html), in each state its frames show (light theme). A frame is picked by
// its frozen caption (UI-DESIGN-KIT 4.1), the way board-cases.ts does. App states are the harness build's
// /shell-preview/job/<state> routes (apps/web/src/job/JobPreview.tsx), each on the frame's own job (Harold Jenkins, job 24830).
// The demo strip, the office top bar and the footer are the shell cases' (shell-cases.ts); this file holds the screen under them.
import type { SelectorPair } from './compare.ts';
import type { WidthFrom } from './shell-cases.ts';

export const JOB_FRAME = 'mockups/pages/office-job.html';

export interface JobCase {
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
export const JOB_SCREEN = '.r1-screen[data-screen="SCR-OFC-03"]';
const J = 'SCR-OFC-03 Job detail: ';
const RS = 'SCR-OFC-20 Reschedule job: ';
const CV = 'SCR-OFC-21 Cancel visit: ';
const FV = 'SCR-OFC-22 Finish visit (office): ';
const ED = 'SCR-OFC-23 Edit job details: ';
export const TX = 'SCR-OFC-35 Text customer: ';
export const NT = 'SCR-OFC-36 Add note: ';
export const EQ = 'SCR-OFC-37 Add or edit equipment: ';
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`.trim(), frame: `${frameRoot} ${s}`.trim() }));
const tileOf = (caption: string) => `${cap(caption)} .b`;
export const hosted = (state: string) => `[data-bw-hosted="${state}"]`;

/** A dialog or toast drawn in its tile: the app's copy takes the tile body's width. */
export const inTile = (state: string, caption: string, inner: string[], box: string, extra: Partial<JobCase> = {}): JobCase => ({
  name: caption, captions: [caption], app: `/shell-preview/job/${state}`, ready: `${hosted(state)} ${box}`,
  widthFrom: [{ app: hosted(state), frame: tileOf(caption) }],
  pairs: within(hosted(state), tileOf(caption), [box, ...inner.map((s) => `${box} ${s}`)]),
  ...extra,
});

/** The page header (the frame's Success screen, under the top bar). */
const HEADER = [
  '.jh', '.jh .crumbs', '.jh .crumbs a', '.jh .crumbs .ic', '.jh .crumbs > span',
  '.jh .row', '.jh h1', '.jh h1 span', '.jh .chip.big', '.jh .chip.big .dot', '.jh .acts', '.jh .acts .btn', '.jh .acts .btn .ic',
  '.jh .meta', '.jh .meta .jline', '.jh .meta .jline > span', '.jh .meta .ic', '.jh .meta .acts2', '.jh .meta .acts2 .btn',
];
/** The left column's cards whose values the product holds as the frame writes them. */
const LEFT = [
  '.body', '.left', '.left > .card', '.card .card-h', '.card .card-h h3', '.card .card-h .lnk', '.card .card-h .muted',
  '.kv', '.kv dt', 'table.hist', 'table.hist th', 'table.hist td:first-child',
  '.notes', '.note', '.note .by',
];
/** The on-the-way panel and the feed card. */
const RIGHT = [
  '.right', '.arrive', '.arrive .top', '.arrive .top .s', '.arrive .top .s .pulse', '.arrive .top .big', '.arrive .top .sub', '.arrive .mapm',
  '.tech', '.tech .av', '.tech b', '.tech span.s', '.tech .btn', '.linkbox', '.linkbox .ic', '.linkbox div',
  '.right > .card:not(.arrive) .card-h', '.feed', '.ev .dot', '.ev .dot .ic',
];

export const DLG = ['.r1-dlg-h', '.r1-dlg-h h2', '.r1-x', '.r1-dlg-b', '.r1-dlg-f', '.r1-dlg-f .btn'];
const DAYS = ['.days', '.dy', '.dy .pk', '.dy .r', '.dy.sel', '.wins', '.win', '.win .radio', '.win .cap', '.win .tag', '.win.sel', '.win.full'];
const FIN = ['.r1-field', '.r1-field label', '.r1-fin-parts', '.r1-fin-row', '.r1-fin-ck', '.r1-fin-lab', '.r1-fin-lab .k', '.r1-fin-lab .r1-input'];
export const TXT = ['.to', '.to b', '.r1-field', '.r1-field label', '.cnt', '.r1-hint'];

const SUCCESS = `${cap(`${J}Success`)}`;
const READY = `${JOB_SCREEN} .arrive .tech`;
/** A toast's words are the catalog's (UI-SPECIFICATION: CTL-OFC-20-03 states the server's answer, CTL-OFC-35-04 "Held until 8:00 AM"), not the tile's sample words, so the toast takes the tile toast's width and every other value is compared. */
const toast = (state: string, caption: string): JobCase => inTile(state, caption, ['span'], '.r1-toast', {
  widthFrom: [{ app: `${hosted(state)} .r1-toast`, frame: `${tileOf(caption)} .r1-toast` }, { app: `${hosted(state)} .r1-toast span`, frame: `${tileOf(caption)} .r1-toast span` }],
});
/** A closed job's actions: the 4 meta-line buttons against the tile's row after its Reassign (the app draws Reassign in the header). */
const closedActs = (state: string, caption: string, extra: SelectorPair[] = [], widths: WidthFrom[] = []): JobCase => ({
  name: caption, captions: [caption], app: `/shell-preview/job/${state}`, ready: `${JOB_SCREEN} .jh .acts2 .btn.dis`,
  widthFrom: [{ app: `${JOB_SCREEN} .jh > p.r1-note`, frame: `${tileOf(caption)} p.r1-note` }, ...widths],
  pairs: [
    { app: `${JOB_SCREEN} .jh .acts2 .btn`, frame: `${tileOf(caption)} .row .btn:not(:first-child)` },
    { app: `${JOB_SCREEN} .jh > p.r1-note`, frame: `${tileOf(caption)} p.r1-note` },
    ...extra,
  ],
});

export const JOB_CASES: JobCase[] = [
  { name: `${J}Success (header)`, captions: [`${J}Success`], app: '/shell-preview/job/success', ready: READY, pairs: [
    ...within(JOB_SCREEN, SUCCESS, HEADER), { app: `${JOB_SCREEN} .jh .r1-live`, frame: `${SUCCESS} .jh > .r1-live` },
  ] },
  { name: `${J}Success (left column)`, captions: [`${J}Success`], app: '/shell-preview/job/success', ready: READY, pairs: within(JOB_SCREEN, SUCCESS, LEFT) },
  { name: `${J}Success (on-the-way panel and feed)`, captions: [`${J}Success`], app: '/shell-preview/job/success', ready: READY, pairs: within(JOB_SCREEN, SUCCESS, RIGHT) },
  {
    name: `${J}Loading`, captions: [`${J}Loading`], app: '/shell-preview/job/loading',
    widthFrom: [{ app: `${JOB_SCREEN} .bw-job-state`, frame: tileOf(`${J}Loading`) }],
    pairs: [{ app: `${JOB_SCREEN} .bw-job-state .r1-skel`, frame: `${tileOf(`${J}Loading`)} .r1-skel` }],
  },
  {
    name: `${J}On the way (the panel)`, captions: [`${J}On the way`], app: '/shell-preview/job/success', ready: `${JOB_SCREEN} .arrive .tech`,
    widthFrom: [{ app: `${JOB_SCREEN} .arrive`, frame: `${tileOf(`${J}On the way`)} .arrive` }],
    pairs: within(`${JOB_SCREEN} .arrive`, `${tileOf(`${J}On the way`)} .arrive`, ['.top', '.top .s', '.top .big', '.top .sub', '.tech', '.tech .av', '.tech b', '.tech span.s', '.linkbox']),
  },
  toast('changed', `${J}Changed`),
  closedActs('canceled', `${J}Canceled`),
  closedActs('no-one-home', `${J}No one home`),
  closedActs('done', `${J}Done`, [
    { app: `${JOB_SCREEN} .wd ul`, frame: `${tileOf(`${J}Done`)} .wd ul` },
    { app: `${JOB_SCREEN} .wd li`, frame: `${tileOf(`${J}Done`)} .wd li` },
    { app: `${JOB_SCREEN} .bill .chip`, frame: `${tileOf(`${J}Done`)} .bill .chip` },
    { app: `${JOB_SCREEN} .bill .r1-link`, frame: `${tileOf(`${J}Done`)} .bill .r1-link` },
  ], [{ app: `${JOB_SCREEN} .wd`, frame: `${tileOf(`${J}Done`)} .wd` }]),
  inTile('reschedule-loading', `${RS}Loading`, [...DLG, '.r1-skel'], '.r1-dlg'),
  inTile('reschedule-choosing', `${RS}Choosing`, [...DLG, ...DAYS], '.r1-dlg', { ready: `${hosted('reschedule-choosing')} .win` }),
  inTile('reschedule-no-room', `${RS}No room`, [...DLG, '.r1-note'], '.r1-dlg', { ready: `${hosted('reschedule-no-room')} .r1-note` }),
  inTile('reschedule-saving', `${RS}Saving`, [...DLG, ...DAYS, '.r1-spin'], '.r1-dlg', { ready: `${hosted('reschedule-saving')} .win` }),
  toast('reschedule-done', `${RS}Done`),
  inTile('cancel-asking', `${CV}Asking`, [...DLG, 'p'], '.r1-dlg'),
  inTile('cancel-canceling', `${CV}Canceling`, [...DLG, 'p', '.r1-spin'], '.r1-dlg'),
  toast('cancel-done', `${CV}Done`),
  inTile('finish-empty', `${FV}Empty`, [...DLG, ...FIN, '.r1-fin-parts .r1-note'], '.r1-dlg'),
  inTile('finish-no-match', `${FV}No part match`, [...DLG, ...FIN, '.r1-fmsg'], '.r1-dlg', { ready: `${hosted('finish-no-match')} .r1-fmsg` }),
  inTile('finish-invalid', `${FV}Invalid`, [...DLG, ...FIN, '.r1-fmsg'], '.r1-dlg'),
  inTile('finish-saving', `${FV}Saving`, [...DLG, ...FIN, '.pr', '.pn b', '.pn code', '.r1-spin'], '.r1-dlg'),
  toast('finish-done', `${FV}Done`),
  inTile('edit-editing', `${ED}Editing`, [...DLG, '.r1-field', '.r1-field label', '.r1-input'], '.r1-dlg'),
  inTile('edit-saving', `${ED}Saving`, [...DLG, '.r1-field', '.r1-field label', '.r1-input', '.r1-spin'], '.r1-dlg'),
  toast('edit-done', `${ED}Done`),
  inTile('text-empty', `${TX}Empty`, [...DLG, ...TXT], '.r1-dlg'),
  inTile('text-typing', `${TX}Typing`, [...DLG, ...TXT], '.r1-dlg'),
  inTile('text-too-long', `${TX}Too long`, [...DLG, ...TXT], '.r1-dlg'),
  inTile('text-sending', `${TX}Sending`, [...DLG, ...TXT, '.r1-spin'], '.r1-dlg'),
  toast('text-sent', `${TX}Sent`),
  toast('text-held', `${TX}Held`),
  inTile('text-refused', `${TX}Refused`, [...DLG, ...TXT, '.r1-fmsg'], '.r1-dlg'),
  inTile('note-empty', `${NT}Empty`, [...DLG, '.r1-field', '.r1-field label', '.r1-hint'], '.r1-dlg'),
  inTile('note-typing', `${NT}Typing`, [...DLG, '.r1-field', '.r1-field label', '.r1-hint'], '.r1-dlg'),
  inTile('note-saving', `${NT}Saving`, [...DLG, '.r1-field', '.r1-field label', '.r1-hint', '.r1-spin'], '.r1-dlg'),
  toast('note-saved', `${NT}Saved`),
  inTile('equipment-editing', `${EQ}Editing`, [...DLG, '.r1-field', '.r1-field label', '.r1-input', '.g2f'], '.r1-dlg'),
  inTile('equipment-saving', `${EQ}Saving`, [...DLG, '.r1-field', '.r1-field label', '.r1-input', '.g2f', '.r1-spin'], '.r1-dlg'),
  toast('equipment-saved', `${EQ}Saved`),
];

/**
 * Captioned states with no look case of their own, each with the reason. The coverage test checks that every caption of the 8
 * screens on the frame is compared by a case or named here, and that each named one is a caption.
 */
export const NOT_COMPARED: Record<string, string> = {
  [`${J}Partial`]: 'the tile draws a photo that failed to load ("Photo could not load"); the app draws the same words in a span.th.fail (JobScreen.tsx PhotoThumb, F-707). A case was tried (W28): only a line-height of 16.1 px against the tile\'s 16.7 px differs, from the tile\'s 13.5 px base font against the page\'s 14 px, a styling matter held for the styling pass (F-1032)',
  [`${EQ}Adding`]: 'Add equipment (SCR-OFC-37 in add mode) opens from the customer page (CTL-OFC-06, SCR-OFC-06), not from this page: CTL-OFC-03-24 opens edit mode only (UI-SPECIFICATION CTL-OFC-03-24); the customer page lane compares it',
  [`${J}Panel ended`]: 'the tile draws the On site chip at the tile\'s own smaller size (.r1-st .chip.big, 13.5 px) and a note saying the panel is gone; the chip is the Success case\'s, and the panel going away at arrival is held by the Compose-stack suite (ci/job-stack/job.stack.ts, "takes the panel and the map off Harold\'s open page when Maria arrives")',
  [`${J}Not found`]: 'the tile is a note: an unknown job number opens the Page not found page (SCR-SHR-02), whose look case is the shell\'s (shell-cases.ts)',
  [`${RS}Outcome not saved`]: 'opened from the call list (SCR-OFC-09, the call list lane): the job page never records a call outcome',
};

/** Parts of a compared state that its case leaves out, each with the reason (read with the cases; no gate reads this record). */
export const LEFT_OUT: Record<string, string> = {
  'SCR-OFC-20 Done: the toast\'s words (job.reschedule.doneKept)': 'the case reads a fixed line at the tile\'s width (F-787); the catalog\'s whole line on the real toast is checked by ci/job-stack/job.stack.ts (F-827)',
  'Canceled, Done, No one home: the Reassign button': 'the tile draws Reassign small in the actions row; the app keeps it in the header at the header button size, compared in the Success case',
  'Done: the signature image (.sig)': 'API-23 carries who signed and when, not the image (CTL-OFC-03-30); the signed line is drawn, the image is not (F-708)',
};

const OWN = /^(SCR-OFC-03|SCR-OFC-20|SCR-OFC-21|SCR-OFC-22|SCR-OFC-23|SCR-OFC-35|SCR-OFC-36|SCR-OFC-37) /;

/** Captions of the 8 screens the frame shows that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncoveredJob(captions: readonly string[]): string[] {
  const compared = new Set(JOB_CASES.flatMap((c) => c.captions));
  const problems: string[] = [];
  for (const c of captions) if (OWN.test(c) && !compared.has(c) && !NOT_COMPARED[c]) problems.push(`no case compares ${c}`);
  for (const c of Object.keys(NOT_COMPARED)) if (!captions.includes(c)) problems.push(`NOT_COMPARED names a caption the frame does not show: ${c}`);
  return problems;
}
