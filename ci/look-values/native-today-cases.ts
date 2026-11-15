// SPDX-License-Identifier: AGPL-3.0-or-later
// G-LOOK-PARITY for the native Today stack (P6-NATIVE-TODAY Acceptance, look clause): SCR-TEC-01, -02, -03, -13 and -14 against DK-117's frames
// (mockups/pages/r1-ios-b.html), native values read from the view hierarchy, in each state the frames show, light theme. The cases run
// with `node ci/look-values/native-compare.ts --dumps <dir> --suite today` (apps/tech-native/xcuitest/run.sh with BW_NATIVE_TESTS=TodayUITests).
// How the pairs are chosen (the rules of native-compare.ts apply):
//  - The device frames (Today Success, Sign-in Default, the 3 sheets) compare the screen's elements at the device's width.
//  - The other frames are fragments drawn at the details strip's width, with their own spacing; there the pairs are the atoms the fragment
//    shows (an icon, a text, a pill, a message box), and a box whose width the fragment sets (`data`) or whose height is the sum of its
//    children (`sum`) skips just that. A list row is compared in the device frame, not in a fragment.
//  - A text with 2 weights in one run (the card's service line) is read by UIKit at its first run, so the pair names the frame's first run.
//  - Not drawn from the view hierarchy (declared, F-993 b): padding, gaps and one-sided borders come from the style (lk()), as native-compare.ts says.
// The time and the counts in the frames are sample words: a pair whose text sets its width carries `data`.
import type { NativeCase, NativePair } from './native-compare.ts';

const cap = (c: string) => `[data-bw-cap="${c}"]`;
const T2 = 'SCR-TEC-02 Today, iPhone: ';
const T1 = 'SCR-TEC-01 Technician sign-in, iPhone: ';
const E3 = 'SCR-EML-03 Forgot password, iPhone: Default';
/** A control-detail tile of the SCR-EML-03 column (the frames' Sent and Not available results; their names repeat elsewhere on the page). */
const e3tile = (name: string) => `.ncol:has(${cap(E3)}) [data-bw-tile="${name}"] > .b`;
const DATA = 'the sample words and counts of the frame are not the test\'s';

/** A box, its text and its icon, named once. */
const box = (frame: string, native: string, flags: Partial<NativePair> = {}): NativePair => ({ frame, native, kind: 'box', ...flags });
const type = (frame: string, native: string): NativePair => ({ frame, native, kind: 'type' });
const text = (frame: string, native: string, flags: Partial<NativePair> = {}): NativePair => ({ frame, native, kind: 'text', ...flags });
const icon = (frame: string, native: string): NativePair => ({ frame, native, kind: 'icon' });

const empty = (name: string, state: string, frameCap: string): NativeCase => ({
  name: `SCR-TEC-02 ${name}`, state, root: cap(`${T2}${frameCap}`),
  pairs: [
    box('.emptyst', 'today.empty', { data: DATA, sum: 'the icon and the text stacked' }),
    icon('.emptyst .ic', 'today.empty.icon'),
    type('.emptyst b', 'today.empty.text'),
  ],
});

const nosig = (): NativePair[] => [
  box('.nosig', 'today.nosig', { data: DATA, sum: 'the title and the text, wrapped to the list\'s width' }),
  box('.nosig .bi', 'today.nosig.bi'),
  icon('.nosig .bi .ic', 'today.nosig.icon'),
  type('.nosig b', 'today.nosig.title'),
  type('.nosig small', 'today.nosig.text'),
];

const doneAtoms = (g = '.grp'): NativePair[] => [
  box(`${g} .num.ok`, 'today.done.0.num'),
  icon(`${g} .num.ok .ic`, 'today.done.0.num.icon'),
  type(`${g} .row.done .tx b`, 'today.done.0.name'),
  type(`${g} .row.done .tx small`, 'today.done.0.area'),
  box(`${g} .row.done .st.done`, 'today.done.0.st', { data: 'Done 10:15 AM is the frame\'s word; the test\'s is No one home' }),
  type(`${g} .row.done .st.done`, 'today.done.0.st.text'),
];

