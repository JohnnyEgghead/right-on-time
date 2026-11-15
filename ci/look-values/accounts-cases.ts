// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-ACCOUNTS (BUILD_PLAN P4-ACCOUNTS Acceptance, look clause): SCR-OFC-43 to SCR-OFC-46 and SCR-EML-01 to
// SCR-EML-03 of the app against their frame pages (DK-101, DK-129 to DK-131), in each state a frame shows, light theme. A frame
// state is picked by its frozen caption (tagFrames, shell-cases.ts); app states are the harness build's
// /shell-preview/accounts-<screen>/<name> routes, each fixed to its frame's data. The office chrome (CMP-01, CMP-07, CMP-08,
// CMP-04) and the public header (CMP-14) are held by the shell cases; these cases hold the page bodies.
import type { SelectorPair } from './compare.ts';
import type { WidthFrom } from './shell-cases.ts';

export interface AccountsCase {
  name: string;
  screen: 'SCR-OFC-43' | 'SCR-OFC-44' | 'SCR-OFC-45' | 'SCR-OFC-46' | 'SCR-EML-01' | 'SCR-EML-02' | 'SCR-EML-03';
  captions: string[];
  app: string;
  frame: string;
  pairs: SelectorPair[];
  widthFrom?: WidthFrom[];
}

const USERS = 'mockups/pages/admin-users.html';
const EMAIL = 'mockups/pages/r1-eml-email.html';
const SETPW = 'mockups/pages/r1-eml-setpw.html';
const FORGOT = 'mockups/pages/r1-eml-forgot.html';
export const ACCOUNTS_FRAMES = [USERS, EMAIL, SETPW, FORGOT];

