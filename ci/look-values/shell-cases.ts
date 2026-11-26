// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P2-SHELL (BUILD_PLAN P2-SHELL Acceptance, look clause): each shared component and shared page of the
// app against its kit frame, in the state that frame shows. A frame is picked by its frozen caption (UI-DESIGN-KIT
// section 4.1): the setup tags the element each caption labels with data-bw-cap, so a selector names the frame, never
// a position. App pages are the harness build's /shell-preview/frame/<name> routes (apps/web/app/shell-preview).
import type { Page } from 'playwright';
import type { SelectorPair } from './compare.ts';

export interface ShellCase {
  name: string;
  /** Component or screen IDs the case holds the look of. */
  covers: string[];
  app: string;
  frame: string;
  pairs: SelectorPair[];
  /**
   * Container widths taken from the frame: a state tile is narrower than a page, and a block (the error panel) or a
   * flex line (the strip's banner line, which ellipsizes) takes its container's width. Before reading, the app element
   * is given the frame element's width, so the case compares the component, not the tile it was drawn in.
   */
  widthFrom?: WidthFrom[];
  /** An app selector to wait for after load (a component that draws after it loads, such as the map). */
  ready?: string;
  /** The case needs the branch map files: the page is served them from .build/data/maps and reloaded (map-files.ts). */
  maps?: boolean;
}

export interface WidthFrom {
  app: string;
  frame: string;
  /**
   * App elements inside the container that the frame tile leaves out (the More tile draws the bar without the branch
   * and the bell): their border-box widths, each with the container's column gap, are added to the frame width, so the
   * app container has the same room for the rest as the tile has.
   */
  plusApp?: string[];
}

/** Tags each frame: a caption inside a state tile labels the tile; a caption above a screen labels that screen. */
export async function tagFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null; closest(s: string): { setAttribute(k: string, v: string): void } | null; nextElementSibling: { setAttribute(k: string, v: string): void } | null }> } }).document;
    const caps = d.querySelectorAll('p.frame-cap');
    for (let i = 0; i < caps.length; i++) {
      const cap = caps[i]!;
      const text = (cap.textContent ?? '').trim();
      const target = cap.closest('.r1-st') ?? cap.nextElementSibling;
      target?.setAttribute('data-bw-cap', text);
    }
  });
}

type Box = { getBoundingClientRect(): { width: number }; style: { width: string; boxSizing: string } };
type Doc = { querySelector(s: string): Box | null };
type Win = { getComputedStyle(e: Box): { columnGap: string }; requestAnimationFrame(f: () => void): void };

/** The frame widths of a case's widthFrom entries, read on the tagged frame page (CSS px, unrounded). */
export async function frameWidths(framePage: Page, entries: { frame: string }[]): Promise<number[]> {
  await tagFrames(framePage);
  return framePage.evaluate((sels) => {
    const d = (globalThis as unknown as { document: Doc }).document;
    return sels.map((s) => {
      const el = d.querySelector(s);
      if (!el) throw new Error(`widthFrom: frame selector matches nothing: ${s}`);
      return el.getBoundingClientRect().width;
    });
  }, entries.map((e) => e.frame));
}

/**
 * Gives each app element its frame width (border-box, as the kit's base sets every box), plus its plusApp elements, then
 * waits 3 frames: a component that measures its width (the bar's More fit) has re-rendered before values are read.
 */
