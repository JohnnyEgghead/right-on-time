// SPDX-License-Identifier: AGPL-3.0-or-later
// The look cases of P5-LIVEMAP (BUILD_PLAN P5-LIVEMAP Acceptance, look clause): SCR-CUS-04 Live map: on the way against mockups/pages/customer-live-map.html
// (DK-123) and SCR-CUS-05 Live map: ended against mockups/pages/customer-live-map-ended.html (DK-124), in each state the frames show (light theme). A
// frame state is picked by its frozen caption (UI-DESIGN-KIT section 4.1), as health-cases.ts picks them: the setup tags the element each caption labels with
// data-bw-cap, and a frame's phone screen is the `.pg` inside it. App states are the harness build's /shell-preview/livemap and /shell-preview/livemap-ended
// routes, each fixed to its frame's data. The Visit changed state of SCR-CUS-05 is drawn on DK-124 and compared below.
import type { SelectorPair } from './compare.ts';
import { cap, within } from './billing-cases.ts';
import type { WidthFrom } from './shell-cases.ts';

export interface LiveMapCase {
  name: string;
  /** The captions the case compares (every captioned state of the frames has a case, or a reason in NOT_COMPARED). */
  captions: string[];
  app: string;
  frame: string;
  screen: 'SCR-CUS-04' | 'SCR-CUS-05';
  pairs: SelectorPair[];
  /** The page is sized to its frame's phone screen (the frame is 390 px wide; the page fills any width). */
  widthFrom: WidthFrom[];
  /** Elements of the frame's state the case leaves out, each with why: only what really has no twin in the page's state. */
  skips?: { element: string; why: string }[];
}

export const LIVE_FRAME = 'mockups/pages/customer-live-map.html';
export const ENDED_FRAME = 'mockups/pages/customer-live-map-ended.html';
const L = 'SCR-CUS-04 Live map: on the way: ';
const E = 'SCR-CUS-05 Live map: ended: ';
const rootOf = (screen: string) => `.r1-screen[data-screen="${screen}"]`;
const pgOf = (screen: string, caption: string): WidthFrom[] => [{ app: `${rootOf(screen)} .pg`, frame: `${cap(caption)} .pg` }];

const BAR = ['.r1-demobar', '.r1-demobar .clk', '.r1-demobar .clk b', '.r1-demobar .run'];
const BRAND = ['.brandrow', '.brandrow .brand', '.brandrow .brand svg.mark', '.brandrow .brand .word', '.brandrow .tel14', '.brandrow .lang'];
const BRAND_NO_PHONE = BRAND.filter((s) => !s.endsWith('.tel14'));
const FOOT = ['.r1p-foot', '.r1p-foot a', '.r1p-foot [data-ctl="CTL-CMP-04-02"]', '.r1p-foot .demo'];
const HERO = ['.hero', '.hero h1', '.hero p', '.hero p b'];
const MAP = ['.mapw', '.mapw .osm'];
const ETA = ['.eta', '.eta > span:first-child', '.eta > span:last-child', '.eta .track', '.eta .track i', '.eta .track b'];
const WHO = ['.who', '.who .av', '.who b', '.who span.s'];
const STOP = ['.stop', '.stop .ic', '.stop div'];
const CALL = ['.call', '.call .ic'];
const ENDED_BODY = ['.hero .chip', '.ended', '.ended .badge', '.ended .badge .ic', '.ended p'];

const phoneSkip = { element: '.brandrow .tel14', why: 'the Not valid page has no branch to name: no read has answered for the link, so it cannot print the branch office phone; the frame prints a sample one' };

