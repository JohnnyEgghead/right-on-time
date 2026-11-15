// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P4-BILLING-UI (BUILD_PLAN P4-BILLING-UI Acceptance, look clause): SCR-OFC-10, SCR-OFC-47, SCR-PBS-01 and SCR-PBS-02 of the
// app against their frame pages, in each state a frame shows, and the CMP-01 tile "Demo clock: Running, no Change (SURF-PBS, D5a-2)" of
// all 6 r1-pbs-* frames (F-233). A frame state is picked by its frozen caption (UI-DESIGN-KIT section 4.1), the way shell-cases.ts picks
// them: the setup tags the element each caption labels with data-bw-cap. App states are the harness build's /shell-preview/billing,
// /shell-preview/pbs-list and /shell-preview/pbs-invoice routes, each fixed to its frame's data.
import type { SelectorPair } from './compare.ts';
import type { WidthFrom } from './shell-cases.ts';

export interface BillingCase {
  name: string;
  /** The captions the case compares (every captioned state of the frames has a case, or a reason in NOT_COMPARED). */
  captions: string[];
  app: string;
  frame: string;
  pairs: SelectorPair[];
  widthFrom?: WidthFrom[];
}

export const OFFICE_BILLING = 'mockups/pages/office-billing.html';
export const PBS_FRAMES = {
  'a-list': 'mockups/pages/r1-pbs-a-list.html',
  'b-list': 'mockups/pages/r1-pbs-b-list.html',
  'c-list': 'mockups/pages/r1-pbs-c-list.html',
  'a-invoice': 'mockups/pages/r1-pbs-a-invoice.html',
  'b-invoice': 'mockups/pages/r1-pbs-b-invoice.html',
  'c-invoice': 'mockups/pages/r1-pbs-c-invoice.html',
} as const;

const cap = (caption: string) => `[data-bw-cap="${caption}"]`;
const root = (screen: string) => `.r1-screen[data-screen="${screen}"]`;
const within = (appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] => inner.map((s) => ({ app: `${appRoot} ${s}`.trim(), frame: `${frameRoot} ${s}`.trim() }));

const B = 'SCR-OFC-10 Jobs not in billing: ';
const K = 'SCR-OFC-47 Mark fixed: ';
const P1 = 'SCR-PBS-01 Pretend billing: invoices and mode: ';
const P2 = 'SCR-PBS-02 Pretend billing: invoice: ';
export const CMP01 = 'CMP-01 Demo clock: Running, no Change (SURF-PBS, D5a-2)';

const CHROME = ['> .r1-demobar', '.r1-demobar .clk', '.r1-demobar .clk .lbl', '.r1-demobar .clk b', '.r1-demobar .run'];
const FOOT = ['.r1-foot', '.r1-foot a', '.r1-foot a code', '.r1-foot [data-ctl="CTL-CMP-04-02"]', '.r1-foot .demo'];

const BILLING_MAIN = [
  '.pgh', '.pgh .row', '.pgh h1', '.pgh p', '.pgh .acts', '.pgh .acts .btn', '.pgh .acts .btn .ic', '.pgh .acts .r1-live',
  '.wrap', '.banner', '.banner .ok', '.banner .ok .bi', '.banner .ok b', '.banner .ok .chip', '.banner .ok .s', '.banner .ok .r1-link',
  '.banner .keep', '.banner .keep .bi', '.banner .keep b', '.banner .keep .s',
  '.card', '.card-h', '.card-h h3', '.card-h > span',
  'table[data-ctl="CTL-OFC-10-03"]', 'table[data-ctl="CTL-OFC-10-03"] th', 'table[data-ctl="CTL-OFC-10-03"] td', 'table[data-ctl="CTL-OFC-10-03"] tr',
  '.jl', '.two', '.two b', '.two small', '.why', '.chip.bill', '.chip.retry', '.acts .btn.sm', '.acts .btn.sm.primary',
  '.lower', '.card.fixed', '.card.fixed th', '.card.fixed td', '.card.fixed .chip.site', '.card.fixed .chip.done',
];

const PBS_LIST_MAIN = [
  '.ah', '.ah .back', '.ah .t1', '.ah h1', '.ah p', '.ah .pbtag', '.grid2', '.panel', '.panel .ph', '.panel .ph h3', '.panel .ph .s',
  '.modep .cur', '.modep .cur .k', '.modep .cur .chip', '.modep .cur .s', '.radios', '.radio', '.radio .dotr', '.radio .rt b', '.radio .rt small',
  '.nfield', '.nfield label', '.ap', '.ap .btn', '.applyn',
  'table[data-ctl="CTL-PBS-01-06"]', 'table[data-ctl="CTL-PBS-01-06"] th', 'table[data-ctl="CTL-PBS-01-06"] td', 'table[data-ctl="CTL-PBS-01-06"] .chip', '.more', '.more .btn',
];

