// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-MESSAGES (BUILD_PLAN P4-MESSAGES Acceptance, look clause): SCR-OFC-08 and SCR-OFC-09 of the app against their frame pages
// (DK-93 mockups/pages/office-messages.html, DK-94 mockups/pages/office-call-list.html), in each state a frame shows. A frame state is picked by
// its frozen caption (UI-DESIGN-KIT section 4.1), the way billing-cases.ts picks them: the setup tags the element each caption labels with
// data-bw-cap. App states are the harness build's /shell-preview/messages and /shell-preview/call-list routes, each fixed to its frame's data.
import type { SelectorPair } from './compare.ts';
import type { WidthFrom } from './shell-cases.ts';

export interface MessagesCase {
  name: string;
  /** The captions the case compares (every captioned state of the frames has a case, or a reason in NOT_COMPARED). */
  captions: string[];
  app: string;
  frame: string;
  pairs: SelectorPair[];
  widthFrom?: WidthFrom[];
}

const OFFICE_MESSAGES = 'mockups/pages/office-messages.html';
const OFFICE_CALL_LIST = 'mockups/pages/office-call-list.html';

const cap = (caption: string) => `[data-bw-cap="${caption}"]`;
const root = (screen: string) => `.r1-screen[data-screen="${screen}"]`;
/** The same inner selector on both sides; `swap` renames a class the app spells differently (the app body is .r1, whose kit rules the frame's body does not take). */
const within = (appRoot: string, frameRoot: string, inner: string[], swap: Record<string, string> = {}): SelectorPair[] =>
  inner.map((s) => {
    let a = s;
    for (const [from, to] of Object.entries(swap)) a = a.split(from).join(to);
    return { app: `${appRoot} ${a}`.trim(), frame: `${frameRoot} ${s}`.trim() };
  });

const L = 'SCR-OFC-08 Messages: text log: ';
const C = 'SCR-OFC-09 Messages: call list: ';

const CHROME = ['> .r1-demobar', '.r1-demobar .clk', '.r1-demobar .clk .lbl', '.r1-demobar .clk b', '.r1-demobar .run'];
const FOOT = ['.r1-foot', '.r1-foot a', '.r1-foot a code', '.r1-foot [data-ctl="CTL-CMP-04-02"]', '.r1-foot .demo'];

const HEADER = [
  '.mh', '.mh .row', '.mh h1', '.mh p', '.mh .acts', '.mh .acts .r1-live', '.tabs', '.tabs a', '.tabs a.on', '.tabs a .ic', '.tabs .n',
];

// Left out of the text log's list, each for a stated reason (the coverage is otherwise the whole page):
//   .work, .panel, .logp, .detp: their height. The frame is a 1440 x 900 picture whose .work is a fixed 648 px box that clips its log (the
//     table and the panel are taller); the page grows to fit them (styles/app/messages.css). Every other property of those boxes is held by
//     their children's cases and by the box-less rules below.
//   .tile .lb of the 2nd tile: its width follows its sub text. The frame's "no mobile or texts off" is a call-list reason; the tile counts
//     the texts that were not sent (all 5 tries failed, or no longer needed), so it says that.
//   the last row's .stc: the frame's note "no text sent back before 8 AM" belongs to a C reply, which sends no text back (SPECIFICATIONS 6.4).
const LOG_MAIN = [
  ...HEADER, '.mh .acts .btn', '.mh .acts .btn .ic',
  '.tiles', '.tile', '.tile .num', '.tile:not(:nth-child(2)) .lb', '.tile:not(:nth-child(2)) .lb small', '.tile.held', '.tile.fail',
  '.fbar', '.fsel', '.fsel .k', '.fsel b', '.fsel .ic', '.fbar .find', '.fbar .find .ic',
  'table.log', 'table.log th', 'table.log td', 'table.log td.tm', 'table.log .cu b', 'table.log .cu small', 'table.log .tx', 'table.log tr.pick td',
  '.ty', '.ty .ic', '.lang', '.lang.es', 'tr:not(:last-child) .stc', 'tr:not(:last-child) .stc small', '.chip', '.chip .dot', '.chip.held', '.chip.held .ic', '.chip.sent', '.chip.late', '.chip.site', '.chip.replyc', '.chip.replyr',
  '.foot', '.foot .pg', '.foot .btn.sm', '.foot [data-ctl="CTL-OFC-08-25"]', '.foot [data-ctl="CTL-OFC-08-25"] .ic',
  '.dh', '.dh .t1', '.dh h2', '.dh .sub', '.bubble', '.meta', '.tries', '.tries h4', '.try', '.try .d', '.try .d.x', '.try .d.n', '.try .w', '.try .w small',
  '.never', '.never .ic', '.vis', '.vis h4', '.dacts', '.dacts .btn', '.dacts .btn .ic',
];