export const LIVEMAP_CASES: LiveMapCase[] = [
  {
    name: 'SCR-CUS-04 On the way (heading, map box, trip progress, technician card, privacy line, Call Brightwater)',
    captions: [`${L}On the way`], app: '/shell-preview/livemap/on-the-way', frame: LIVE_FRAME, screen: 'SCR-CUS-04',
    widthFrom: pgOf('SCR-CUS-04', `${L}On the way`),
    pairs: within(rootOf('SCR-CUS-04'), cap(`${L}On the way`), [...BAR, ...BRAND, ...HERO, ...MAP, ...ETA, ...WHO, ...STOP, ...CALL, ...FOOT]),
  },
  {
    name: 'SCR-CUS-04 Loading (heading skeleton, map skeleton, Call Brightwater)',
    captions: [`${L}Loading`], app: '/shell-preview/livemap/loading', frame: LIVE_FRAME, screen: 'SCR-CUS-04',
    widthFrom: pgOf('SCR-CUS-04', `${L}Loading`),
    pairs: within(rootOf('SCR-CUS-04'), cap(`${L}Loading`), [...BAR, ...BRAND, '.skl', '.skl .r1-skel', '.mapw', '.mapw .r1-skel', ...CALL]),
    skips: [{ element: '.mapw .osm', why: 'the loading tile draws the OpenStreetMap credit over the skeleton; the page draws the map and its credit only once a read has answered' }],
  },
  {
    name: 'SCR-CUS-04 Not valid (the message)',
    captions: [`${L}Not valid`], app: '/shell-preview/livemap/not-valid', frame: LIVE_FRAME, screen: 'SCR-CUS-04',
    widthFrom: pgOf('SCR-CUS-04', `${L}Not valid`),
    pairs: within(rootOf('SCR-CUS-04'), cap(`${L}Not valid`), [...BAR, ...BRAND_NO_PHONE, '.msgc', '.msgc .ic', '.msgc span']),
    skips: [phoneSkip],
  },
  {
    name: 'SCR-CUS-04 Update failed (the van removed, the message, Call Brightwater)',
    captions: [`${L}Update failed`], app: '/shell-preview/livemap/update-failed', frame: LIVE_FRAME, screen: 'SCR-CUS-04',
    widthFrom: pgOf('SCR-CUS-04', `${L}Update failed`),
    pairs: within(rootOf('SCR-CUS-04'), cap(`${L}Update failed`), [...BAR, ...BRAND, ...HERO, ...MAP, '.msgc.warn', '.msgc.warn .ic', '.msgc.warn span', ...CALL]),
    skips: [{ element: '.r1p-foot', why: 'the Update failed tile draws no footer; the page draws it as in every other state' }],
  },
  {
    name: 'SCR-CUS-05 By arrival (heading, message, visit card, privacy line, Call Brightwater)',
    captions: [`${E}By arrival`], app: '/shell-preview/livemap-ended/by-arrival', frame: ENDED_FRAME, screen: 'SCR-CUS-05',
    widthFrom: pgOf('SCR-CUS-05', `${E}By arrival`),
    pairs: within(rootOf('SCR-CUS-05'), cap(`${E}By arrival`), [
      ...BAR, ...BRAND, ...HERO, ...ENDED_BODY, '.card2', '.card2 .who', '.card2 .who .av', '.card2 .who b', '.card2 .who span.s', '.card2 .li', '.card2 .li span', '.card2 .li b',
      '.priv', '.priv .ic', '.priv div', ...CALL, '.call small', ...FOOT,
    ]),
  },
  {
    name: 'SCR-CUS-05 Visit changed (the heading, the message, Call Brightwater with the number)',
    captions: [`${E}Visit changed`], app: '/shell-preview/livemap-ended/changed', frame: ENDED_FRAME, screen: 'SCR-CUS-05',
    widthFrom: pgOf('SCR-CUS-05', `${E}Visit changed`),
    pairs: within(rootOf('SCR-CUS-05'), cap(`${E}Visit changed`), [...BAR, ...BRAND, '.hero', '.hero h1', '.ended', '.ended .badge', '.ended .badge .ic', '.ended p', ...CALL, '.call small']),
    skips: [{ element: '.r1p-foot', why: 'the Visit changed tile draws no footer; the page draws it as in every other state' }],
  },
];

/**
 * Captioned frame states with no look case of their own, each with the reason. The coverage test checks every caption the frames show is compared by a
 * case or named here, and that each named one is a caption of its frame.
 */
export const NOT_COMPARED: Record<string, { frame: string; why: string }> = {
  [`${L}Ended`]: { frame: LIVE_FRAME, why: 'the tile holds only a note saying the ended page shows in its place (SCR-CUS-05, compared by its own cases); it draws no element of the page' },
};

/** Captions the frames show (read by the pw test) that no case and no NOT_COMPARED row covers; and NOT_COMPARED rows that are wrong. */
export function uncovered(captions: Record<string, string[]>): string[] {
  const compared = new Set(LIVEMAP_CASES.flatMap((c) => c.captions.map((x) => `${c.frame} | ${x}`)));
  const problems: string[] = [];
  for (const [frame, caps] of Object.entries(captions)) {
    for (const c of caps) {
      if (!/^(SCR-CUS-04 |SCR-CUS-05 )/.test(c)) continue;
      if (compared.has(`${frame} | ${c}`)) continue;
      const n = NOT_COMPARED[c];
      if (n && n.frame === frame) continue;
      problems.push(`no case compares ${frame} | ${c}`);
    }
  }
  for (const [c, n] of Object.entries(NOT_COMPARED)) if (!(captions[n.frame] ?? []).includes(c)) problems.push(`NOT_COMPARED names a caption its frame does not show: ${n.frame} | ${c}`);
  return problems;
}