const PBS_INVOICE_MAIN = [
  '.ah', '.ah .back', '.ah .t1', '.ah h1', '.ah p', '.ah .pbtag', '.grid2', '.panel', '.meta', '.meta dt', '.meta dd',
  'table.lines', 'table.lines th', 'table.lines td', 'table.lines tr.grp td', 'table.lines tr.disc td', 'table.lines tr.tot td', '.work', '.work h4', '.work li', '.nosign',
];

export const BILLING_CASES: BillingCase[] = [
  {
    name: 'SCR-OFC-10 Success (header, link card, waiting table, Fixed table)',
    captions: [`${B}Success`], app: '/shell-preview/billing/success', frame: OFFICE_BILLING,
    pairs: within(root('SCR-OFC-10'), cap(`${B}Success`), [...CHROME, ...BILLING_MAIN, ...FOOT]),
  },
  {
    name: 'SCR-PBS-01 Success (option A: Mode panel and Invoices received)',
    captions: [`${P1}Success`], app: '/shell-preview/pbs-list/success', frame: PBS_FRAMES['a-list'],
    pairs: within(root('SCR-PBS-01'), cap(`${P1}Success`), [...CHROME, ...PBS_LIST_MAIN, ...FOOT]),
  },
  {
    name: 'SCR-PBS-02 Success (option A: meta and lines)',
    captions: [`${P2}Success`], app: '/shell-preview/pbs-invoice/success', frame: PBS_FRAMES['a-invoice'],
    pairs: within(root('SCR-PBS-02'), cap(`${P2}Success`), [...CHROME, ...PBS_INVOICE_MAIN, ...FOOT]),
  },
  // F-233: the CMP-01 tile of every r1-pbs-* frame that draws it. The 3 list frames do (listTiles); the 3 invoice frames carry the same
  // T(...) call in their source but draw invTiles, so their captions at run time hold no CMP-01 tile (the coverage test pins both facts).
  // The strip has no Change link on the page or in the tile (the pw test asserts both). The pretend billing pages' demo strip has no Change (D5a-2); the tile and the page
  // draw the same strip, so each frame's tile is read against the strip of the screen that frame shows. The tile is narrower than the
  // page, so the app strip takes the tile strip's width.
  ...(['a-list', 'b-list', 'c-list'] as const).map((k): BillingCase => {
    const screen = 'SCR-PBS-01';
    return {
      name: `CMP-01 Running, no Change on r1-pbs-${k} (${screen})`,
      captions: [CMP01], app: `/shell-preview/pbs-list/success`, frame: PBS_FRAMES[k],
      widthFrom: [{ app: `${root(screen)} > .r1-demobar`, frame: `${cap(CMP01)} .r1-demobar` }],
      pairs: [
        { app: `${root(screen)} > .r1-demobar`, frame: `${cap(CMP01)} .r1-demobar` },
        ...['.clk', '.clk .lbl', '.clk b', '.run'].map((x) => ({ app: `${root(screen)} > .r1-demobar ${x}`, frame: `${cap(CMP01)} .r1-demobar ${x}` })),
      ],
    };
  }),
];

const O = root('SCR-OFC-10');
const PL = root('SCR-PBS-01');
const DLG = '[data-screen="SCR-OFC-47"]';
const DIALOG_INNER = ['.r1-dlg-h', '.r1-dlg-h h2', '.r1-dlg-h .r1-x', '.r1-dlg-b', '.r1-dlg-b p', '.r1-field', '.r1-field label', '.r1-dlg-f', '.r1-dlg-f .btn'];

