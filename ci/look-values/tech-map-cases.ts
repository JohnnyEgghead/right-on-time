// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P5-TWA-MAP-ME (BUILD_PLAN P5-TWA-MAP-ME Acceptance, look clause): SCR-TEC-15 Map and SCR-TEC-08 Directions against
// mockups/pages/tech-map.html (DK-113), SCR-TEC-10 Me against tech-me.html (DK-114), SCR-TEC-11 Install the app against
// r1-techweb-install.html (DK-115) and SCR-TEC-16 Parts against r1-techweb-parts.html (DK-116), in each state the frames show (light theme).
// A frame state is picked by its frozen caption (UI-DESIGN-KIT 4.1): the setup tags the element each caption labels with data-bw-cap, and a
// frame's phone screen is the `.screen` inside it. A control-details tile has no caption and is picked by the control it shows. App states are
// the harness build's /shell-preview/tech-map, tech-dir, tech-me, tech-parts and tech-install routes, each fixed to its frame's data
// (apps/web/src/tech/preview-day.ts).
//
// What the cases leave out, and why (the same for every state): the frames draw a phone status bar (.sbar) and the demo clock row inside the
// header and the island and home bar around the screen; the app's phone has its own status bar, and the demo clock is the shell's strip
// (CMP-01) above the screen, so the header box itself (.apphead, .dh) is not compared, only what is inside it. The map is CMP-05 (MapLibre, compared
// by P3-MAP-WEB's cases), not the frame's drawing, so only its box is compared. The footer (CMP-04) is the shell's.
import type { SelectorPair } from './compare.ts';
import type { WidthFrom } from './shell-cases.ts';

export const MAP_FRAME = 'mockups/pages/tech-map.html';
export const ME_FRAME = 'mockups/pages/tech-me.html';
export const PARTS_FRAME = 'mockups/pages/r1-techweb-parts.html';
export const INSTALL_FRAME = 'mockups/pages/r1-techweb-install.html';

export interface TechMapCase {
  name: string;
  frame: string;
  /** The frame captions the case compares (a control-details tile has none). */
  captions: string[];
  app: string;
  /** The screen's data-screen. */
  screen: string;
  pairs: SelectorPair[];
  widthFrom: WidthFrom[];
}

