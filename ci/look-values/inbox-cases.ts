// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P5-INBOX (BUILD_PLAN P5-INBOX Acceptance, look clause): SCR-INB-01 Text inbox against DK-126 to DK-128
// (mockups/pages/customer-texts.html, customer-texts-spanish.html, customer-texts-late-reschedule.html) and SCR-CUS-06 Change your
// visit time against DK-125 (mockups/pages/customer-reschedule.html), in each state a frame shows, light theme. A frame state is picked by
// its frozen caption (tagFrames, shell-cases.ts); the control details a frame draws without a caption are picked by their place in the
// states board. App states are the harness build's /shell-preview/inbox/<name> and /shell-preview/reschedule/<name> routes, each fixed to
// its frame's data. The frames draw a phone (status bar, island, home bar, URL bar): the app has the screen only, so no case compares the
// phone's own parts, a screen's height or `.mhead`'s box (it holds the status bar); the cases hold every part the app draws.
import type { SelectorPair } from './compare.ts';
import type { WidthFrom } from './shell-cases.ts';

export interface InboxCase {
  name: string;
  screen: 'SCR-INB-01' | 'SCR-CUS-06';
  captions: string[];
  app: string;
  frame: string;
  pairs: SelectorPair[];
  widthFrom?: WidthFrom[];
}

const TEXTS = 'mockups/pages/customer-texts.html';
const SPANISH = 'mockups/pages/customer-texts-spanish.html';
const LATE = 'mockups/pages/customer-texts-late-reschedule.html';
const RESCHED = 'mockups/pages/customer-reschedule.html';
export const INBOX_FRAMES = [TEXTS, SPANISH, LATE, RESCHED];

