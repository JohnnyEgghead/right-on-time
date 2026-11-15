// SPDX-License-Identifier: AGPL-3.0-or-later
// The native look cases of P6-NATIVE-MAP-ME (G-LOOK-PARITY on the native app, ci/look-values/native-compare.ts): SCR-TEC-15 Map, SCR-TEC-16 Parts,
// SCR-TEC-10 Me and SCR-TEC-08 Directions at the main state DK-117's frames show (light theme), and the tab bar in the Map, Parts and Me states
// (F-993 a: CMP-09 is compared in each tab's own state, not only in Today's). The app dumps each state (apps/tech-native/src/screens/mapme:
// map, parts, me, directions); a pair names a frame element and the view that draws it. See native-compare.ts for the kinds and flags.
import type { NativeCase, NativePair } from './native-compare.ts';

const cap = (c: string) => `[data-bw-cap="${c}"]`;
const MAP = 'SCR-TEC-15 Map, iPhone: Route';
const PARTS = 'SCR-TEC-16 Parts, iPhone: Results';
const ME = 'SCR-TEC-10 Me, iPhone: Success';
const DIR = 'SCR-TEC-08 Directions, iPhone: Route';

/** The teal bar2 of a frame: the row, the title and the line under it. The bar's own height holds the system status bar, whose height is the phone's. */
function bar(p: string, opts: { sub?: boolean; back?: boolean } = {}): NativePair[] {
  return [
    { frame: '.bar2', native: `${p}.bar`, kind: 'box', sum: 'the height holds the system status bar, which the phone draws at its own height (the frame draws a 54 px one)' },
    { frame: '.bar2 .navrow', native: `${p}.bar.nav`, kind: 'box' },
    ...(opts.back ? [
      { frame: '.bar2 .backb', native: `${p}.bar.back`, kind: 'box' },
      { frame: '.bar2 .backb', native: `${p}.bar.back.text`, kind: 'type' },
      { frame: '.bar2 .backb .ic', native: `${p}.bar.back.icon`, kind: 'icon' },
    ] satisfies NativePair[] : []),
    { frame: '.bar2 h1', native: `${p}.bar.title`, kind: 'text' },
    ...(opts.sub ? [{ frame: '.bar2 .sub', native: `${p}.bar.sub`, kind: 'text' }] satisfies NativePair[] : []),
  ];
}

/** The map box with its credit (CTL-CMP-05-01, CTL-CMP-05-04). */
function nmap(id: string): NativePair[] {
  return [
    { frame: '.nmap', native: id, kind: 'box' },
    { frame: '.nmap .osm2', native: `${id}.osm.pill`, kind: 'box' }, // F-1640: the link's own box is its 44 pt hit area; the pill inside is the credit as drawn
    { frame: '.nmap .osm2', native: `${id}.osm.text`, kind: 'type' },
  ];
}

/** Why a step's sizes are the test's own: the words and lengths are the real route's (the frame shows UI-SPEC's sample steps). */
const STEP_WORDS = 'the step\'s words are the route\'s own (the frame shows UI-SPEC SCR-TEC-08\'s sample steps)';
const STEP_HEIGHT = 'its height follows the step\'s words, which wrap as long as they are; its parts are each compared';

/**
 * SCR-TEC-08 with kit 0.9's turn-by-turn half (P6-NATIVE-STEPS; F-1233): the 216 px map with Show the whole route, the destination group,
 * the Next turn card, the Steps head and the ordered list of steps (the first marked Now, a plain step, the arrival).
 */
