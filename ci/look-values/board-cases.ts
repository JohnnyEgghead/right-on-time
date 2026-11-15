// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-BOARD (BUILD_PLAN P4-BOARD Acceptance, look clause): SCR-OFC-02 and its 6 hosted screens (SCR-OFC-18,
// -19, -29, -31, -32, -33) against DK-85 (mockups/pages/office-board.html), in each state its frames show (light theme). A
// frame is picked by its frozen caption (UI-DESIGN-KIT 4.1), the way shell-cases.ts does. App states are the harness build's
// /shell-preview/board/<state> routes (apps/web/src/board/BoardPreview.tsx), each on the frame's own sample day.
import type { SelectorPair } from './compare.ts';
import type { WidthFrom } from './shell-cases.ts';

export const BOARD_FRAME = 'mockups/pages/office-board.html';

export interface BoardCase {
  name: string;
  /** The frame captions the case compares. */
  captions: string[];
  app: string;
  pairs: SelectorPair[];
  widthFrom?: WidthFrom[];
  /** An app selector to wait for (the timeline places its blocks once mounted). */
  ready?: string;
  /** The state draws CMP-05: the page is served the branch map files and reloaded (map-files.ts). */
  maps?: boolean;
}

const cap = (caption: string) => `[data-bw-cap="${caption}"]`;
const APP = '.r1-screen[data-screen="SCR-OFC-02"]';
const B = 'SCR-OFC-02 Dispatch board: ';
const JP = 'SCR-OFC-29 Board job popover: ';
const RA = 'SCR-OFC-18 Reassign job: ';
const CF = 'SCR-OFC-19 Someone else changed this job or block: ';
const BL = 'SCR-OFC-31 Add or change a block: ';
const BP = 'SCR-OFC-32 Board block popover: ';
const BD = 'SCR-OFC-33 Delete a block: ';
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`.trim(), frame: `${frameRoot} ${s}`.trim() }));

/** The board at rest (the frame's Success screen, a copy of its main screen before the drag is drawn). */
const AT_REST = [
  '.sumbar', '.sumbar .datenav', '.datenav .arrow', '.datenav .d', '.datenav .d b', '.datenav .d > span', '.datenav .mode', '.datenav .btn.sm',
  '.tiles', '.tile', '.tile .num', '.tile .lb', '.tile .lb small', '.tile .lb small.sim', '.sumbar > .btn.primary',
  '.boardp', '.boardp .ph', '.boardp .ph h2', '.boardp .ph .muted', '.boardp .seg', '.boardp .seg span', '.boardp .ph > .btn.sm', '.boardp .r1-live',
  '.legend', '.legend .k', '.legend .sw',
  '.tl-head', '.tl-head .corner', '.tl-hours', '.tl-hours span', '.tl-row', '.tl-row .who', '.tl-row .who .av',
  // Kevin Doyle's row (the 5th child) is left out of the name column: the frame's sample skill "Water heaters" is no product skill.
  '.tl-row:not(:nth-child(5)) .who .nm', '.tl-row:not(:nth-child(5)) .who .sub',
  '.tl-row .lane', '.tl-grid', '.tl-off', '.job', '.job .l1', '.job .l2', '.job .tag', '.job .ck', '.tl-now .flag',
];
/** The map panel at rest (P4-BOARD-MAP): the same selectors on both sides. */
const PANEL = [
  '.mapp', '.mapp .ph', '.mapp .ph h2', '.mapp .ph .live', '.mapp .ph .live .dotp', '.mapp .ph > .btn.sm', '.mtools', '.mtools .seg', '.mtools .seg span', '.mtools .msel',
  // The first .eta b is the customer: the frame's block says Jenkins, its card Harold Jenkins, and 1 fixture job holds 1 name.
  '.vancard', '.vancard .top', '.vancard .top .av', '.vancard .top b', '.vancard .top span.s', '.vancard .chip', '.vancard .eta', '.vancard .eta b:last-of-type', '.vancard .acts', '.vancard .acts .btn',
  // The frame's Needs attention badge says 4 over 5 rows; the product's count equals its rows (CTL-OFC-02-28), so that 1 digit differs.
  '.jtabs', '.jtabs a:not(:nth-child(2))', '.jtabs a:not(:nth-child(2)) b',
  // Only the job rows: the frame's flagged row carries sample words the product's flagged message does not (its height follows them).
  '.att .row:not(:last-child)', '.att .row:not(:last-child) .chip', '.att .row:not(:last-child) .tx', '.att .row:not(:last-child) .tx b', '.att .row:not(:last-child) .tx small',
];
/** CMP-05's parts and the legend, whose app classes differ from the frame's page classes. */
const mapParts = (appRoot: string, frameRoot: string): SelectorPair[] => [
  ['.bw-map-panel', '.mapbox'], ['.bw-map-panel .zm', '.mapbox .zoom'], ['.bw-map-panel .zm button', '.mapbox .zoom span'], ['.bw-map-panel .osm', '.mapbox .osm'],
  ['.bw-mkey', '.mkey'], // F-816: the frame's 4 words of each legend; the words the owner added (Nov 7) are not drawn yet (doc batch), so they are read by the stack.
  ['.bw-mkey span:not(:has(.free, .jobWay, .jobSite, .jobClosed))', '.mkey span'],
].map(([a, f]) => ({ app: `${appRoot} ${a}`, frame: `${frameRoot} ${f}`, ...(a === '.bw-mkey' ? { wrapRuled: 'F-816, owner answer e18182a0: the added words take a 2nd line' } : {}) }));

/** The drag the frame's main screen draws (Moving): the job left behind, the drop target, the dragged block and its preview. */
const DRAGGING = ['.left-behind', '.drop-target', '.job.dragging', '.job.dragging .l1', '.job.dragging .l2', '.dragtip', '.dragtip b', '.dragtip .ok', '.tl-now', '.boardp > .tl'];
// The small board's dragged block and drop target are drawn 1.34 hours long (11.58 to 12.92) for a job of 80 minutes (1.33 hours;
// minutes are whole on the wire): 0.7 px apart at this width, and rotated, so no width can be handed over. The same component's
// boxes are compared on the main screen (the Moving case), where the difference is within the 0.5 px tolerance.
const MINI_DRAG = ['.dragtip', '.dragtip b', '.dragtip .ok'];

const tileOf = (caption: string) => `${cap(caption)} .b`;
const hosted = (state: string) => `[data-bw-hosted="${state}"]`;
/** A hosted screen drawn in its tile: the app's copy takes the tile body's width. */
const inTile = (state: string, caption: string, inner: string[], box: string): BoardCase => ({
  name: caption, captions: [caption], app: `/shell-preview/board/${state}`, ready: `${hosted(state)} ${box}`,
  widthFrom: [{ app: hosted(state), frame: tileOf(caption) }],
  pairs: within(hosted(state), tileOf(caption), [box, ...inner.map((s) => `${box} ${s}`)]),
});

const POP = ['h3', 'p', '.acts', '.acts .btn'];
const DLG = ['.r1-dlg-h', '.r1-dlg-h h2', '.r1-x', '.r1-dlg-b', '.r1-dlg-f', '.r1-dlg-f .btn'];
// The third row's sub line is sample text the product has no skill for ("Water heaters"); its font and color are the other rows'.
const RLIST = ['.rlist', '.rl2', '.rl2 .rd', '.rl2 b', '.rl2:not(:nth-child(3)) small'];
const FIELDS = ['.r1-field', '.r1-field label', '.r1-input', '.g2f'];

export const BOARD_CASES: BoardCase[] = [
  // The Success screen is the frame's copy of its main screen, drawn after the caption and its note (DK-85 BDsuccess).
  {
    name: `${B}Success (the board at rest)`, captions: [`${B}Success`], app: '/shell-preview/board/success', ready: `${APP} .job`, maps: true,
    pairs: [...within(APP, `${cap(`${B}Success`)} + .r1-screen`, [...AT_REST, ...PANEL]), ...mapParts(APP, `${cap(`${B}Success`)} + .r1-screen`)],
  },
  { name: `${B}Moving (the main screen: a job dragged and dropped)`, captions: [`${B}Moving`], app: '/shell-preview/board/moving', ready: `${APP} .dragtip`, pairs: within(APP, cap(`${B}Moving`), DRAGGING) },
  {
    name: `${B}Loading`, captions: [`${B}Loading`], app: '/shell-preview/board/loading',
    widthFrom: [{ app: '.bw-board-loading', frame: `${tileOf(`${B}Loading`)} .row > div` }],
    pairs: [{ app: '.bw-board-loading .r1-skel', frame: `${tileOf(`${B}Loading`)} .r1-skel` }],
  },
  {
    name: `${B}No technicians`, captions: [`${B}No technicians`], app: '/shell-preview/board/no-technicians', ready: `${APP} .datenav .mode`,
    pairs: [{ app: `${APP} .datenav .mode`, frame: `${tileOf(`${B}No technicians`)} .mode` }],
  },
  {
    name: `${B}Marking handled`, captions: [`${B}Marking handled`], app: '/shell-preview/board/marking', ready: `${APP} .att .btn.busy`,
    pairs: [
      { app: `${APP} .att .chip.flagc`, frame: `${tileOf(`${B}Marking handled`)} .chip.flagc` },
      { app: `${APP} .att .btn.busy`, frame: `${tileOf(`${B}Marking handled`)} .btn.busy` },
      { app: `${APP} .r1-toast`, frame: `${tileOf(`${B}Marking handled`)} .r1-toast` },
    ],
  },
  {
    // F-1155, owner ruling c4aa4366: the frame's "Control details: what a flagged item held" tile is not a captioned frame (tagFrames keys on captions), so it is
    // picked by its entry lines. The 2 flagged rows, a finish and a note, with the lines under each (kit 0.9 .att .row .tx small.ent).
    name: 'SCR-OFC-02 Needs attention: what a flagged item held (control details tile)', captions: [], app: '/shell-preview/board/flagged-entries', ready: `${APP} .att small.ent`,
    widthFrom: [{ app: `${APP} .att`, frame: '.r1-st .att:has(small.ent)' }],
    // Only the flagged rows (data-conflict): the product's Needs attention list also holds the late, at-risk and unassigned job rows, which the main frame's cases hold.
    pairs: ['.att .row', '.att .row .chip', '.att .row .tx', '.att .row .tx b', '.att .row .tx small', '.att .row .tx small.ent', '.att .row .btn.sm'].map((s) => ({
      app: `${APP} .att .row[data-conflict]${s.slice('.att .row'.length)}`, frame: `.r1-st .att:has(small.ent)${s.slice('.att'.length)}`,
    })),
  },
  {
    name: `${B}Offline`, captions: [`${B}Offline`], app: '/shell-preview/board/offline', ready: `${APP} .offbar`,
    widthFrom: [{ app: `${APP} .offbar`, frame: `${tileOf(`${B}Offline`)} .offbar` }],
    pairs: within(`${APP}`, tileOf(`${B}Offline`), ['.offbar', '.offbar .btn']),
  },
  {
    name: `${B}Previewing`, captions: [`${B}Previewing`], app: '/shell-preview/board/previewing', ready: '[data-bw-mini] .dragtip',
    widthFrom: [{ app: '[data-bw-mini]', frame: `${tileOf(`${B}Previewing`)} .mini` }],
    pairs: within('[data-bw-mini]', `${tileOf(`${B}Previewing`)} .mini`, MINI_DRAG),
  },
  {
    name: `${B}No jobs`, captions: [`${B}No jobs`], app: '/shell-preview/board/no-jobs', ready: '[data-bw-mini] .nojobs',
    widthFrom: [{ app: '[data-bw-mini]', frame: `${tileOf(`${B}No jobs`)} .mini` }],
    pairs: within('[data-bw-mini]', `${tileOf(`${B}No jobs`)} .mini`, ['.tl-row', '.tl-row .who', '.nojobs']),
  },
  {
    name: `${B}Partial`, captions: [`${B}Partial`], app: '/shell-preview/board/partial', ready: `${APP} .r1-errpanel`,
    widthFrom: [{ app: `${APP} .bw-van-error .r1-errpanel`, frame: `${tileOf(`${B}Partial`)} .r1-errpanel` }],
    pairs: within(`${APP} .bw-van-error`, tileOf(`${B}Partial`), ['.r1-errpanel', '.r1-errpanel b', '.r1-errpanel .btn']),
  },
  {
    name: `${B}Map hidden`, captions: [`${B}Map hidden`], app: '/shell-preview/board/map-hidden', ready: `${APP} [data-ctl="CTL-OFC-02-22"]`,
    pairs: [{ app: `${APP} .boardp .ph > [data-ctl="CTL-OFC-02-22"]`, frame: `${tileOf(`${B}Map hidden`)} .ph > .btn` }],
  },
  {
    name: `${B}Jobs on the map`, captions: [`${B}Jobs on the map`], app: '/shell-preview/board/jobs-on-map', ready: `${APP} .bw-mkey[data-map-legend="jobs"]`, maps: true,
    pairs: [
      ...within(`${APP} .mtools`, tileOf(`${B}Jobs on the map`), ['.seg', '.seg span']),
      { app: `${APP} .bw-mkey span:not(:has(.jobWay, .jobSite, .jobClosed))`, frame: `${tileOf(`${B}Jobs on the map`)} .mkey span` },
      { app: `${APP} .bw-mkey i.jm:not(.jobWay, .jobSite, .jobClosed)`, frame: `${tileOf(`${B}Jobs on the map`)} .mkey i.jm` },
    ],
  },
  {
    name: `${B}Filtered by skill`, captions: [`${B}Filtered by skill`], app: '/shell-preview/board/skill-filter', ready: `${APP} .att a.jrow`, maps: true,
    widthFrom: [{ app: `${APP} .jtabs`, frame: `${tileOf(`${B}Filtered by skill`)} .jtabs` }, { app: `${APP} .att`, frame: `${tileOf(`${B}Filtered by skill`)} .att` }],
    pairs: [
      { app: `${APP} .mtools .msel[data-ctl="CTL-OFC-02-30"]`, frame: `${tileOf(`${B}Filtered by skill`)} .msel` },
      { app: `${APP} .bw-skill-note b`, frame: `${tileOf(`${B}Filtered by skill`)} .row > b` },
      { app: `${APP} .bw-skill-note .btn`, frame: `${tileOf(`${B}Filtered by skill`)} .row > .btn` },
      // Only the last tab: the first 3 counts are sample digits (the frame's 18, 1 and 3; its Needs attention leaves out its own late Reyes;
      // F-843: the preview's plumbing day has 0 on the way, so the On the way tab's width follows that digit too). On site is 4 on both.
      ...within(APP, tileOf(`${B}Filtered by skill`), ['.jtabs', '.jtabs a:nth-child(4)', '.jtabs a:nth-child(4) b']),
      // The tile draws 2 rows of the list, Hale and Okafor: each against its own row of the app's list (the sub line is the frame's sample problem).
      // The row boxes are the 2nd only: the frame's 1st row is first of its list, so it has no top rule; the app's Hale is not.
      ...[[24797, 1, [' .w', ' .tx', ' .tx b', ' .tx small', ' .chip']], [24791, 2, ['', ' .w', ' .tx', ' .tx b', ' .tx small', ' .chip']]].flatMap(([job, row, parts]) => (parts as string[]).map((inner) => ({
        app: `${APP} .att a.jrow[href$="/${job}"]${inner}`, frame: `${tileOf(`${B}Filtered by skill`)} .att a.jrow:nth-child(${row})${inner}`,
      }))),
    ],
  },
  inTile('job-open', `${JP}Open`, POP, '.r1-pop'),
  inTile('job-updated', `${JP}Updated`, POP, '.r1-pop'),
  inTile('job-gone', `${JP}Gone`, ['p', '.acts .btn'], '.r1-pop'),
  inTile('reassign-loading', `${RA}Loading`, [...DLG, '.r1-skel'], '.r1-dlg'),
  inTile('reassign-choosing', `${RA}Choosing`, [...DLG, ...RLIST, '.rl2 .now'], '.r1-dlg'),
  inTile('reassign-previewing', `${RA}Previewing`, [...DLG, ...RLIST, '.pvw'], '.r1-dlg'),
  inTile('reassign-no-others', `${RA}No others`, [...DLG, '.r1-note', ...RLIST], '.r1-dlg'),
  inTile('reassign-saving', `${RA}Saving`, [...DLG, ...RLIST, '.pvw', '.r1-spin'], '.r1-dlg'),
  inTile('reassign-done', `${RA}Done`, ['span'], '.r1-toast'),
  inTile('conflict-shown', `${CF}Shown`, [...DLG, '.r1-fmsg'], '.r1-dlg'),
  inTile('conflict-resending', `${CF}Resending`, [...DLG, '.r1-fmsg', '.r1-spin'], '.r1-dlg'),
  inTile('conflict-again', `${CF}Changed again`, [...DLG, '.r1-fmsg'], '.r1-dlg'),
  inTile('conflict-gone', `${CF}Gone`, [...DLG, 'p'], '.r1-dlg'),
  inTile('conflict-done', `${CF}Done`, ['span'], '.r1-toast'),
  inTile('block-adding', `${BL}Adding`, [...DLG, ...FIELDS], '.r1-dlg'),
  inTile('block-changing', `${BL}Changing`, [...DLG, ...FIELDS], '.r1-dlg'),
  inTile('block-saving', `${BL}Saving`, [...DLG, ...FIELDS, '.r1-spin'], '.r1-dlg'),
  inTile('block-overlap', `${BL}Overlap`, [...DLG, ...FIELDS, '.r1-fmsg'], '.r1-dlg'),
  inTile('block-done', `${BL}Done`, ['span'], '.r1-toast'),
  inTile('blockpop-open', `${BP}Open`, POP, '.r1-pop'),
  inTile('blockpop-updated', `${BP}Updated`, POP, '.r1-pop'),
  inTile('blockpop-gone', `${BP}Gone`, ['p', '.acts .btn'], '.r1-pop'),
  inTile('delete-asking', `${BD}Asking`, [...DLG, 'p'], '.r1-dlg'),
  inTile('delete-deleting', `${BD}Deleting`, [...DLG, 'p', '.r1-spin'], '.r1-dlg'),
  inTile('delete-done', `${BD}Done`, ['span'], '.r1-toast'),
];

/**
 * Captioned states of the 7 screens with no look case of their own, each with the reason. The coverage test checks that
 * every caption of the 7 screens on the frame is compared by a case or named here, and that each named one is a caption.
 */
export const NOT_COMPARED: Record<string, string> = {
  [`${B}Conflict`]: 'the tile draws one note (the block returns and the dialog opens); the dialog is the SCR-OFC-19 cases',
  [`${B}Catching up`]: 'the tile draws CMP-02\'s catching-up line (P2-SHELL\'s look case) and a small board equal to the Success rows',
};

/** Parts of a compared state that its case leaves out, each with the reason (read with the cases; no gate reads this record). */
export const LEFT_OUT: Record<string, string> = {
  'Success: the Needs attention tab\'s digit badge (.jtabs a:nth-child(2) b)': 'the frame\'s badge says 4 over 5 rows; the product\'s count equals its rows (CTL-OFC-02-28), so that 1 digit differs. This drops the whole tab, and with it the selected tab\'s color and underline: it is the frame\'s 2nd tab (a.on), so no case compares it. Measured on Chromium: a pair for a.on differs in width only (app 129 px, frame 129.61 px, the digit; handing the frame width over did not move it, the app\'s tab row is as tight as its text). F-840 stays open on this point: it needs a state where the digit matches, or a per-pair width exception',
  'Filtered by skill: the first 3 tabs, All, Needs attention and On the way, with their badges': 'their counts are sample digits (the frame\'s 18, 1 and 3; its Needs attention leaves out its own late Reyes). F-843: the preview\'s plumbing day has 0 on the way against the frame\'s 3, so that tab\'s badge and the tab are as wide as their digit: 0.47 px wider on the Mac (under the 0.5 px bound), 1 px on the Spectre rig, where a glyph\'s advance is a whole pixel. All is the selected tab here, so the selected tab\'s color and underline are compared in no case (see the Success entry)',
  'Filtered by skill: the timeline': 'the frame draws no small timeline in this tile any more (DK-85, kit 0.8: its caption says the timeline keeps every technician), so nothing is left to compare here; the full timeline, every technician on it, is compared in the Success case, and the No jobs and Previewing cases compare the same small board\'s rows and names',
  'Filtered by skill: the Approximate route chip (.aprx)': 'no pair reads its look (F-818, closed with this reason recorded); its words, its data-ctl and when it shows are proved by ci/shell-stack/map.stack.ts (FR-MAP-3)',
  'Filtered by skill: the note strip\'s own box (.bw-skill-note against the tile\'s .row)': 'its words (b) and its All skills button are compared; the strip\'s own box, padding and placement is read by no pair (F-818, closed with this reason recorded)',
  'Jobs on the map: the Both legend': 'no frame draws it, so there is nothing to compare it with; its 2 keys are the Vans key (compared in the Success case) and the Jobs key (compared in the Jobs on the map case)',
};

const OWN = /^(SCR-OFC-02|SCR-OFC-18|SCR-OFC-19|SCR-OFC-29|SCR-OFC-31|SCR-OFC-32|SCR-OFC-33) /;

/** Captions of the 7 screens the frame shows that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncoveredBoard(captions: readonly string[]): string[] {
  const compared = new Set(BOARD_CASES.flatMap((c) => c.captions));
  const problems: string[] = [];
  for (const c of captions) if (OWN.test(c) && !compared.has(c) && !NOT_COMPARED[c]) problems.push(`no case compares ${c}`);
  for (const c of Object.keys(NOT_COMPARED)) if (!captions.includes(c)) problems.push(`NOT_COMPARED names a caption the frame does not show: ${c}`);
  return problems;
}
