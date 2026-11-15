// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-BOOK-13, NFR-12 (the look of the booking site's 5 pages is held by the comparator, OA-84)
// G-LOOK-PARITY on the P5-BOOKING-PAGES screen (SCR-CUS-07 at its 5 routes), on Chromium and WebKit, against the real app (the harness build served by
// ci/web-app.ts) in each state its frame shows. Run by ci/gates/look-values-comparator.sh; the unit-tests gate excludes *.pw.test.ts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { BOOKMENU_CASES, BOOKMENU_FRAME, BOOKMENU_FRAMES, uncovered, type FrameStates } from './bookmenu-cases.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
const VIEW = { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' } as const;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('booking site pages look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-BOOK-13 every state the frames show for the 5 pages has a case that compares it, or a stated reason it has none
  it('compare every state the frames show, keyed by frame caption and tile title', async () => {
    const g = await guardedContext(browser, [], VIEW);
    const states: Record<string, FrameStates> = {};
    for (const f of BOOKMENU_FRAMES) {
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(f)).href, { waitUntil: 'load' });
      states[f] = await fp.evaluate((withTitles) => {
        type El = { textContent: string | null };
        const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<El> } }).document;
        const text = (s: string) => Array.from(d.querySelectorAll(s), (c) => (c.textContent ?? '').trim());
        return { captions: text('p.frame-cap'), titles: withTitles ? text('.r1-st .h > b') : [] };
      }, f === BOOKMENU_FRAME);
      await fp.close();
    }
    await g.context.close();
    expect(states[BOOKMENU_FRAME]!.captions.length).toBe(5);
    expect(uncovered(states)).toEqual([]);
  }, 120_000);

  // why: FR-BOOK-13 each of the 5 pages matches its frame in the state the frame shows (G-LOOK-PARITY)
  it.each(BOOKMENU_CASES)('look case: $name', async (c) => {
    let widths: number[] = [];
    if (c.widthFrom) {
      const g = await guardedContext(browser, [], VIEW);
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(c.frame)).href, { waitUntil: 'load' });
      widths = await frameWidths(fp, c.widthFrom);
      await g.context.close();
    }
    const r = await compareLook({
      appUrl: app.origin + c.app,
      framePath: c.frame,
      pairs: c.pairs,
      browser,
      setup: async (page, which) => {
        if (which === 'frame') return tagFrames(page);
        await page.waitForSelector('.r1-screen[data-screen="SCR-CUS-07"] .split', { state: 'attached' });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-BOOK-13 a look case must be able to fail: the Comfort Club heading read against the Heating tile's differs once the page is read at the wrong width
  it('flags the Comfort Club page read against the Heating tile (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: `${app.origin}/shell-preview/bookmenu/comfort-club`,
      framePath: BOOKMENU_FRAME,
      pairs: [{ app: '.r1-screen[data-screen="SCR-CUS-07"] .txt h1', frame: '[data-bw-cap="SCR-CUS-07 Booking site page, Heating: Shown"] .rt .txt h1' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