// Left out of the call list's list, each for a stated reason:
//   a.jlk after the first row, table.cl small and .done small of the last column: their width follows their text. The frame's service names
//     ("Boiler service", "AC not cooling") and notes ("left message") are not the catalog's services or the API's fields; the first row's
//     link ("Furnace tune-up") is the same word on both sides and holds the link's rule.
const CALL_MAIN = [
  ...HEADER,
  '.work', '.panel', '.listp', '.lh', '.lh h2', '.lh .why', '.lh .acts', '.lh .fsel', '.lh .fsel .k', '.lh .fsel b', '.lh .fsel .ic', '.lh .btn', '.lh .btn .ic',
  '.prog', '.prog b', '.prog .bar', '.prog .bar i', '.prog .k', '.prog .k i',
  'table.cl', 'table.cl th', 'table.cl td', 'table.cl b', 'table.cl td:not(:last-child) small', 'table.cl .ph', 'table.cl .win', 'table.cl .lang', 'table.cl .lang.es',
  '.outs', '.ob', '.ob.c', '.ob.r', '.ob.n', '.done', '.chip', '.chip .dot', '.chip.conf', '.chip.resch', '.chip.noans', '.chg', 'tr.called td', 'tr:first-child a.jlk',
  '.side', '.side .panel', '.side h3', '.seg', '.seg span', '.seg span.on', '.script', '.script b', '.rules', '.rules div', '.rules .ic', '.ftx', '.ftx .fr', '.ftx .fr small', '.ftx .outs', '.ftx .ob',
];

const SWAP_CALL = { '.side': '.bw-cl-side', '.ph': '.bw-ph' };

export const MESSAGES_CASES: MessagesCase[] = [
  {
    name: 'SCR-OFC-08 Success (header, tiles, filters, log, footer, text detail)',
    captions: [`${L}Success`], app: '/shell-preview/messages/success', frame: OFFICE_MESSAGES,
    pairs: within(root('SCR-OFC-08'), cap(`${L}Success`), [...CHROME, ...LOG_MAIN, ...FOOT]),
  },
  {
    name: 'SCR-OFC-09 Success (header, reminder calls, progress, outcomes, script, side cards)',
    captions: [`${C}Success`], app: '/shell-preview/call-list/success', frame: OFFICE_CALL_LIST,
    pairs: within(root('SCR-OFC-09'), cap(`${C}Success`), [...CHROME, ...CALL_MAIN, ...FOOT], SWAP_CALL),
  },
];

const O = root('SCR-OFC-08');
const K = root('SCR-OFC-09');

export const STATE_CASES: MessagesCase[] = [
  {
    name: 'SCR-OFC-08 Error',
    captions: [`${L}Error`], app: '/shell-preview/messages/error', frame: OFFICE_MESSAGES,
    widthFrom: [{ app: `${O} .r1-errpanel`, frame: `${cap(`${L}Error`)} .r1-errpanel` }],
    pairs: within(O, cap(`${L}Error`), ['.r1-errpanel', '.r1-errpanel b', '.r1-errpanel .btn.sm']),
  },
  {
    name: 'SCR-OFC-08 Live row (the simulator notice)',
    captions: [`${L}Live row`], app: '/shell-preview/messages/live', frame: OFFICE_MESSAGES,
    widthFrom: [{ app: `${O} .simn`, frame: `${cap(`${L}Live row`)} .simn` }],
    pairs: within(O, cap(`${L}Live row`), ['.simn', '.simn .ic']),
  },
  {
    name: 'SCR-OFC-09 Error',
    captions: [`${C}Error`], app: '/shell-preview/call-list/error', frame: OFFICE_CALL_LIST,
    widthFrom: [{ app: `${K} .r1-errpanel`, frame: `${cap(`${C}Error`)} .r1-errpanel` }],
    pairs: within(K, cap(`${C}Error`), ['.r1-errpanel', '.r1-errpanel b', '.r1-errpanel .btn.sm']),
  },
];
MESSAGES_CASES.push(...STATE_CASES);

