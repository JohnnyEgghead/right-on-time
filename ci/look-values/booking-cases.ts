// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P5-BOOKING (BUILD_PLAN P5-BOOKING Acceptance, look clause): SCR-CUS-01 to SCR-CUS-03 against DK-118 to DK-121
// (mockups/pages/customer-booking.html, customer-booking-phone.html, customer-booking-window-taken.html, customer-booking-done.html), at 1440 x 900
// and, for the phone frame, 520 x 980, in each state the frames show (light theme). A frame tile is picked by its frozen caption (UI-DESIGN-KIT 4.1);
// a frame's main picture has no tile, so its selectors start at `body >`. App states are the harness build's /shell-preview/booking*/<state>
// routes (apps/web/src/booking/BookingPreview.tsx and DonePreview.tsx): each the page itself on the frame's own sample (Harold Jenkins, a
// furnace tune-up on Tue, Sep 15, today Thu, Sep 10). The demo strip, the booking header and the footer are the shell cases' (shell-cases.ts).
import type { SelectorPair } from './compare.ts';
import type { WidthFrom } from './shell-cases.ts';

export const BOOKING_FRAMES = {
  desktop: 'mockups/pages/customer-booking.html',
  phone: 'mockups/pages/customer-booking-phone.html',
  taken: 'mockups/pages/customer-booking-window-taken.html',
  done: 'mockups/pages/customer-booking-done.html',
} as const;
export type BookingFrameKey = keyof typeof BOOKING_FRAMES;

export interface BookingCase {
  name: string;
  frame: BookingFrameKey;
  /** The frame captions the case compares. */
  captions: string[];
  app: string;
  pairs: SelectorPair[];
  widthFrom?: WidthFrom[];
  /** An app selector to wait for (a read that answers after mount). */
  ready: string;
  viewport?: { width: number; height: number };
}