export async function applyWidths(appPage: Page, entries: { app: string; plusApp?: string[] }[], widths: number[]): Promise<void> {
  await appPage.evaluate(
    async ({ list, ws }) => {
      const g = globalThis as unknown as { document: Doc } & Win;
      const d = g.document;
      list.forEach(({ app: s, plusApp }, i) => {
        const el = d.querySelector(s);
        if (!el) throw new Error(`widthFrom: app selector matches nothing: ${s}`);
        let w = ws[i]!;
        const gap = parseFloat(g.getComputedStyle(el).columnGap) || 0;
        for (const p of plusApp ?? []) {
          const extra = d.querySelector(`${s} ${p}`);
          if (!extra) throw new Error(`widthFrom: plusApp selector matches nothing: ${s} ${p}`);
          w += extra.getBoundingClientRect().width + gap;
        }
        el.style.boxSizing = 'border-box';
        el.style.width = `${w}px`;
      });
      for (let f = 0; f < 3; f++) await new Promise<void>((r) => g.requestAnimationFrame(() => r()));
    },
    { list: entries.map((e) => ({ app: e.app, plusApp: e.plusApp ?? [] })), ws: widths },
  );
}

const cap = (caption: string) => `[data-bw-cap="${caption}"]`;

/** The same inner selectors on both sides, under an app root and a frame root. */
function within(appRoot: string, frameRoot: string, inner: string[]): SelectorPair[] {
  return inner.map((s) => ({ app: `${appRoot} ${s}`.trim(), frame: `${frameRoot} ${s}`.trim() }));
}

const STRIP = ['.r1-demobar .clk', '.r1-demobar .clk .lbl', '.r1-demobar .clk b', '.r1-demobar .run'];
const FOOT = ['.r1-foot', '.r1-foot a', '.r1-foot a code', '.r1-foot [data-ctl="CTL-CMP-04-02"]', '.r1-foot .demo'];
const SHARED = [
  '> .r1-demobar',
  ...STRIP,
  '.shr-head',
  '.shr-head .brand .word',
  '.shr-head .prod',
  '.shr-head .r1-lang',
  '.shr-head .r1-lang a',
  '.shr-main',
  '.shr-card',
  '.shr-ico',
  '.shr-card h1',
  '.shr-card p',
  '.shr-acts',
  '.shr-acts .btn',
  '.shr-code',
  ...FOOT,
];
const TOPBAR = [
  'header.topbar',
  'header.topbar .brand .word',
  'header.topbar .brand .word small',
  'header.topbar .appname',
  'header.topbar nav',
  'header.topbar nav a',
  'header.topbar .branch',
  'header.topbar .search',
  'header.topbar .search kbd',
  'header.topbar .iconbtn',
  'header.topbar .iconbtn .badge',
  'header.topbar .user',
  'header.topbar .user .av',
  'header.topbar .user .role',
];
const SIDE = ['.side', '.side h4', '.side a', '.side a .ic'];
// The CMP-07 state tiles of office-board (DK-85). Each tile draws the part of the bar its state changes, so a case reads
// that part: the More toggle and menu, the results list, the user menu. The bar itself is held by the main-screen case.
const TB_MORE = 'CMP-07 Office top bar: More menu';
const TB_SEARCH = 'CMP-07 Office top bar: Search results';
const TB_USER = 'CMP-07 Office top bar: User menu with Press / to search';
const MORE = ['header.topbar nav a', 'header.topbar nav a[data-ctl="CTL-CMP-07-03"]', '.r1-menu', '.r1-menu a'];
const SEARCH_RESULTS = ['.sres', '.sres h5', '.sres a'];
const USER_MENU = [
  '.r1-menu',
  '.r1-menu .mi',
  '.r1-menu .av',
  '.r1-menu .mi b',
  '.r1-menu .mi small',
  '.r1-menu .sep',
  '.r1-menu .r1-lang',
  '.r1-menu .r1-lang a',
  '.r1-menu .r1-switch',
  '.r1-menu .r1-switch .trk',
  '.r1-menu .r1-switch .st',
  '.r1-menu a[role="menuitem"]',
];

