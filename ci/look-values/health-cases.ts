// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-HEALTH (BUILD_PLAN P4-HEALTH Acceptance, look clause): SCR-OFC-16 System health against mockups/pages/admin-health.html and
// SCR-OFC-28 Office alerts against the "Office alerts" tiles of mockups/pages/office-board.html, in each state a frame shows (light theme). A
// frame state is picked by its frozen caption (UI-DESIGN-KIT section 4.1), the way shell-cases.ts picks them: the setup tags the element each
// caption labels with data-bw-cap. App states are the harness build's /shell-preview/health and /shell-preview/alerts routes, each fixed to
// its frame's data.
import type { SelectorPair } from './compare.ts';
import { CHROME, cap, within } from './billing-cases.ts';
import type { WidthFrom } from './shell-cases.ts';

export interface HealthCase {
  name: string;
  /** The captions the case compares (every captioned state of the frames has a case, or a reason in NOT_COMPARED). */
  captions: string[];
  app: string;
  frame: string;
  screen: 'SCR-OFC-16' | 'SCR-OFC-28';
  pairs: SelectorPair[];
  /** App elements sized to their frame twin before values are read (a tile is a narrow body; the page is wide). */
  widthFrom?: WidthFrom[];
}

export const HEALTH_FRAME = 'mockups/pages/admin-health.html';
export const BOARD_FRAME = 'mockups/pages/office-board.html';
const H = 'SCR-OFC-16 Admin: system health: ';
const A = 'SCR-OFC-28 Office alerts: ';
const FOOT = ['.r1-foot', '.r1-foot a', '.r1-foot a code', '.r1-foot [data-ctl="CTL-CMP-04-02"]', '.r1-foot .demo'];
const rootOf = (screen: string) => `.r1-screen[data-screen="${screen}"]`;

const SIDE = ['.side', '.side h4', '.side a', '.side a.on'];
const HEAD = ['.ah', '.ah h1', '.ah p', '.ah .acts', '.ah .chk', '.ah .chip', '.ah .btn', '.ah .btn .ic'];
const CARDS = [
  '.body', '.cards', '.cards > .panel', '.hc .ph', '.hc .ph h3', '.hc .ph .ic', '.hc .ph .chip', '.hc .in', '.hc .big', '.hc .sub', '.hc .foot', '.hc .foot .ic',
  '.nights', '.nights div', '.nights div b', '.hist', '.hist div', '.hist .chip', '.warn', '.warn b', '.rq', '.rq h5', '.rq div', '.rq div .chip', '.rq small',
  '.loc div', '.loc div span', '.loc div b', '.chip.us', '.spark', '.tbt', '.simc', '.simc .cur', '.simc .cur b', '.rads2', '.rads2 span', '.rads2 i', '.rads2 .on i',
];
const ALERTS = [
  '.alerts', '.alerts .ph', '.alerts .ph h3', '.shw', '.shw b', '.shw .ic', '.al', '.al b', '.al p', '.al time', '.al .chip', '.al .chip.open', '.al .chip.inf', '.al .r1-link',
  '.ast', '.ast h4', '.sw', '.sw.on',
];
const PANEL = ['.r1-alerts', '.r1-alerts .ah2', '.r1-alerts .ah2 h2', '.r1-alerts .ah2 .chip', '.r1-alerts .ah2 .btn', '.r1-alerts ul', '.r1-alerts li', '.r1-alerts li time', '.r1-alerts li:nth-child(2) a'];

