// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-BOOK-2, FR-BOOK-17, FR-BOOK-18, UC-13 (the look of the arrival windows page and its switch dialog is held by the comparator, OA-84)
// G-LOOK-PARITY on the P4-ADMIN-WINDOWS screens (SCR-OFC-12, SCR-OFC-24), on Chromium and WebKit, against the real app (the harness build served by
// ci/web-app.ts) in each state its frame shows. Run by ci/gates/look-values-comparator.sh; the unit-tests gate excludes *.pw.test.ts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';
import { uncovered, WINDOWS_CASES, WINDOWS_FRAME } from './windows-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('windows look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-BOOK-2 every captioned state of the frame that belongs to SCR-OFC-12 or SCR-OFC-24 has a case that compares it, or a stated reason it has none
  it('compare every state the frame shows, keyed by frame caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const fp = await g.context.newPage();
    await fp.goto(pathToFileURL(path.resolve(WINDOWS_FRAME)).href, { waitUntil: 'load' });
    const caps = await fp.evaluate(() => {
      const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
      return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
    });
    await g.context.close();
    expect(caps.length).toBeGreaterThan(0);
    expect(uncovered({ [WINDOWS_FRAME]: caps })).toEqual([]);
  }, 120_000);

  // why: FR-BOOK-2, FR-BOOK-17, FR-BOOK-18 each screen matches its frame in the state the frame shows (G-LOOK-PARITY)
  it.each(WINDOWS_CASES)('look case: $name', async (c) => {
    let widths: number[] = [];
    if (c.widthFrom) {
      // The frame is a file: page; the guard allows no other origin.
      const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(c.frame)).href, { waitUntil: 'load' });
      await tagFrames(fp);
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
        await page.waitForSelector(c.wait, { state: 'attached' });
        // The meters' widths are set through the CSSOM once the page has hydrated (the page's CSP allows no style attribute).
        await page.waitForFunction("Array.from(document.querySelectorAll('.meter i')).every((e) => e.style.width !== '')");
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-BOOK-2 a look case must be able to fail: the page's heading read against the frame's calendar day differs
  it('flags the arrival windows page read against another element of the frame (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: app.origin + '/shell-preview/windows/success',
      framePath: WINDOWS_FRAME,
      pairs: [{ app: '.r1-screen[data-screen="SCR-OFC-12"] .ah h1', frame: '[data-bw-cap="SCR-OFC-12 Admin: arrival windows: Success"] .day .m' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