const cap = (caption: string) => `[data-bw-cap="${caption}"]`;
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`.trim(), frame: `${frameRoot} ${s}`.trim() }));
const APP = '.bw-tech';
const screenOf = (caption: string) => `${cap(caption)} .screen`;
/** The app's phone screen is sized to its frame's (the frame is 390 px wide; the page fills any width). */
const sized = (caption: string): WidthFrom[] => [{ app: APP, frame: `${screenOf(caption)} .tabbar` }];

const M = 'SCR-TEC-15 Map, web: ';
const D = 'SCR-TEC-08 Directions, web: ';
const ME = 'SCR-TEC-10 Me, web: ';
const P = 'SCR-TEC-16 Parts, web: ';
const I = 'SCR-TEC-11 Install the app (web only): ';

const HEAD_R = ['.apphead .r', '.apphead h1', '.apphead .d', '.apphead .sync', '.apphead .sync .ic'];
const TABS = ['.tabbar', '.tabbar [data-ctl]', '.tabbar .on', '.tabbar [data-ctl] .ic'];
// Stops 4 and 5 of the frame's sample day name services the catalog has no label for (AC not cooling, Heat pump check), so their service words are not
// compared; the first 3 stops' are.
const STOP_LIST = ['.below', '.below h3', '.stop', '.stop .num', '.stop .tx', '.stop .tx b', '.stop:nth-child(-n+3) .tx small', '.stop .w', '.stop .w small'];
const EMPTY = ['.below .r1p-empty', '.below .r1p-empty .ic', '.below .r1p-empty span'];
const DH = ['.dh .nav', '.dh .nav span', '.dh .nav .ic', '.dh h1'];
// SCR-TEC-08's kit 0.9 parts (DK-113): the Next turn card, the Steps list (an ordered list of buttons) and the 3 skeleton rows of Loading.
const NEXT_TURN = ['.nturn', '.nturn .mv', '.nturn .mv .ic', '.nturn .tx', '.nturn .tx b', '.nturn .tx span'];
const STEPS = ['.below', '.below h3', '.steps', '.steps li', '.steps .sb', '.steps .mv', '.steps .mv .ic', '.steps .tx', '.steps .w'];
const STEPS_SKEL = ['.below', '.below h3', '.steps', '.steps li', '.steps .sb', '.steps .mv', '.steps .r1-skel'];
const DEST = ['.dest', '.dest .lab', '.dest h2', '.dest .addr', '.dest a'];
const SYNCROW = ['.syncrow', '.syncrow .ok', '.syncrow .ok .ic', '.syncrow .tx', '.syncrow b', '.syncrow small', '.sbtn', '.sbtn .ic'];
// The frame's tiles word the Sync row's second line with the sample day's items ("Notes and a photo for job 24830", a period after "Nothing waiting to send"),
// so the tiles compare the row without that line's text-fitted width.
const SYNCROW_TILE = SYNCROW.filter((x) => x !== '.syncrow small');

export const TECH_MAP_CASES: TechMapCase[] = [
  {
    name: 'SCR-TEC-15 Route (header, map box, legend, buttons, Next stop card, Stops list, tab bar)',
    frame: MAP_FRAME, captions: [`${M}Route`], app: '/shell-preview/tech-map/route', screen: 'SCR-TEC-15', widthFrom: sized(`${M}Route`),
    pairs: within(APP, screenOf(`${M}Route`), [
      ...HEAD_R, '.mapw', '.legend', '.legend span', '.legend i.d', '.fab', '.fab .ic',
      '.stopcard', '.stopcard .lab', '.stopcard .num', '.stopcard .win', '.stopcard h2', '.stopcard .addr', '.stopcard .dist', '.stopcard .dist .ic',
      '.row2', '.dir', '.dir .ic', '.dir small', '.open', '.open .ic',
      // The frame's .below also holds the footer (CMP-04), which the shell draws.
      ...STOP_LIST.filter((x) => x !== '.below'), ...TABS,
    ]),
  },
  {
    name: 'SCR-TEC-15 Loading (map skeleton, the Stops list)',
    frame: MAP_FRAME, captions: [`${M}Loading`], app: '/shell-preview/tech-map/loading', screen: 'SCR-TEC-15', widthFrom: sized(`${M}Loading`),
    pairs: within(APP, screenOf(`${M}Loading`), [...HEAD_R, '.tmap', '.tmap .skel', ...STOP_LIST, ...TABS]),
  },
  // Kit 0.12 (57520d6c, F-1560; UI-SPECIFICATION 4.5 rule 12): the page before it has read the phone's copy. The header has no count or sync
  // line, the stops are skeleton rows.
  {
    name: 'SCR-TEC-15 Reading the phone (header with a skeleton day line, map skeleton, skeleton stop rows)',
    frame: MAP_FRAME, captions: [`${M}Reading the phone (web)`], app: '/shell-preview/tech-map/reading', screen: 'SCR-TEC-15', widthFrom: sized(`${M}Reading the phone (web)`),
    pairs: within(APP, screenOf(`${M}Reading the phone (web)`), [
      '.apphead .r', '.apphead h1', '.apphead .d', '.apphead .d .r1-skel', '.tmap', '.tmap .skel', '.below', '.below h3', '.stop', '.stop .num', '.stop .tx', '.stop .tx .r1-skel', ...TABS,
    ]),
  },
  {
    name: 'SCR-TEC-15 Offline (No signal card, the map needs signal, the saved Stops list)',
    frame: MAP_FRAME, captions: [`${M}Offline`], app: '/shell-preview/tech-map/offline', screen: 'SCR-TEC-15', widthFrom: sized(`${M}Offline`),
    pairs: within(APP, screenOf(`${M}Offline`), [
      ...HEAD_R, '.r1p-nosig', '.r1p-nosig .ic', '.r1p-nosig b', '.tmap', '.tmap .need', '.tmap .need .ic', '.tmap .need span', ...STOP_LIST, ...TABS,
    ]),
  },
  {
    name: 'SCR-TEC-15 No jobs (You have no jobs today)',
    frame: MAP_FRAME, captions: [`${M}No jobs`], app: '/shell-preview/tech-map/nojobs', screen: 'SCR-TEC-15', widthFrom: sized(`${M}No jobs`),
    pairs: within(APP, screenOf(`${M}No jobs`), [...HEAD_R, '.below', ...EMPTY, ...TABS]),
  },
  {
    name: 'SCR-TEC-15 All done (map box, All stops are done)',
    frame: MAP_FRAME, captions: [`${M}All done`], app: '/shell-preview/tech-map/alldone', screen: 'SCR-TEC-15', widthFrom: sized(`${M}All done`),
    pairs: within(APP, screenOf(`${M}All done`), [...HEAD_R, '.tmap', '.below', '.below h3', ...EMPTY, ...TABS]),
  },
  {
    name: 'SCR-TEC-08 Loading (header, map skeleton, destination in words, 3 skeleton step rows)',
    frame: MAP_FRAME, captions: [`${D}Loading`], app: '/shell-preview/tech-dir/loading', screen: 'SCR-TEC-08', widthFrom: sized(`${D}Loading`),
    pairs: within(APP, screenOf(`${D}Loading`), [...DH, '.tmap', '.tmap .skel', ...DEST, ...STEPS_SKEL, ...TABS]),
  },
  // Kit 0.12 (57520d6c): the Loading skeleton, the destination's name and address skeletons too (they come from the phone's copy of the day).
  {
    name: 'SCR-TEC-08 Reading the phone (map skeleton, skeleton destination, 3 skeleton step rows)',
    frame: MAP_FRAME, captions: [`${D}Reading the phone (web)`], app: '/shell-preview/tech-dir/reading', screen: 'SCR-TEC-08', widthFrom: sized(`${D}Reading the phone (web)`),
    pairs: within(APP, screenOf(`${D}Reading the phone (web)`), [...DH, '.tmap', '.tmap .skel', '.dest', '.dest .lab', '.dest .r1-skel', '.dest a', ...STEPS_SKEL, ...TABS]),
  },
  {
    name: 'SCR-TEC-08 Route (map box, Show the whole route, destination, drive time, Next turn card, Steps list with the first marked Now)',
    frame: MAP_FRAME, captions: [`${D}Route`], app: '/shell-preview/tech-dir/route', screen: 'SCR-TEC-08', widthFrom: sized(`${D}Route`),
    pairs: within(APP, screenOf(`${D}Route`), [...DH, '.tmap', '.tmap .fab', '.tmap .fab .ic', ...DEST, '.dest .dt', '.dest .dt .ic', ...NEXT_TURN, ...STEPS, '.steps li.now', '.steps .now-t', ...TABS]),
  },
  {
    name: 'SCR-TEC-08 Approximate (map box, destination, no drive time, the steps are not available)',
    frame: MAP_FRAME, captions: [`${D}Approximate`], app: '/shell-preview/tech-dir/approximate', screen: 'SCR-TEC-08', widthFrom: sized(`${D}Approximate`),
    pairs: within(APP, screenOf(`${D}Approximate`), [...DH, '.tmap', '.tmap .fab', '.tmap .fab .ic', ...DEST, '.below', '.below h3', '.noturn', '.noturn .ic', '.noturn span', ...TABS]),
  },
  {
    name: 'SCR-TEC-08 Offline, steps saved (No signal card, the map needs signal, drive time, the kept steps with no Now mark)',
    frame: MAP_FRAME, captions: [`${D}Offline, steps saved`], app: '/shell-preview/tech-dir/offlinesaved', screen: 'SCR-TEC-08', widthFrom: sized(`${D}Offline, steps saved`),
    pairs: within(APP, screenOf(`${D}Offline, steps saved`), [
      ...DH, '.r1p-nosig', '.r1p-nosig .ic', '.r1p-nosig b', '.tmap', '.tmap .need', '.tmap .need .ic', '.tmap .need span', ...DEST, '.dest .dt', '.dest .dt .ic', ...STEPS, ...TABS,
    ]),
  },
  {
    name: 'SCR-TEC-08 Offline (No signal card, the map needs signal, the next stop in words)',
    frame: MAP_FRAME, captions: [`${D}Offline`], app: '/shell-preview/tech-dir/offline', screen: 'SCR-TEC-08', widthFrom: sized(`${D}Offline`),
    pairs: within(APP, screenOf(`${D}Offline`), [...DH, '.r1p-nosig', '.r1p-nosig .ic', '.r1p-nosig b', '.tmap', '.tmap .need', '.tmap .need .ic', '.tmap .need span', ...DEST, ...TABS]),
  },
  {
    name: 'SCR-TEC-08 Route not loaded (the error panel with Try again, the destination)',
    frame: MAP_FRAME, captions: [`${D}Route not loaded`], app: '/shell-preview/tech-dir/notloaded', screen: 'SCR-TEC-08', widthFrom: sized(`${D}Route not loaded`),
    pairs: within(APP, screenOf(`${D}Route not loaded`), [...DH, '.r1-errpanel', '.r1-errpanel .ic', '.r1-errpanel b', '.r1-errpanel .btn', ...DEST, ...TABS]),
  },
  {
    name: 'SCR-TEC-08 Job moved (This job is no longer on your day, the destination)',
    frame: MAP_FRAME, captions: [`${D}Job moved`], app: '/shell-preview/tech-dir/moved', screen: 'SCR-TEC-08', widthFrom: sized(`${D}Job moved`),
    pairs: within(APP, screenOf(`${D}Job moved`), [...DH, '.moved', ...EMPTY.map((x) => x.replace('.below ', '.moved ')), ...DEST, ...TABS]),
  },
  {
    name: 'SCR-TEC-08 Route updated (the route redrawn, Route updated.)',
    frame: MAP_FRAME, captions: [`${D}Route updated`], app: '/shell-preview/tech-dir/updated', screen: 'SCR-TEC-08', widthFrom: sized(`${D}Route updated`),
    pairs: within(APP, screenOf(`${D}Route updated`), [
      ...DH, '.tmap', '.tmap .fab', ...DEST, '.dest .dt', ...NEXT_TURN, ...STEPS, '.steps li.now', '.steps .now-t', '.r1p-notice', '.r1p-notice .ic', '.r1p-notice span', ...TABS,
    ]),
  },
  {
    name: 'SCR-TEC-08 No next job (No more jobs today)',
    frame: MAP_FRAME, captions: [`${D}No next job`], app: '/shell-preview/tech-dir/nonext', screen: 'SCR-TEC-08', widthFrom: sized(`${D}No next job`),
    pairs: within(APP, screenOf(`${D}No next job`), [...DH, '.below', ...EMPTY, ...TABS]),
  },
  {
    name: 'SCR-TEC-10 Success (profile, van, hours, sync, settings rows, Sign out, tab bar)',
    frame: ME_FRAME, captions: [`${ME}Success`], app: '/shell-preview/tech-me/success', screen: 'SCR-TEC-10', widthFrom: sized(`${ME}Success`),
    pairs: within(APP, screenOf(`${ME}Success`), [
      '.prof', '.prof .av', '.prof h1', '.prof .d',
      '.card', '.ch h3', '.van', '.van .ico', '.van .ico .ic', '.van b', '.van small',
      '.hours', '.hours div', '.hours b', '.hours small', ...SYNCROW,
      '.rows', '.rows .rw', '.rows .rw > .ic', '.rows .rw .call', '.rows .rw .call .ic', '.rows .rw .r1-switch', '.rows .rw .r1-switch .trk', '.rows .rw .r1-switch .st',
      '.rows .rw .aa', '.rows .rw .sel', '.rows .rw .sel .ic', '.rows .rw .r1-lang', '.rows .rw .r1-lang a', '.rows .rw .v',
      // The frame's Sign out button is squeezed to 25 px by its 844 px device (a flex item of a clipped column), so its box is not compared.
      '.out .ic', '.outnote', ...TABS,
    ]),
  },
  {
    name: 'SCR-TEC-10 Sign-out refused (3 waiting, the refusal)',
    frame: ME_FRAME, captions: [`${ME}Sign-out refused`], app: '/shell-preview/tech-me/refused', screen: 'SCR-TEC-10', widthFrom: sized(`${ME}Sign-out refused`),
    pairs: within(APP, screenOf(`${ME}Sign-out refused`), [...SYNCROW_TILE, '.out .ic', '.refused', '.refused .ic', '.refused span', ...TABS]),
  },
  {
    name: 'SCR-TEC-10 Signing out (Busy)',
    frame: ME_FRAME, captions: [`${ME}Signing out`], app: '/shell-preview/tech-me/signing', screen: 'SCR-TEC-10', widthFrom: sized(`${ME}Signing out`),
    // The frame's Busy button is squeezed to 25 px by its mini screen (a flex item of a fixed-height column); the app's keeps the 50 px of the
    // frame's own rule, so the button's box is not compared in this state, only what is inside it.
    pairs: within(APP, screenOf(`${ME}Signing out`), [...SYNCROW_TILE, '.out .r1-spin', ...TABS]),
  },
  {
    name: 'SCR-TEC-10 Offline (No signal card, the saved van and start time, Send now disabled with its reason)',
    frame: ME_FRAME, captions: [`${ME}Offline`], app: '/shell-preview/tech-me/offline', screen: 'SCR-TEC-10', widthFrom: sized(`${ME}Offline`),
    pairs: within(APP, screenOf(`${ME}Offline`), [
      '.r1p-nosig', '.r1p-nosig .ic', '.r1p-nosig b', '.van', '.van b', '.van small', '.ch h3', '.hours', '.hours div', '.hours b', '.hours small',
      ...SYNCROW_TILE, '.r1p-why', ...TABS,
    ]),
  },
  {
    name: 'SCR-TEC-10 Not started yet (control details)',
    frame: ME_FRAME, captions: [], app: '/shell-preview/tech-me/notstarted', screen: 'SCR-TEC-10',
    widthFrom: [{ app: `${APP} .hours`, frame: '.r1-st:has(> .b > .hours[data-ctl="CTL-TEC-10-07"]) .hours' }],
    pairs: within(`${APP} .hours`, '.r1-st:has(> .b > .hours[data-ctl="CTL-TEC-10-07"]) .hours', ['', 'div', 'b', 'small']),
  },
  {
    name: 'SCR-TEC-10 Text size open (control details)',
    frame: ME_FRAME, captions: [], app: '/shell-preview/tech-me/sizeopen', screen: 'SCR-TEC-10',
    widthFrom: [{ app: `${APP} .r1-menu`, frame: '.r1-st:has(.r1-menu[data-ctl="CTL-TEC-10-09"]) .r1-menu' }],
    pairs: within(`${APP} .r1-menu`, '.r1-st:has(.r1-menu[data-ctl="CTL-TEC-10-09"]) .r1-menu', ['', '.mi', '.mi b']),
  },
  // Kit 0.12 (57520d6c): the van, hours and sync cards as their titles over skeleton lines. The profile header's avatar is
  // compared (F-1779: the reading state draws the kept profile since F-1775). Its name and role line are not: they sit in a box as wide as the
  // longest line, and the frame names the branch there where the reading state draws a skeleton (F-1770), so the name's box is 45 px wider in
  // the frame (a local Chromium run, h1 width 239.42 against 194.13).
  {
    name: 'SCR-TEC-10 Reading the phone (the van, hours and sync cards as skeletons)',
    frame: ME_FRAME, captions: [`${ME}Reading the phone (web)`], app: '/shell-preview/tech-me/reading', screen: 'SCR-TEC-10', widthFrom: sized(`${ME}Reading the phone (web)`),
    pairs: within(APP, screenOf(`${ME}Reading the phone (web)`), ['.prof .av', '.card[aria-busy]', '.card[aria-busy] .ch', '.card[aria-busy] .ch h3', '.card[aria-busy] > .r1-skel', ...TABS]),
  },
  {
    name: 'SCR-TEC-16 Results (header, search field, count, results, read-only note, tab bar)',
    frame: PARTS_FRAME, captions: [`${P}Results`], app: '/shell-preview/tech-parts/results', screen: 'SCR-TEC-16', widthFrom: sized(`${P}Results`),
    pairs: within(APP, screenOf(`${P}Results`), [
      ...HEAD_R, '.lbl16', '.srch', '.srch .ic', '.srch .v', '.srch .clr', '.srch .clr .ic', '.cnt', '.res', '.res .pr', '.res .pr .tx', '.res .pr b', '.res .pr code', '.res .pr .pz',
      '.ro', '.ro .ic', '.ro span', '.tabbar', '.tabbar a', '.tabbar a.on', '.tabbar a .ic',
    ]),
  },
  {
    name: 'SCR-TEC-16 Empty (the search field idle, the count of parts)',
    frame: PARTS_FRAME, captions: [`${P}Empty`], app: '/shell-preview/tech-parts/empty', screen: 'SCR-TEC-16',
    widthFrom: [{ app: `${APP} .srch`, frame: `${cap(`${P}Empty`)} .srch` }, { app: `${APP} .emp`, frame: `${cap(`${P}Empty`)} .emp` }],
    pairs: within(APP, cap(`${P}Empty`), ['.srch', '.srch .ic', '.srch .v', '.emp', '.emp .ic', '.emp span']),
  },
  {
    name: 'SCR-TEC-16 No match (the typed search, the message)',
    frame: PARTS_FRAME, captions: [`${P}No match`], app: '/shell-preview/tech-parts/nomatch', screen: 'SCR-TEC-16',
    widthFrom: [{ app: `${APP} .srch`, frame: `${cap(`${P}No match`)} .srch` }, { app: `${APP} .emp`, frame: `${cap(`${P}No match`)} .emp` }],
    pairs: within(APP, cap(`${P}No match`), ['.srch', '.srch .ic', '.srch .v', '.srch .clr', '.srch .clr .ic', '.emp', '.emp .ic', '.emp span']),
  },
  {
    name: 'SCR-TEC-16 No copy yet (the message)',
    frame: PARTS_FRAME, captions: [`${P}No copy yet`], app: '/shell-preview/tech-parts/nocopy', screen: 'SCR-TEC-16',
    widthFrom: [{ app: `${APP} .emp`, frame: `${cap(`${P}No copy yet`)} .emp` }],
    pairs: within(APP, cap(`${P}No copy yet`), ['.emp', '.emp .ic', '.emp span']),
  },
  // Kit 0.12 (57520d6c): the search field, and skeleton rows in place of the count hint and the list. The skeleton rows are compared in every value but height (F-1744):
  // the frame draws them in a state tile, whose skeleton height is a tile-only rule (r1-single.css .r1-st .b .r1-skel, 14 px) against CMP-12's
  // 12 px, and every box around them takes its height from it (owner answer 2edb4bdc). The .res .pr row box is also held by the Results case (F-615).
  {
    name: 'SCR-TEC-16 Reading the phone (the search field idle)',
    frame: PARTS_FRAME, captions: [`${P}Reading the phone (web)`], app: '/shell-preview/tech-parts/reading', screen: 'SCR-TEC-16',
    widthFrom: [{ app: `${APP} .srch`, frame: `${cap(`${P}Reading the phone (web)`)} .srch` }, { app: `${APP} .res`, frame: `${cap(`${P}Reading the phone (web)`)} .res` }],
    pairs: [
      ...within(APP, cap(`${P}Reading the phone (web)`), ['.srch', '.srch .ic', '.srch .v']),
      // F-1744: the 3 skeleton rows are compared in every value but height. A skeleton is 14 px in the frame's tile (r1-single.css .r1-st .b .r1-skel) and
      // 12 px in CMP-12; the owner approved the pages with that difference (answer 2edb4bdc, Approve all pages), so the height of each box that follows it is not compared.
      ...within(APP, cap(`${P}Reading the phone (web)`), ['.res', '.res .pr', '.res .pr .tx', '.res .pr .r1-skel']).map((x) => ({ ...x, wrapRuled: 'F-1744, owner answer 2edb4bdc: the tile skeleton is 14 px, CMP-12 is 12 px' })),
    ],
  },
  {
    name: 'SCR-TEC-11 iPhone (brand row, steps, Continue, note, footer)',
    frame: INSTALL_FRAME, captions: [`${I}iPhone`], app: '/shell-preview/tech-install/iphone', screen: 'SCR-TEC-11',
    widthFrom: [{ app: '.bw-tech-install', frame: `${screenOf(`${I}iPhone`)}.inst .top11` }],
    pairs: within('.bw-tech-install', `${screenOf(`${I}iPhone`)}.inst`, [
      '.top11', '.top11 .brand', '.top11 .brand svg.mark', '.top11 .brand .word', '.top11 .brand .word small', '.top11 .r1-lang', '.top11 .r1-lang a',
      '.body11 h1', '.body11 .lead', '.steps11', '.steps11 li', '.steps11 .n', '.steps11 .gl', '.steps11 .gl .ic', '.cont', '.why11', '.pfoot', '.pfoot a', '.pfoot .demo',
    ]),
  },
  {
    name: 'SCR-TEC-11 Android with prompt (steps, Install, Continue)',
    frame: INSTALL_FRAME, captions: [`${I}Android with prompt`], app: '/shell-preview/tech-install/android-prompt', screen: 'SCR-TEC-11',
    widthFrom: [{ app: '.bw-tech-install .steps11', frame: `${cap(`${I}Android with prompt`)} .steps11` }, { app: '.bw-tech-install .btn.primary', frame: `${cap(`${I}Android with prompt`)} .btn.primary` }, { app: '.bw-tech-install .btn:not(.primary)', frame: `${cap(`${I}Android with prompt`)} .btn:not(.primary)` }],
    pairs: within('.bw-tech-install', cap(`${I}Android with prompt`), ['.steps11', '.steps11 li', '.steps11 .n', '.btn.primary', '.btn.primary .ic', '.btn:not(.primary)']),
  },
  {
    name: 'SCR-TEC-11 Android without prompt (steps, Continue)',
    frame: INSTALL_FRAME, captions: [`${I}Android without prompt`], app: '/shell-preview/tech-install/android', screen: 'SCR-TEC-11',
    widthFrom: [{ app: '.bw-tech-install .steps11', frame: `${cap(`${I}Android without prompt`)} .steps11` }, { app: '.bw-tech-install .btn', frame: `${cap(`${I}Android without prompt`)} .btn` }],
    pairs: within('.bw-tech-install', cap(`${I}Android without prompt`), ['.steps11', '.steps11 li', '.steps11 .n', '.btn']),
  },
  {
    name: 'SCR-TEC-11 Other browser (the message, Continue)',
    frame: INSTALL_FRAME, captions: [`${I}Other browser`], app: '/shell-preview/tech-install/other', screen: 'SCR-TEC-11',
    widthFrom: [{ app: '.bw-tech-install .infobox2', frame: `${cap(`${I}Other browser`)} .infobox2` }, { app: '.bw-tech-install .btn', frame: `${cap(`${I}Other browser`)} .btn` }],
    pairs: within('.bw-tech-install', cap(`${I}Other browser`), ['.infobox2', '.infobox2 .ic', '.infobox2 span', '.btn']),
  },
];

/** Frame captions that have no case, each with why (control-details tiles carry no caption, so only screens' states are listed). */
export const NOT_COMPARED: Record<string, string> = {};

export const FRAMES = [MAP_FRAME, ME_FRAME, PARTS_FRAME, INSTALL_FRAME] as const;

/** The captioned states of the frames that no case compares and no reason excuses. */
export function uncovered(captions: Record<string, string[]>, cases: readonly TechMapCase[] = TECH_MAP_CASES): string[] {
  const covered = new Set(cases.flatMap((c) => c.captions));
  return Object.values(captions).flat().filter((c) => !covered.has(c) && !(c in NOT_COMPARED));
}
