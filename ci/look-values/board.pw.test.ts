// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-1, FR-DISP-14, FR-DISP-16, FR-DISP-17 (the look of SCR-OFC-02 and its 6 hosted screens is held by the comparator, OA-84)
// G-LOOK-PARITY on the P4-BOARD screens (SCR-OFC-02, -18, -19, -29, -31, -32, -33), on Chromium and WebKit, against the real
// app (the harness build served by ci/web-app.ts) in each state DK-85 draws. Run by ci/gates/look-values-comparator.sh
// (Chromium) and the nightly half (WebKit); the unit-tests gate excludes *.pw.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { BOARD_CASES, BOARD_FRAME, uncoveredBoard } from './board-cases.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { mapFilesPresent, serveMapFiles } from './map-files.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe('board sheets', () => {
  // why: FR-DISP-1 the page's own rules are the frame's last style block, copied byte for byte (UI-DESIGN-KIT 1.1)
  it('copies the frame page\'s own style block byte for byte', () => {
    const frame = readFileSync(BOARD_FRAME, 'utf8');
    const blocks = [...frame.matchAll(/<style>\n([\s\S]*?)<\/style>/g)].map((m) => m[1] as string);
    const copy = readFileSync('apps/web/styles/page-office-board.css', 'utf8');
    const body = copy.slice(copy.indexOf('*/\n') + 3);
    expect(body).toBe(blocks.at(-1));
  });
});

describe.each(engines)('board look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-DISP-1 every captioned state of the 7 screens has a case that compares it, or a stated reason it has none
  it('compares every state the frame shows for SCR-OFC-02 and its hosted screens, keyed by caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const fp = await g.context.newPage();
    await fp.goto(pathToFileURL(path.resolve(BOARD_FRAME)).href, { waitUntil: 'load' });
    const captions = await fp.evaluate(() => {
      const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
      return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
    });
    await g.context.close();
    expect(captions.length).toBeGreaterThan(30);
    expect(uncoveredBoard(captions)).toEqual([]);
  }, 120_000);

  // why: FR-DISP-14, FR-DISP-16, FR-DISP-17 each screen matches its frame in the state the frame shows (G-LOOK-PARITY)
  it.each(BOARD_CASES)('look case: $name', async (c) => {
    let widths: number[] = [];
    if (c.widthFrom) {
      const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(BOARD_FRAME)).href, { waitUntil: 'load' });
      widths = await frameWidths(fp, c.widthFrom);
      await g.context.close();
    }
    const r = await compareLook({
      appUrl: app.origin + c.app,
      framePath: BOARD_FRAME,
      pairs: c.pairs,
      browser,
      setup: async (page, which) => {
        if (which === 'frame') return tagFrames(page);
        if (c.maps) {
          expect(mapFilesPresent(), 'the map files are missing: run pnpm run setup:maps').toBe(true);
          await serveMapFiles(page.context());
          await page.reload({ waitUntil: 'load' });
        }
        await page.waitForSelector('.r1-screen', { state: 'attached' });
        if (c.ready) await page.waitForSelector(c.ready, { state: 'visible', timeout: 60_000 });
        if (c.maps) await page.waitForSelector('[data-map-state="ready"]', { state: 'attached', timeout: 60_000 });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);
});
