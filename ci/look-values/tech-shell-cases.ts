// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P5-TWA-OUTBOX (BUILD_PLAN P5-TWA-OUTBOX Acceptance, look clause: CMP-10 against DK-111 in each state its
// frames show, light theme), plus CMP-09 and the Today header's waiting count on DK-107 (the block's Design SSOT frame). A
// frame tile is picked by its frozen caption (UI-DESIGN-KIT 4.1), a control-details tile by the control it shows. App
// states are the harness build's /shell-preview/tech-sync/<state> and /shell-preview/tech-frame/<state> routes
// (apps/web/src/tech/SyncPreview.tsx), each drawn in the wrapper its frame tile draws it in.
import type { SelectorPair } from './compare.ts';
import type { WidthFrom } from './shell-cases.ts';

export const OFFLINE_FRAME = 'mockups/pages/tech-offline.html';
export const TODAY_FRAME = 'mockups/pages/tech-today.html';

export interface TechShellCase {
  name: string;
  frame: string;
  /** The frame captions the case compares (a control-details tile has none). */
  captions: string[];
  app: string;
  pairs: SelectorPair[];
  widthFrom?: WidthFrom[];
  /** An app selector to wait for. */
  ready: string;
  /**
   * The app page is the service worker's own no-signal page for `app` (ci/look-values/sw-page.ts; F-1100), not a harness preview: a page
   * the phone does not hold, opened with no signal.
   */
  swNoSignal?: true;
}

const cap = (caption: string) => `[data-bw-cap="${caption}"]`;
const within = (root: string, inner: string[], frameRoot = root): SelectorPair[] => inner.map((s) => ({ app: `${root} ${s}`, frame: `${frameRoot} ${s}` }));

const NOSIG = 'CMP-10 Sync strip: No signal, waiting count';
const OLD = 'CMP-10 Sync strip: 24-hour banner';
const EMPTY = 'SCR-TEC-05 Add note, web: Empty';
const TODAY = 'SCR-TEC-02 Today, web: Success';
const TODAY_OFF = 'SCR-TEC-02 Today, web: Offline, saved';
/** The det tile of CTL-CMP-10-04 ("Sent announcement"), which carries no caption of its own. */
const SENT_TILE = '.r1-st:has(> .b > .r1p-notice[data-ctl="CTL-CMP-10-04"])';

export const TECH_SHELL_CASES: TechShellCase[] = [
  {
    name: 'CMP-10 No signal strip with the waiting count (DK-111)',
    frame: OFFLINE_FRAME, captions: [NOSIG], app: '/shell-preview/tech-sync/nosignal', ready: '.banner',
    pairs: within(cap(NOSIG), ['.banner', '.banner .bi', '.banner .bi .ic', '.banner > div', '.banner b', '.banner .bsync', '.banner .bsync .ic', '.banner small']),
  },
  {
    name: 'CMP-10 24-hour banner (DK-111)',
    frame: OFFLINE_FRAME, captions: [OLD], app: '/shell-preview/tech-sync/old', ready: '.r1p-old',
    pairs: within(cap(OLD), ['.r1p-pad', '.r1p-old', '.r1p-old .ic', '.r1p-old span', '.r1p-old a']),
    widthFrom: [{ app: cap(OLD), frame: cap(OLD) }],
  },
  {
    name: 'CMP-10 waiting count at 0, All synced, in the job header (DK-111)',
    frame: OFFLINE_FRAME, captions: [], app: '/shell-preview/tech-sync/count-synced', ready: '.sync',
    pairs: within(cap(EMPTY), ['.apphead .sync', '.apphead .sync .ic']),
  },
  {
    name: 'CMP-10 sent announcement (DK-111 control details)',
    frame: OFFLINE_FRAME, captions: [], app: '/shell-preview/tech-sync/sent', ready: '.r1p-notice',
    pairs: [
      { app: `${cap('Sent announcement')} .r1p-notice`, frame: `${SENT_TILE} .r1p-notice` },
      { app: `${cap('Sent announcement')} .r1p-notice .ic`, frame: `${SENT_TILE} .r1p-notice .ic` },
      { app: `${cap('Sent announcement')} .r1p-notice span`, frame: `${SENT_TILE} .r1p-notice span` },
    ],
    widthFrom: [{ app: cap('Sent announcement'), frame: SENT_TILE }],
  },
  {
    name: 'CMP-10 No signal card in the Today list (DK-107)',
    frame: TODAY_FRAME, captions: [TODAY_OFF], app: '/shell-preview/tech-frame/today-offline', ready: '.r1p-nosig',
    pairs: within('.bw-tech', ['.r1p-nosig', '.r1p-nosig .ic', '.r1p-nosig b'], cap(TODAY_OFF)),
    widthFrom: [{ app: '.bw-tech .list', frame: `${cap(TODAY_OFF)} .list` }],
  },
  {
    name: 'CMP-09 tab bar and the Today header\'s waiting count (DK-107)',
    frame: TODAY_FRAME, captions: [TODAY], app: '/shell-preview/tech-frame/today', ready: '.tabbar',
    pairs: [
      ...within('.bw-tech', ['.tabbar', '.tabbar [data-ctl]', '.tabbar .on', '.tabbar [data-ctl] .ic'], cap(TODAY)),
      ...within('.bw-tech', ['.apphead .sync', '.apphead .sync .ic'], cap(TODAY)),
    ],
    widthFrom: [{ app: '.bw-tech', frame: `${cap(TODAY)} .screen` }],
  },
];

/** The CMP-10 states the frames caption: every one must be compared by a case. */
export const CMP10_PREFIX = 'CMP-10 ';

export function uncoveredCmp10(captions: readonly string[], cases: readonly TechShellCase[] = TECH_SHELL_CASES): string[] {
  const covered = new Set(cases.flatMap((c) => c.captions));
  return captions.filter((c) => c.startsWith(CMP10_PREFIX) && !covered.has(c));
}