export const HEALTH_CASES: HealthCase[] = [
  {
    name: 'SCR-OFC-16 Success (header, six cards, recent alerts, alert settings)',
    captions: [`${H}Success`], app: '/shell-preview/health/success', frame: HEALTH_FRAME, screen: 'SCR-OFC-16',
    // F-664, owner e43f8c5b, Nov 3 (Words match the app): the subline says every 5 minutes where the frozen frame says every minute, and the h1 shares its column.
    pairs: within(rootOf('SCR-OFC-16'), cap(`${H}Success`), [...CHROME, ...SIDE, ...HEAD, ...CARDS, ...ALERTS, ...FOOT]).map((x) => (/ \.ah (h1|p)$/.test(x.app) ? { ...x, wordsRuled: 'F-664 e43f8c5b' } : x)),
  },
  {
    name: 'SCR-OFC-28 Success (the bell panel with 2 alerts)',
    captions: [`${A}Success`], app: '/shell-preview/alerts/success', frame: BOARD_FRAME, screen: 'SCR-OFC-28',
    widthFrom: [{ app: `${rootOf('SCR-OFC-28')} .r1-alerts`, frame: `${cap(`${A}Success`)} .r1-alerts` }],
    pairs: within(rootOf('SCR-OFC-28'), cap(`${A}Success`), PANEL),
  },
  {
    name: 'SCR-OFC-28 New alert (the new row is marked)',
    captions: [`${A}New alert`], app: '/shell-preview/alerts/new', frame: BOARD_FRAME, screen: 'SCR-OFC-28',
    widthFrom: [{ app: `${rootOf('SCR-OFC-28')} .r1-alerts`, frame: `${cap(`${A}New alert`)} .r1-alerts` }],
    pairs: within(rootOf('SCR-OFC-28'), cap(`${A}New alert`), ['.r1-alerts', '.r1-alerts .ah2 .chip', '.r1-alerts li', '.r1-alerts li.new', '.r1-alerts li time', '.r1-alerts li:nth-child(3) a']),
  },
  // The state tiles draw only the part of the screen that changes, in the states board's own box (a narrow body, the board's rules): each case
  // compares that part, sized to its tile where the page's box differs.
  {
    name: 'SCR-OFC-16 Checking (the busy Check now button)',
    captions: [`${H}Checking`], app: '/shell-preview/health/checking', frame: HEALTH_FRAME, screen: 'SCR-OFC-16',
    pairs: [{ app: `${rootOf('SCR-OFC-16')} .ah .btn.busy`, frame: `${cap(`${H}Checking`)} .btn.busy` }, { app: `${rootOf('SCR-OFC-16')} .ah .btn.busy .r1-spin`, frame: `${cap(`${H}Checking`)} .btn.busy .r1-spin` }],
  },
  {
    name: 'SCR-OFC-16 Applied (the toast)',
    captions: [`${H}Applied`], app: '/shell-preview/health/applied', frame: HEALTH_FRAME, screen: 'SCR-OFC-16',
    widthFrom: [{ app: `${rootOf('SCR-OFC-16')} .r1-toast`, frame: `${cap(`${H}Applied`)} .r1-toast` }],
    pairs: [{ app: `${rootOf('SCR-OFC-16')} .r1-toast`, frame: `${cap(`${H}Applied`)} .r1-toast` }, { app: `${rootOf('SCR-OFC-16')} .r1-toast span`, frame: `${cap(`${H}Applied`)} .r1-toast span` }],
  },
  {
    name: 'SCR-OFC-16 Email opened (the row says "You opened this email.")',
    captions: [`${H}Email opened`], app: '/shell-preview/health/email-opened', frame: HEALTH_FRAME, screen: 'SCR-OFC-16',
    widthFrom: [{ app: `${rootOf('SCR-OFC-16')} .alerts .al`, frame: `${cap(`${H}Email opened`)} .al` }],
    pairs: [{ app: `${rootOf('SCR-OFC-16')} .alerts .al:first-child`, frame: `${cap(`${H}Email opened`)} .al` }].concat(
      ['b', '.chip', 'p', 'time', '.used'].map((s) => ({ app: `${rootOf('SCR-OFC-16')} .alerts .al:first-child ${s}`, frame: `${cap(`${H}Email opened`)} .al ${s}` })),
    ),
  },
  {
    name: 'SCR-OFC-16 New alert (a new row with its email link)',
    captions: [`${H}New alert`], app: '/shell-preview/health/new-alert', frame: HEALTH_FRAME, screen: 'SCR-OFC-16',
    widthFrom: [{ app: `${rootOf('SCR-OFC-16')} .alerts .al`, frame: `${cap(`${H}New alert`)} .al` }],
    pairs: [{ app: `${rootOf('SCR-OFC-16')} .alerts .al:first-child`, frame: `${cap(`${H}New alert`)} .al` }].concat(
      ['b', '.chip', 'p', 'time', '.r1-link'].map((s) => ({ app: `${rootOf('SCR-OFC-16')} .alerts .al:first-child ${s}`, frame: `${cap(`${H}New alert`)} .al ${s}` })),
    ),
  },
  {
    name: 'SCR-OFC-16 Error (the error panel and its Try again)',
    captions: [`${H}Error`], app: '/shell-preview/health/error', frame: HEALTH_FRAME, screen: 'SCR-OFC-16',
    widthFrom: [{ app: `${rootOf('SCR-OFC-16')} .r1-errpanel`, frame: `${cap(`${H}Error`)} .r1-errpanel` }],
    pairs: within(rootOf('SCR-OFC-16'), cap(`${H}Error`), ['.r1-errpanel', '.r1-errpanel b', '.r1-errpanel .btn.sm']),
  },
  {
    name: 'SCR-OFC-16 No backup (the note in the Nightly backup card)',
    captions: [`${H}No backup`], app: '/shell-preview/health/no-backup', frame: HEALTH_FRAME, screen: 'SCR-OFC-16',
    widthFrom: [{ app: `${rootOf('SCR-OFC-16')} .cards > .panel:first-child .r1-note`, frame: `${cap(`${H}No backup`)} .r1-note` }],
    pairs: [{ app: `${rootOf('SCR-OFC-16')} .cards > .panel:first-child .r1-note`, frame: `${cap(`${H}No backup`)} .r1-note` }],
  },
  {
    name: 'SCR-OFC-28 Empty (the note)',
    captions: [`${A}Empty`], app: '/shell-preview/alerts/empty', frame: BOARD_FRAME, screen: 'SCR-OFC-28',
    widthFrom: [{ app: `${rootOf('SCR-OFC-28')} .r1-alerts`, frame: `${cap(`${A}Empty`)} .r1-alerts` }],
    pairs: within(rootOf('SCR-OFC-28'), cap(`${A}Empty`), ['.r1-alerts', '.r1-alerts .ah2', '.r1-alerts .ah2 h2', '.r1-alerts .ah2 .btn', '.r1-note']),
  },
  {
    // F-1144, owner ruling 9f7f745a "Add a Dismiss": the dismissed row reads Resolved with no Dismiss, and CMP-11 says Alert dismissed.
    name: 'SCR-OFC-16 Dismissed (the Resolved row and the toast)',
    captions: [`${H}Dismissed`], app: '/shell-preview/health/dismissed', frame: HEALTH_FRAME, screen: 'SCR-OFC-16',
    widthFrom: [{ app: `${rootOf('SCR-OFC-16')} .alerts .al`, frame: `${cap(`${H}Dismissed`)} .al` }, { app: `${rootOf('SCR-OFC-16')} .r1-toast`, frame: `${cap(`${H}Dismissed`)} .r1-toast` }],
    pairs: [{ app: `${rootOf('SCR-OFC-16')} .alerts .al:first-child`, frame: `${cap(`${H}Dismissed`)} .al` }, { app: `${rootOf('SCR-OFC-16')} .r1-toast`, frame: `${cap(`${H}Dismissed`)} .r1-toast` }, { app: `${rootOf('SCR-OFC-16')} .r1-toast span`, frame: `${cap(`${H}Dismissed`)} .r1-toast span` }].concat(
      ['b', '.chip', 'p', 'time'].map((x) => ({ app: `${rootOf('SCR-OFC-16')} .alerts .al:first-child ${x}`, frame: `${cap(`${H}Dismissed`)} .al ${x}` })),
    ),
  },
  {
    // The tile "Control details: Dismiss" is not a frame (no frame-cap, so tagFrames cannot key it); the frame side picks the only row that carries the button.
    name: 'SCR-OFC-16 Control details: Dismiss (the open row and its button)',
    captions: [], app: '/shell-preview/health/dismiss', frame: HEALTH_FRAME, screen: 'SCR-OFC-16',
    widthFrom: [{ app: `${rootOf('SCR-OFC-16')} .alerts .al`, frame: '.r1-st .al:has([data-ctl="CTL-OFC-16-28"])' }],
    pairs: [{ app: `${rootOf('SCR-OFC-16')} .alerts .al:first-child`, frame: '.r1-st .al:has([data-ctl="CTL-OFC-16-28"])' }].concat(
      ['b', '.chip', 'p', 'time', '[data-ctl="CTL-OFC-16-28"]'].map((x) => ({ app: `${rootOf('SCR-OFC-16')} .alerts .al:first-child ${x}`, frame: `.r1-st .al:has([data-ctl="CTL-OFC-16-28"]) ${x}` })),
    ),
  },
  {
    // The Resolved chip and the Dismiss button's margin (kit 0.9 .r1-alerts li .chip and .btn): the alert row follows its frame.
    name: 'SCR-OFC-28 Dismissed (the Resolved chip, the 2 rows and the toast)',
    captions: [`${A}Dismissed`], app: '/shell-preview/alerts/dismissed', frame: BOARD_FRAME, screen: 'SCR-OFC-28',
    widthFrom: [{ app: `${rootOf('SCR-OFC-28')} .r1-alerts`, frame: `${cap(`${A}Dismissed`)} .r1-alerts` }],
    pairs: within(rootOf('SCR-OFC-28'), cap(`${A}Dismissed`), ['.r1-alerts', '.r1-alerts .ah2', '.r1-alerts li', '.r1-alerts li time', '.r1-alerts li .chip', '.r1-alerts li .chip .dot', '.r1-toast', '.r1-toast span']).concat(within(rootOf('SCR-OFC-28'), cap(`${A}Dismissed`), ['.r1-alerts li a'])),
  },
  {
    // F-1282: the comparator reads no margin or position (compare.ts PROPERTIES), so this case holds the row and the button's own values, not the
    // 12 px gap to the link or the chip's 4 px margin; those two rules (kit.css .r1-alerts li .btn, .chip) are the kit's own bytes, held by
    // apps/web/src/kit-slices.test.ts. When compare.ts gains margin-left, the name can claim the gap again.
    name: 'SCR-OFC-28 Control details: Dismiss (the open row and its button)',
    captions: [], app: '/shell-preview/alerts/dismiss', frame: BOARD_FRAME, screen: 'SCR-OFC-28',
    widthFrom: [{ app: `${rootOf('SCR-OFC-28')} .r1-alerts`, frame: '.r1-st .r1-alerts:has([data-ctl="CTL-OFC-28-05"])' }],
    pairs: ['.r1-alerts', '.r1-alerts li', '.r1-alerts li time', '.r1-alerts li a', '.r1-alerts li .btn'].map((x) => ({ app: `${rootOf('SCR-OFC-28')} ${x}`, frame: `.r1-st .r1-alerts:has([data-ctl="CTL-OFC-28-05"])${x.slice(10)}` })),
  },
];