const shared = (n: '403' | '404' | '500', caption: string, screen: string, signedIn = false): ShellCase => ({
  name: `${screen} ${caption.split(': ')[1]}`,
  covers: [screen, 'CMP-01', 'CMP-03', 'CMP-04'],
  app: `/shell-preview/shared/${signedIn ? `${n}-in` : n}`,
  frame: `mockups/pages/r1-shr-${n}.html`,
  pairs: within('.r1-screen', cap(caption), SHARED),
  // F-1047: the way on is read from API-07 after load; wait until the signed-in session has turned Book a visit into the home link.
  ...(signedIn ? { ready: '.shr-acts .btn[href="/office/board"]' } : {}),
});

// CMP-05 Map (P3-MAP-WEB; DK-85 office-board): the board panel's map box, zoom, credit, legend and markers on the main screen,
// the jobs legend, the "Approximate route" label, and the "The map could not load" tile. The frame draws its markers into 1
// svg, so a marker is read by its place among the svg's children (the frame is frozen, UI-DESIGN-KIT section 4): child 270 is
// the first van on site (MB), child 274 the first van on the way (DK). The app draws the same 2 initials.
const BOARD = cap('SCR-OFC-02 Dispatch board: Moving');
const FAIL = 'CMP-05 Map: The map could not load';
const MAP_CASES: ShellCase[] = [
  {
    name: 'CMP-05 Map on the board panel: box, zoom, credit, legend, van markers (office-board main screen)',
    covers: ['CMP-05'],
    app: '/shell-preview/map/board',
    frame: 'mockups/pages/office-board.html',
    maps: true,
    ready: '[data-map-state="ready"]',
    pairs: [
      { app: '.r1-map.bw-map-panel', frame: `${BOARD} .mapbox` },
      { app: '.bw-map-panel .zm', frame: `${BOARD} .mapbox .zoom` },
      { app: '.bw-map-panel .zm button', frame: `${BOARD} .mapbox .zoom span` },
      { app: '.bw-map-panel a.osm', frame: `${BOARD} .mapbox .osm` },
      { app: '.bw-mkey', frame: `${BOARD} .mkey`, wrapRuled: 'F-816, owner answer e18182a0: the added words take a 2nd line' },
      { app: '.bw-mkey span:not(:has(.free))', frame: `${BOARD} .mkey span` }, // the 4 key words the frame draws (F-816)
      { app: '.bw-mkey i:not(.free)', frame: `${BOARD} .mkey i` },
      { app: '[data-marker-id="v2"] circle', frame: `${BOARD} .mapbox svg > :nth-child(270) > circle` },
      { app: '[data-marker-id="v2"] text', frame: `${BOARD} .mapbox svg > :nth-child(270) > text` },
      { app: '[data-marker-id="v1"] circle', frame: `${BOARD} .mapbox svg > :nth-child(274) > circle` },
      { app: '[data-marker-id="v1"] text', frame: `${BOARD} .mapbox svg > :nth-child(274) > text` },
    ],
    widthFrom: [{ app: '.bw-prev-panel', frame: `${BOARD} .mapbox` }],
  },
  {
    name: 'CMP-05 Map on the board: the "Approximate route" label (office-board Filtered by skill tile)',
    covers: ['CMP-05'],
    app: '/shell-preview/map/board',
    frame: 'mockups/pages/office-board.html',
    maps: true,
    ready: '[data-map-state="ready"]',
    pairs: [{ app: '.bw-aprx', frame: `${cap('SCR-OFC-02 Dispatch board: Filtered by skill')} .aprx` }],
  },
  {
    name: 'CMP-05 Map on the board: the Jobs legend (office-board Jobs on the map tile)',
    covers: ['CMP-05'],
    app: '/shell-preview/map/jobs',
    frame: 'mockups/pages/office-board.html',
    maps: true,
    ready: '[data-map-state="ready"]',
    pairs: [
      { app: '.bw-mkey span:not(:has(.jobWay, .jobSite, .jobClosed))', frame: `${cap('SCR-OFC-02 Dispatch board: Jobs on the map')} .mkey span` },
      { app: '.bw-mkey i.jm:not(.jobWay, .jobSite, .jobClosed)', frame: `${cap('SCR-OFC-02 Dispatch board: Jobs on the map')} .mkey i.jm` },
    ],
    // The tile draws the legend on the full tile width; 4 job words do not fit the 372 px panel on 1 line.
    widthFrom: [{ app: '.bw-prev-panel', frame: `${cap('SCR-OFC-02 Dispatch board: Jobs on the map')} .mkey` }],
  },
  {
    name: 'CMP-05 Map: The map could not load (office-board tile)',
    covers: ['CMP-05'],
    app: '/shell-preview/map/live?fail=1',
    frame: 'mockups/pages/office-board.html',
    ready: '[data-map-state="failed"]',
    pairs: within('[data-preview-map]', cap(FAIL), ['.r1-map', '.r1-map .fail', '.r1-map .fail .ic', '.r1-map .osm', '.r1-mapalt', '.r1-mapalt li']),
    widthFrom: [{ app: '.bw-prev-card', frame: `${cap(FAIL)} .r1-map` }],
  },
];