export const STATE_CASES: BillingCase[] = [
  {
    name: 'SCR-OFC-10 Error',
    captions: [`${B}Error`], app: '/shell-preview/billing/error', frame: OFFICE_BILLING,
    widthFrom: [{ app: `${O} .r1-errpanel`, frame: `${cap(`${B}Error`)} .r1-errpanel` }],
    pairs: within(O, cap(`${B}Error`), ['.r1-errpanel', '.r1-errpanel b', '.r1-errpanel .btn.sm']),
  },
  {
    name: 'SCR-OFC-10 Retrying now (busy row and Retry all)',
    captions: [`${B}Retrying now`], app: '/shell-preview/billing/retrying', frame: OFFICE_BILLING,
    pairs: [
      { app: `${O} .acts .btn.busy.sm`, frame: `${cap(`${B}Retrying now`)} td .btn.busy.sm` },
      { app: `${O} .acts .btn.busy.sm .r1-spin`, frame: `${cap(`${B}Retrying now`)} td .btn.busy.sm .r1-spin` },
      { app: `${O} .acts .btn.dis.sm`, frame: `${cap(`${B}Retrying now`)} td .btn.dis.sm` },
    ],
  },
  {
    name: 'SCR-OFC-10 Sending again (busy row)',
    captions: [`${B}Sending again`], app: '/shell-preview/billing/sending', frame: OFFICE_BILLING,
    pairs: [
      { app: `${O} td .btn.busy.sm`, frame: `${cap(`${B}Sending again`)} td .btn.busy.sm` },
      { app: `${O} td .btn.busy.sm .r1-spin`, frame: `${cap(`${B}Sending again`)} td .btn.busy.sm .r1-spin` },
      { app: `${O} td .btn.dis.sm`, frame: `${cap(`${B}Sending again`)} td .btn.dis.sm` },
    ],
  },
  {
    name: 'SCR-OFC-10 Live row (the toast; the arrived row table cells carry the tile padding, so the Success case holds them)',
    captions: [`${B}Live row`], app: '/shell-preview/billing/live', frame: OFFICE_BILLING,
    widthFrom: [{ app: `${O} .r1-toast`, frame: `${cap(`${B}Live row`)} .r1-toast` }],
    pairs: [
      ...['', ' .ic'].map((x) => ({ app: `${O} .r1-toast${x}`, frame: `${cap(`${B}Live row`)} .r1-toast${x}` })),
    ],
  },
  {
    name: 'SCR-OFC-47 Asking (the dialog)',
    captions: [`${K}Asking`], app: '/shell-preview/billing/dialog', frame: OFFICE_BILLING,
    widthFrom: [{ app: `${DLG}`, frame: `${cap(`${K}Asking`)} .r1-dlg` }],
    pairs: within(DLG, `${cap(`${K}Asking`)} .r1-dlg`, DIALOG_INNER),
  },
  {
    name: 'SCR-PBS-01 Applying (option A)',
    captions: [`${P1}Applying`], app: '/shell-preview/pbs-list/applying', frame: PBS_FRAMES['a-list'],
    widthFrom: [{ app: `${PL} .ap .btn.busy`, frame: `${cap(`${P1}Applying`)} .btn.busy` }],
    pairs: within(PL, cap(`${P1}Applying`), ['.btn.busy', '.btn.busy .r1-spin']),
  },
  {
    name: 'SCR-PBS-01 Error (option A)',
    captions: [`${P1}Error`], app: '/shell-preview/pbs-list/error', frame: PBS_FRAMES['a-list'],
    widthFrom: [{ app: `${PL} .r1-errpanel`, frame: `${cap(`${P1}Error`)} .r1-errpanel` }],
    pairs: within(PL, cap(`${P1}Error`), ['.r1-errpanel', '.r1-errpanel b', '.r1-errpanel .btn.sm']),
  },
  // F-601: the 2 states whose width cause the widthFrom remedy removes (the tile's narrow body wraps what the page draws on one line)
  {
    name: 'SCR-PBS-01 Empty (option A)',
    captions: [`${P1}Empty`], app: '/shell-preview/pbs-list/empty', frame: PBS_FRAMES['a-list'],
    widthFrom: [{ app: `${PL} .emptyb`, frame: `${cap(`${P1}Empty`)} .emptyb` }],
    pairs: within(PL, cap(`${P1}Empty`), ['.emptyb']),
  },
  {
    name: 'SCR-PBS-02 Entered by hand (option A)',
    captions: [`${P2}Entered by hand`], app: '/shell-preview/pbs-invoice/hand', frame: PBS_FRAMES['a-invoice'],
    widthFrom: [{ app: `${root('SCR-PBS-02')} .hand`, frame: `${cap(`${P2}Entered by hand`)} .hand` }],
    pairs: within(root('SCR-PBS-02'), cap(`${P2}Entered by hand`), ['.hand', '.hand p', '.hand .by']),
  },
];
BILLING_CASES.push(...STATE_CASES);

/**
 * Captioned frame states with no look case of their own, each with the reason. The coverage test checks every caption the frames show
 * is compared by a case or named here, and that each named one is a caption of its frame.
 */
