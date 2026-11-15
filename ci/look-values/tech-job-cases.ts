// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P5-TWA-JOB (BUILD_PLAN P5-TWA-JOB Acceptance, look clause: SCR-TEC-04 to SCR-TEC-07 and SCR-TEC-09 against DK-110 to
// DK-112, light theme). A frame is picked by its frozen caption (UI-DESIGN-KIT 4.1); app states are the harness build's
// /shell-preview/tech-job, tech-note, tech-finish and tech-waiting routes (apps/web/src/tech/job/*Preview.tsx). Each case sets the app
// screen to the frame screen's width (widthFrom) and compares the pieces the frame draws with the app's data. The header boxes
// (.apphead, .wh) are compared on the tiles: the app draws CMP-01 inside the header as the frames do (HeadClock, main's DemoStrip header variant,
// F-1024); a device frame's header also holds the device's status bar, which the app does not draw, so there its parts are compared
// and not its box (as P5-TWA-TODAY's cases do). Every captioned state of the 5 screens has a case; the ones that have none say why (UNCASED, held by a test).
// The cases run in a 1440 x 900 window: tech.css's under-720 px 44 px tap-target rules (a phone's window) are off there, so the
// frames' own values are what is compared.
import type { SelectorPair } from './compare.ts';
import type { TechShellCase } from './tech-shell-cases.ts';

export const JOB_FRAME = 'mockups/pages/tech-job.html';
export const OFFLINE_FRAME = 'mockups/pages/tech-offline.html';
export const FINISH_FRAME = 'mockups/pages/tech-finish.html';

const cap = (caption: string) => `[data-bw-cap="${caption}"]`;
const pairs = (frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `.bw-tech ${s}`, frame: `${frameRoot} ${s}` }));
const screenOf = (caption: string) => ({ app: '.bw-tech', frame: `${cap(caption)} .screen` });

const JOB = 'SCR-TEC-04 Job, web: Success';
const NOTE = 'SCR-TEC-05 Add note, web: Typing';
const FIN = 'SCR-TEC-07 Finish job, web: Signed';
const W9 = 'SCR-TEC-09 Waiting to send, web: Waiting, offline';
const W9_NONE = 'SCR-TEC-09 Waiting to send, web: Nothing waiting';
const C4 = 'SCR-TEC-04 Job, web: ';
const C5 = 'SCR-TEC-05 Add note, web: ';
const C6 = 'SCR-TEC-06 Add photo, web: ';
const C7 = 'SCR-TEC-07 Finish job, web: ';
const C9 = 'SCR-TEC-09 Waiting to send, web: ';
/** A tile's preview is the frames' mini screen (TechAppFrame mini: .screen.r1p-mini, with its 1 px border), so it takes the tile screen's width. */
const tileWidth = (caption: string) => [{ app: '.bw-tech', frame: `${cap(caption)} .screen` }];
/**
 * A sheet over the screen (DK-36) is outside the app's screen box (.bw-tech-overlay, fixed to the window); in the frame it is inside the tile,
 * so the overlay gets the frame sheet's width. The sheet's own box is not paired: the tiles draw it inline (.r1-sheet.in: 22 px bottom padding
 * and a 120 px top margin in the tile), while the app's is the kit's real sheet at the foot of the screen (30 px); every piece inside is paired.
 */
const sheetWidth = (caption: string) => [...tileWidth(caption), { app: '.bw-tech-overlay', frame: `${cap(caption)} .r1-sheet` }];
// The header behind a sheet is not paired: the frame draws a short form of it under the dim (back, number, name; no clock).
const sheet = (caption: string, inner: string[]): SelectorPair[] => inner.map((x) => ({ app: `.bw-tech-overlay ${x}`, frame: `${cap(caption)} ${x}` }));
const tile = (name: string, frame: string, state: string, app: string, ready: string, inner: string[]): TechShellCase => ({
  name, frame, captions: [state], app, ready, pairs: pairs(cap(state), inner), widthFrom: tileWidth(state),
});
const CLK = ['.r1p-clk', '.r1p-clk .ic', '.r1p-clk b'];

/** The captioned states with no case, each with its reason (the coverage test reads it). */
export const UNCASED: Record<string, string> = {
  [`${C6}Permission denied`]: 'the frame draws "Native only. The web app has no such state." (the spec gives it to the iPhone app only)',
};
/** The frame captions of the 5 screens that no case compares and UNCASED does not name. */
export function uncoveredStates(captions: readonly string[], cases: readonly TechShellCase[] = TECH_JOB_CASES): string[] {
  const covered = new Set(cases.flatMap((c) => c.captions));
  // F-1267: an exemption for a caption that a case now covers is stale (its owning task built the case), and a later loss of that case
  // would not go red while the entry stays; the entry is a problem of its own, so it is removed when the case lands.
  const stale = Object.keys(UNCASED).filter((c) => covered.has(c)).map((c) => `UNCASED names a caption a case covers, remove the entry: ${c}`);
  return [...captions.filter((c) => /^SCR-TEC-0[4-79] /.test(c) && !covered.has(c) && !(c in UNCASED)), ...stale];
}