export const SHELL_CASES: ShellCase[] = [
  shared('403', 'SCR-SHR-01 No access: Refused', 'SCR-SHR-01'),
  // The frame's Missing state is the signed-in one ("Go to your home page"); a signed-out reader gets Book a visit (CTL-SHR-02-02).
  // F-1049, accepted at P5-CLOSE: the signed-out Book a visit button (CTL-SHR-02-02, .shr-acts .btn) has no look case. mockups/pages/r1-shr-404.html
  // draws it only as an uncaptioned control-detail tile (a btn primary lg, not the screen's button), and tagFrames keys frames on their captions, so
  // there is nothing to pair it with. Only the signed-in Missing state is compared; the signed-out state's control is read by the bookmenu stack (ci/bookmenu-stack, F-925).
  shared('404', 'SCR-SHR-02 Page not found: Missing', 'SCR-SHR-02', true),
  shared('500', 'SCR-SHR-03 Something went wrong: Failed', 'SCR-SHR-03'),
  {
    name: 'CMP-01 Running with Change, CMP-07 Admin current, CMP-08, CMP-04 (r1-admin-clock main screen)',
    covers: ['CMP-01', 'CMP-07', 'CMP-08', 'CMP-04'],
    app: '/shell-preview/frame/admin-clock',
    frame: 'mockups/pages/r1-admin-clock.html',
    pairs: within('.r1-screen', 'body > .r1-screen', ['> .r1-demobar', ...STRIP, '.r1-demobar a', ...TOPBAR, ...SIDE, ...FOOT]),
  },
  {
    name: 'CMP-07 Office top bar, Board current (office-board main screen)',
    covers: ['CMP-07', 'CMP-01'],
    app: '/shell-preview/frame/office-board',
    frame: 'mockups/pages/office-board.html',
    pairs: [
      ...within('.r1-screen', cap('SCR-OFC-02 Dispatch board: Moving'), ['> .r1-demobar', ...STRIP, '.r1-demobar a']),
      ...within('.r1-screen', `${cap('SCR-OFC-02 Dispatch board: Moving')} .r1k-in`, TOPBAR),
    ],
  },
  {
    name: 'CMP-07 Office top bar: More menu (office-board tile)',
    covers: ['CMP-07'],
    app: '/shell-preview/frame/topbar-states',
    frame: 'mockups/pages/office-board.html',
    pairs: within('[data-state="more"]', cap(TB_MORE), MORE),
    widthFrom: [{ app: '[data-state="more"] header.topbar', frame: `${cap(TB_MORE)} header.topbar`, plusApp: ['.branch', '.iconbtn'] }],
  },
  {
    name: 'CMP-07 Office top bar: Search results (office-board tile)',
    covers: ['CMP-07'],
    app: '/shell-preview/frame/topbar-states',
    frame: 'mockups/pages/office-board.html',
    pairs: within('[data-state="search"]', cap(TB_SEARCH), SEARCH_RESULTS),
  },
  {
    name: 'CMP-07 Office top bar: User menu with Press / to search (office-board tile)',
    covers: ['CMP-07'],
    app: '/shell-preview/frame/topbar-states',
    frame: 'mockups/pages/office-board.html',
    pairs: within('[data-state="user"]', cap(TB_USER), USER_MENU),
  },
  {
    name: 'CMP-01 Paused and CMP-02 Last move, Catching up, World reset notice (r1-admin-clock tiles)',
    covers: ['CMP-01', 'CMP-02'],
    app: '/shell-preview/frame/clock-states',
    frame: 'mockups/pages/r1-admin-clock.html',
    pairs: [
      ...within('[data-state="paused"]', cap('CMP-01 Demo clock: Paused'), [...STRIP, '.r1-demobar a']),
      ...within('[data-state="moved"]', cap('CMP-02 Clock banner: Last move'), [...STRIP, '.r1-demobar a', '.r1-demobar .moved', '.r1-demobar .moved b']),
      ...within('[data-state="catching-up"]', cap('CMP-02 Clock banner: Catching up'), [...STRIP, '.r1-demobar .moved']),
      ...within('[data-state="reset"]', cap('CMP-02 Clock banner: World reset notice'), [...STRIP, '.r1-demobar .moved']),
    ],
    widthFrom: [
      { app: '[data-state="paused"] .r1-demobar', frame: `${cap('CMP-01 Demo clock: Paused')} .r1-demobar` },
      { app: '[data-state="moved"] .r1-demobar', frame: `${cap('CMP-02 Clock banner: Last move')} .r1-demobar` },
      { app: '[data-state="catching-up"] .r1-demobar', frame: `${cap('CMP-02 Clock banner: Catching up')} .r1-demobar` },
      { app: '[data-state="reset"] .r1-demobar', frame: `${cap('CMP-02 Clock banner: World reset notice')} .r1-demobar` },
    ],
  },
  {
    name: 'CMP-11 Toast, CMP-13 Live, Reconnecting, Updates paused with Refresh, CMP-16 number shown (office-board tiles)',
    covers: ['CMP-11', 'CMP-13', 'CMP-16'],
    app: '/shell-preview/frame/components',
    frame: 'mockups/pages/office-board.html',
    pairs: [
      ...within('[data-state="toast"]', cap('CMP-11 Announcement region: Toast'), ['.r1-toast', '.r1-toast .ic']),
      ...within('[data-state="live"]', cap('CMP-13 Live updates indicator: Live'), ['.r1-live']),
      ...within('[data-state="reconnecting"]', cap('CMP-13 Live updates indicator: Reconnecting'), ['.r1-live']),
      ...within('[data-state="paused"]', cap('CMP-13 Live updates indicator: Updates paused, with Refresh'), ['.r1-live', '.btn']),
      ...within('[data-state="call"]', cap('CMP-16 Call button: On a computer: number shown'), ['.btn.sm', '.r1-pop', '.r1-pop h3']),
    ],
  },
  {
    name: 'CMP-12 Error panel with Try again (r1-admin-history tile)',
    covers: ['CMP-12'],
    app: '/shell-preview/frame/components',
    frame: 'mockups/pages/r1-admin-history.html',
    pairs: within('[data-state="error"]', cap('CMP-12 Error panel: Error with Try again'), ['.r1-errpanel', '.r1-errpanel .ic', '.r1-errpanel b', '.r1-errpanel .btn']),
    widthFrom: [{ app: '[data-state="error"]', frame: `${cap('CMP-12 Error panel: Error with Try again')} .r1-errpanel` }],
  },
  ...MAP_CASES,
];

