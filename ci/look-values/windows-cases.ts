// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-ADMIN-WINDOWS (BUILD_PLAN P4-ADMIN-WINDOWS Acceptance, look clause): SCR-OFC-12 Admin: arrival windows and its dialog SCR-OFC-24
// Switch a day's windows against DK-97 (mockups/pages/admin-windows.html), in each state the frame shows (light theme). A frame state is picked by its
// frozen caption (UI-DESIGN-KIT section 4.1), the way health-cases.ts picks them: the setup tags the element each caption labels with data-bw-cap. App
// states are the harness build's /shell-preview/windows routes, each fixed to its frame's data.
import type { SelectorPair } from './compare.ts';
import { CHROME, cap, within } from './billing-cases.ts';
import type { WidthFrom } from './shell-cases.ts';

export interface WindowsCase {
  name: string;
  /** The captions the case compares (every captioned state of the frame has a case, or a reason in NOT_COMPARED). */
  captions: string[];
  app: string;
  frame: string;
  /** The root the app route waits for: the page's screen root, or the dialog's own (a dialog tile draws no page). */
  wait: string;
  pairs: SelectorPair[];
  /** App elements sized to their frame twin before values are read (a tile is a narrow body; the page is wide). */
  widthFrom?: WidthFrom[];
}

export const WINDOWS_FRAME = 'mockups/pages/admin-windows.html';
const W = 'SCR-OFC-12 Admin: arrival windows: ';
const S = "SCR-OFC-24 Switch a day's windows: ";
const PAGE = '.r1-screen[data-screen="SCR-OFC-12"]';
const FOOT = ['.r1-foot', '.r1-foot a', '.r1-foot a code', '.r1-foot [data-ctl="CTL-CMP-04-02"]', '.r1-foot .demo'];
// `.side` itself is left out: its height is the shell's, which the frame fixes at 842 px (a clipped column) and the page lets grow with its content.
const SIDE = ['.side h4', '.side a', '.side a.on'];
const HEAD = ['.ah', '.ah h1', '.ah p', '.ah .acts', '.seg', '.seg span', '.seg span.on', '.ah .btn', '.ah .btn.primary', '.ah .btn .ic'];
const TABLE = [
  '.panel', '.panel .ph', '.panel h3', '.panel .ph .s', 'table.w', 'table.w th', 'table.w td', 'table.w td:first-child b', 'table.w .tnum', '.step', '.step span', '.fill', '.meter',
  '.chip.full', '.chip.full .dot', '.note', '.note .ic', '.note span',
];
const RULES = ['.set', '.set .l', '.set .l b', '.set .l small', '.val.lock', '.val.lock .ic'];
const PEAK = [
  '.panel.wide', '.legend2', '.legend2 span', '.legend2 i', '.peakin', '.cal', '.dow', '.dow span', '.wk', '.day', '.day .d', '.day .pill', '.day .m', '.day.today', '.day.today .tt',
  '.day.peak', '.day.peak .why', '.day.picked', '.day.closed', '.day.past', '.pill.two', '.pill.four', '.pill.off',
];
// `.kv b` is left out of the Success case: the frame's panel prints the bold reason "Heat advisory, 94°F forecast" for Wed, Sep 16 while its calendar day and its
// Reason field print "Heat advisory" for the same day, and 1 stored reason cannot be both; the Switched case holds `.kv b` where the frame's data agree.
const DAYSET = [
  '.dayset', '.dayset h4', '.dayset .wins', '.dayset .wins span', '.dayset .kv', '.dayset .acts', '.tog', '.tog .sw', '.reason', '.reason .k', '.dayset .btn',
];
const DLG = ['.r1-dlg', '.r1-dlg-h', '.r1-dlg-h h2', '.r1-x', '.r1-x .ic', '.r1-dlg-b', '.r1-dlg-b p', '.r1-dlg-f', '.r1-dlg-f .btn'];
const PANEL_PARTS = ['h4', '.wins', '.wins span', '.kv', '.kv b', '.tog', '.tog .sw', '.reason', '.reason .k', '.btn'];

