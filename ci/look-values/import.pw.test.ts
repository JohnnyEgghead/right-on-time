// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-IMP-10, FR-IMP-11, UC-08 (the look of the import pages and their dialogs is held by the comparator, OA-84)
// G-LOOK-PARITY on the P4-ADMIN-IMPORT screens (SCR-OFC-13, -14, -15 and the dialogs SCR-OFC-25, -26), on Chromium and WebKit, against
// the real app (the harness build served by ci/web-app.ts) in each state its frame shows. Run by ci/gates/look-values-comparator.sh; the
// unit-tests gate excludes *.pw.test.ts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { IMPORT_CASES, IMPORT_FRAMES, uncovered } from './import-cases.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('import look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-IMP-10 every captioned state of the 3 import screens has a case that compares it, or a stated reason it has none
  it('compare every state the 3 frames show, keyed by frame caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const captions: Record<string, string[]> = {};
    for (const f of IMPORT_FRAMES) {
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(f)).href, { waitUntil: 'load' });
      captions[f] = await fp.evaluate(() => {
        const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
        return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
      });
      await fp.close();
    }
    await g.context.close();
    expect(Object.values(captions).flat().length).toBeGreaterThan(0);
    expect(uncovered(captions)).toEqual([]);
  }, 120_000);

  // why: FR-IMP-10, FR-IMP-11, UC-08 each import screen matches its frame page in the state the frame shows (G-LOOK-PARITY)
  it.each(IMPORT_CASES)('look case: $name', async (c) => {
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
        await page.waitForSelector(c.screen === 'SCR-OFC-25' || c.screen === 'SCR-OFC-26' ? '.r1-dlg' : `.r1-screen[data-screen="${c.screen}"]`, { state: 'attached' });
        // The bars' widths are set through the CSSOM once the page has hydrated (the page's CSP allows no style attribute).
        await page.waitForFunction("Array.from(document.querySelectorAll('.sbar i, .pbar i, .bar i')).every((e) => e.style.width !== '')");
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-IMP-11 a look case must be able to fail: the duplicates page read against the history frame differs
  it('flags the duplicates page read against the history frame (the cases are not vacuous)', async () => {
    const c = IMPORT_CASES.find((x) => x.screen === 'SCR-OFC-14')!;
    const r = await compareLook({
      appUrl: app.origin + c.app,
      framePath: 'mockups/pages/r1-admin-history.html',
      pairs: [{ app: `.r1-screen[data-screen="SCR-OFC-14"] .panel`, frame: `[data-bw-cap="SCR-OFC-15 Admin: import, history: Success"] .panel` }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