/** The look clause names these; every one must be covered by at least 1 case. */
export const REQUIRED_COVERAGE = ['CMP-01', 'CMP-02', 'CMP-05', 'CMP-07', 'CMP-08', 'CMP-12', 'CMP-13', 'SCR-SHR-01', 'SCR-SHR-02', 'SCR-SHR-03'];

/**
 * The frames of the look clause (DK-85 office-board, r1-admin-clock, r1-admin-history, the 3 shared pages). Every
 * captioned state of a REQUIRED_COVERAGE ID on these pages must be compared by a case (F-226): a state is keyed by its
 * frozen caption, not by the component ID, so a state with no case fails the coverage test.
 */
export const LOOK_FRAMES = [
  'mockups/pages/office-board.html',
  'mockups/pages/r1-admin-clock.html',
  'mockups/pages/r1-admin-history.html',
  'mockups/pages/r1-shr-403.html',
  'mockups/pages/r1-shr-404.html',
  'mockups/pages/r1-shr-500.html',
];

/**
 * Captioned tiles that draw the same markup as a screen a case already compares, so the state is held by that case.
 * Each names the case and why; the coverage test checks the case exists on the same frame.
 */
const DRAWN_AS: Record<string, { frame: string; caseName: string; why: string }> = {
  'CMP-07 Office top bar: Spec order (Billing, Demo clock in Admin)': {
    frame: 'mockups/pages/office-board.html',
    caseName: 'CMP-07 Office top bar, Board current (office-board main screen)',
    why: 'the tile draws O.topbar("Board") at zoom .94, the bar of the main screen; the Demo clock side link is held by the r1-admin-clock case',
  },
  'CMP-01 Demo clock: Running, with Change (manager)': {
    frame: 'mockups/pages/r1-admin-clock.html',
    caseName: 'CMP-01 Running with Change, CMP-07 Admin current, CMP-08, CMP-04 (r1-admin-clock main screen)',
    why: 'the tile draws O.demobar(), the default bar with Change that the main screen carries',
  },
};