export const DIRECTIONS_PAIRS: NativePair[] = [
  ...bar('dir', { back: true }),
  ...nmap('dir.map'),
  { frame: '.nmap .nfit', native: 'dir.fit', kind: 'box' },
  { frame: '.nmap .nfit .ic', native: 'dir.fit.icon', kind: 'icon' },
  { frame: '.scroll > div.grp', native: 'dir.dest', kind: 'box', sum: 'the sum of its 3 rows' },
  { frame: '.scroll > div.grp .row:nth-child(1)', native: 'dir.dest.who', kind: 'box' },
  ...rowText('.scroll > div.grp .row:nth-child(1)', 'dir.dest.who', 'the destination is the test\'s next job'),
  { frame: '.scroll > div.grp .row:nth-child(2)', native: 'dir.time', kind: 'box' },
  { frame: '.scroll > div.grp .row:nth-child(2) .tx b', native: 'dir.time.tx.b', kind: 'text', data: 'the leg\'s own drive minutes' },
  { frame: '.scroll > div.grp .row:nth-child(3)', native: 'dir.open', kind: 'box' },
  { frame: '.scroll > div.grp .row:nth-child(3) .tx b', native: 'dir.open.tx.b', kind: 'text' },
  { frame: '.scroll > div.grp .row:nth-child(3) .chev .ic', native: 'dir.open.chev', kind: 'icon' },
  { frame: '.nturn', native: 'dir.next', kind: 'box', sum: STEP_HEIGHT },
  { frame: '.nturn .mv', native: 'dir.next.mv', kind: 'box' },
  { frame: '.nturn .mv .ic', native: 'dir.next.icon', kind: 'icon' },
  { frame: '.nturn .tx b', native: 'dir.next.lead', kind: 'text', data: STEP_WORDS },
  { frame: '.nturn .tx > span', native: 'dir.next.words', kind: 'type' },
  { frame: '.scroll > .ghead', native: 'dir.ghead', kind: 'text' },
  { frame: 'ol.nsteps', native: 'dir.steps', kind: 'box', sum: 'the sum of its step rows' },
  { frame: 'li.row.turn.now', native: 'dir.step.0', kind: 'box', sum: STEP_HEIGHT },
  { frame: 'li.row.turn.now .mv', native: 'dir.step.0.mv', kind: 'box' },
  { frame: 'li.row.turn.now .mv .ic', native: 'dir.step.0.icon', kind: 'icon' },
  { frame: 'li.row.turn.now .nowt', native: 'dir.step.0.now', kind: 'box' },
  { frame: 'li.row.turn.now .nowt', native: 'dir.step.0.now.text', kind: 'type' },
  { frame: 'li.row.turn.now .tx b > span:last-child', native: 'dir.step.0.words', kind: 'type' },
  { frame: 'li.row.turn.now .v', native: 'dir.step.0.v', kind: 'text', data: STEP_WORDS },
  { frame: 'li.row.turn:nth-child(2)', native: 'dir.step.1', kind: 'box', sum: STEP_HEIGHT },
  { frame: 'li.row.turn:nth-child(2) .mv', native: 'dir.step.1.mv', kind: 'box' },
  { frame: 'li.row.turn:nth-child(2) .mv .ic', native: 'dir.step.1.icon', kind: 'icon' },
  { frame: 'li.row.turn:nth-child(2) .tx b > span', native: 'dir.step.1.words', kind: 'type' },
  { frame: 'li.row.turn:nth-child(2) .v', native: 'dir.step.1.v', kind: 'text', data: STEP_WORDS },
  { frame: 'li.row.turn.arrive', native: 'dir.step.arrive', kind: 'box', sum: STEP_HEIGHT },
  { frame: 'li.row.turn.arrive .mv', native: 'dir.step.arrive.mv', kind: 'box' },
  { frame: 'li.row.turn.arrive .mv .ic', native: 'dir.step.arrive.icon', kind: 'icon' },
  { frame: 'li.row.turn.arrive .tx b > span', native: 'dir.step.arrive.words', kind: 'type' },
];

/** One row of a group: the row box and its text lines. `data` is why a width is the test's own data. */
function rowText(frame: string, native: string, data?: string): NativePair[] {
  const d = data ? { data } : {};
  return [
    { frame: `${frame} .tx`, native: `${native}.tx`, kind: 'box', ...d },
    { frame: `${frame} .tx b`, native: `${native}.tx.b`, kind: 'text', ...d },
    { frame: `${frame} .tx small`, native: `${native}.tx.small`, kind: 'text', ...d },
  ];
}

const ROW_DATA = 'the room the row\'s trailing part leaves';

/** CMP-09 in the state of the screen the dump was written on: `on` is the current tab (DK-117 draws tabbar(\'Map\'), (\'Parts\'), (\'Me\')). */
function tabbar(name: string, state: string, frameCap: string, on: 'map' | 'parts' | 'me'): NativeCase {
  const tabs = ['today', 'map', 'parts', 'me'] as const;
  return {
    name: `CMP-09 tab bar (the ${name} frame)`, state, root: `${cap(frameCap)} .tabbar`,
    pairs: [
      { frame: '', native: 'tabbar', kind: 'box' },
      { frame: '.tab.on', native: `tab.${on}`, kind: 'box' },
      { frame: '.tab.on::before', native: `tab.${on}.mark`, kind: 'box' },
      ...tabs.flatMap((t, i): NativePair[] => [
        { frame: `.tab:nth-child(${i + 1})`, native: `tab.${t}`, kind: 'box' },
        { frame: `.tab:nth-child(${i + 1}) .ic`, native: `tab.${t}.icon`, kind: 'icon' },
        { frame: `.tab:nth-child(${i + 1}) span`, native: `tab.${t}.text`, kind: 'text' },
      ]),
    ],
  };
}