const sheet = (name: string, state: string, frameCap: string, go: string, withEta: boolean): NativeCase => ({
  name, state, root: `${cap(frameCap)} .nsheet`,
  pairs: [
    type('h2', 'sheet.title'),
    type('.m', 'sheet.msg'),
    ...(withEta ? [type('.what.eta span', 'sheet.eta.text'), icon('.what.eta .ic', 'sheet.eta.icon')] : []),
    box('.b2', 'sheet.btns'),
    box('.nbtn:not(.warm):not(.pri)', 'sheet.cancel'),
    type('.nbtn:not(.warm):not(.pri)', 'sheet.cancel.text'),
    box(go, 'sheet.go'),
    type(go, 'sheet.go.text'),
    ...(go.includes('warm') ? [icon(`${go} .ic`, 'sheet.go.icon')] : go === '.nbtn.pri' && frameCap.includes('SCR-TEC-13') ? [icon(`${go} .ic`, 'sheet.go.icon')] : []),
  ],
});

const fieldPairs = (n: 'login' | 'password', nth: number, inp: string): NativePair[] => [
  text(`.fld:nth-of-type(${nth}) > label`, `signin.${n}.label`),
  box(`.fld:nth-of-type(${nth}) ${inp}`, `signin.${n}.inp`),
  icon(`.fld:nth-of-type(${nth}) ${inp} .ic`, `signin.${n}.icon`),
  { frame: `.fld:nth-of-type(${nth}) ${inp} .v`, native: `signin.${n}.value`, kind: 'face' },
];

/** SCR-EML-03's result box in a tile (F-1107): the box, its icon and its words (the address in the frame is a sample one). */
const resultPairs = (boxSel: string): NativePair[] => [
  box(boxSel, 'forgot.result', { data: DATA, sum: 'the icon and the message' }),
  icon(`${boxSel} .ic`, 'forgot.result.icon'),
  type(`${boxSel} > span`, 'forgot.result.text'),
];

