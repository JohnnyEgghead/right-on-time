// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-REP-1, FR-REP-2, FR-REP-4, FR-REP-5, FR-REP-6, FR-REP-7, FR-REP-8, NFR-06 (the look of the Reports page is held by the comparator, OA-84)
// G-LOOK-PARITY on the P4-REPORTS screen (SCR-OFC-11), on Chromium and WebKit, against the real app (the harness build served by ci/web-app.ts)
// in each state its frame shows. Run by ci/gates/look-values-comparator.sh; the unit-tests gate excludes *.pw.test.ts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { REPORTS_CASES, REPORTS_FRAME, uncovered } from './reports-cases.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('reports look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-REP-4 every captioned state of the frame that belongs to SCR-OFC-11 has a case that compares it, or a stated reason it has none
  it('compare every state the frame shows, keyed by frame caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const fp = await g.context.newPage();
    await fp.goto(pathToFileURL(path.resolve(REPORTS_FRAME)).href, { waitUntil: 'load' });
    const captions = await fp.evaluate(() => {
      const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
      return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
    });
    await g.context.close();
    expect(captions.length).toBeGreaterThan(0);
    expect(uncovered({ [REPORTS_FRAME]: captions })).toEqual([]);
  }, 120_000);

  // why: FR-REP-1, FR-REP-2, FR-REP-6, FR-REP-7, FR-REP-8 the screen matches its frame in the state the frame shows (G-LOOK-PARITY)
  it.each(REPORTS_CASES)('look case: $name', async (c) => {
    let widths: number[] = [];
    if (c.widthFrom) {
      // The frame is a file: page; the guard allows no other origin.
      const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(REPORTS_FRAME)).href, { waitUntil: 'load' });
      await tagFrames(fp);
      widths = await frameWidths(fp, c.widthFrom);
      await g.context.close();
    }
    const r = await compareLook({
      appUrl: app.origin + c.app,
      framePath: REPORTS_FRAME,
      pairs: c.pairs,
      browser,
      setup: async (page, which) => {
        if (which === 'frame') return tagFrames(page);
        await page.waitForSelector('.r1-screen[data-screen="SCR-OFC-11"]', { state: 'attached' });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-REP-4 a look case must be able to fail: the Reports page's heading read against the frame's by-technician heading differs
  it('flags the Reports page read against another element of its frame (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: app.origin + '/shell-preview/reports/success',
      framePath: REPORTS_FRAME,
      pairs: [{ app: '.r1-screen[data-screen="SCR-OFC-11"] .rh h1', frame: '[data-bw-cap="SCR-OFC-11 Reports: Success"] .panel h3' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