/** The app's number field is an input where the frame draws a b: the same box, read from the element that draws it. */
const stepField = (appRoot: string, frameRoot: string, inner: string): SelectorPair => ({ app: `${appRoot} ${inner} .bw-step-in`, frame: `${frameRoot} ${inner} b` });
/** The frame's tiles draw the picked-day panel in a states-board body (`.r1-st .dayset { width: auto }`), the page in its 360 px column: sized to the tile. */
const dayset = (appRoot: string, c: string): WidthFrom => ({ app: `${appRoot} .dayset`, frame: `${cap(c)} .dayset` });

export const WINDOWS_CASES: WindowsCase[] = [
  {
    name: 'SCR-OFC-12 Success (header, 2-hour windows, rules, peak days calendar, picked-day panel)',
    captions: [`${W}Success`], app: '/shell-preview/windows/success', frame: WINDOWS_FRAME, wait: PAGE,
    pairs: [...within(PAGE, cap(`${W}Success`), [...CHROME, ...SIDE, ...HEAD, ...TABLE, ...RULES, ...PEAK, ...DAYSET, ...FOOT]), stepField(PAGE, cap(`${W}Success`), '.step')],
  },
  {
    name: 'SCR-OFC-12 Changed (an edited number and the Unsaved changes line)',
    captions: [`${W}Changed`], app: '/shell-preview/windows/changed', frame: WINDOWS_FRAME, wait: PAGE,
    pairs: [...within(PAGE, cap(`${W}Changed`), ['.step.chg', '.step.chg span', '.unsaved', '.unsaved .ic']), stepField(PAGE, cap(`${W}Changed`), '.step.chg')],
  },
  {
    name: 'SCR-OFC-12 Saving (the busy Save changes and the off Discard)',
    captions: [`${W}Saving`], app: '/shell-preview/windows/saving', frame: WINDOWS_FRAME, wait: PAGE,
    pairs: within(PAGE, cap(`${W}Saving`), ['.btn.busy', '.btn.busy .r1-spin', '.btn.dis']),
  },
  {
    // The message's own box is not compared: the tile draws a 2-column table whose cell is 322 px wide, the page's cell is the Jobs per window column of its
    // 4-column table, so the sentence wraps to 2 lines there (208 px, 75.6 px tall against 37.8 px); its icon and the field's box are compared.
    name: 'SCR-OFC-12 Refused (the reason on the field, the number kept)',
    captions: [`${W}Refused`], app: '/shell-preview/windows/refused', frame: WINDOWS_FRAME, wait: PAGE,
    pairs: [...within(PAGE, cap(`${W}Refused`), ['.step.bad', '.step.bad span', '.r1-fmsg .ic']), stepField(PAGE, cap(`${W}Refused`), '.step.bad')],
  },
  {
    name: 'SCR-OFC-12 Error (the error panel and its Try again)',
    captions: [`${W}Error`], app: '/shell-preview/windows/error', frame: WINDOWS_FRAME, wait: PAGE,
    widthFrom: [{ app: `${PAGE} .r1-errpanel`, frame: `${cap(`${W}Error`)} .r1-errpanel` }],
    pairs: within(PAGE, cap(`${W}Error`), ['.r1-errpanel', '.r1-errpanel b', '.r1-errpanel .btn.sm']),
  },
  {
    name: 'SCR-OFC-12 Loading (the skeleton rows)',
    captions: [`${W}Loading`], app: '/shell-preview/windows/loading', frame: WINDOWS_FRAME, wait: PAGE,
    widthFrom: [{ app: `${PAGE} .bw-win-skel`, frame: `${cap(`${W}Loading`)} .b` }],
    pairs: within(PAGE, cap(`${W}Loading`), ['.r1-skel']),
  },
  {
    // The picked day's own box is not compared: the tile draws 4 columns of a 560 px tile (80.7 px a day), the page 7 columns (75 px), so the day's lines take
    // another width and its reason wraps; the Success case holds the days at full size. Its pill has the width of its text and is compared.
    name: 'SCR-OFC-12 Switched (the picked day on 4-hour windows with its reason, who and when, and the toast)',
    captions: [`${W}Switched`], app: '/shell-preview/windows/switched', frame: WINDOWS_FRAME, wait: PAGE,
    widthFrom: [dayset(PAGE, `${W}Switched`), { app: `${PAGE} .r1-toast`, frame: `${cap(`${W}Switched`)} .r1-toast` }],
    pairs: [
      ...within(`${PAGE} .dayset`, `${cap(`${W}Switched`)} .dayset`, PANEL_PARTS),
      ...within(`${PAGE} .day.picked`, `${cap(`${W}Switched`)} .day.picked`, ['.pill']),
      ...within(PAGE, cap(`${W}Switched`), ['.r1-toast', '.r1-toast span', '.r1-toast .ic']),
    ],
  },
  {
    name: 'SCR-OFC-12 Day picked (a 2-hour day: the switch off, the reason field ready, Switch back off)',
    captions: [`${W}Day picked`], app: '/shell-preview/windows/day-picked', frame: WINDOWS_FRAME, wait: PAGE,
    widthFrom: [dayset(PAGE, `${W}Day picked`)],
    pairs: [
      ...within(`${PAGE} .dayset`, `${cap(`${W}Day picked`)} .dayset`, ['h4', '.wins span', '.tog.off', '.tog.off .sw', '.reason', '.reason .k', '.btn.dis']),
      ...within(`${PAGE} .day.picked`, `${cap(`${W}Day picked`)} .day.picked`, ['.pill']),
    ],
  },
  {
    // The Reason field's box is held by the Switching case, not here: the Asking frame draws the field with the focus ring (a teal border and halo) while its
    // own caption and CTL-OFC-24-03 give the first focus to Cancel, so the page's unfocused field differs in border color only by that ring.
    name: 'SCR-OFC-24 Asking (the dialog with its message, an empty Reason field and the off Switch)',
    captions: [`${S}Asking`], app: '/shell-preview/windows/dlg-asking', frame: WINDOWS_FRAME, wait: '.r1-dlg',
    widthFrom: [dayset('.r1-st', `${S}Asking`)],
    pairs: [
      ...within('.r1-st', cap(`${S}Asking`), [...DLG, '.r1-field', '.r1-field label', '.r1-dlg-f .btn.primary.dis']),
      ...within('.r1-st .dayset', `${cap(`${S}Asking`)} .dayset`, ['h4', '.tog', '.tog .sw', '.reason', '.btn.dis']),
    ],
  },
  {
    name: 'SCR-OFC-24 Switching (the busy Switch and the off Cancel)',
    captions: [`${S}Switching`], app: '/shell-preview/windows/dlg-switching', frame: WINDOWS_FRAME, wait: '.r1-dlg',
    pairs: within('.r1-st', cap(`${S}Switching`), [...DLG, '.r1-field', '.r1-input', '.r1-dlg-f .btn.busy', '.r1-dlg-f .btn.dis', '.r1-spin']),
  },
  {
    name: 'SCR-OFC-24 Done (the picked-day panel on its new mode)',
    captions: [`${S}Done`], app: '/shell-preview/windows/dlg-done', frame: WINDOWS_FRAME, wait: '.dayset',
    widthFrom: [dayset('.r1-st', `${S}Done`)],
    pairs: within('.r1-st .dayset', `${cap(`${S}Done`)} .dayset`, PANEL_PARTS),
  },
];

/**
 * Captioned frame states with no look case of their own, each with the reason. The coverage test checks every caption the frame shows is compared by a
 * case or named here, and that each named one is a caption of its frame.
 */
export const NOT_COMPARED: Record<string, { frame: string; why: string }> = {};

/** Captions the frame shows (read by the pw test) that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncovered(captions: Record<string, string[]>): string[] {
  const compared = new Set(WINDOWS_CASES.flatMap((c) => c.captions.map((x) => `${c.frame} | ${x}`)));
  const problems: string[] = [];
  for (const [frame, caps] of Object.entries(captions)) {
    for (const c of caps) {
      if (!/^(SCR-OFC-12 |SCR-OFC-24 )/.test(c)) continue;
      if (compared.has(`${frame} | ${c}`)) continue;
      const n = NOT_COMPARED[c];
      if (n && n.frame === frame) continue;
      problems.push(`no case compares ${frame} | ${c}`);
    }
  }
  for (const [c, n] of Object.entries(NOT_COMPARED)) if (!(captions[n.frame] ?? []).includes(c)) problems.push(`NOT_COMPARED names a caption its frame does not show: ${n.frame} | ${c}`);
  return problems;
}