const cap = (caption: string) => `[data-bw-cap="${caption}"]`;
const S1 = 'SCR-CUS-01 Book a visit: ';
const S2 = 'SCR-CUS-02 Window just taken: ';
const S3 = "SCR-CUS-03 You're booked: ";
export const SCREENS = { s1: '.r1-screen[data-screen="SCR-CUS-01"]', s2: '.r1-screen[data-screen="SCR-CUS-02"]', s3: '.r1-screen[data-screen="SCR-CUS-03"]' } as const;
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`.trim(), frame: `${frameRoot} ${s}`.trim() }));
const pairs = (appRoot: string, frameRoot: string, list: [string, string?][]): SelectorPair[] => list.map(([a, f]) => ({ app: `${appRoot} ${a}`.trim(), frame: `${frameRoot} ${f ?? a}`.trim() }));
const tile = (caption: string) => `${cap(caption)} .b`;

// --- SCR-CUS-01, the main picture (Step 1 to 6) ---------------------------------------------------------------------------------------------
const HERO = ['.hero', '.hero h1', '.hero p', '.hero .steps', '.hero .step', '.hero .step .n', '.hero .step.ok .n', '.hero .step.cur .n', '.hero .steps .line'];
const LEFT = [
  '.main', '.main .left', '.main .right', '.main .left .box', '.main .left .box h2', '.main .left .box h2 .n', '.main .left .box h2 .chg',
  '.main .svc', '.main .tile', '.main .tile .ico', '.main .tile b', '.main .tile > span:last-child', '.main .tile.sel', '.main .tile .tick',
  '.main .addr2', '.main .f', '.main .f label', '.main .f .in', '.main .f .in .ic', '.main .hint',
  '.main .pick', '.main .cal .mh', '.main .cal .mh b', '.main .cal .mh .arr', '.main .cal .mh .arr > *', '.main .grid7', '.main .grid7 .wd', '.main .d', '.main .d.open',
  '.main .d.sel', '.main .d.few', '.main .d.off', '.main .d.closed', '.main .d.today', '.main .callg', '.main .callg span', '.main .callg i',
];
const WINDOWS = [
  '.main .pick .box + .box', '.main .pick .box + .box h2', '.main .pick .box + .box h2 small', '.main .wins', '.main .win', '.main .win .radio', '.main .win .r', '.main .win.sel',
  '.main .win.sel .radio', '.main .win.sel .r', '.main .win.full', '.main .win.full .radio', '.main .win.full .r', '.main .win.few .r', '.main .winnote',
];
const RIGHT = [
  '.main .right .box', '.main .right .box h2', '.main .right .box h2 small', '.main .demo', '.main .demo .ic', '.main .right .f', '.main .right .f label', '.main .right .f .in',
  '.main .right .hint', '.main .chk', '.main .chk .bx', '.main .chk .bx .ic', '.main .chk .sel', '.main .chk .sel .ic', '.main .sum', '.main .sum .li', '.main .sum .li span',
  '.main .sum .li b', '.main .cbtns', '.main .cbtns .back', '.main .cbtns .back .ic', '.main .cbtns .confirm', '.main .cbtns .confirm .ic', '.main .fine',
];

const BODY = 'body >';
const main = (name: string, inner: string[]): BookingCase => ({
  name: `${S1}Step 1 to 6 (${name})`, frame: 'desktop', captions: [`${S1}Step 1 to 6`], app: '/shell-preview/booking/steps', pairs: within(SCREENS.s1, BODY, inner), ready: `${SCREENS.s1} .main .box`,
});

const t1 = (name: string, state: string, caption: string, list: [string, string?][], extra: Partial<BookingCase> = {}): BookingCase => ({
  name: `${S1}${name}`, frame: 'desktop', captions: [`${S1}${caption}`], app: `/shell-preview/booking/${state}`, pairs: pairs(`${SCREENS.s1} .main .left`, tile(`${S1}${caption}`), list),
  ready: `${SCREENS.s1} .main .box`, ...extra,
});
const LEFT_LAST = `${SCREENS.s1} .main .left > .box:last-child`;
const RIGHT_LAST = `${SCREENS.s1} .main .right > .box:last-child`;
const CONT = [['.contb'], ['.contb .go'], ['.contb .go .ic'], ['.contb .k'], ['.contb .k .ic']] as [string, string?][];

// --- SCR-CUS-02, the main picture (Options) --------------------------------------------------------------------------------------------------
const TAKEN_MAIN = [
  '.hero', '.hero h1', '.hero p', '.hero .steps', '.hero .step', '.hero .step .n', '.hero .steps .line', '.main .left .box h2', '.main .svc', '.main .tile',
  '.main .tile.sel', '.main .cal .mh', '.main .grid7', '.main .d', '.main .d.sel', '.main .win', '.main .win.full', '.main .win.few', '.main .win.few .r',
  '.main .alert', '.main .alert .t', '.main .alert h2', '.main .alert p', '.main .alert .t .ic', '.main .winnote', '.main .right .box', '.main .right .box h2', '.main .alts', '.main .alt', '.main .alt .radio', '.main .alt b', '.main .alt small', '.main .alt .r',
  '.main .alt .r.few', '.main .go', '.main .why', '.main .other', '.main .other .ic', '.main .sum', '.main .sum .li', '.main .sum .li b', '.main .sum .li b.none', '.main .right .box h2 small',
];
// --- SCR-CUS-03, the main picture (Success) ----------------------------------------------------------------------------------------------------
const DONE_MAIN = [
  '.hero', '.hero .hl', '.hero .okmark', '.hero .okmark .ic', '.hero h1', '.hero p', '.hero .steps', '.hero .step', '.hero .step .n', '.hero .steps .line', '.main', '.main .col', '.main .box', '.main .box h2',
  '.main .box h2 small', '.main .visit', '.main .visit .big', '.main .visit .big .ico', '.main .visit .big .ico .ic', '.main .visit .big b', '.main .visit .big .win', '.main .visit .big .win strong',
  '.main .visit .big .num', '.main .sum', '.main .sum .li', '.main .sum .li span', '.main .sum .li b', '.main .next', '.main .next li', '.main .next .dot', '.main .next .dot .ic', '.main .next li.done .dot', '.main .next .when',
  '.main .next li.done .when', '.main .next b', '.main .next p', '.main .quiet', '.main .quiet .ic', '.main .sent', '.main .sent b', '.main .sent .ic', '.main .sentchip', '.main .sentchip .ic',
  '.main .phonebox', '.main .phonebox .stamp', '.main .phonebox .stamp b', '.main .phonebox .bub', '.main .seetx', '.main .seetx .ic', '.main .change h2', '.main .ways', '.main .way', '.main .way .ic',
  '.main .way b', '.main .way span', '.main .noacct', '.main .noacct .ic', '.main .noacct b', '.main .acts', '.main .acts .btn', '.main .acts .btn.primary',
];
const PHONE = [
  '.prog', '.prog .t', '.prog .t b', '.prog .t span', '.prog .bars', '.prog .bars i', '.prog .bars i.ok', '.prog .bars i.cur', '.prog .bl', '.prog .bl span', '.prog .bl span.cur', '.chosen .tick',
  '.chosen .tick .ic', '.chosen b', '.chosen .ch', '.days', '.day', '.day small', '.day b', '.day.sel', '.day.sel small', '.day.few', 'h2', 'h2 small', '.wins', '.win', '.win .radio', '.win .r',
  '.win.sel', '.win.sel .radio', '.win.sel .r', '.win.full', '.win.full .radio', '.win.full .r', '.win.few .r', '.note', '.foot .back', '.foot .back .ic', '.foot .go', '.foot .go .ic',
];

// The control detail "Step 3 on a phone: Pick a day" of DK-119 (F-945 item 3, F-1272): the month calendar with 44 px day cells. It carries no
// frame caption, so the frame side finds its tile by the calendar grid only that tile draws.
const DAY_STEP = [
  '.prog', '.prog .t b', '.prog .t span', '.prog .bars i.ok', '.prog .bars i.cur', '.prog .bl span.cur', '.chosen', '.chosen .tick', '.chosen b', '.chosen .ch', 'h2',
  '.mh', '.mh b', '.mh .arr', '.grid7', '.grid7 .wd', '.grid7 .d', '.grid7 .d.open', '.grid7 .d.few', '.grid7 .d.sel', '.grid7 .d.closed', '.callg', '.callg span', '.callg i',
  '.foot .back', '.foot .go',
];

export const BOOKING_CASES: BookingCase[] = [
  main('hero and steps', HERO),
  main('service, address, day', LEFT),
  main('arrival windows', WINDOWS),
  main('details and Confirm', RIGHT),
  t1('Loading', 'loading', 'Loading', [['.box h2', '.box h2'], ['.box h2 .n', '.box h2 .n'], ['.svc', '.svc'], ['.tile', '.tile'], ['.tile .r1-skel', '.tile .r1-skel']], {
    widthFrom: [{ app: `${SCREENS.s1} .main .left > .box`, frame: `${tile(`${S1}Loading`)} .box` }],
  }),
  {
    name: `${S1}No street match`, frame: 'desktop', captions: [`${S1}No street match`], app: '/shell-preview/booking/no-match',
    pairs: pairs(LEFT_LAST, `${tile(`${S1}No street match`)} .box`, [
      ['h2'], ['h2 .n'],
      ['.f[data-ctl="CTL-CUS-01-04"] .in .ic', '.f .in .ic'], ['.msg'], ['.msg .ic'], ['.msg span'],
    ]).concat(pairs(`${SCREENS.s1} .main .left`, tile(`${S1}No street match`), [...CONT, ['.hint.bw-right', '.hint']])),
    widthFrom: [{ app: LEFT_LAST, frame: `${tile(`${S1}No street match`)} .box` }], ready: `${SCREENS.s1} .msg`,
  },
  {
    name: `${S1}No days`, frame: 'desktop', captions: [`${S1}No days`], app: '/shell-preview/booking/no-days',
    pairs: pairs(LEFT_LAST, `${tile(`${S1}No days`)} .box`, [['h2'], ['h2 .n'], ['.msg'], ['.msg .ic'], ['.msg span']]).concat(pairs(`${SCREENS.s1} .main .left`, tile(`${S1}No days`), [...CONT, ['.hint.bw-right', '.hint']])),
    widthFrom: [{ app: LEFT_LAST, frame: `${tile(`${S1}No days`)} .box` }], ready: `${SCREENS.s1} .msg`,
  },
  {
    name: `${S1}Day full`, frame: 'desktop', captions: [`${S1}Day full`], app: '/shell-preview/booking/day-full',
    pairs: pairs(`${SCREENS.s1} .main .left .pick > .box:last-child`, `${tile(`${S1}Day full`)} .box`, [['h2'], ['h2 .n'], ['.wins'], ['.win.full'], ['.win.full .radio'], ['.win.full .r'], ['.msg'], ['.msg .ic']]).concat(pairs(`${SCREENS.s1} .main .left`, tile(`${S1}Day full`), CONT)),
    widthFrom: [{ app: `${SCREENS.s1} .main .left .pick > .box:last-child`, frame: `${tile(`${S1}Day full`)} .box` }], ready: `${SCREENS.s1} .msg`,
  },
  {
    name: `${S1}No mobile`, frame: 'desktop', captions: [`${S1}No mobile`], app: '/shell-preview/booking/no-mobile',
    pairs: pairs(RIGHT_LAST, `${tile(`${S1}No mobile`)} .box`, [
      ['h2'], ['h2 small'], ['.demo'], ['.demo .ic'], ['.f'], ['.f label'], ['.f .in'], ['.f .hint', '.f .hint'], ['.chk'], ['.chk .bx.off'], ['.chk .sel.dis'], ['.chk ~ .hint', '.chk + .hint'],
    ]).concat(pairs(`${SCREENS.s1} .main .right`, tile(`${S1}No mobile`), CONT.slice(1))),
    widthFrom: [{ app: RIGHT_LAST, frame: `${tile(`${S1}No mobile`)} .box` }], ready: `${SCREENS.s1} .chk`,
  },
  {
    name: `${S1}Booking`, frame: 'desktop', captions: [`${S1}Booking`], app: '/shell-preview/booking/booking',
    pairs: pairs(RIGHT_LAST, `${tile(`${S1}Booking`)} .box`, [['h2 .n'], ['.cbtns'], ['.cbtns .back'], ['.cbtns .back .ic'], ['.cbtns .confirm.busy', '.cbtns .confirm.busy'], ['.confirm .r1-spin']]),
    widthFrom: [{ app: `${RIGHT_LAST} .cbtns`, frame: `${tile(`${S1}Booking`)} .box .cbtns` }], ready: `${SCREENS.s1} .confirm.busy`,
  },
  {
    name: `${S1}Restored`, frame: 'desktop', captions: [`${S1}Restored`], app: '/shell-preview/booking/restored',
    pairs: pairs(RIGHT_LAST.replace(':last-child', ':first-child'), `${tile(`${S1}Restored`)} .box`.replace(' .box', ' section.box'), [
      ['h2'], ['h2 .n'], ['.demo'], ['.demo .ic'], ['.f label'], ['.f .in'], ['.chk'], ['.chk .bx'], ['.chk .bx .ic'], ['.chk .sel .ic'],
    ]),
    widthFrom: [{ app: RIGHT_LAST.replace(':last-child', ':first-child'), frame: `${tile(`${S1}Restored`)} section.box` }], ready: `${SCREENS.s1} .chk`,
  },
  {
    name: `${S1}Step 1 to 6, phone`, frame: 'phone', captions: [`${S1}Step 1 to 6, phone`], app: '/shell-preview/booking/phone', pairs: within(`${SCREENS.s1} .bw-ph`, '.r1p-stage .pg', PHONE),
    widthFrom: [{ app: `${SCREENS.s1} .bw-ph .pg`, frame: '.r1p-stage .pg' }], ready: `${SCREENS.s1} .bw-ph .win`, viewport: { width: 520, height: 980 },
  },
  {
    name: `${S1}Control details: Step 3 on a phone, Pick a day`, frame: 'phone', captions: [], app: '/shell-preview/booking/phone-day',
    pairs: within(`${SCREENS.s1} .bw-ph`, '.r1-st:has(.grid7) .pg', DAY_STEP),
    widthFrom: [{ app: `${SCREENS.s1} .bw-ph .pg`, frame: '.r1-st:has(.grid7) .pg' }], ready: `${SCREENS.s1} .bw-ph .grid7`, viewport: { width: 520, height: 980 },
  },
  // SCR-CUS-02
  { name: `${S2}Options`, frame: 'taken', captions: [`${S2}Options`], app: '/shell-preview/booking-taken/options', pairs: within(SCREENS.s2, BODY, TAKEN_MAIN), ready: `${SCREENS.s2} .alert` },
  {
    name: `${S2}None nearby`, frame: 'taken', captions: [`${S2}None nearby`], app: '/shell-preview/booking-taken/none-nearby',
    pairs: pairs(`${SCREENS.s2} .main .right`, tile(`${S2}None nearby`), [['.alert .t .ic'], ['section.box.bw-mt-12', 'section.box'], ['.other'], ['.other .ic']]),
    widthFrom: [{ app: `${SCREENS.s2} .main .right section.box.bw-mt-12`, frame: `${tile(`${S2}None nearby`)} section.box` }], ready: `${SCREENS.s2} .alert`,
  },
  {
    name: `${S2}Booking`, frame: 'taken', captions: [`${S2}Booking`], app: '/shell-preview/booking-taken/booking',
    pairs: pairs(`${SCREENS.s2} .main .right`, tile(`${S2}Booking`), [['.alts'], ['.alt'], ['.alt.sel'], ['.alt .radio'], ['.alt b'], ['.alt small'], ['.go.busy', '.go.busy'], ['.go.busy .r1-spin', '.go.busy .r1-spin']]),
    widthFrom: [{ app: `${SCREENS.s2} .main .right .alts`, frame: `${tile(`${S2}Booking`)} .alts` }, { app: `${SCREENS.s2} .main .right .go.busy`, frame: `${tile(`${S2}Booking`)} .go.busy` }], ready: `${SCREENS.s2} .go.busy`,
  },
  // SCR-CUS-03
  { name: `${S3}Success`, frame: 'done', captions: [`${S3}Success`], app: '/shell-preview/booking-done/success', pairs: within(SCREENS.s3, BODY, DONE_MAIN), ready: `${SCREENS.s3} .visit` },
  {
    name: `${S3}Loading`, frame: 'done', captions: [`${S3}Loading`], app: '/shell-preview/booking-done/loading',
    pairs: pairs(`${SCREENS.s3} .main`, tile(`${S3}Loading`), [['.box'], ['.box .r1-skel']]),
    widthFrom: [{ app: `${SCREENS.s3} .main .box`, frame: `${tile(`${S3}Loading`)} .box` }], ready: `${SCREENS.s3} .r1-skel`,
  },
  {
    name: `${S3}No texts`, frame: 'done', captions: [`${S3}No texts`], app: '/shell-preview/booking-done/no-texts',
    pairs: pairs(`${SCREENS.s3} .main`, tile(`${S3}No texts`), [['.callnote'], ['.callnote .ic'], ['.callnote span'], ['.noacct'], ['.noacct .ic'], ['.noacct b']]),
    widthFrom: [{ app: `${SCREENS.s3} .main .callnote`, frame: `${tile(`${S3}No texts`)} .callnote` }, { app: `${SCREENS.s3} .main .noacct`, frame: `${tile(`${S3}No texts`)} .noacct` }], ready: `${SCREENS.s3} .callnote`,
  },
  {
    name: `${S3}Not found`, frame: 'done', captions: [`${S3}Not found`], app: '/shell-preview/booking-done/not-found',
    pairs: pairs(`${SCREENS.s3} .main`, tile(`${S3}Not found`), [['.box.nf', '.box.nf'], ['.nf .r1-note'], ['.nf h2'], ['.nf p'], ['.nf .btn.primary']]),
    widthFrom: [{ app: `${SCREENS.s3} .main .box.nf`, frame: `${tile(`${S3}Not found`)} .box.nf` }], ready: `${SCREENS.s3} .nf`,
  },
];

/**
 * Captioned states with no look case of their own, each with the reason. The coverage test checks that every caption of each screen on the frames
 * is compared by a case or named here, and that each named one is a caption.
 */
export const NOT_COMPARED: Record<string, string> = {
  [`${S1}Booked`]: 'the tile is a note ("The You\'re booked page opens"): it draws no element of this page; SCR-CUS-03 has its own cases',
  [`${S1}Taken`]: 'the tile is a note ("The Window just taken page opens in place"): it draws no element of this page; SCR-CUS-02 has its own cases',
  [`${S2}Booked`]: 'the tile is a note ("The You\'re booked page opens"): it draws no element of this page; SCR-CUS-03 has its own cases',
};

/** Parts of a compared state that its case leaves out, each with the reason (read with the cases; no gate reads this record). */
export const LEFT_OUT: Record<string, string> = {
  'Step 1 to 6 and Restored: the step line (p.r1-note, CTL-CUS-01-01)': 'the tiles draw the progress as a note line above the step; the page draws it as the hero\'s step bar (compared in Step 1 to 6) on a wide screen',
  'No street match, No days, Day full, No mobile: the step\'s Back button': 'the frame draws Back in the row and the page draws it too; only the first step has none, so it is compared in every state that shows it',
  'Booking (SCR-CUS-02): the room word of the first option (.alt .r)': 'the tile draws "1 left" in the plain grey the Options frame draws "Open" in, while the Options frame draws the same "1 left" orange (.r.few); the page follows the Options frame in both states, and the Options case compares it',
  'Booking: the Confirm summary above the buttons (.sum)': 'the tile draws only the buttons; the page keeps its summary in the box in every state (CTL-CUS-01-12)',
  'Restored: the words': 'the tile is Spanish; the preview is the page in English (the language is a cookie the harness does not set), so only the boxes are compared; the Spanish words are the Spanish walker\'s',
  'Street results, Step 2 open, Booking closed (control details, no caption)': 'the 3 tiles under "Control details inside the frames above" carry no frame caption; the street results list and the closed-day message are drawn by the same components the cases compare, and ci/booking-stack exercises them live',
};

const OWN = /^SCR-CUS-0[123] /;

/** Captions of the screens that the frames show and no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncoveredBooking(captionsByFrame: Record<BookingFrameKey, readonly string[]>): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(BOOKING_FRAMES) as BookingFrameKey[]) {
    const compared = new Set(BOOKING_CASES.filter((c) => c.frame === key).flatMap((c) => c.captions));
    for (const c of captionsByFrame[key]) if (OWN.test(c) && !compared.has(c) && !NOT_COMPARED[c]) problems.push(`no case compares ${c}`);
  }
  const all = new Set(Object.values(captionsByFrame).flat());
  for (const c of Object.keys(NOT_COMPARED)) if (!all.has(c)) problems.push(`NOT_COMPARED names a caption the frames do not show: ${c}`);
  return problems;
}