export const NOT_COMPARED: Record<string, { frames: string[]; why: string }> = {
  [`${B}Loading`]: { frames: [OFFICE_BILLING], why: 'the tile pads its body differently from the page (the skeleton rows measure 147 px against 140 px wide, 421 px against 401 px); the skeleton rule itself (CMP-12 style, 12 px) is the shell\'s' },
  [`${B}Empty`]: { frames: [OFFICE_BILLING], why: 'the tile draws the note and the Fixed table with the states board\'s rules (table cell padding 10 px against the page\'s 11 px, chip type 12.5 px against 12 px); the Fixed table itself is held by the Success case' },
  [`${B}Exporting`]: { frames: [OFFICE_BILLING], why: 'the tile draws a stand-alone primary busy button; the page\'s Exporting state is the header button with its spinner, which the Success case\'s .acts .btn and the Retrying now case\'s .r1-spin hold' },
  [`${P1}Loading`]: { frames: [PBS_FRAMES['a-list'], PBS_FRAMES['b-list'], PBS_FRAMES['c-list']], why: 'the tile\'s skeleton height is a tile-only rule (DK-64 .r1-st .b .r1-skel, 14 px) against the page\'s 12 px, and its body is narrower; the widths are the frame\'s' },
  [`${P1}Empty`]: { frames: [PBS_FRAMES['b-list'], PBS_FRAMES['c-list']], why: 'options B and C were not picked (DK-65 draws option A, picked); the app is option A, whose case holds .emptyb (F-601)' },
  [`${P2}Loading`]: { frames: [PBS_FRAMES['a-invoice'], PBS_FRAMES['b-invoice'], PBS_FRAMES['c-invoice']], why: 'the tile\'s skeleton height is a tile-only rule (DK-64 .r1-st .b .r1-skel, 14 px) against the page\'s 12 px, and its body is narrower' },
  [`${P2}Entered by hand`]: { frames: [PBS_FRAMES['b-invoice'], PBS_FRAMES['c-invoice']], why: 'options B and C were not picked (DK-65 draws option A, picked); the app is option A, whose case holds .hand, its text and its By line (F-601)' },
  [`${K}Saving`]: { frames: [OFFICE_BILLING], why: 'the dialog is the Asking case\'s with a typed reason and the busy button; the busy button is the Retrying now case\'s .btn.busy and the field is the Asking case\'s .r1-field' },
  [`${K}Done`]: { frames: [OFFICE_BILLING], why: 'the tile draws the Fixed table row and the toast the Live row case holds (tr.live td, .r1-toast); the dialog is closed' },
  [`${P2}Not found`]: { frames: [PBS_FRAMES['a-invoice'], PBS_FRAMES['b-invoice'], PBS_FRAMES['c-invoice']], why: 'the tile draws one note: the Page not found page opens (SCR-SHR-02), which the shell look cases hold; the app calls notFound()' },
  [`${P1}Success`]: { frames: [PBS_FRAMES['b-list'], PBS_FRAMES['c-list']], why: 'options B and C were not picked (DK-65 draws option A, picked); the app is option A' },
  [`${P2}Success`]: { frames: [PBS_FRAMES['b-invoice'], PBS_FRAMES['c-invoice']], why: 'options B and C were not picked (DK-65 draws option A, picked); the app is option A' },
  [`${P1}Applying`]: { frames: [PBS_FRAMES['b-list'], PBS_FRAMES['c-list']], why: 'the same tile as option A\'s (listTiles), which its case holds' },
  [`${P1}Error`]: { frames: [PBS_FRAMES['b-list'], PBS_FRAMES['c-list']], why: 'the same tile as option A\'s (listTiles), which its case holds' },
};

export const BILLING_FRAMES = [OFFICE_BILLING, ...Object.values(PBS_FRAMES)];
export { cap, root, within, B, K, P1, P2, CHROME };

/** Captions the frames show (read by the pw test) that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncovered(captions: Record<string, string[]>): string[] {
  const compared = new Set(BILLING_CASES.flatMap((c) => c.captions.map((x) => `${c.frame} | ${x}`)));
  const problems: string[] = [];
  for (const [frame, caps] of Object.entries(captions)) {
    for (const c of caps) {
      if (!/^(SCR-OFC-10|SCR-OFC-47|SCR-PBS-01|SCR-PBS-02|CMP-01 Demo clock: Running, no Change)/.test(c)) continue;
      if (compared.has(`${frame} | ${c}`)) continue;
      const n = NOT_COMPARED[c];
      if (n && n.frames.includes(frame)) continue;
      problems.push(`no case compares ${frame} | ${c}`);
    }
  }
  for (const [c, n] of Object.entries(NOT_COMPARED)) for (const f of n.frames) if (!(captions[f] ?? []).includes(c)) problems.push(`NOT_COMPARED names a caption its frame does not show: ${f} | ${c}`);
  return problems;
}

// Pairs used by the state cases below this line are added as each state is measured.
export type { WidthFrom };