export const TECH_JOB_CASES: TechShellCase[] = [
  {
    name: 'SCR-TEC-04 Job: Success (DK-110)',
    frame: JOB_FRAME, captions: [JOB], app: '/shell-preview/tech-job/success', ready: '[data-ctl="CTL-TEC-04-02"]',
    pairs: pairs(cap(JOB), [
      ...CLK, '.apphead .nav', '.nav [data-ctl="CTL-TEC-04-01"]', '.nav .mid', '.apphead h1', '.apphead .addr', '.apphead .when', '.when .tag', '.when b',
      '.acts', '[data-ctl="CTL-TEC-04-04"]', '[data-ctl="CTL-TEC-04-04"] small', '.notebox', '.notebox b', '[data-ctl="CTL-TEC-04-06"] .ch h3', '.eq', '.eq b', '.hrow .dt', '.hrow .tx', '.note', '.note .by', '.ph.add', '.tabbar',
    ]),
    widthFrom: [screenOf(JOB)],
  },
  {
    name: 'SCR-TEC-05 Add note: Typing (DK-111)',
    frame: OFFLINE_FRAME, captions: [NOTE], app: '/shell-preview/tech-note/typing', ready: '.compose',
    pairs: pairs(cap(NOTE), [
      '.clkrow', ...CLK, '.r1p-clk .ns', '.apphead h1', '.apphead .addr', '.chip.site', '.banner', '.banner b', '.banner small', '.card.saved', '.saved h3', '.item .tx b', '.item .tx small', '.wait',
      '.compose', '.compose h3', '.compose .kept', '.compose .disc', '.compose .savebtn',
    ]),
    widthFrom: [screenOf(NOTE)],
  },
  {
    name: 'SCR-TEC-07 Finish job: Signed (DK-112)',
    frame: FINISH_FRAME, captions: [FIN], app: '/shell-preview/tech-finish/signed', ready: '[data-ctl="CTL-TEC-07-11"]',
    pairs: pairs(cap(FIN), [
      ...CLK, '.apphead h1', '.apphead .d', '.nav .mid', '.card .ch h3', '.wl .in', '.addl', '.pt', '.pt .n', '.pt .n code', '.step', '.step b', '.find', '.nop', '.labor small',
      '.notes', '.sig', '.sig .who', '.sig .clr', '.bottom', '.fin', '.finnote', '.cancel',
    ]),
    widthFrom: [screenOf(FIN)],
  },
  {
    name: 'SCR-TEC-09 Waiting to send: Waiting, offline (DK-111)',
    frame: OFFLINE_FRAME, captions: [W9], app: '/shell-preview/tech-waiting/offline', ready: '[data-ctl="CTL-TEC-09-01"]',
    pairs: pairs(cap(W9), ['.wh', ...CLK, '.r1p-clk .ns', '.wh h1', '.banner', '.cnt', '[data-ctl="CTL-TEC-09-01"]', '.item', '.item .tx b', '.item .tx small', '.wait', '[data-ctl="CTL-TEC-09-02"]', '.r1p-why', '.how']),
    widthFrom: tileWidth(W9),
  },
  {
    name: 'SCR-TEC-09 Waiting to send: Nothing waiting (DK-111)',
    frame: OFFLINE_FRAME, captions: [W9_NONE], app: '/shell-preview/tech-waiting/nothing', ready: '[data-ctl="CTL-TEC-09-01"]',
    pairs: pairs(cap(W9_NONE), ['.wh', ...CLK, '.wh h1', '.r1p-empty', '.how']),
    widthFrom: tileWidth(W9_NONE),
  },
  {
    name: 'SCR-TEC-05 Add note: Empty (DK-111)',
    frame: OFFLINE_FRAME, captions: ['SCR-TEC-05 Add note, web: Empty'], app: '/shell-preview/tech-note/empty', ready: '.compose',
    pairs: pairs(cap('SCR-TEC-05 Add note, web: Empty'), ['.apphead', '.clkrow', ...CLK, '.apphead .sync', '.apphead h1', '.compose h3', '.compose .savebtn', '.compose .why']),
    widthFrom: tileWidth('SCR-TEC-05 Add note, web: Empty'),
  },
  {
    name: 'SCR-TEC-05 Add note: Discard asked (DK-111)',
    frame: OFFLINE_FRAME, captions: ['SCR-TEC-05 Add note, web: Discard asked'], app: '/shell-preview/tech-note/discard', ready: '.cdlg',
    pairs: pairs(cap('SCR-TEC-05 Add note, web: Discard asked'), ['.apphead', '.clkrow', ...CLK, '.cdlg', '.cdlg h2', '.cdlg p', '.cdlg .row .k', '.cdlg .row .x']),
    widthFrom: tileWidth('SCR-TEC-05 Add note, web: Discard asked'),
  },
  {
    name: 'SCR-TEC-07 Finish job: Invalid (DK-112)',
    frame: FINISH_FRAME, captions: ['SCR-TEC-07 Finish job, web: Invalid'], app: '/shell-preview/tech-finish/invalid', ready: '.fmsg',
    pairs: pairs(cap('SCR-TEC-07 Finish job, web: Invalid'), ['.apphead', ...CLK, '.apphead h1', '.fmsg', '.find', '.nop', '.nop .bx']),
    widthFrom: tileWidth('SCR-TEC-07 Finish job, web: Invalid'),
  },
  {
    name: 'SCR-TEC-07 Finish job: Confirming (DK-112)',
    frame: FINISH_FRAME, captions: ['SCR-TEC-07 Finish job, web: Confirming'], app: '/shell-preview/tech-finish/confirming', ready: '.cstep',
    pairs: pairs(cap('SCR-TEC-07 Finish job, web: Confirming'), ['.apphead', ...CLK, '.cstep h2', '.cstep ul', '.cstep li', '.cstep .warn', '.cstep .fin', '.cstep .back2']),
    widthFrom: tileWidth('SCR-TEC-07 Finish job, web: Confirming'),
  },
  {
    name: 'SCR-TEC-04 Job: Done (DK-110)',
    frame: JOB_FRAME, captions: ['SCR-TEC-04 Job, web: Done'], app: '/shell-preview/tech-job/done', ready: '.stmsg',
    pairs: pairs(cap('SCR-TEC-04 Job, web: Done'), ['.apphead', ...CLK, '.apphead h1', '.when .tag', '.stmsg', '.stmsg span']),
    widthFrom: tileWidth('SCR-TEC-04 Job, web: Done'),
  },
  {
    name: 'SCR-TEC-09 Waiting to send: Partial (DK-111)',
    frame: OFFLINE_FRAME, captions: ['SCR-TEC-09 Waiting to send, web: Partial'], app: '/shell-preview/tech-waiting/partial', ready: '[data-ctl="CTL-TEC-09-01"]',
    pairs: pairs(cap('SCR-TEC-09 Waiting to send, web: Partial'), ['.wh', ...CLK, '.cnt', '.wait.sent', '.item .tx .why', '[data-ctl="CTL-TEC-09-02"]']),
    widthFrom: tileWidth('SCR-TEC-09 Waiting to send, web: Partial'),
  },
  // F-1024: the other states the frames show.
  tile('SCR-TEC-04 Job: Loading (DK-110)', JOB_FRAME, `${C4}Loading`, '/shell-preview/tech-job/loading', '.r1-skel',
    ['.apphead', ...CLK, '.apphead .nav', '.nav .mid', '.apphead > .r1-skel', '.body > .card', '.card .r1-skel', '.tabbar']),
  tile('SCR-TEC-04 Job: Offline, saved (DK-110)', JOB_FRAME, `${C4}Offline, saved`, '/shell-preview/tech-job/offline', '.r1p-nosig',
    ['.apphead', ...CLK, '.r1p-clk .ns', '.apphead h1', '.apphead .addr', '.when .tag', '.acts', '.r1p-nosig', '.r1p-nosig b', '.notebox', '.notebox b', '[data-ctl="CTL-TEC-04-08"] .ch h3', '.note', '.note .r1p-wait', '.note .by']),
  tile('SCR-TEC-04 Job: Offline, not saved (DK-110)', JOB_FRAME, `${C4}Offline, not saved`, '/shell-preview/tech-job/not-on-phone', '.r1p-empty',
    ['.apphead', ...CLK, '.r1p-clk .ns', '.nav .mid', '.r1p-nosig', '.r1p-nosig b', '.r1p-empty', '.r1p-empty span']),
  // Kit 0.9 (F-1144): the app's own no-signal page (the service worker's, F-1100) for a screen of a job the phone does not hold. The frame
  // draws it in a mini screen with no header or tab bar; the page's main is the frame's .nsp, its link the kit's .r1p-btn.pri.
  (() => {
    const s = `${C4}Offline, screen not saved`;
    const nsp = (app: string, frame: string): { app: string; frame: string } => ({ app: `main[data-bw-offline] ${app}`.trim(), frame: `${cap(s)} .nsp ${frame}`.trim() });
    return {
      name: 'SCR-TEC-04 Job: Offline, screen not saved (DK-110)', frame: JOB_FRAME, captions: [s], app: '/tech/jobs/24871/note', swNoSignal: true,
      ready: 'main[data-bw-offline]', pairs: [nsp('', ''), nsp('h1', 'h1'), nsp('p', 'p'), nsp('a', '.r1p-btn')], widthFrom: [nsp('', '')],
    } satisfies TechShellCase;
  })(),
  tile('SCR-TEC-04 Job: No longer yours (DK-110)', JOB_FRAME, `${C4}No longer yours`, '/shell-preview/tech-job/not-yours', '.stmsg',
    ['.apphead', ...CLK, '.nav .mid', '.stmsg', '.stmsg span', '.body > .r1-note', '.r1p-btn.pri']),
  tile('SCR-TEC-04 Job: No one home (DK-110)', JOB_FRAME, `${C4}No one home`, '/shell-preview/tech-job/no-one-home', '.stmsg',
    ['.apphead', ...CLK, '.apphead h1', '.when .tag', '.stmsg', '.stmsg span', '[data-ctl="CTL-TEC-04-08"] .ch h3', '.note', '.note .by', '.ph.add']),
  // The Notes heading is not paired: the frame's Canceled tile counts 2 notes and draws 1 (the office note); the app counts what it shows.
  tile('SCR-TEC-04 Job: Canceled (DK-110)', JOB_FRAME, `${C4}Canceled`, '/shell-preview/tech-job/canceled', '.stmsg',
    ['.apphead', ...CLK, '.apphead h1', '.when .tag', '.stmsg', '.stmsg span', '[data-ctl="CTL-TEC-04-08"]', '.note', '.note .by']),
  {
    name: 'SCR-TEC-06 Add photo: No photo (DK-110)', frame: JOB_FRAME, captions: [`${C6}No photo`], app: '/shell-preview/tech-job/photo-none', ready: '.bw-tech-overlay .r1-sheet',
    pairs: sheet(`${C6}No photo`, ['.r1-sheet .grab', '.r1-sheet h2', '.r1-sheet .alt', '.sbtns', '[data-ctl="CTL-TEC-06-01"]', '[data-ctl="CTL-TEC-06-05"]']),
    widthFrom: sheetWidth(`${C6}No photo`),
  },
  {
    name: 'SCR-TEC-06 Add photo: Preview (DK-110)', frame: JOB_FRAME, captions: [`${C6}Preview`], app: '/shell-preview/tech-job/photo-preview', ready: '.bw-tech-overlay .pv',
    pairs: sheet(`${C6}Preview`, ['.r1-sheet .grab', '.r1-sheet h2', '.pv', '.sbtns', '[data-ctl="CTL-TEC-06-04"]', '[data-ctl="CTL-TEC-06-03"]', '.r1p-why', '[data-ctl="CTL-TEC-06-05"]']),
    widthFrom: sheetWidth(`${C6}Preview`),
  },
  // The tile draws the Photos card cut to the new thumbnail (Photos (4), 1 drawn): that thumbnail is paired with the app's waiting one.
  (() => {
    const c = tile('SCR-TEC-06 Add photo: Saved (DK-110)', JOB_FRAME, `${C6}Saved`, '/shell-preview/tech-job/photo-saved', '[data-ctl="CTL-TEC-04-11"]',
    ['.apphead', ...CLK, '.apphead h1', '.when .tag', '[data-ctl="CTL-TEC-04-10"] .ch h3', '.ph.add', '.r1p-notice', '.r1p-notice span']);
    const thumb = (x: string) => ({ app: `.bw-tech [data-ctl="CTL-TEC-04-11"][data-waiting="1"]${x}`, frame: `${cap(`${C6}Saved`)} [data-ctl="CTL-TEC-04-11"]${x}` });
    return { ...c, pairs: [...c.pairs, thumb(''), thumb(' span')] };
  })(),
  tile('SCR-TEC-05 Add note: Restored (DK-111)', OFFLINE_FRAME, `${C5}Restored`, '/shell-preview/tech-note/restored', '.compose',
    ['.apphead', '.clkrow', ...CLK, '.apphead .sync', '.apphead h1', '.r1p-notice', '.r1p-notice span', '.compose', '.compose h3', '.compose .kept', '.compose .disc', '.compose .savebtn']),
  // The saved list: the tile draws a cut of it (the 2 newest notes, newest first, no summary line), while the device frame (Typing, paired
  // in full above) draws every waiting item of the job, oldest first, with the summary; the app follows the device frame. So the note just
  // saved is paired row to row (the app's last row, the tile's first), with the list's card and heading left out.
  (() => {
    const c = tile('SCR-TEC-05 Add note: Saved (DK-111)', OFFLINE_FRAME, `${C5}Saved`, '/shell-preview/tech-note/saved-offline', '.card.saved',
      ['.apphead', '.clkrow', ...CLK, '.r1p-clk .ns', '.apphead h1', '.banner', '.banner b', '.banner small']);
    const row = (x: string) => ({ app: `.bw-tech .card.saved .item:last-child${x}`, frame: `${cap(`${C5}Saved`)} .card.saved .item:nth-child(2)${x}` });
    return { ...c, pairs: [...c.pairs, ...['', ' .ico', ' .tx b', ' .tx small', ' .wait'].map(row)] };
  })(),
  tile('SCR-TEC-07 Finish job: Editing (DK-112)', FINISH_FRAME, `${C7}Editing`, '/shell-preview/tech-finish/editing', '[data-ctl="CTL-TEC-07-06"]',
    ['.apphead', ...CLK, '.apphead h1', '.apphead .d', '.card .ch h3', '.wl .in', '.addl', '.find', '.nop', '.labor small', '.sig', '.bottom', '.fin', '.finnote', '.cancel']),
  tile('SCR-TEC-07 Finish job: No parts list yet (DK-112)', FINISH_FRAME, `${C7}No parts list yet`, '/shell-preview/tech-finish/no-parts-list', '.fmsg',
    ['.apphead', ...CLK, '.r1p-clk .ns', '.r1p-nosig', '.r1p-nosig b', '.find', '.fmsg', '.nop', '.bottom']),
  // Saved is the job screen after Finish (SCR-TEC-04 with ?finished=1): its header is DK-110's job header, held by the Done case above; DK-112's
  // tile draws a short form of it in the finish frame's sizes (a 24 px name, "Job #24830"), so the header's box, name and middle are not paired.
  tile('SCR-TEC-07 Finish job: Saved (DK-112)', FINISH_FRAME, `${C7}Saved`, '/shell-preview/tech-job/finished', '.r1p-notice',
    [...CLK, '.r1p-notice', '.r1p-notice span']),
  tile('SCR-TEC-07 Finish job: Restored (DK-112)', FINISH_FRAME, `${C7}Restored`, '/shell-preview/tech-finish/restored', '.r1p-notice',
    ['.apphead', ...CLK, '.apphead h1', '.r1p-notice', '.r1p-notice span', '.wl .in', '.pt', '.pt .n', '.pt .n code', '.step', '.step b', '.sig', '.bottom']),
  tile('SCR-TEC-09 Waiting to send: Sending (DK-111)', OFFLINE_FRAME, `${C9}Sending`, '/shell-preview/tech-waiting/sending', '[data-ctl="CTL-TEC-09-02"]',
    ['.wh', ...CLK, '.wh h1', '.cnt', '.item', '.item .tx b', '.item .tx small', '.wait.sending', '[data-ctl="CTL-TEC-09-02"]', '[data-ctl="CTL-TEC-09-02"] .r1-spin', '.how']),
  // F-1144: DK-111 Refused (a finish the server refused for parts stays in the list with its message, and opens Finish job).
  tile('SCR-TEC-09 Waiting to send: Refused (DK-111)', OFFLINE_FRAME, `${C9}Refused`, '/shell-preview/tech-waiting/refused', '.item[data-state="refused"]',
    // No clock pair: the frame's tile reads 12:51 PM and the preview's demo clock 10:28 AM (a different digit run, the clock's box width).
    ['.wh', '.wh h1', '.cnt', '.item', '.item .tx b', '.item .tx small', '.item .tx .why', '.wait.old', '[data-ctl="CTL-TEC-09-02"]', '.how']),
  tile('SCR-TEC-09 Waiting to send: Old items (DK-111)', OFFLINE_FRAME, `${C9}Old items`, '/shell-preview/tech-waiting/old', '.r1p-old',
    ['.wh', ...CLK, '.wh h1', '.r1p-old', '.r1p-old a', '.item', '.item .tx b', '.item .tx small', '.item .tx .why', '.wait.old', '[data-ctl="CTL-TEC-09-02"]', '.how']),
];
