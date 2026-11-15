// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-CLOCK (BUILD_PLAN P4-CLOCK Acceptance, look clause): SCR-OFC-17 and its dialog SCR-OFC-27 against DK-103
// (mockups/pages/r1-admin-clock.html), in each state a frame shows. A frame state is picked by its frozen caption (UI-DESIGN-KIT section 4.1):
// the setup tags the element each caption labels with data-bw-cap. App states are the harness build's /shell-preview/clock routes
// (apps/web/app/shell-preview/clock), each fixed to its frame's data. The strip, top bar, side menu and footer of the main screen are the
// shell case "CMP-01 Running with Change, CMP-07 Admin current, CMP-08, CMP-04 (r1-admin-clock main screen)".
import type { SelectorPair } from './compare.ts';

export interface ClockCase {
  name: string;
  screen: string;
  captions: string[];
  app: string;
  frame: string;
  pairs: SelectorPair[];
}

export const CLOCK_FRAME = 'mockups/pages/r1-admin-clock.html';
const cap = (c: string) => `[data-bw-cap="${c}"]`;
const root = '.r1-screen[data-screen="SCR-OFC-17"]';
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`, frame: `${frameRoot} ${s}` }));

const C = 'SCR-OFC-17 Admin: demo clock: ';
const W = 'SCR-OFC-27 Reset the demo world: ';

/** `.body` is left out: the frame's is a fixed-height, clipped column inside its 900 px screen; the page grows with its content. */
const RUNNING = [
  '.ah', '.ah h1', '.ah p', '.note17', '.note17 .ic', '.note17 span',
  '.panel.now', '.now .big', '.now .big .chip', '.now .big .chip .dot', '.now .lm', '.now .lm b', '.now .acts', '.now .acts .btn', '.now .acts .btn .ic',
  '.panel.pp', '.pp .ph', '.pp .ph h3', '.pp .ph .s', '.pp .in', '.row3', '.row3 .r1-field', '.row3 .r1-field label', '.row3 .r1-input', '.row3 .r1-input .ic', '.row3 .btn.primary',
  '.presets', '.pre', '.pre b', '.pre span',
  '.panel.reset', '.reset .tx', '.reset .tx b', '.reset .btn.warnb', '.reset .btn.warnb .ic',
];

const DLG = ['.r1-dlg', '.r1-dlg-h', '.r1-dlg-h h2', '.r1-x', '.r1-x .ic', '.r1-dlg-b', '.r1-dlg-b p', '.r1-dlg-f', '.r1-dlg-f .btn'];

export const CLOCK_CASES: ClockCase[] = [
  {
    name: 'SCR-OFC-17 Running (the page: header, shared-clock note, clock and Pause, Jump to, Presets, Reset)',
    screen: 'SCR-OFC-17', captions: [`${C}Running`], app: '/shell-preview/clock/running', frame: CLOCK_FRAME,
    pairs: within(root, cap(`${C}Running`), RUNNING),
  },
  {
    // The chip's own box is not compared: in the page it sits in the 30 px heading, whose letter spacing it inherits (the Running case holds
    // that chip against the frame's); the tile draws a 15 px line. Resume is the page's large Pause button (the tile draws a small one).
    name: 'SCR-OFC-17 Paused (the Paused chip dot)',
    screen: 'SCR-OFC-17', captions: [`${C}Paused`], app: '/shell-preview/clock/paused', frame: CLOCK_FRAME,
    pairs: [{ app: `${root} .now .big .chip .dot`, frame: `${cap(`${C}Paused`)} .chip .dot` }],
  },
  {
    name: 'SCR-OFC-17 Catching up (the progress text)',
    screen: 'SCR-OFC-17', captions: [`${C}Catching up`], app: '/shell-preview/clock/catching-up', frame: CLOCK_FRAME,
    pairs: [{ app: `${root} [data-ctl="CTL-OFC-17-07"] > b`, frame: `${cap(`${C}Catching up`)} [data-ctl="CTL-OFC-17-07"] > b` }],
  },
  {
    // The time-left note is not compared: its box is the tile's full width in the frame, the button's column in the page.
    name: 'SCR-OFC-17 Cool-down (Reset off)',
    screen: 'SCR-OFC-17', captions: [`${C}Cool-down`], app: '/shell-preview/clock/cooldown', frame: CLOCK_FRAME,
    pairs: [{ app: `${root} .reset .btn.lg.dis`, frame: `${cap(`${C}Cool-down`)} .btn.lg.dis` }],
  },
  {
    // The bad input's box is not compared: the tile draws it 130 x 40 px at 16 px; the page's is the Running case's 42 px, 15 px field.
    name: 'SCR-OFC-17 Refused (the message icon by Jump to)',
    screen: 'SCR-OFC-17', captions: [`${C}Refused`], app: '/shell-preview/clock/refused', frame: CLOCK_FRAME,
    pairs: [{ app: `${root} .pp .r1-fmsg .ic`, frame: `${cap(`${C}Refused`)} .r1-fmsg .ic` }],
  },
  {
    name: 'SCR-OFC-27 Asking',
    screen: 'SCR-OFC-27', captions: [`${W}Asking`], app: '/shell-preview/clock/dlg-asking', frame: CLOCK_FRAME,
    pairs: within('.r1-st', cap(`${W}Asking`), DLG),
  },
  {
    name: 'SCR-OFC-27 Resetting',
    screen: 'SCR-OFC-27', captions: [`${W}Resetting`], app: '/shell-preview/clock/dlg-resetting', frame: CLOCK_FRAME,
    pairs: within('.r1-st', cap(`${W}Resetting`), [...DLG, '.r1-dlg-f .btn.busy', '.r1-dlg-f .btn.dis', '.r1-spin']),
  },
  {
    name: 'SCR-OFC-27 Done (Reset off after the reset)',
    screen: 'SCR-OFC-27', captions: [`${W}Done`], app: '/shell-preview/clock/done', frame: CLOCK_FRAME,
    pairs: [{ app: `${root} .reset .btn.lg.dis`, frame: `${cap(`${W}Done`)} .btn.lg.dis` }],
  },
];

/**
 * Captioned frame states with no look case of their own, each with the reason. The coverage test checks every caption the frame shows is
 * compared by a case or named here, and that each named one is a caption of its frame.
 */
const FRAGMENT = 'the tile draws a fragment inside a 560 px tile (padding 14 px, widths from the tile); the page draws the same pieces in its own layout, which the Running case holds';
export const NOT_COMPARED: Record<string, { frame: string; why: string }> = {
  [`${C}Loading`]: { frame: CLOCK_FRAME, why: `skeleton rows: ${FRAGMENT}; the rows are the shared r1-skel` },
};

export const CLOCK_FRAMES = [CLOCK_FRAME];

/** Captions the frame shows (read by the pw test) that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncovered(captions: Record<string, string[]>): string[] {
  const compared = new Set(CLOCK_CASES.flatMap((c) => c.captions.map((x) => `${c.frame} | ${x}`)));
  const problems: string[] = [];
  for (const [frame, caps] of Object.entries(captions)) {
    for (const c of caps) {
      if (!/^(SCR-OFC-17|SCR-OFC-27)/.test(c)) continue;
      if (compared.has(`${frame} | ${c}`)) continue;
      const n = NOT_COMPARED[c];
      if (n && n.frame === frame) continue;
      problems.push(`no case compares ${frame} | ${c}`);
    }
  }
  for (const [c, n] of Object.entries(NOT_COMPARED)) if (!(captions[n.frame] ?? []).includes(c)) problems.push(`NOT_COMPARED names a caption its frame does not show: ${n.frame} | ${c}`);
  return problems;
}
