// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DEMO-5, FR-DEMO-4, UC-10 (the look of the demo clock page and its reset dialog is held by the comparator, OA-84)
// G-LOOK-PARITY on the P4-CLOCK screens (SCR-OFC-17 and the dialog SCR-OFC-27), on Chromium and WebKit, against the real app (the harness
// build served by ci/web-app.ts) in each state its frame shows. Run by ci/gates/look-values-comparator.sh; the unit-tests gate excludes *.pw.test.ts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { CLOCK_CASES, CLOCK_FRAME, CLOCK_FRAMES, uncovered } from './clock-cases.ts';
import { tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('demo clock look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-DEMO-5 every captioned state of the clock screen and its reset dialog has a case that compares it, or a stated reason it has none
  it('compare every state the frame shows, keyed by frame caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const captions: Record<string, string[]> = {};
    for (const f of CLOCK_FRAMES) {
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

  // why: FR-DEMO-5, UC-10 the clock page and its reset dialog match their frame in the state the frame shows (G-LOOK-PARITY)
  it.each(CLOCK_CASES)('look case: $name', async (c) => {
    const r = await compareLook({
      appUrl: app.origin + c.app,
      framePath: c.frame,
      pairs: c.pairs,
      browser,
      setup: async (page, which) => {
        if (which === 'frame') return tagFrames(page);
        await page.waitForSelector(c.screen === 'SCR-OFC-27' && c.app.includes('dlg-') ? '.r1-dlg' : `.r1-screen[data-screen="SCR-OFC-17"]`, { state: 'attached' });
        // The progress bar's width is set through the CSSOM once the page has hydrated (the page's CSP allows no style attribute).
        await page.waitForFunction("Array.from(document.querySelectorAll('.bar i')).every((e) => e.style.width !== '')");
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-DEMO-5 a look case must be able to fail: the Running page read against the Cool-down tile's reset button differs
  it('flags the running page read against the wrong frame state (the cases are not vacuous)', async () => {
    const c = CLOCK_CASES.find((x) => x.name.startsWith('SCR-OFC-17 Running'))!;
    const r = await compareLook({
      appUrl: app.origin + c.app,
      framePath: CLOCK_FRAME,
      pairs: [{ app: '.r1-screen[data-screen="SCR-OFC-17"] .reset .btn.warnb', frame: '[data-bw-cap="SCR-OFC-17 Admin: demo clock: Cool-down"] .btn' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