/** The frame states a case really compares: the captions its frame selectors read. */
function comparedStates(cases: ShellCase[]): Set<string> {
  const out = new Set<string>();
  for (const c of cases) {
    for (const p of c.pairs) {
      for (const m of (p.frame ?? p.app).matchAll(/\[data-bw-cap="([^"]+)"\]/g)) out.add(`${c.frame} | ${m[1]}`);
    }
  }
  return out;
}

/** The required states (frame | caption) that no case compares and DRAWN_AS does not hold; and DRAWN_AS rows that are wrong. */
export function uncoveredStates(captions: Record<string, string[]>, cases: ShellCase[], drawnAs = DRAWN_AS): string[] {
  const compared = comparedStates(cases);
  const problems: string[] = [];
  for (const [frame, caps] of Object.entries(captions)) {
    for (const caption of caps) {
      if (!REQUIRED_COVERAGE.includes(caption.split(' ')[0]!)) continue;
      const key = `${frame} | ${caption}`;
      if (compared.has(key)) continue;
      const d = drawnAs[caption];
      if (d && d.frame === frame && cases.some((c) => c.name === d.caseName && c.frame === frame)) continue;
      problems.push(`no case compares ${key}`);
    }
  }
  for (const [caption, d] of Object.entries(drawnAs)) {
    if (!(captions[d.frame] ?? []).includes(caption)) problems.push(`DRAWN_AS names a caption its frame does not show: ${d.frame} | ${caption}`);
    if (!cases.some((c) => c.name === d.caseName && c.frame === d.frame)) problems.push(`DRAWN_AS names no case on ${d.frame}: ${d.caseName}`);
  }
  return problems;
}

/** The copied kit sheets (look clause: byte for byte). */
export const KIT_COPIES = [
  { app: 'apps/web/styles/kit/kit.css', kit: 'docs/design/kit.css' },
  { app: 'apps/web/styles/kit/tokens/brand.css', kit: 'docs/design/tokens/brand.css' },
];