export const MAPME_CASES: NativeCase[] = [
  {
    name: 'SCR-TEC-15 Map: Route (the main frame)', state: 'map', root: cap(MAP),
    pairs: [
      ...bar('map', { sub: true }),
      ...nmap('map.view'),
      { frame: '.next', native: 'map.next', kind: 'box', sum: 'the sum of its children, each compared; the app adds the drive-time line (CTL-TEC-15-09) and the Open job link (CTL-TEC-15-10), which the frame leaves out' },
      { frame: '.next .lab', native: 'map.next.lab', kind: 'box' },
      { frame: '.next .lab .num', native: 'map.next.num', kind: 'box' },
      { frame: '.next .lab .num', native: 'map.next.num.text', kind: 'type' },
      { frame: '.next .lab > span:nth-child(2)', native: 'map.next.label', kind: 'text' },
      { frame: '.next .lab .win', native: 'map.next.win', kind: 'box', data: 'the window the day gives the next stop' },
      { frame: '.next .lab .win', native: 'map.next.win.text', kind: 'type' },
      { frame: '.next .who', native: 'map.next.who', kind: 'box' },
      { frame: '.next .who h2', native: 'map.next.name', kind: 'text', data: 'the next stop\'s customer' },
      { frame: '.next .addr', native: 'map.next.addr', kind: 'text' },
      { frame: '.next .acts', native: 'map.next.acts', kind: 'box' },
      { frame: '.next .pbtn.dir', native: 'map.dir', kind: 'box' },
      { frame: '.next .pbtn.dir .ic', native: 'map.dir.icon', kind: 'icon' },
      { frame: '.next .pbtn.dir span', native: 'map.dir.text', kind: 'text' },
      { frame: '.next .pbtn.dir small', native: 'map.dir.min', kind: 'text', data: 'the minutes of the next leg' },
      { frame: '.scroll > .grp', native: 'map.stops', kind: 'box', sum: 'the sum of its rows, one per stop of the day' },
      // The frame's first row is a Done stop (its check disc and Done chip). The sample day has none done at the demo time the stack starts at, so
      // the MapMeUITests run has the relay answer the route with its first stop done (signal-relay.mjs do=firstdone), and the dump draws that row;
      // the frame's second row (hairline above it, the Next stop's disc and chip) is the Next row the day then gives (F-1075).
      { frame: '.scroll > .grp .row:nth-child(1)', native: 'map.stop.done.0', kind: 'box' },
      { frame: '.scroll > .grp .row:nth-child(1) .num', native: 'map.stop.done.0.num', kind: 'box' },
      { frame: '.scroll > .grp .row:nth-child(1) .num .ic', native: 'map.stop.done.0.num.icon', kind: 'icon' },
      ...rowText('.scroll > .grp .row:nth-child(1)', 'map.stop.done.0', ROW_DATA),
      { frame: '.scroll > .grp .row:nth-child(1) .st', native: 'map.stop.done.0.st', kind: 'box' },
      { frame: '.scroll > .grp .row:nth-child(1) .st', native: 'map.stop.done.0.st.text', kind: 'type' },
      { frame: '.scroll > .grp .row:nth-child(2)', native: 'map.stop.next.0', kind: 'box' },
      { frame: '.scroll > .grp .row:nth-child(2) .num', native: 'map.stop.next.0.num', kind: 'box' },
      { frame: '.scroll > .grp .row:nth-child(2) .num', native: 'map.stop.next.0.num.text', kind: 'type' },
      ...rowText('.scroll > .grp .row:nth-child(2)', 'map.stop.next.0', ROW_DATA),
      { frame: '.scroll > .grp .row:nth-child(2) .st', native: 'map.stop.next.0.st', kind: 'box' },
      { frame: '.scroll > .grp .row:nth-child(2) .st', native: 'map.stop.next.0.st.text', kind: 'type' },
    ],
  },
  tabbar('Map', 'map', MAP, 'map'),
  {
    name: 'SCR-TEC-16 Parts: Results (the main frame)', state: 'parts', root: cap(PARTS),
    pairs: [
      ...bar('parts', { sub: true }),
      { frame: '.fld', native: 'parts.fld', kind: 'box' },
      { frame: '.fld .inp', native: 'parts.inp', kind: 'box' },
      { frame: '.fld .inp .ic', native: 'parts.inp.icon', kind: 'icon' },
      { frame: '.fld .inp .v', native: 'parts.input', kind: 'face' },
      { frame: '.fld .inp .show', native: 'parts.clear', kind: 'box' },
      { frame: '.fld .inp .show', native: 'parts.clear.text', kind: 'type' },
      { frame: '.scroll > .hint', native: 'parts.count', kind: 'text', data: 'the count the search finds in the list on the phone' },
      { frame: '.scroll > .grp', native: 'parts.results', kind: 'box', sum: 'the sum of its rows, one per matching part' },
      { frame: '.grp .row:nth-child(1)', native: 'parts.row.0', kind: 'box' },
      { frame: '.grp .row:nth-child(1) .tx', native: 'parts.row.0.tx', kind: 'box', data: 'the room the price leaves' },
      { frame: '.grp .row:nth-child(1) .tx b', native: 'parts.row.0.name', kind: 'text', data: 'the part\'s name' },
      { frame: '.grp .row:nth-child(1) .tx small', native: 'parts.row.0.code', kind: 'text', data: 'the part\'s code' },
      { frame: '.grp .row:nth-child(1) .trail', native: 'parts.row.0.trail', kind: 'box', data: 'the part\'s price' },
      { frame: '.grp .row:nth-child(1) .trail b', native: 'parts.row.0.price', kind: 'text', data: 'the part\'s price' },
      { frame: '.grp .row:nth-child(2)', native: 'parts.row.1', kind: 'box' },
    ],
  },
  tabbar('Parts', 'parts', PARTS, 'parts'),
  {
    name: 'SCR-TEC-10 Me: Success (the main frame)', state: 'me', root: cap(ME),
    pairs: [
      ...bar('me'),
      { frame: '.scroll > :nth-child(1)', native: 'me.profile.grp', kind: 'box', sum: 'the profile row, whose height is its text wrapped to the phone\'s width' },
      { frame: '.scroll > :nth-child(1) .row', native: 'me.profile', kind: 'box', sum: 'its height is the profile text wrapped to the phone\'s width' },
      { frame: '.scroll > :nth-child(1) .num', native: 'me.avatar', kind: 'box' },
      { frame: '.scroll > :nth-child(1) .num', native: 'me.avatar.text', kind: 'type' },
      { frame: '.scroll > :nth-child(1) .tx b', native: 'me.profile.tx.b', kind: 'text', data: 'the signed-in technician\'s name' },
      { frame: '.scroll > :nth-child(1) .tx small', native: 'me.profile.tx.small', kind: 'type' },
      { frame: '.scroll > :nth-child(2)', native: 'me.day.grp', kind: 'box', sum: 'the sum of its 3 rows' },
      { frame: '.scroll > :nth-child(2) .row:nth-child(1)', native: 'me.van', kind: 'box' },
      { frame: '.scroll > :nth-child(2) .row:nth-child(1) .tx b', native: 'me.van.tx.b', kind: 'type' },
      { frame: '.scroll > :nth-child(2) .row:nth-child(1) .tx small', native: 'me.van.tx.small', kind: 'type' },
      { frame: '.scroll > :nth-child(2) .row:nth-child(2)', native: 'me.hours', kind: 'box' },
      { frame: '.scroll > :nth-child(2) .row:nth-child(2) .tx b', native: 'me.hours.tx.b', kind: 'type' },
      { frame: '.scroll > :nth-child(2) .row:nth-child(2) .tx small', native: 'me.hours.tx.small', kind: 'type' },
      { frame: '.scroll > :nth-child(2) .row:nth-child(3)', native: 'me.sync', kind: 'box' },
      { frame: '.scroll > :nth-child(2) .row:nth-child(3) .tx b', native: 'me.sync.tx.b', kind: 'type' },
      { frame: '.scroll > :nth-child(2) .row:nth-child(3) .tx small', native: 'me.sync.tx.small', kind: 'type' },
      { frame: '.scroll > :nth-child(2) .row:nth-child(3) .sbtn', native: 'me.sendnow', kind: 'box' },
      { frame: '.scroll > :nth-child(2) .row:nth-child(3) .sbtn span', native: 'me.sendnow.text', kind: 'text' },
      { frame: '.grp.setg', native: 'me.settings', kind: 'box', sum: 'the sum of its 6 rows' },
      { frame: '.grp.setg .row:nth-child(1)', native: 'me.notices', kind: 'box' },
      { frame: '.grp.setg .row:nth-child(1) .ic', native: 'me.notices.icon', kind: 'icon' },
      { frame: '.grp.setg .row:nth-child(1) .k', native: 'me.notices.key', kind: 'text' },
      { frame: '.grp.setg .row:nth-child(1) .switch', native: 'me.notices.switch', kind: 'box' },
      { frame: '.grp.setg .row:nth-child(2)', native: 'me.size', kind: 'box' },
      { frame: '.grp.setg .row:nth-child(2) .k', native: 'me.size.key', kind: 'text', data: 'the room the chosen size\'s name leaves' },
      { frame: '.grp.setg .row:nth-child(2) .v', native: 'me.size.value', kind: 'text', data: 'the chosen size\'s name (the frame shows Large; the test starts at Standard)' },
      { frame: '.grp.setg .row:nth-child(2) .chev .ic', native: 'me.size.chev', kind: 'icon' },
      { frame: '.grp.setg .row:nth-child(3)', native: 'me.language', kind: 'box' },
      { frame: '.grp.setg .row:nth-child(3) > .ic', native: 'me.language.icon', kind: 'icon' },
      { frame: '.grp.setg .row:nth-child(3) .k', native: 'me.language.key', kind: 'text' },
      { frame: '.grp.setg .row:nth-child(3) .iseg', native: 'me.lang', kind: 'box' },
      { frame: '.grp.setg .row:nth-child(3) .iseg button.on', native: 'me.lang.en', kind: 'box' },
      { frame: '.grp.setg .row:nth-child(4)', native: 'me.call', kind: 'box' },
      { frame: '.grp.setg .row:nth-child(4) .ic', native: 'me.call.icon', kind: 'icon' },
      { frame: '.grp.setg .row:nth-child(4) .k', native: 'me.call.key', kind: 'text', data: 'the room the branch number leaves' },
      { frame: '.grp.setg .row:nth-child(4) .v', native: 'me.call.value', kind: 'text', data: 'the branch office number' },
      { frame: '.grp.setg .row:nth-child(5)', native: 'me.server', kind: 'box' },
      { frame: '.grp.setg .row:nth-child(5) .ic', native: 'me.server.icon', kind: 'icon' },
      { frame: '.grp.setg .row:nth-child(5) .k', native: 'me.server.key', kind: 'text', data: 'the room the server address leaves' },
      { frame: '.grp.setg .row:nth-child(5) .v', native: 'me.server.value', kind: 'text', data: 'the server address the test saved' },
      { frame: '.grp.setg .row:nth-child(6)', native: 'me.version', kind: 'box' },
      { frame: '.grp.setg .row:nth-child(6) .ic', native: 'me.version.icon', kind: 'icon' },
      { frame: '.grp.setg .row:nth-child(6) .k', native: 'me.version.key', kind: 'text', data: 'the room the version leaves' },
      { frame: '.grp.setg .row:nth-child(6) .v', native: 'me.version.value', kind: 'text', data: 'the installed version' },
      { frame: '.scroll > .hint.c', native: 'me.hint', kind: 'text' },
      { frame: '.scroll > a.sbtn.wide', native: 'me.signout', kind: 'box' },
      { frame: '.scroll > a.sbtn.wide .ic', native: 'me.signout.icon', kind: 'icon' },
      { frame: '.scroll > a.sbtn.wide span', native: 'me.signout.text', kind: 'text' },
    ],
  },
  tabbar('Me', 'me', ME, 'me'),
];

/**
 * SCR-TEC-08 Route with its turn-by-turn half (P6-NATIVE-STEPS): dumped by StepsUITests on a stack whose API-104 answers steps (the phase 5
 * tag's does not, so MapMeUITests' Directions no longer reaches the Route frame's state there); the steps set compares it (native-compare.ts).
 */
export const DIRECTIONS_CASE: NativeCase = {
  name: 'SCR-TEC-08 Directions: Route (the main frame)', state: 'directions', root: cap(DIR),
  pairs: DIRECTIONS_PAIRS,
};
