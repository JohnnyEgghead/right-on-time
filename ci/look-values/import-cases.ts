// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-ADMIN-IMPORT (BUILD_PLAN P4-ADMIN-IMPORT Acceptance, look clause): SCR-OFC-13, SCR-OFC-14 and SCR-OFC-15 and their
// dialogs (SCR-OFC-25, SCR-OFC-26) against DK-98, DK-99 and DK-100, in each state a frame shows. A frame state is picked by its frozen
// caption (UI-DESIGN-KIT section 4.1): the setup tags the element each caption labels with data-bw-cap. App states are the harness
// build's /shell-preview/import-dry, import-dups and import-hist routes (apps/web/app/shell-preview), each fixed to its frame's data.
import type { SelectorPair } from './compare.ts';

export interface ImportCase {
  name: string;
  screen: string;
  captions: string[];
  app: string;
  frame: string;
  pairs: SelectorPair[];
  /** Elements the tile draws narrower than the page: the app element takes the frame element's width, as the billing cases do. */
  widthFrom?: { app: string; frame: string }[];
}

const DRY = 'mockups/pages/admin-import-dryrun.html';
const DUPS = 'mockups/pages/admin-import-duplicates.html';
const HIST = 'mockups/pages/r1-admin-history.html';
const cap = (c: string) => `[data-bw-cap="${c}"]`;
const root = (screen: string) => `.r1-screen[data-screen="${screen}"]`;
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`, frame: `${frameRoot} ${s}` }));

const D = 'SCR-OFC-13 Admin: import, dry run: ';
const R = 'SCR-OFC-25 Run the import: ';
const P = 'SCR-OFC-14 Admin: import, duplicates: ';
const H = 'SCR-OFC-15 Admin: import, history: ';
const U = 'SCR-OFC-26 Undo a merge: ';

const HEADER = ['.ah', '.ah h1', '.ah p', '.tabs', '.tabs a', '.tabs a .ic', '.tabs a.on', '.tabs .n'];

/** `.cnt .l span` (the card's note) is left out: S4-1 words the visits note 'Sep 2020 to Aug 2026', the frame prints 'Sep 2020 - Aug 2026'. */
const DRY_REPORT = [
  ...HEADER, '.body', '.banner', '.banner .big', '.banner h2', '.banner p', '.banner .acts', '.banner .btn',
  '.counts', '.cnt', '.cnt .l', '.cnt .v', '.sbar', '.sbar i', '.k3', '.k3 span', '.k3 i', '.k3 b',
  '.lower', '.panel .ph', '.panel h3', '.ph .tot', 'table.pr', 'table.pr th', 'table.pr td', 'table.pr .rs b', 'table.pr .rs small', 'table.pr tr', '.chip.flag', '.chip.no', '.ex', '.ex div',
  '.rcol', '.dup', '.dup .big', '.dup .row', '.dup .row b', '.run', '.run .btn.accent', '.run .conf', '.run .conf b',
];

/**
 * All 10 rows of CTL-OFC-14-06 (P4-IMPORT-FRAMES, owner ruling d9901466 "Match the design fully"): the 2-line Address, Equipment and
 * Visits cells with their second lines, and the Plan and Notes rows; and the header's old customer numbers.
 */
const CMP_ROWS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap((n) => [`table.c tbody tr:nth-child(${n})`, `table.c tbody tr:nth-child(${n}) td`, `table.c tbody tr:nth-child(${n}) .tag`]);
const CMP_LINES = ['table.c tbody tr:nth-child(2) td.v small', 'table.c tbody tr:nth-child(6) td.v small', 'table.c tbody tr:nth-child(7) td.v small', 'table.c th small'];
/**
 * Left out (F-843), as the history case leaves out `.body` and the messages and week cases their fixed boxes: `.body`, `.work`, `.queue` and
 * `.cmp`. The frame is a 1440 x 900 picture whose `.work` is a fixed 584 px box and whose panels clip (overflow hidden); the page grows
 * with its content (styles/page-admin-import.css). Since all 10 rows are drawn the shown pair is 577 px on the Mac, so both are 584 px
 * there; on the Spectre rig the pair's sub line (`.cmp .top p`) takes a second line on both sides, the content is 595.36 px, the frame
 * clips its own action row by 11.36 px and the page shows it. Every child of those boxes is compared, and the panel look is `.sum`'s.
 */
const DUP_SUCCESS = [
  ...HEADER, '.sum', '.sum .st', '.sum .st b', '.sum .st span', '.sum .prog', '.sum .prog .t', '.sum .prog .t b', '.pbar', '.pbar i', '.pk', '.pk span', '.pk i',
  '.queue .ph', '.queue .ph h3', '.shw', '.shw b', '.qi', '.qi .no', '.qi b', '.qi small', '.qi .chip', '.qi.now', '.qmore',
  '.cmp .top', '.cmp .top h2', '.cmp .top p', '.cmp .top .nav', '.cmp .top .nav .btn', 'table.c th', ...CMP_ROWS, ...CMP_LINES,
  '.acts', '.acts .btn', '.acts kbd', '.acts .hint',
];

/**
 * `.body` is a fixed-height column in the frame's 900 px screen; `.ph .s` is text-length bound (the runs note names the date). The runs
 * table is compared whole, and so is the merges table: each merge's address line (`.pair small`, P4-IMPORT-FRAMES) and the
 * "Showing 5 of 1,206 merges" count under it (`.ft span`).
 */
const HIST_SUCCESS = [
  ...HEADER, 'section.panel:first-of-type', '.panel h3', 'table.t th', 'table.t .chip', '[data-ctl="CTL-OFC-15-01"] tr', '[data-ctl="CTL-OFC-15-01"] td', '[data-ctl="CTL-OFC-15-01"] .n', '.cnts', '.cnts b', '.jl',
  '.find', '.find label', '.find .r1-input', '[data-ctl="CTL-OFC-15-04"] tr', '[data-ctl="CTL-OFC-15-04"] td', '.pair', '.pair b', '.pair small', 'table.t .btn.sm',
  '.ft', '.ft span', '.ft .btn',
];

const DLG = ['.r1-dlg', '.r1-dlg-h', '.r1-dlg-h h2', '.r1-x', '.r1-x .ic', '.r1-dlg-b', '.r1-dlg-f', '.r1-dlg-f .btn'];

export const IMPORT_CASES: ImportCase[] = [
  {
    name: 'SCR-OFC-13 Report (the page: header and tabs, run line, the 3 count cards, problems by reason, duplicates, Run the real import)',
    screen: 'SCR-OFC-13', captions: [`${D}Report`], app: '/shell-preview/import-dry/dry-report', frame: DRY,
    pairs: within(root('SCR-OFC-13'), cap(`${D}Report`), DRY_REPORT),
  },
  {
    name: 'SCR-OFC-13 No dry run (the button)',
    screen: 'SCR-OFC-13', captions: [`${D}No dry run`], app: '/shell-preview/import-dry/dry-none', frame: DRY,
    pairs: [{ app: `${root('SCR-OFC-13')} .body .btn`, frame: `${cap(`${D}No dry run`)} .btn` }],
  },
  {
    name: 'SCR-OFC-13 Running (both Run buttons off)',
    screen: 'SCR-OFC-13', captions: [`${D}Running`], app: '/shell-preview/import-dry/dry-running', frame: DRY,
    // F-625: the progress line (CTL-OFC-13-05: its box, the 10 px bar and its fill; the bold text's font is read below, its width is left out, see LEFT_OUT) and the note, as well as the 2 buttons; the tile is narrower than the page
    widthFrom: [{ app: `${root('SCR-OFC-13')} [data-ctl="CTL-OFC-13-05"]`, frame: `${cap(`${D}Running`)} [data-ctl="CTL-OFC-13-05"]` }, { app: `${root('SCR-OFC-13')} .body .r1-note`, frame: `${cap(`${D}Running`)} .r1-note` }],
    pairs: [
      { app: `${root('SCR-OFC-13')} .body .row .btn:nth-child(1)`, frame: `${cap(`${D}Running`)} .row .btn:nth-child(1)` },
      { app: `${root('SCR-OFC-13')} .body .row .btn:nth-child(2)`, frame: `${cap(`${D}Running`)} .row .btn:nth-child(2)` },
      ...['', ' .bar', ' .bar i'].map((x) => ({ app: `${root('SCR-OFC-13')} [data-ctl="CTL-OFC-13-05"]${x}`, frame: `${cap(`${D}Running`)} [data-ctl="CTL-OFC-13-05"]${x}` })),
      { app: `${root('SCR-OFC-13')} .body .r1-note`, frame: `${cap(`${D}Running`)} .r1-note` },
    ],
  },
  {
    name: 'SCR-OFC-13 Real run done (Run the import off with its reason)',
    screen: 'SCR-OFC-13', captions: [`${D}Real run done`], app: '/shell-preview/import-dry/dry-report-realdone', frame: DRY,
    pairs: [{ app: `${root('SCR-OFC-13')} .run .btn.dis`, frame: `${cap(`${D}Real run done`)} .btn.dis` }],
  },
  {
    name: 'SCR-OFC-13 Failed (the button)',
    screen: 'SCR-OFC-13', captions: [`${D}Failed`], app: '/shell-preview/import-dry/dry-failed', frame: DRY,
    pairs: [{ app: `${root('SCR-OFC-13')} .body .btn`, frame: `${cap(`${D}Failed`)} .btn` }],
  },
  {
    name: 'SCR-OFC-25 Asking',
    screen: 'SCR-OFC-25', captions: [`${R}Asking`], app: '/shell-preview/import-dry/dlg-asking', frame: DRY,
    pairs: within('.r1-st', cap(`${R}Asking`), DLG),
  },
  {
    name: 'SCR-OFC-25 Starting',
    screen: 'SCR-OFC-25', captions: [`${R}Starting`], app: '/shell-preview/import-dry/dlg-starting', frame: DRY,
    pairs: within('.r1-st', cap(`${R}Starting`), [...DLG, '.r1-dlg-f .btn.busy', '.r1-dlg-f .btn.dis', '.r1-spin']),
  },
  {
    name: 'SCR-OFC-14 Success (the page: header and tabs, progress, the queue, the shown pair and its actions)',
    screen: 'SCR-OFC-14', captions: [`${P}Success`], app: '/shell-preview/import-dups/dups-success', frame: DUPS,
    pairs: within(root('SCR-OFC-14'), cap(`${P}Success`), DUP_SUCCESS),
  },
  {
    name: 'SCR-OFC-14 Deciding (Merge busy, the other two off)',
    screen: 'SCR-OFC-14', captions: [`${P}Deciding`], app: '/shell-preview/import-dups/dups-deciding', frame: DUPS,
    pairs: [
      { app: `${root('SCR-OFC-14')} .acts .btn.busy`, frame: `${cap(`${P}Deciding`)} .btn.busy` },
      { app: `${root('SCR-OFC-14')} .acts .btn.busy .r1-spin`, frame: `${cap(`${P}Deciding`)} .btn.busy .r1-spin` },
      { app: `${root('SCR-OFC-14')} .acts .btn.dis`, frame: `${cap(`${P}Deciding`)} .btn.dis` },
      { app: `${root('SCR-OFC-14')} .acts .btn.busy kbd`, frame: `${cap(`${P}Deciding`)} .btn.busy kbd` },
    ],
  },
  {
    name: 'SCR-OFC-15 Success (the page: header and tabs, runs, merges, Find a merge, Show more)',
    screen: 'SCR-OFC-15', captions: [`${H}Success`], app: '/shell-preview/import-hist/hist-success', frame: HIST,
    pairs: within(root('SCR-OFC-15'), cap(`${H}Success`), HIST_SUCCESS),
  },
  {
    name: 'SCR-OFC-26 Asking',
    screen: 'SCR-OFC-26', captions: [`${U}Asking`], app: '/shell-preview/import-hist/undo-asking', frame: HIST,
    pairs: within('.r1-st', cap(`${U}Asking`), DLG),
  },
  {
    name: 'SCR-OFC-26 Undoing',
    screen: 'SCR-OFC-26', captions: [`${U}Undoing`], app: '/shell-preview/import-hist/undo-undoing', frame: HIST,
    pairs: within('.r1-st', cap(`${U}Undoing`), [...DLG, '.r1-dlg-f .btn.busy', '.r1-dlg-f .btn.dis', '.r1-spin']),
  },
];

/** Parts of a compared state that its case leaves out, each with the reason (read with the cases; no gate reads this record). */
export const LEFT_OUT: Record<string, string> = {
  'Running: the progress line\'s bold text (CTL-OFC-13-05 b)': 'its width follows its words: the frame says "checking addresses", a sample stage, and the product says the 4 stage words (admin.import.stage.*), which differ in length; no owner ruling lets the comparator skip a text-fitted width (wordsRuled), so the element is left out (F-625)',
};

/**
 * Captioned frame states with no look case of their own, each with the reason. The coverage test checks every caption the 3 frames show
 * is compared by a case or named here, and that each named one is a caption of its frame.
 */
const FRAGMENT = 'the tile draws a fragment inside a 560 px tile (padding 14 px, widths from the tile); the page draws the same pieces in its own layout. The Report case holds the page\'s values; the fragments themselves are held by no case: measured with this comparator (review R268, F-625), every non-width value of them matches and only the container width differs (and Duplicates Done lacks the tile\'s .sum context)';
export const NOT_COMPARED: Record<string, { frame: string; why: string }> = {
  [`${D}Loading`]: { frame: DRY, why: `skeleton rows: ${FRAGMENT}; the rows are the shared r1-skel` },
  [`${D}Error`]: { frame: DRY, why: 'CMP-12 Error panel, held by the shell case "CMP-12 Error panel with Try again"' },
  [`${R}Started`]: { frame: DRY, why: 'the progress line (CTL-OFC-13-05) is compared by the Running case (its bold text, bar and fill, F-625); the toast is CMP-11, held by its case' },
  [`${P}Loading`]: { frame: DUPS, why: `skeleton rows: ${FRAGMENT}` },
  [`${P}Done`]: { frame: DUPS, why: `a progress line and a note: ${FRAGMENT}` },
  [`${P}Error`]: { frame: DUPS, why: 'CMP-12 Error panel, held by the shell case "CMP-12 Error panel with Try again"' },
  [`${H}Loading`]: { frame: HIST, why: `skeleton rows: ${FRAGMENT}` },
  [`${H}No merges match`]: { frame: HIST, why: `a find field and a note: ${FRAGMENT}; the find field is held by the Success case` },
  [`${H}Error`]: { frame: HIST, why: 'CMP-12 Error panel in the Merges table, held by the shell case' },
  [`${U}Done`]: { frame: HIST, why: 'the row reading Undone and the CMP-11 toast: the chip is held by the Success case (chip neutral) and the toast by CMP-11' },
  'CMP-12 Error panel: Error with Try again': { frame: HIST, why: 'held by the shell case "CMP-12 Error panel with Try again (r1-admin-history tile)"' },
};

export const IMPORT_FRAMES = [DRY, DUPS, HIST];

/** Captions the 3 frames show (read by the pw test) that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncovered(captions: Record<string, string[]>): string[] {
  const compared = new Set(IMPORT_CASES.flatMap((c) => c.captions.map((x) => `${c.frame} | ${x}`)));
  const problems: string[] = [];
  for (const [frame, caps] of Object.entries(captions)) {
    for (const c of caps) {
      if (!/^(SCR-OFC-13|SCR-OFC-14|SCR-OFC-15|SCR-OFC-25|SCR-OFC-26|CMP-12)/.test(c)) continue;
      if (compared.has(`${frame} | ${c}`)) continue;
      const n = NOT_COMPARED[c];
      if (n && n.frame === frame) continue;
      problems.push(`no case compares ${frame} | ${c}`);
    }
  }
  for (const [c, n] of Object.entries(NOT_COMPARED)) if (!(captions[n.frame] ?? []).includes(c)) problems.push(`NOT_COMPARED names a caption its frame does not show: ${n.frame} | ${c}`);
  return problems;
}
