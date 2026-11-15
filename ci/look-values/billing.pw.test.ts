// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-BILL-4, FR-BILL-5, FR-BILL-10, FR-BILL-11, FR-BILL-12, UC-20 (the look of the billing list, Mark fixed and the pretend billing screens is held by the comparator, OA-84)
// G-LOOK-PARITY on the P4-BILLING-UI screens (SCR-OFC-10, SCR-OFC-47, SCR-PBS-01, SCR-PBS-02) and the CMP-01 no-Change tile of the
// 6 r1-pbs-* frames (F-233), on Chromium and WebKit, against the real app (the harness build served by ci/web-app.ts) in each state its
// frame shows. Run by ci/gates/look-values-comparator.sh; the unit-tests gate excludes *.pw.test.ts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { BILLING_CASES, BILLING_FRAMES, root, uncovered } from './billing-cases.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('billing look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-BILL-12 every captioned state of the 7 frames has a case that compares it, or a stated reason it has none (F-233)
  it('compare every state the frames show, keyed by frame caption, the CMP-01 tile of each pretend billing frame included', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const captions: Record<string, string[]> = {};
    for (const f of BILLING_FRAMES) {
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
    // F-233: the CMP-01 caption is drawn on the 3 pretend billing list frames, and on none of the 3 invoice frames (they draw invTiles)
    const cmp01 = (f: string) => captions[f]!.some((c) => c.startsWith('CMP-01 Demo clock: Running, no Change (SURF-PBS'));
    expect(BILLING_FRAMES.filter((f) => f.endsWith('-list.html')).map(cmp01)).toEqual([true, true, true]);
    expect(BILLING_FRAMES.filter((f) => f.endsWith('-invoice.html')).map(cmp01)).toEqual([false, false, false]);
    expect(uncovered(captions)).toEqual([]);
  }, 120_000);

  // why: FR-BILL-4, FR-BILL-5, FR-BILL-10, FR-BILL-11, FR-BILL-12, UC-20 each screen matches its frame page in the state the frame shows (G-LOOK-PARITY)
  it.each(BILLING_CASES)('look case: $name', async (c) => {
    const screen = c.app.includes('/pbs-list/') ? 'SCR-PBS-01' : c.app.includes('/pbs-invoice/') ? 'SCR-PBS-02' : c.app.endsWith('/dialog') ? 'SCR-OFC-47' : 'SCR-OFC-10';
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
        await page.waitForSelector(screen === 'SCR-OFC-47' ? `[data-screen="${screen}"]` : root(screen), { state: 'attached' });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-BILL-4 the pretend billing demo strip has no Change link, on the page and in the frame's CMP-01 tile (D5a-2, F-233)
  it('shows no Change link on the pretend billing strip or in its CMP-01 tile', async () => {
    const g = await guardedContext(browser, [app.origin], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await g.context.newPage();
    for (const path of ['/shell-preview/pbs-list/success', '/shell-preview/pbs-invoice/success']) {
      await page.goto(app.origin + path, { waitUntil: 'load' });
      await page.waitForSelector('.r1-demobar', { state: 'attached' });
      expect(await page.locator('.r1-demobar a[data-ctl="CTL-CMP-01-02"]').count()).toBe(0);
    }
    await g.context.close();
    const f = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const frame = await f.context.newPage();
    await frame.goto(pathToFileURL(path.resolve(BILLING_FRAMES[1]!)).href, { waitUntil: 'load' });
    await tagFrames(frame);
    expect(await frame.locator('[data-bw-cap^="CMP-01 Demo clock: Running, no Change"] .r1-demobar').count()).toBe(1);
    expect(await frame.locator('[data-bw-cap^="CMP-01 Demo clock: Running, no Change"] .r1-demobar a').count()).toBe(0);
    await f.context.close();
  }, 120_000);

  // why: FR-BILL-12 a look case must be able to fail: the pretend billing list read against the billing list frame differs
  it('flags the pretend billing list read against the billing list frame (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: app.origin + '/shell-preview/pbs-list/success',
      framePath: 'mockups/pages/office-billing.html',
      pairs: [{ app: `${root('SCR-PBS-01')} h1`, frame: `[data-bw-cap="SCR-OFC-10 Jobs not in billing: Success"] .pgh h1` }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