/**
 * Captioned frame states with no look case of their own, each with the reason. The coverage test checks every caption the frames show is compared by a
 * case or named here, and that each named one is a caption of its frame.
 */
export const NOT_COMPARED: Record<string, { frame: string; why: string }> = {
  [`${H}Applied`]: { frame: HEALTH_FRAME, why: 'the tile draws the in-force line and the radios in the states board\'s body (ink-900, 17.5 px lines, 98 px tall) while the card sets ink-700 and 18.1 px lines; the toast has a box of its own and is compared; the radio dots and the disabled Apply take their line height from that body (17.5 px and 18.2 px against 18.1 px and 18.9 px), their own rules being held by the Success case' },
  [`${H}Loading`]: { frame: HEALTH_FRAME, why: 'the tile draws a skeleton in the states board\'s padded body (CMP-12 rules, DK-64 .r1-st .b .r1-skel 14 px); the page\'s skeleton rows are the shell\'s own (12 px), held by the shell cases' },
  [`${H}Applying`]: { frame: HEALTH_FRAME, why: 'the tile draws the busy button in the states board\'s 14 px type, the card in its 13 px (line-height 19.6 px against 20.3 px); the busy button rule itself is the kit\'s, held by the Checking case' },
  [`${A}Loading`]: { frame: BOARD_FRAME, why: 'the tile draws the 3 skeleton rows at 50% of a narrow body with the board\'s tile padding; the panel\'s rows are the shell\'s skeleton rule (12 px), held by the shell cases' },
};

/** Captions the frames show (read by the pw test) that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncovered(captions: Record<string, string[]>): string[] {
  const compared = new Set(HEALTH_CASES.flatMap((c) => c.captions.map((x) => `${c.frame} | ${x}`)));
  const problems: string[] = [];
  for (const [frame, caps] of Object.entries(captions)) {
    for (const c of caps) {
      if (!/^(SCR-OFC-16 |SCR-OFC-28 )/.test(c)) continue;
      if (compared.has(`${frame} | ${c}`)) continue;
      const n = NOT_COMPARED[c];
      if (n && n.frame === frame) continue;
      problems.push(`no case compares ${frame} | ${c}`);
    }
  }
  for (const [c, n] of Object.entries(NOT_COMPARED)) if (!(captions[n.frame] ?? []).includes(c)) problems.push(`NOT_COMPARED names a caption its frame does not show: ${n.frame} | ${c}`);
  return problems;
}