/**
 * Captioned frame states with no look case of their own, each with the reason. The coverage test checks every caption the frames show
 * is compared by a case or named here, and that each named one is a caption of its frame.
 */
export const NOT_COMPARED: Record<string, { frames: string[]; why: string }> = {
  [`${L}Loading`]: { frames: [OFFICE_MESSAGES], why: 'the tile pads its body differently from the page and sizes the skeleton with a tile-only rule (DK-64 .r1-st .b .r1-skel); the skeleton rule itself (CMP-12 style) is the shell cases\' Loading' },
  [`${L}Empty day`]: { frames: [OFFICE_MESSAGES], why: 'the tile draws the filter bar and the note with the states board\'s rules (.r1-st .b padding, the .r1-note margin); the filter bar is the Success case\'s .fbar and .fsel' },
  [`${L}Empty filter`]: { frames: [OFFICE_MESSAGES], why: 'the same tile as Empty day with Clear filters added, a .btn.sm the Success case holds in .foot' },
  [`${L}Trying now`]: { frames: [OFFICE_MESSAGES], why: 'the tile draws the panel\'s tries and buttons with the states board\'s padding (.tries padding 0, .dacts border 0); the busy button is the shell cases\' .btn.busy, the tries are the Success case\'s' },
  [`${L}Added to call list`]: { frames: [OFFICE_MESSAGES], why: 'the tile draws .never and .dacts with the states board\'s margin and padding; both are the Success case\'s, and .btn.dis is the shell cases\'' },
  [`${L}Exporting`]: { frames: [OFFICE_MESSAGES], why: 'the tile draws a stand-alone primary busy button; the page\'s Exporting state is the header button with its spinner, the shell cases\' .btn.busy' },
  [`${C}Loading`]: { frames: [OFFICE_CALL_LIST], why: 'the tile pads its body differently from the page and sizes the skeleton with a tile-only rule (DK-64 .r1-st .b .r1-skel); the skeleton rule itself is the shell cases\' Loading' },
  [`${C}Empty`]: { frames: [OFFICE_CALL_LIST], why: 'the tile draws the 2 notes with the states board\'s margins (.r1-note margin 4px 0 12px); the page draws one in the list panel' },
  [`${C}Recording`]: { frames: [OFFICE_CALL_LIST], why: 'the tile draws a row\'s buttons stand-alone with an inline opacity .6 on the disabled ones; the page\'s buttons are the Success case\'s .ob, and the busy one is the shell cases\' .btn.busy spinner' },
  [`${C}Correcting`]: { frames: [OFFICE_CALL_LIST], why: 'the tile draws a row\'s done line and buttons stand-alone with inline margins; both are the Success case\'s .done and .outs' },
};

export const MESSAGES_FRAMES = [OFFICE_MESSAGES, OFFICE_CALL_LIST];
export { cap, root, within, L, C, CHROME, FOOT };

/** Captions the frames show (read by the pw test) that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncovered(captions: Record<string, string[]>): string[] {
  const compared = new Set(MESSAGES_CASES.flatMap((c) => c.captions.map((x) => `${c.frame} | ${x}`)));
  const problems: string[] = [];
  for (const [frame, caps] of Object.entries(captions)) {
    for (const c of caps) {
      if (!/^(SCR-OFC-08|SCR-OFC-09)/.test(c)) continue;
      if (compared.has(`${frame} | ${c}`)) continue;
      const n = NOT_COMPARED[c];
      if (n && n.frames.includes(frame)) continue;
      problems.push(`no case compares ${frame} | ${c}`);
    }
  }
  for (const [c, n] of Object.entries(NOT_COMPARED)) for (const f of n.frames) if (!(captions[f] ?? []).includes(c)) problems.push(`NOT_COMPARED names a caption its frame does not show: ${f} | ${c}`);
  return problems;
}
