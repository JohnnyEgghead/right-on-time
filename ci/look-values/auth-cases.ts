// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P2-AUTH (BUILD_PLAN P2-AUTH Acceptance, look clause): SCR-OFC-01, SCR-GATE-01 and SCR-GATE-02 of the app against
// their frame pages, in each state a frame shows. A frame state is picked by its frozen caption (UI-DESIGN-KIT section 4.1), the
// way shell-cases.ts picks them: the setup tags the element each caption labels with data-bw-cap. App states are the harness
// build's /shell-preview/auth/<name> routes (apps/web/app/shell-preview/auth), each fixed to its frame's data.
import type { SelectorPair } from './compare.ts';
import type { WidthFrom } from './shell-cases.ts';

export interface AuthCase {
  name: string;
  /** The screen the case holds the look of. */
  screen: 'SCR-OFC-01' | 'SCR-GATE-01' | 'SCR-GATE-02';
  /** The frame captions the case compares (every captioned state of the 3 screens has a case, or a reason in NOT_COMPARED). */
  captions: string[];
  app: string;
  frame: string;
  pairs: SelectorPair[];
  /** A state tile is narrower than a page: the app element takes the tile element's width, so the case compares the component. */
  widthFrom?: WidthFrom[];
}

const SIGNIN = 'mockups/pages/office-signin.html';
const CODE = 'mockups/pages/r1-gate-a-code.html';
const START = 'mockups/pages/r1-gate-a-start.html';
const cap = (caption: string) => `[data-bw-cap="${caption}"]`;
const root = (screen: string) => `.r1-screen[data-screen="${screen}"]`;
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`.trim(), frame: `${frameRoot} ${s}`.trim() }));

const CHROME = ['> .r1-demobar', '.r1-demobar .clk', '.r1-demobar .clk .lbl', '.r1-demobar .clk b', '.r1-demobar .run'];
const FOOT = ['.r1-foot', '.r1-foot a', '.r1-foot a code', '.r1-foot [data-ctl="CTL-CMP-04-02"]', '.r1-foot .demo'];

const S = 'SCR-OFC-01 Staff sign-in: ';
const G1 = 'SCR-GATE-01 Access code: ';
const G2 = 'SCR-GATE-02 Start page: ';

const SIGNIN_MAIN = [
  '.side', '.side .brand', '.side .brand .word', '.side .app', '.side h1', '.side h1 em', '.side .lead', '.side .roles', '.side .role', '.side .role .ri',
  '.side .role b', '.side .role span', '.side .foot', '.side .wave',
  '.main', '.hlang', '.hlang a', '.duo', '.box', '.box h2', '.box .sub', '.form', '.form .l', '.form .field', '.form .field .ic', '.form .gap',
  '.row2', '.row2 .check', '.row2 .check .bx', '.row2 .link', '.btn.primary.go', '.note', '.note .ic', '.help', '.help b',
  '.asl', '.asl h3', '.asl .asn', '.aslist', '.aslist h4', '.aslist .who', '.aslist .who .av', '.aslist .who b', '.aslist .who small', '.asl .cust',
];
const SIGNIN_FORM = ['.form .msgb', '.form .msgb .ic', '.form .msgb span', '.form .l', '.form .field', '.form .field .ic', '.btn.primary.go'];

const GATE_CODE_MAIN = [
  '.side', '.side .brand', '.side .brand .word', '.side .brand .word small', '.side .sideprod', '.side h1.tag', '.side h1.tag em', '.side .sidep', '.side .drop',
  '.mainp', '.topr', '.topr a', '.box', '.box h2', '.box .lead', '.codeform', '.codeform .r1-field', '.codeform .r1-field label', '.codeform .r1-input',
  '.codeform .r1-input .ic', '.codeform .btn.enter', '.staff', '.staff a', '.r1-foot', '.r1-foot a', '.r1-foot a code', '.r1-foot [data-ctl="CTL-CMP-04-02"]',
];

const START_MAIN = [
  ...CHROME, '.r1-pubhead', '.r1-pubhead .brand .word', '.r1-pubhead .prod', '.r1-pubhead .r1-lang a', '.r1-pubhead .tel', '.r1-pubhead .tel small',
  '.band', '.band h1', '.band p', '.doors', '.door', '.door .dico', '.door b', '.door p', '.door .btn.primary.lg',
  '.iph', '.iph .iphl', '.iph h2', '.iph .signintro', 'table.signs', 'table.signs th', 'table.signs td', 'table.signs td.mono',
  '.appline', '.appline .aico', '.appline b', '.appline span', '.appline .btn', ...FOOT,
];

export const AUTH_CASES: AuthCase[] = [
  {
    name: 'SCR-OFC-01 Default (sign-in form, Sign in as list, demo clock, footer)',
    screen: 'SCR-OFC-01', captions: [`${S}Default`], app: '/shell-preview/auth-signin/default', frame: SIGNIN,
    pairs: within(root('SCR-OFC-01'), cap(`${S}Default`), [...CHROME, ...SIGNIN_MAIN, ...FOOT]),
  },
  {
    name: 'SCR-OFC-01 Signing in (the pressed control is busy)',
    screen: 'SCR-OFC-01', captions: [`${S}Signing in`], app: '/shell-preview/auth-signin/busy', frame: SIGNIN,
    widthFrom: [{ app: `${root('SCR-OFC-01')} .form`, frame: `${cap(`${S}Signing in`)} .form` }],
    pairs: [
      ...within(`${root('SCR-OFC-01')} .form`, `${cap(`${S}Signing in`)} .form`, ['.l', '.field', '.btn.primary.go.busy', '.btn.primary.go.busy .r1-spin']),
    ],
  },
  {
    name: 'SCR-OFC-01 Wrong details',
    screen: 'SCR-OFC-01', captions: [`${S}Wrong details`], app: '/shell-preview/auth-signin/bad', frame: SIGNIN,
    widthFrom: [{ app: `${root('SCR-OFC-01')} .form`, frame: `${cap(`${S}Wrong details`)} .form` }],
    pairs: within(root('SCR-OFC-01'), cap(`${S}Wrong details`), SIGNIN_FORM.map((s) => (s.startsWith('.form') ? s : `.form ${s}`))),
  },
  {
    name: 'SCR-OFC-01 Turned off',
    screen: 'SCR-OFC-01', captions: [`${S}Turned off`], app: '/shell-preview/auth-signin/off', frame: SIGNIN,
    widthFrom: [{ app: `${root('SCR-OFC-01')} .form`, frame: `${cap(`${S}Turned off`)} .form` }],
    pairs: within(root('SCR-OFC-01'), cap(`${S}Turned off`), ['.form .msgb', '.form .msgb .ic', '.form .msgb span']),
  },
  {
    name: 'SCR-OFC-01 Returned',
    screen: 'SCR-OFC-01', captions: [`${S}Returned`], app: '/shell-preview/auth-signin/returned', frame: SIGNIN,
    widthFrom: [{ app: `${root('SCR-OFC-01')} .form`, frame: `${cap(`${S}Returned`)} .form` }],
    pairs: within(root('SCR-OFC-01'), cap(`${S}Returned`), ['.form .msgb', '.form .msgb .ic', '.form .msgb span']),
  },
  {
    name: 'SCR-OFC-01 List loading',
    screen: 'SCR-OFC-01', captions: [`${S}List loading`], app: '/shell-preview/auth-signin/loading', frame: SIGNIN,
    widthFrom: [{ app: `${root('SCR-OFC-01')} .aslist`, frame: `${cap(`${S}List loading`)} .aslist` }],
    pairs: within(root('SCR-OFC-01'), cap(`${S}List loading`), ['.aslist h4']),
  },
  {
    name: 'SCR-OFC-01 List error',
    screen: 'SCR-OFC-01', captions: [`${S}List error`], app: '/shell-preview/auth-signin/error', frame: SIGNIN,
    widthFrom: [{ app: `${root('SCR-OFC-01')} .aslist`, frame: `${cap(`${S}List error`)} .aslist` }],
    pairs: within(root('SCR-OFC-01'), cap(`${S}List error`), ['.aslist', '.aslist h4', '.aslist .r1-errpanel', '.aslist .r1-errpanel b']),
  },
  {
    name: 'SCR-GATE-01 Empty (the screen)',
    screen: 'SCR-GATE-01', captions: [`${G1}Empty`], app: '/shell-preview/auth-gate/empty', frame: CODE,
    pairs: within(root('SCR-GATE-01'), cap(`${G1}Empty`), GATE_CODE_MAIN),
  },
  {
    name: 'SCR-GATE-01 Wrong code (label, message and icon; the tile draws the field outside .codeform, so the Empty case holds the control box)',
    screen: 'SCR-GATE-01', captions: [`${G1}Wrong code`], app: '/shell-preview/auth-gate/wrong', frame: CODE,
    widthFrom: [{ app: `${root('SCR-GATE-01')} .codeform .r1-field`, frame: `${cap(`${G1}Wrong code`)} .r1-field` }],
    pairs: [
      { app: `${root('SCR-GATE-01')} .codeform .r1-field label`, frame: `${cap(`${G1}Wrong code`)} .r1-field label` },
      { app: `${root('SCR-GATE-01')} .codeform .r1-fmsg`, frame: `${cap(`${G1}Wrong code`)} .r1-fmsg` },
      { app: `${root('SCR-GATE-01')} .codeform .r1-fmsg .ic`, frame: `${cap(`${G1}Wrong code`)} .r1-fmsg .ic` },
    ],
  },
  {
    name: 'SCR-GATE-02 With sign-ins (the screen, app link)',
    screen: 'SCR-GATE-02', captions: [`${G2}With sign-ins`], app: '/shell-preview/auth-start/link', frame: START,
    pairs: within(root('SCR-GATE-02'), cap(`${G2}With sign-ins`), START_MAIN),
  },
  {
    name: 'SCR-GATE-02 App coming',
    screen: 'SCR-GATE-02', captions: [`${G2}App coming`], app: '/shell-preview/auth-start/coming', frame: START,
    widthFrom: [{ app: `${root('SCR-GATE-02')} .appline.coming`, frame: `${cap(`${G2}App coming`)} .appline.coming` }],
    pairs: within(root('SCR-GATE-02'), cap(`${G2}App coming`), ['.appline.coming', '.appline.coming > .ic', '.appline.coming b', '.appline.coming span']),
  },
  {
    name: 'SCR-GATE-02 List error',
    screen: 'SCR-GATE-02', captions: [`${G2}List error`], app: '/shell-preview/auth-start/error', frame: START,
    widthFrom: [{ app: `${root('SCR-GATE-02')} .r1-errpanel`, frame: `${cap(`${G2}List error`)} .r1-errpanel` }],
    pairs: within(root('SCR-GATE-02'), cap(`${G2}List error`), ['.r1-errpanel', '.r1-errpanel b', '.r1-errpanel .btn.sm']),
  },
];

/**
 * Captioned frame states with no look case of their own, each with the reason. The coverage test checks every caption the 3
 * frames show is compared by a case or named here, and that each named one is a caption of its frame.
 */
export const NOT_COMPARED: Record<string, { frame: string; why: string }> = {
  [`${G1}Checking`]: { frame: CODE, why: 'the tile draws the busy button outside .codeform (48 px, 16 px); the screen\'s own form sets 52 px and 17 px (DK-60 .codeform .enter), which the Empty case holds, and the spinner inherits that font size; the busy label, aria-busy and the spinner\'s box and border are held by the SCR-GATE-01 Checking test in auth.pw.test.ts (F-287)' },
  [`${G2}List loading`]: { frame: START, why: 'the tile\'s skeleton height is a tile-only rule (DK-60 .r1-st .b .r1-skel, 14 px) against CMP-12\'s 12 px; the widths are the frame\'s 40, 95, 95 and 80 percent (asserted by the SCR-GATE-02 List loading test in auth.pw.test.ts)' },
  [`${G1}Accepted`]: { frame: CODE, why: 'the tile draws one note (the page that was asked for opens); the app shows that page, not a state of this screen' },
  [`${G1}Gate off`]: { frame: CODE, why: 'the tile draws one note (this page never appears); with the code off the page gate renders the asked page' },
  [`${G2}App link`]: { frame: START, why: 'the tile draws the same .appline the With sign-ins screen carries (appLink); that case holds it' },
  [`${G2}Default`]: { frame: START, why: 'the tile draws a note and a .mini3 strip of the 3 ways in, a frame-only summary; the 3 doors themselves are held by the With sign-ins case' },
  'CMP-04 Footer: Demo mode on': { frame: START, why: 'the tile draws footStart, the footer of the With sign-ins screen; that case holds .r1-foot and .demo' },
};

export const AUTH_FRAMES = [SIGNIN, CODE, START];

/** Captions the 3 frames show (read by the pw test) that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncovered(captions: Record<string, string[]>): string[] {
  const compared = new Set(AUTH_CASES.flatMap((c) => c.captions.map((x) => `${c.frame} | ${x}`)));
  const problems: string[] = [];
  for (const [frame, caps] of Object.entries(captions)) {
    for (const c of caps) {
      if (!/^(SCR-OFC-01|SCR-GATE-01|SCR-GATE-02|CMP-04 Footer: Demo mode on)/.test(c)) continue;
      if (compared.has(`${frame} | ${c}`)) continue;
      const n = NOT_COMPARED[c];
      if (n && n.frame === frame) continue;
      problems.push(`no case compares ${frame} | ${c}`);
    }
  }
  for (const [c, n] of Object.entries(NOT_COMPARED)) if (!(captions[n.frame] ?? []).includes(c)) problems.push(`NOT_COMPARED names a caption its frame does not show: ${n.frame} | ${c}`);
  return problems;
}