const cap = (caption: string) => `[data-bw-cap="${caption}"]`;
const root = (screen: string) => `.r1-screen[data-screen="${screen}"]`;
/** The same selectors inside the app's screen root and the frame's tagged screen (a tile's `.screen` is a mini phone, the stage's a full one). */
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`.trim(), frame: `${frameRoot} ${s}`.trim() }));
const inb = (caption: string, inner: string[], extra: { app: string; frame: string }[] = []): SelectorPair[] => [
  ...within(`${root('SCR-INB-01')} .screen`, `${cap(caption)} .screen`, inner),
  ...extra.map((p) => ({ app: `${root('SCR-INB-01')} .screen ${p.app}`, frame: `${cap(caption)} .screen ${p.frame}` })),
];
/** A control detail without a caption: the n-th tile of the states board's last grid. */
const det = (n: number) => `.r1-states > div.r1-grid:last-of-type .r1-st:nth-child(${n})`;

const I1 = 'SCR-INB-01 Text inbox: ';
const C6 = 'SCR-CUS-06 Change your visit time: ';

/** The top of every inbox state: the demo bar, the brand row with the office phone and the language, whose phone. */
const TOP = [
  '.mhead .ibx', '.mhead .ibx .r1-demobar', '.ibrow', '.ibrow .brand', '.ibrow .brand svg.mark', '.ibrow .brand .word', '.ibrow .tel14', '.ibrow .lang', '.ibrow .lang b', '.whose', '.whose b',
];
/** The contact row of the full phone: the frames' tiles leave it out. */
/** The state tiles of Loading, Not valid and Error draw whose phone it is and the office phone, which the page cannot know before or without its read (the token's customer is read by API-120): those states hold the demo bar and the brand and language only. */
const TOP_UNREAD = ['.mhead .ibx .r1-demobar', '.ibrow', '.ibrow .brand', '.ibrow .brand svg.mark', '.ibrow .brand .word', '.ibrow .lang', '.ibrow .lang b'];
const CONTACT = ['.mhead .r .who', '.mhead .avatar', '.mhead .avatar svg.mark', '.mhead .nm', '.mhead .nm .ic', '.mhead .sub'];
const REPLIES = ['.quiet', '.rbtns', '.rbtns span', '.inputbar .field', '.inputbar .send'];
/** The full phone's reply bar box: a tile's own bar carries an inline bottom padding of 12 px, so only the full phone holds the box. */
const REPLY_BAR = ['.inputbar'];
// The sample link is the 8-character token of a real link (SD-17), as the frames now draw it (DK-126 to DK-128, F-1129), so the bubble that holds it is paired like the others.
const BUBBLES = ['.stamp', '.stamp b', '.bub', '.bub a', '.meta'];
const FOOT = ['.r1p-foot', '.r1p-foot a', '.r1p-foot .demo'];

/** The preview card: the app's picture is an image where the frame draws an SVG (both are the card's 70 px picture). */
const PREVIEW = [
  { app: '.preview', frame: '.preview' }, { app: '.preview .pt', frame: '.preview .pt' }, { app: '.preview .pt b', frame: '.preview .pt b' },
  { app: '.preview .pt span', frame: '.preview .pt span' }, { app: '.preview .bw-pv', frame: '.preview svg' },
];

// The Spanish frame (DK-127) and the late text and R reply frame (DK-128) draw the thread and the reply field with other padding, line height and field color than the Success frame (DK-126) (their own page rules
// differ from DK-126's), so the bubble, stamp, thread and field of the app hold DK-126's values and these 2 frames are compared on the rest.
const NOT_BUBBLE_TOP = [...TOP, ...CONTACT, '.quiet', '.rbtns', '.rbtns span', '.inputbar .send', ...FOOT];

const m = (c: string, a: string, inner: string[]): SelectorPair[] => within(`${root('SCR-CUS-06')} ${a}`, `${cap(c)} ${a}`, inner);
const RTOP = ['.pg .r1-demobar', '.brandrow', '.brandrow .brand', '.brandrow .brand svg.mark', '.brandrow .brand .word', '.brandrow .tel14', '.brandrow .seg', '.brandrow .seg span', '.brandrow .seg span.on', 'h1'];
const CUR = ['.cur', '.cur .ico', '.cur .ico .ic', '.cur small', '.cur b', '.cur span.s'];
const KEEP = ['.foot .keep', '.foot .priv', '.foot .priv .ic'];
const MSG = ['.msgc', '.msgc .ic', '.msgc span'];

const CASES: InboxCase[] = [
  {
    name: 'SCR-INB-01 Success (the contact row, the thread with its stamps, bubbles, link and preview card, the reply controls)',
    screen: 'SCR-INB-01', captions: [`${I1}Success`], app: '/shell-preview/inbox/success', frame: TEXTS,
    pairs: inb(`${I1}Success`, ['', ...TOP, ...CONTACT, ...BUBBLES, ...REPLIES, ...REPLY_BAR, ...FOOT], PREVIEW),
  },
  { name: 'SCR-INB-01 Loading', screen: 'SCR-INB-01', captions: [`${I1}Loading`], app: '/shell-preview/inbox/loading', frame: TEXTS, pairs: inb(`${I1}Loading`, TOP_UNREAD) },
  { name: 'SCR-INB-01 Empty', screen: 'SCR-INB-01', captions: [`${I1}Empty`], app: '/shell-preview/inbox/empty', frame: TEXTS, pairs: inb(`${I1}Empty`, [...TOP, '.imsg', '.imsg .ic', ...REPLIES]) },
  { name: 'SCR-INB-01 No mobile', screen: 'SCR-INB-01', captions: [`${I1}No mobile`], app: '/shell-preview/inbox/nomobile', frame: TEXTS, pairs: inb(`${I1}No mobile`, [...TOP, '.imsg', '.imsg .ic']) },
  { name: 'SCR-INB-01 Texts off', screen: 'SCR-INB-01', captions: [`${I1}Texts off`], app: '/shell-preview/inbox/textsoff', frame: TEXTS, pairs: inb(`${I1}Texts off`, [...TOP, '.stamp', '.stamp b', '.bub', '.imsg', '.imsg .ic']) },
  { name: 'SCR-INB-01 Sending', screen: 'SCR-INB-01', captions: [`${I1}Sending`], app: '/shell-preview/inbox/sending', frame: TEXTS, pairs: inb(`${I1}Sending`, [...TOP, '.stamp', '.bub', ...REPLIES, '.rbtns span.busy', '.rbtns span.busy .r1-spin']) },
  { name: 'SCR-INB-01 Not valid', screen: 'SCR-INB-01', captions: [`${I1}Not valid`], app: '/shell-preview/inbox/notvalid', frame: TEXTS, pairs: inb(`${I1}Not valid`, [...TOP_UNREAD, '.imsg', '.imsg .ic']) },
  { name: 'SCR-INB-01 Error (CMP-12 above off reply controls)', screen: 'SCR-INB-01', captions: [`${I1}Error`], app: '/shell-preview/inbox/error', frame: TEXTS, pairs: inb(`${I1}Error`, [...TOP_UNREAD, '.r1-errpanel', '.r1-errpanel b', '.r1-errpanel .btn.sm', ...REPLIES]) },
  { name: 'SCR-INB-01 Preview after arrival (control detail)', screen: 'SCR-INB-01', captions: [], app: '/shell-preview/inbox/ended', frame: TEXTS, pairs: [{ app: `${root('SCR-INB-01')} .preview.ended`, frame: `${det(1)} .preview.ended` }, { app: `${root('SCR-INB-01')} .preview.ended b`, frame: `${det(1)} .preview.ended b` }] },
  // the Not sent line itself is the frame's right-aligned tile block (width of the tile), the app's is a flex item of the thread: its color is the sheet's var(--st-late-ink), its box is not compared
  { name: 'SCR-INB-01 Not sent (control detail)', screen: 'SCR-INB-01', captions: [], app: '/shell-preview/inbox/notsent', frame: TEXTS, pairs: [{ app: `${root('SCR-INB-01')} .thread .bub.out`, frame: `${det(2)} .bub.out` }] },
  { name: 'SCR-INB-01 New text (control detail)', screen: 'SCR-INB-01', captions: [], app: '/shell-preview/inbox/newtext', frame: TEXTS, pairs: [{ app: `${root('SCR-INB-01')} .r1p-notice`, frame: `${det(3)} .r1p-notice` }, { app: `${root('SCR-INB-01')} .r1p-notice .ic`, frame: `${det(3)} .r1p-notice .ic` }, { app: `${root('SCR-INB-01')} .r1p-notice span`, frame: `${det(3)} .r1p-notice span` }], widthFrom: [{ app: `${root('SCR-INB-01')} .r1p-notice`, frame: `${det(3)} .r1p-notice` }] },
  {
    name: 'SCR-INB-01 Success, Spanish (DK-127: the chrome in Spanish; thread, bubble, stamp and field values are DK-126\'s)',
    screen: 'SCR-INB-01', captions: [`${I1}Success, Spanish`], app: '/shell-preview/inbox/spanish', frame: SPANISH,
    pairs: inb(`${I1}Success, Spanish`, NOT_BUBBLE_TOP),
  },
  {
    name: 'SCR-INB-01 Success, late text and R reply (DK-128: a late text, the R-reply with its reschedule link)',
    screen: 'SCR-INB-01', captions: [`${I1}Success, late text and R reply`], app: '/shell-preview/inbox/late', frame: LATE,
    pairs: inb(`${I1}Success, late text and R reply`, NOT_BUBBLE_TOP),
  },
  {
    name: 'SCR-CUS-06 Choosing (current visit, days, busy day note, windows, confirm, keep, privacy)',
    screen: 'SCR-CUS-06', captions: [`${C6}Choosing`], app: '/shell-preview/reschedule/choosing', frame: RESCHED,
    pairs: m(`${C6}Choosing`, '.screen', [
      ...RTOP, ...CUR, '.lab', '.lab small', '.days', '.day', '.day small', '.day b', '.day em', '.day.now', '.day.sel', '.busyb', '.busyb .ic', '.busyb b', '.busyb span',
      '.wins', '.win', '.win .radio', '.win .tx', '.win .r', '.win.full', '.win.sel', '.win.few', '.pg .r1p-foot', '.foot', '.foot .go', '.foot .go .ic', ...KEEP,
    ]),
  },
  { name: 'SCR-CUS-06 Loading', screen: 'SCR-CUS-06', captions: [`${C6}Loading`], app: '/shell-preview/reschedule/loading', frame: RESCHED, pairs: m(`${C6}Loading`, '.screen', [...RTOP, '.days', '.day']) },
  { name: 'SCR-CUS-06 No other time', screen: 'SCR-CUS-06', captions: [`${C6}No other time`], app: '/shell-preview/reschedule/noother', frame: RESCHED, pairs: m(`${C6}No other time`, '.screen', [...RTOP, ...CUR, ...MSG, ...KEEP]) },
  { name: 'SCR-CUS-06 Saving', screen: 'SCR-CUS-06', captions: [`${C6}Saving`], app: '/shell-preview/reschedule/saving', frame: RESCHED, pairs: m(`${C6}Saving`, '.screen', [...RTOP, ...CUR, '.foot .go.busy', '.foot .go.busy .r1-spin', ...KEEP]) },
  { name: 'SCR-CUS-06 Changed', screen: 'SCR-CUS-06', captions: [`${C6}Changed`], app: '/shell-preview/reschedule/changed', frame: RESCHED, pairs: m(`${C6}Changed`, '.screen', [...RTOP, ...MSG, '.msgc.ok', '.foot .priv', '.foot .priv .ic']) },
  { name: 'SCR-CUS-06 Kept', screen: 'SCR-CUS-06', captions: [`${C6}Kept`], app: '/shell-preview/reschedule/kept', frame: RESCHED, pairs: m(`${C6}Kept`, '.screen', [...RTOP, ...MSG, '.msgc.ok', '.foot .priv']) },
  { name: 'SCR-CUS-06 Ended', screen: 'SCR-CUS-06', captions: [`${C6}Ended`], app: '/shell-preview/reschedule/ended', frame: RESCHED, pairs: m(`${C6}Ended`, '.screen', [...RTOP, ...MSG, '.msgc.warn']) },
  { name: 'SCR-CUS-06 Not valid', screen: 'SCR-CUS-06', captions: [`${C6}Not valid`], app: '/shell-preview/reschedule/notvalid', frame: RESCHED, pairs: m(`${C6}Not valid`, '.screen', [...RTOP, ...MSG, '.msgc.warn']) },
  {
    name: 'SCR-CUS-06 Window just filled (control detail)', screen: 'SCR-CUS-06', captions: [], app: '/shell-preview/reschedule/filled', frame: RESCHED,
    // The app draws the whole choosing screen with the filled window inside its row of 4: the pair is that window (the 4th, whose row-mate keeps its row at the frame's single line, F-1162) and its word; the tile's box
    // widths are the tile's (a lone window in a 390 px tile), so the message box takes the tile's width.
    pairs: [
      { app: `${root('SCR-CUS-06')} .wins .win:nth-child(4)`, frame: `${det(1)} .win.full` },
      { app: `${root('SCR-CUS-06')} .wins .win:nth-child(4) .r`, frame: `${det(1)} .win.full .r` }, { app: `${root('SCR-CUS-06')} .msgc.warn`, frame: `${det(1)} .msgc.warn` },
    ],
    widthFrom: [{ app: `${root('SCR-CUS-06')} .msgc.warn`, frame: `${det(1)} .msgc.warn` }, { app: `${root('SCR-CUS-06')} .wins .win:nth-child(4)`, frame: `${det(1)} .win.full` }],
  },
];

/** The state tiles are narrower than the page's own phone (a tile's mini screen has a 1 px border): a tile's case gives the app screen the width of the tile's content (the screen's first part, inside the tile's 1 px border). */
const FULL_PHONES = new Set([`${I1}Success`, `${I1}Success, Spanish`, `${I1}Success, late text and R reply`, `${C6}Choosing`]);
export const INBOX_CASES: InboxCase[] = CASES.map((c) =>
  c.captions.length > 0 && !FULL_PHONES.has(c.captions[0]!) ? { ...c, widthFrom: [{ app: `${root(c.screen)} .screen`, frame: `${cap(c.captions[0]!)} .screen > :first-child` }] } : c,
);

/** The frames' captions the cases cover, and the caption prefix each frame's screen carries. */
export function uncovered(captions: Record<string, string[]>): string[] {
  const compared = new Set(INBOX_CASES.flatMap((c) => c.captions.map((x) => `${c.frame} | ${x}`)));
  const problems: string[] = [];
  for (const [frame, caps] of Object.entries(captions)) {
    for (const c of caps) {
      if (!/^(SCR-INB-01|SCR-CUS-06)/.test(c)) continue;
      if (!compared.has(`${frame} | ${c}`)) problems.push(`no case compares ${frame} | ${c}`);
    }
  }
  return problems;
}
