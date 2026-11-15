// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-7, FR-DISP-29, FR-DISP-30, FR-DISP-31, FR-DISP-32 (the look of the customer screens and their dialogs is held by the comparator, OA-84)
// G-LOOK-PARITY on the P4-CUSTOMERS screens (SCR-OFC-05, -06 and the dialogs SCR-OFC-38, -39, -40), on Chromium and WebKit, against the real
// app (the harness build served by ci/web-app.ts) in each state its frame shows. Run by ci/gates/look-values-comparator.sh; the unit-tests
// gate excludes *.pw.test.ts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { CUSTOMERS_CASES, CUSTOMERS_FRAMES, uncovered } from './customers-cases.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('customers look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-DISP-30 every captioned state of the 2 customer frames has a case that compares it, or a stated reason it has none
  it('compares every state the 2 frames show, keyed by frame caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const captions: Record<string, string[]> = {};
    for (const f of CUSTOMERS_FRAMES) {
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

  // why: FR-DISP-7, FR-DISP-29, FR-DISP-30, FR-DISP-31, FR-DISP-32 each customer screen matches its frame page in the state the frame shows (G-LOOK-PARITY)
  it.each(CUSTOMERS_CASES)('look case: $name', async (c) => {
    const dialog = c.screen === 'SCR-OFC-38' || c.screen === 'SCR-OFC-39' || c.screen === 'SCR-OFC-40';
    let widths: number[] = [];
    if (c.widthFrom) {
      const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
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
        await page.waitForSelector(dialog ? '.r1-dlg' : `.r1-screen[data-screen="${c.screen}"]`, { state: 'attached' });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-DISP-30 a look case must be able to fail: the customer page read against the search frame differs
  it('flags the customer page read against the search frame (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: app.origin + '/shell-preview/customer/success',
      framePath: 'mockups/pages/office-customer-search.html',
      pairs: [{ app: '.r1-screen[data-screen="SCR-OFC-06"] .card', frame: '[data-bw-cap="SCR-OFC-05 Customer search: Results"] .card' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