export const NATIVE_TODAY_CASES: NativeCase[] = [
  {
    name: 'SCR-TEC-02 Success (the main frame)', state: 'today', root: cap(`${T2}Success`),
    pairs: [
      box('.nav .navrow', 'today.navrow'),
      type('.nav h1.lt', 'today.title'),
      box('.nav .sync', 'today.sync'),
      icon('.nav .sync .ic', 'today.sync.icon'),
      text('.nav .sync span', 'sync.count', { sum: 'F-1640: the words are their own accessibility element, grown to 44 pt tall by padding with a matching negative margin; the pill above (today.sync) is compared at its height and the font on the type pair' }),
      box('.nav .navbtn', 'today.refresh'),
      icon('.nav .navbtn .ic', 'today.refresh.icon'),
      type('.nav .sub', 'today.sub'),
      box('.nav .prog .bar', 'today.prog'),
      box('.nav .prog .bar i', 'today.prog.fill', { data: 'the share of the day done is the test\'s' }),
      // the done group and its row
      box('.scroll > .grp:first-child', 'today.done', { data: 'fills the list', sum: 'its rows' }),
      box('.scroll > .grp:first-child a.row.done', 'today.done.0', { data: 'fills the group', sum: 'the row follows its trailing badges: the test\'s job also shows Sent' }),
      ...doneAtoms('.scroll > .grp:first-child'),
      // the next job card
      box('section.next', 'today.card', { data: 'fills the list', sum: 'the lines the job has' }),
      box('.next .lab', 'card.lab'),
      box('.next .lab .num', 'card.num'),
      type('.next .lab .num', 'card.num.text'),
      type('.next .lab > span:nth-child(2)', 'card.label'),
      box('.next .lab .win', 'card.win', { data: DATA }),
      type('.next .lab .win', 'card.win.text'),
      box('.next .who', 'card.who', { sum: 'the name and the status' }),
      type('.next .who h2', 'card.name'),
      box('.next .who .st', 'card.st', { data: DATA }),
      type('.next .who .st', 'card.st.text'),
      type('.next .addr', 'card.addr'),
      box('.next .what:not(.eta):not(:has(.lnk))', 'card.what1', { sum: 'the icon and the text' }),
      icon('.next .what:not(.eta):not(:has(.lnk)) .ic', 'card.what1.icon'),
      type('.next .what:not(.eta):not(:has(.lnk)) span b', 'card.what1.text'),
      box('.next .what:has(.lnk)', 'card.what2', { sum: 'the icon and the text' }),
      icon('.next .what:has(.lnk) .ic', 'card.what2.icon'),
      type('.next .what:has(.lnk) > span', 'card.what2.text'),
      // F-1106: the arrival estimate when online (CTL-TEC-02-02), API-100's estimate for the next job
      box('.next .what.eta', 'card.eta', { sum: 'the icon and the text' }),
      icon('.next .what.eta .ic', 'card.eta.icon'),
      type('.next .what.eta > span', 'card.eta.text'),
      box('.next .acts', 'card.acts'),
      box('.next .pbtn.dir', 'card.dir'),
      icon('.next .pbtn.dir .ic', 'card.dir.icon'),
      type('.next .pbtn.dir span', 'card.dir.text'),
      type('.next .pbtn.dir small', 'card.dir.min'),
      box('.next .acts .pbtn.sq:nth-child(2)', 'card.call'),
      icon('.next .acts .pbtn.sq:nth-child(2) .ic', 'card.call.icon'),
      box('.next .acts .pbtn.sq:nth-child(3)', 'card.open'),
      icon('.next .acts .pbtn.sq:nth-child(3) .ic', 'card.open.icon'),
      box('.next .omw', 'card.omw'),
      icon('.next .omw .ic', 'card.omw.icon'),
      type('.next .omw span', 'card.omw.text'),
      type('.next .omwnote', 'card.omwnote'),
      box('.next .acts2', 'card.acts2'),
      box('.next .acts2 .sbtn:nth-child(1)', 'card.arrived'),
      icon('.next .acts2 .sbtn:nth-child(1) .ic', 'card.arrived.icon'),
      type('.next .acts2 .sbtn:nth-child(1) span', 'card.arrived.text'),
      box('.next .acts2 .sbtn.dis:nth-child(2)', 'card.noh'),
      type('.next .acts2 .sbtn.dis:nth-child(2) span', 'card.noh.text'),
      box('.next .acts2 .sbtn.dis:nth-child(3)', 'card.finish'),
      type('.next .acts2 .sbtn.dis:nth-child(3) span', 'card.finish.text'),
      type('.next .after', 'card.after'),
      // F-1113 (a): the customer note box and See history (run.sh gives the test job's customer a note, so the Success frame shows both)
      box('.next .notebox', 'card.note', { data: DATA }),
      type('.next .notebox b', 'card.note.title'),
      type('.next .notebox', 'card.note.text'),
      type('.next .what:has(.lnk) .lnk', 'card.history.text'),
      // Later today
      type('.ghead', 'today.later.head'),
      box('.scroll > .grp:last-child', 'today.later', { data: 'fills the list', sum: 'its rows' }),
      box('.scroll > .grp:last-child a.row.later:nth-child(1)', 'today.later.0', { data: 'fills the group', sum: 'the row follows its text, which wraps with the test\'s words' }),
      box('.scroll > .grp:last-child a.row.later:nth-child(1) .num', 'today.later.0.num'),
      type('.scroll > .grp:last-child a.row.later:nth-child(1) .num', 'today.later.0.num.text'),
      type('.scroll > .grp:last-child a.row.later:nth-child(1) .tx b', 'today.later.0.name'),
      type('.scroll > .grp:last-child a.row.later:nth-child(1) .tx small', 'today.later.0.area'),
      type('.scroll > .grp:last-child a.row.later:nth-child(1) .trail b', 'today.later.0.win'),
      box('.scroll > .grp:last-child a.row.later:nth-child(1) .st.sched', 'today.later.0.st'),
      type('.scroll > .grp:last-child a.row.later:nth-child(1) .st.sched', 'today.later.0.st.text'),
      icon('.scroll > .grp:last-child a.row.later:nth-child(1) .chev .ic', 'today.later.0.chev'),
      box('.scroll > .grp:last-child a.row.later:nth-child(2)', 'today.later.1', { data: 'fills the group', sum: 'the row follows its text, which wraps with the test\'s words' }),
    ],
  },
  {
    name: 'SCR-TEC-02 Loading', state: 'today-loading', root: cap(`${T2}Loading`),
    pairs: [
      box('.b > .grp', 'today.skel', { data: DATA, sum: 'its rows' }),
      box('.row:first-child .num.sk', 'today.skel.0.num'),
    ],
  },
  {
    name: 'SCR-TEC-02 Offline, saved', state: 'today-offline-saved', root: cap(`${T2}Offline, saved`),
    pairs: [
      ...nosig(),
      box('.savedline', 'today.savedline', { data: DATA, sum: 'the text and the pill' }),
      type('.savedline > span', 'today.savedline.text'),
      box('.savedline .sync.warn', 'today.savedline.pill', { data: DATA }),
      icon('.savedline .sync.warn .ic', 'today.savedline.icon'),
      type('.savedline .sync.warn span', 'today.savedline.pill.text'),
      box('.b > .grp', 'today.done', { data: DATA, sum: 'its rows' }),
      ...doneAtoms('.b > .grp'),
    ],
  },
  {
    name: 'SCR-TEC-02 Offline, nothing saved', state: 'today-offline-none', root: cap(`${T2}Offline, nothing saved`),
    pairs: [
      ...nosig(),
      box('.emptyst', 'today.empty', { data: DATA, sum: 'the icon and the text stacked' }),
      type('.emptyst b', 'today.empty.text'),
    ],
  },
  {
    // the frame draws the waiting job as a list row; the native card carries the same status and Waiting badge, so the atoms are compared
    name: 'SCR-TEC-02 Pending status', state: 'today-pending', root: cap(`${T2}Pending status`),
    pairs: [
      box('.st.way', 'card.st'),
      type('.st.way', 'card.st.text'),
      box('.wait', 'card.wait'),
      type('.wait', 'card.wait.text'),
    ],
  },
  empty('No jobs', 'today-no-jobs', 'No jobs'),
  empty('All done', 'today-all-done', 'All done'),
  {
    name: 'SCR-TEC-02 New day', state: 'today-new-day', root: cap(`${T2}New day`),
    pairs: [
      box('.b > .grp', 'today.skel', { data: DATA, sum: 'its rows' }),
      box('.row:first-child .num.sk', 'today.skel.0.num'),
    ],
  },
  sheet('SCR-TEC-03 On my way: confirm (Online)', 'sheet-omw', 'SCR-TEC-03 On my way: confirm, iPhone: Online', '.nbtn.warm', true),
  sheet('SCR-TEC-13 Arrived: confirm (Asking)', 'sheet-arrived', 'SCR-TEC-13 Arrived: confirm, iPhone: Asking', '.nbtn.pri', false),
  sheet('SCR-TEC-14 No one home: confirm (Online)', 'sheet-noh', 'SCR-TEC-14 No one home: confirm, iPhone: Online', '.nbtn.pri', false),
  {
    name: 'SCR-TEC-01 Default (the main frame)', state: 'signin', root: cap(`${T1}Default`),
    pairs: [
      box('.hero .appicon', 'signin.appicon'),
      type('.hero .co', 'signin.co'),
      type('.hero h1', 'signin.product'),
      type('.hero p:last-child', 'signin.app'),
      box('.form', 'signin.form', { sum: 'the form\'s children' }),
      type('.form h2', 'signin.h2'),
      type('.form .lead', 'signin.lead'),
      ...fieldPairs('login', 1, '.inp'),
      ...fieldPairs('password', 2, '.inp.focus'),
      box('.inp.focus .show', 'signin.show'),
      type('.inp.focus .show', 'signin.show.text'),
      box('.stay', 'signin.stay.card', { sum: 'its 2 text lines, which UIKit snaps to the 1/3 pt pixel grid' }),
      type('.stay b', 'signin.stay.title'),
      type('.stay small', 'signin.stay.note'),
      box('a.primary', 'signin.submit'),
      icon('a.primary .ic', 'signin.submit.icon'),
      type('a.primary span', 'signin.submit.text'),
      box('a.forgot', 'signin.forgot'),
      type('a.forgot', 'signin.forgot.text'),
      box('.grp.setg', 'signin.server.grp', { sum: 'the Language row and the Server row' }),
      box('.row.set:nth-child(1)', 'signin.lang.row'),
      icon('.row.set:nth-child(1) > .ic', 'signin.lang.icon'),
      type('.row.set:nth-child(1) .k', 'signin.lang.key'),
      box('.iseg', 'signin.lang'),
      box('.iseg button.on', 'signin.lang.en'),
      { frame: '.iseg button.on', native: 'signin.lang.en.text', kind: 'face' },
      { frame: '.iseg button:not(.on)', native: 'signin.lang.es.text', kind: 'face' },
      icon('.row.set:nth-child(2) > .ic', 'signin.server.icon'),
      type('.row.set:nth-child(2) .k', 'signin.server.key'),
      type('.row.set:nth-child(2) .v', 'signin.server.value'),
      icon('.row.set:nth-child(2) .chev .ic', 'signin.server.chev'),
      type('.ver', 'signin.ver'),
    ],
  },
  {
    name: 'SCR-TEC-01 Signing in', state: 'signin-busy', root: cap(`${T1}Signing in`),
    pairs: [
      box('a.primary.busy', 'signin.submit', { data: DATA }),
      type('a.primary.busy span:not(.r1-spin)', 'signin.submit.text'),
    ],
  },
  {
    name: 'SCR-TEC-01 Wrong details', state: 'signin-wrong', root: cap(`${T1}Wrong details`),
    pairs: [
      box('.errbox', 'signin.error', { data: DATA, sum: 'the icon and the message' }),
      icon('.errbox .ic', 'signin.error.icon'),
      type('.errbox span', 'signin.error.text'),
    ],
  },
  {
    name: 'SCR-TEC-01 Turned off', state: 'signin-off', root: cap(`${T1}Turned off`),
    pairs: [
      box('.errbox', 'signin.error', { data: DATA, sum: 'the icon and the message' }),
      icon('.errbox .ic', 'signin.error.icon'),
      type('.errbox span', 'signin.error.text'),
    ],
  },
  {
    name: 'SCR-TEC-01 Items waiting', state: 'signin-waiting', root: cap(`${T1}Items waiting`),
    pairs: [
      text('.fld > label', 'signin.login.label', { data: DATA }),
      box('.inp.locked', 'signin.login.inp', { data: DATA }),
      icon('.inp.locked .ic', 'signin.login.icon'),
      { frame: '.inp.locked .v', native: 'signin.login.value', kind: 'face' },
      box('.infobox', 'signin.info', { data: DATA, sum: 'the icon and the message' }),
      icon('.infobox .ic', 'signin.info.icon'),
      type('.infobox span', 'signin.info.text'),
    ],
  },
  // F-1107: SCR-EML-03 Forgot password, the native screen (DK-117 eml03: the Default frame and its Sent and Not available tiles)
  {
    name: 'SCR-EML-03 Default (the main frame)', state: 'forgot', root: cap(E3),
    pairs: [
      box('.bar2 .navrow', 'forgot.bar.nav'),
      box('.bar2 .backb', 'forgot.bar.back'),
      icon('.bar2 .backb .ic', 'forgot.bar.back.icon'),
      type('.bar2 .backb', 'forgot.bar.back.text'),
      text('.bar2 h1', 'forgot.bar.title'),
      box('.form', 'forgot.form', { sum: 'the form\'s children' }),
      type('.form .lead', 'forgot.lead'),
      text('.fld > label', 'forgot.email.label'),
      box('.inp.focus', 'forgot.email.inp'),
      icon('.inp.focus .ic', 'forgot.email.icon'),
      { frame: '.inp.focus .v', native: 'forgot.email.value', kind: 'face' },
      box('a.primary', 'forgot.send'),
      icon('a.primary .ic', 'forgot.send.icon'),
      type('a.primary span', 'forgot.send.text'),
      box('a.forgot', 'forgot.back'),
      type('a.forgot', 'forgot.back.text'),
    ],
  },
  { name: 'SCR-EML-03 Sent (the result tile)', state: 'forgot-sent', root: e3tile('Sent'), pairs: resultPairs('.okmsg') },
  { name: 'SCR-EML-03 Not available (the result tile)', state: 'forgot-not-available', root: e3tile('Not available'), pairs: resultPairs('.infobox') },
  {
    name: 'SCR-TEC-01 Server unreachable', state: 'signin-unreachable', root: cap(`${T1}Server unreachable`),
    pairs: [
      box('.errbox', 'signin.error', { data: DATA, sum: 'the icon and the message' }),
      icon('.errbox .ic', 'signin.error.icon'),
      type('.errbox > span', 'signin.error.text'),
    ],
  },
];
