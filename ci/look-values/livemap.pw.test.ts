// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-22, FR-TEXT-23, FR-TEXT-4 (the look of the live map page and its ended page is held by the comparator, OA-84)
// G-LOOK-PARITY on the P5-LIVEMAP screens (SCR-CUS-04, SCR-CUS-05), on Chromium and WebKit, against the real app (the harness build served by
// ci/web-app.ts) in each state its frame shows. Run by ci/gates/look-values-comparator.sh; the unit-tests gate excludes *.pw.test.ts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { ENDED_FRAME, LIVE_FRAME, LIVEMAP_CASES, uncovered } from './livemap-cases.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('live map look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-TEXT-22 every captioned state of the 2 frames that belongs to SCR-CUS-04 or SCR-CUS-05 has a case that compares it, or a stated reason it has none
  it('compare every state the frames show, keyed by frame caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const captions: Record<string, string[]> = {};
    for (const f of [LIVE_FRAME, ENDED_FRAME]) {
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(f)).href, { waitUntil: 'load' });
      captions[f] = await fp.evaluate(() => {
        const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
        return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
      });
      await fp.close();
    }
    await g.context.close();
    expect(captions[LIVE_FRAME]!.length).toBeGreaterThan(0);
    expect(uncovered(captions)).toEqual([]);
  }, 120_000);

  // why: FR-TEXT-22, FR-TEXT-23, FR-TEXT-4 each screen matches its frame in the state the frame shows (G-LOOK-PARITY)
  it.each(LIVEMAP_CASES)('look case: $name', async (c) => {
    // The frame is a file: page; the guard allows no other origin.
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const fp = await g.context.newPage();
    await fp.goto(pathToFileURL(path.resolve(c.frame)).href, { waitUntil: 'load' });
    await tagFrames(fp);
    const widths = await frameWidths(fp, c.widthFrom);
    await g.context.close();
    const r = await compareLook({
      appUrl: app.origin + c.app,
      framePath: c.frame,
      pairs: c.pairs,
      browser,
      setup: async (page, which) => {
        if (which === 'frame') return tagFrames(page);
        await page.waitForSelector(`.r1-screen[data-screen="${c.screen}"]`, { state: 'attached' });
        await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-TEXT-22 a look case must be able to fail: the live map's heading read against the ended frame's heading differs
  it('flags the live map read against the other frame (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: app.origin + '/shell-preview/livemap/on-the-way',
      framePath: ENDED_FRAME,
      pairs: [{ app: '.r1-screen[data-screen="SCR-CUS-04"] .hero h1', frame: '.r1p-stage .hero h1' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