const cap = (caption: string) => `[data-bw-cap="${caption}"]`;
const root = (screen: string) => `.r1-screen[data-screen="${screen}"]`;
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`.trim(), frame: `${frameRoot} ${s}`.trim() }));

const U = 'SCR-OFC-43 Admin: users and roles: ';
const V = 'SCR-OFC-44 Invite user: ';
const C = 'SCR-OFC-45 Change role: ';
const X = 'SCR-OFC-46 Turn a user off: ';
const E1 = 'SCR-EML-01 Email inbox: 1 email: ';
const E2 = 'SCR-EML-02 Set a password: ';
const E3 = 'SCR-EML-03 Forgot password, web: ';

const USERS_MAIN = [
  '.ah', '.ah h1', '.ah p', '.ah .acts .btn.primary', '.ah .acts .btn.primary .ic', '.body',
  '.panel.listp', '.fbar', '.fsel', '.fsel .k', '.fsel b', '.fsel .ic', '.fbar .cnt',
  'table.u', 'table.u th', 'table.u td', '.who', '.who .av', '.who b', '.who small', '.rl', '.rl .ic', 'table.u .chip', 'table.u .chip .dot',
  'td.when', 'td.when small', 'td.ra .btn', '.you', '.listp .foot', '.listp .foot .pg .btn',
  '.panel.rolep', '.panel .ph', '.panel h3', 'table.m', 'table.m th', 'table.m td', '.y', '.n', '.y .ic', '.n .ic',
  '.callout', '.callout .ic', '.callout.info', '.chg', '.chg div', '.chg small',
];
const DIALOG = ['.r1-dlg-h', '.r1-dlg-h h2', '.r1-x', '.r1-x .ic', '.r1-dlg-b', '.r1-dlg-f', '.r1-dlg-f .btn'];
const RADIOS = ['.rads', '.rad', '.rad i'];
/** A dialog preview's screen root carries the dialog's own screen ID (the walkers' 1 root per page). */
const dlgScreen = (caption: string): AccountsCase['screen'] => (caption.startsWith('SCR-OFC-44') ? 'SCR-OFC-44' : caption.startsWith('SCR-OFC-45') ? 'SCR-OFC-45' : 'SCR-OFC-46');
const dlg = (caption: string, inner: string[]): Pick<AccountsCase, 'pairs' | 'widthFrom' | 'screen'> => ({
  screen: dlgScreen(caption),
  pairs: within(`${root(dlgScreen(caption))} .r1-dlg`, `${cap(caption)} .r1-dlg`, ['', ...inner]),
  widthFrom: [{ app: `${root(dlgScreen(caption))} .r1-dlg`, frame: `${cap(caption)} .r1-dlg` }],
});
const tile = (screen: AccountsCase['screen'], caption: string, box: string, inner: string[]): Pick<AccountsCase, 'pairs' | 'widthFrom'> => ({
  pairs: within(`${root(screen)} ${box}`, `${cap(caption)} ${box}`, ['', ...inner]),
  widthFrom: [{ app: `${root(screen)} ${box}`, frame: `${cap(caption)} ${box}` }],
});

const EML_CHROME = ['> .r1-demobar', '.r1-pubhead', '.r1-pubhead .prod', '.mid', '.r1-foot'];

export const ACCOUNTS_CASES: AccountsCase[] = [
  {
    name: 'SCR-OFC-43 Success (filters, users, role table, notes, recent changes)',
    screen: 'SCR-OFC-43', captions: [`${U}Success`], app: '/shell-preview/accounts-users/success', frame: USERS,
    pairs: within(root('SCR-OFC-43'), cap(`${U}Success`), USERS_MAIN),
  },
  {
    name: 'SCR-OFC-43 No match',
    screen: 'SCR-OFC-43', captions: [`${U}No match`], app: '/shell-preview/accounts-users/nomatch', frame: USERS,
    ...tile('SCR-OFC-43', `${U}No match`, '.r1-note', []),
  },
  {
    name: 'SCR-OFC-43 Error (CMP-12 in the list)',
    screen: 'SCR-OFC-43', captions: [`${U}Error`], app: '/shell-preview/accounts-users/error', frame: USERS,
    ...tile('SCR-OFC-43', `${U}Error`, '.r1-errpanel', ['b', '.btn.sm']),
  },
  { name: 'SCR-OFC-44 Editing', captions: [`${V}Editing`], app: '/shell-preview/accounts-users/invite-editing', frame: USERS, ...dlg(`${V}Editing`, [...DIALOG, '.r1-field', '.r1-field label', '.r1-input', ...RADIOS]) },
  { name: 'SCR-OFC-44 Sending', captions: [`${V}Sending`], app: '/shell-preview/accounts-users/invite-sending', frame: USERS, ...dlg(`${V}Sending`, [...DIALOG, '.r1-input', '.rad.on', '.rad.on i', '.btn.busy .r1-spin']) },
  { name: 'SCR-OFC-44 Sent', captions: [`${V}Sent`], app: '/shell-preview/accounts-users/invite-sent', frame: USERS, ...dlg(`${V}Sent`, [...DIALOG, '.r1-dlg-b p b', '.r1-link']) },
  { name: 'SCR-OFC-45 Choosing', captions: [`${C}Choosing`], app: '/shell-preview/accounts-users/role-choosing', frame: USERS, ...dlg(`${C}Choosing`, [...DIALOG, ...RADIOS, '.rad.on', '.rad.on i', '.rad small']) },
  { name: 'SCR-OFC-45 Saving', captions: [`${C}Saving`], app: '/shell-preview/accounts-users/role-saving', frame: USERS, ...dlg(`${C}Saving`, [...DIALOG, '.btn.busy .r1-spin']) },
  { name: 'SCR-OFC-46 Asking', captions: [`${X}Asking`], app: '/shell-preview/accounts-users/off-asking', frame: USERS, ...dlg(`${X}Asking`, [...DIALOG, '.r1-dlg-b p', '.btn.danger']) },
  { name: 'SCR-OFC-46 Turning off', captions: [`${X}Turning off`], app: '/shell-preview/accounts-users/off-turning', frame: USERS, ...dlg(`${X}Turning off`, [...DIALOG, '.btn.busy.danger', '.btn.busy .r1-spin']) },
  {
    name: 'SCR-EML-01 Shown (whose inbox, the email, its button, the once-only note)',
    screen: 'SCR-EML-01', captions: [`${E1}Shown`], app: '/shell-preview/accounts-email/shown', frame: EMAIL,
    pairs: within(root('SCR-EML-01'), cap(`${E1}Shown`), [
      ...EML_CHROME, '.mail', '.whose', '.whose .ic', '.whose b', '.mailbody', '.mh', '.mh h1', '.mh dl', '.mh dt', '.mh dd', '.mh .when',
      '.asis', '.asis .ic', '.mb', '.mb p', '.mb .btn.primary.lg', '.once', '.once .ic',
    ]),
  },
  { name: 'SCR-EML-01 Used', screen: 'SCR-EML-01', captions: [`${E1}Used`], app: '/shell-preview/accounts-email/used', frame: EMAIL, ...tile('SCR-EML-01', `${E1}Used`, '.warnbox', ['.ic', 'span']) },
  { name: 'SCR-EML-01 Not valid', screen: 'SCR-EML-01', captions: [`${E1}Not valid`], app: '/shell-preview/accounts-email/notvalid', frame: EMAIL, ...tile('SCR-EML-01', `${E1}Not valid`, '.warnbox', ['.ic', 'span']) },
  {
    name: 'SCR-EML-02 Ready (whose password, the field with its rules, Save password)',
    screen: 'SCR-EML-02', captions: [`${E2}Ready`], app: '/shell-preview/accounts-setpw/ready', frame: SETPW,
    pairs: within(root('SCR-EML-02'), cap(`${E2}Ready`), [
      ...EML_CHROME, '.pcard.pw', '.pcard h1', '.pcard .lead', '.who', '.who .av', '.who b', '.who span span', '.r1-field', '.r1-field label',
      '.r1-field label .muted', '.r1-input', '.r1-input > .ic', '.r1-input .tail', '.rules', '.rules li', '.rules li .ic', '.btn.save',
    ]),
  },
  { name: 'SCR-EML-02 Saving', screen: 'SCR-EML-02', captions: [`${E2}Saving`], app: '/shell-preview/accounts-setpw/saving', frame: SETPW, ...tile('SCR-EML-02', `${E2}Saving`, '.btn.busy', ['.r1-spin']) },
  { name: 'SCR-EML-02 Ended', screen: 'SCR-EML-02', captions: [`${E2}Ended`], app: '/shell-preview/accounts-setpw/ended', frame: SETPW, ...tile('SCR-EML-02', `${E2}Ended`, '.warnbox', ['.ic', 'span']) },
  { name: 'SCR-EML-02 Turned off', screen: 'SCR-EML-02', captions: [`${E2}Turned off`], app: '/shell-preview/accounts-setpw/off', frame: SETPW, ...tile('SCR-EML-02', `${E2}Turned off`, '.warnbox', ['.ic', 'span']) },
  { name: 'SCR-EML-02 Not valid', screen: 'SCR-EML-02', captions: [`${E2}Not valid`], app: '/shell-preview/accounts-setpw/notvalid', frame: SETPW, ...tile('SCR-EML-02', `${E2}Not valid`, '.warnbox', ['.ic', 'span']) },
  {
    name: 'SCR-EML-03 Sent (the form, the sent result with Open the email, Back to sign in)',
    screen: 'SCR-EML-03', captions: [`${E3}Sent`], app: '/shell-preview/accounts-forgot/sent', frame: FORGOT,
    pairs: within(root('SCR-EML-03'), cap(`${E3}Sent`), [
      ...EML_CHROME, '.pcard.fp', '.pcard h1', '.pcard .lead', 'form', '.r1-field', '.r1-field label', '.r1-field label .muted', '.r1-input', '.r1-input > .ic',
      'form .btn.primary.lg', '.res', '.okbox', '.okbox > .ic', '.okbox b', '.okbox a', '.okbox a .ic', '.backl', '.backl .ic',
    ]),
  },
  { name: 'SCR-EML-03 Sending', screen: 'SCR-EML-03', captions: [`${E3}Sending`], app: '/shell-preview/accounts-forgot/sending', frame: FORGOT, ...tile('SCR-EML-03', `${E3}Sending`, '.btn.busy', ['.r1-spin']) },
  { name: 'SCR-EML-03 No account', screen: 'SCR-EML-03', captions: [`${E3}No account`], app: '/shell-preview/accounts-forgot/noaccount', frame: FORGOT, ...tile('SCR-EML-03', `${E3}No account`, '.infobox2', ['.ic', 'span']) },
  { name: 'SCR-EML-03 Not available', screen: 'SCR-EML-03', captions: [`${E3}Not available`], app: '/shell-preview/accounts-forgot/notavailable', frame: FORGOT, ...tile('SCR-EML-03', `${E3}Not available`, '.infobox2', ['.ic', 'span']) },
  { name: 'SCR-EML-03 Turned off', screen: 'SCR-EML-03', captions: [`${E3}Turned off`], app: '/shell-preview/accounts-forgot/off', frame: FORGOT, ...tile('SCR-EML-03', `${E3}Turned off`, '.infobox2', ['.ic', 'span']) },
];

const SKEL = 'the tile\'s skeleton height is a tile-only rule (DK-47 .r1-st .b .r1-skel, 14 px) against CMP-12\'s 12 px; the skeleton itself is CMP-12, held by the shell cases. That reason covers the height only: the bar count and widths each page draws are page layout and no case compares them (F-615)';
/**
 * Captioned frame states with no look case of their own, each with the reason. The coverage test checks every caption the 4
 * frames show is compared by a case or named here, and that each named one is a caption of its frame.
 */
export const NOT_COMPARED: Record<string, { frame: string; why: string }> = {
  [`${U}Loading`]: { frame: USERS, why: SKEL },
  [`${E1}Loading`]: { frame: EMAIL, why: SKEL },
  [`${E2}Loading`]: { frame: SETPW, why: SKEL },
  [`${U}Changed`]: { frame: USERS, why: 'the tile draws 1 users row, 1 change line and the CMP-11 toast: the Success case holds table.u rows, their chips and buttons, and the .chg lines; the toast is CMP-11, held by the shell cases' },
  [`${C}Done`]: { frame: USERS, why: 'the tile draws the closed dialog\'s result: 1 users row with the Manager chip and the CMP-11 toast, each held by the Success case (table.u, .rl.mgr) and the shell cases (CMP-11)' },
  [`${X}Done`]: { frame: USERS, why: 'the tile draws 1 users row with the Turned off chip and Turn back on, and the CMP-11 toast; the Success case holds Omar Haddad\'s Turned off row and its Turn back on button' },
  [`${E2}Done`]: { frame: SETPW, why: 'the tile draws the result: the sign-in page of the user\'s app opens with "Your password is set. Sign in.", which is SCR-OFC-01\'s message box (.msgb.info), held by the P2-AUTH Returned case' },
  [`${E3}Default`]: { frame: FORGOT, why: 'the tile draws the empty field and the button outside the card\'s form (an inline 12 px margin); the Sent case holds the same field, button and Back to sign in inside the card' },
};

/** Captions the 4 frames show (read by the pw test) that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncovered(captions: Record<string, string[]>): string[] {
  const compared = new Set(ACCOUNTS_CASES.flatMap((c) => c.captions.map((x) => `${c.frame} | ${x}`)));
  const problems: string[] = [];
  for (const [frame, caps] of Object.entries(captions)) {
    for (const c of caps) {
      if (!/^(SCR-OFC-4[3-6]|SCR-EML-0[1-3])/.test(c)) continue;
      if (compared.has(`${frame} | ${c}`)) continue;
      const n = NOT_COMPARED[c];
      if (n && n.frame === frame) continue;
      problems.push(`no case compares ${frame} | ${c}`);
    }
  }
  for (const [c, n] of Object.entries(NOT_COMPARED)) if (!(captions[n.frame] ?? []).includes(c)) problems.push(`NOT_COMPARED names a caption its frame does not show: ${n.frame} | ${c}`);
  return problems;
}
