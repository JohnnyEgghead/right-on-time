// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-5, FR-TECH-10, FR-TECH-11, FR-TECH-13, FR-TECH-15, NFR-09 (the look of the technician app's map, directions, parts, Me and install screens is held by the comparator, OA-84)
// G-LOOK-PARITY on the P5-TWA-MAP-ME screens (SCR-TEC-08, -10, -11, -15, -16) against DK-113 to DK-116, on Chromium and WebKit, against the real app
// (the harness build served by ci/web-app.ts) in each state the frames show. Run by ci/gates/look-values-comparator.sh; the unit-tests gate
// excludes *.pw.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';
import { FRAMES, INSTALL_FRAME, MAP_FRAME, ME_FRAME, PARTS_FRAME, TECH_MAP_CASES, uncovered } from './tech-map-cases.ts';

const SCREEN_BUDGET_S = 30;
const VIEW = { viewport: { width: 1440, height: 900 }, colorScheme: 'light' as const, reducedMotion: 'reduce' as const };
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe('technician app map, Me, parts and install page sheets', () => {
  // why: FR-TECH-11 the pages' own rules are their frames' last style blocks, copied byte for byte (UI-DESIGN-KIT 1.1)
  it.each([
    [MAP_FRAME, 'apps/web/styles/page-tech-map.css'], [ME_FRAME, 'apps/web/styles/page-tech-me.css'],
    [PARTS_FRAME, 'apps/web/styles/page-tech-parts.css'], [INSTALL_FRAME, 'apps/web/styles/page-tech-install.css'],
  ])('copies %s\'s own style block byte for byte', (frame, sheet) => {
    const blocks = [...readFileSync(frame, 'utf8').matchAll(/<style>\n([\s\S]*?)<\/style>/g)].map((m) => m[1] as string);
    const copy = readFileSync(sheet, 'utf8');
    expect(copy.slice(copy.indexOf('*/\n') + 3)).toBe(blocks.at(-1));
  });
});

describe.each(engines)('technician app map, directions, parts, Me and install look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-TECH-11 every captioned state of the 4 frames has a case that compares it, or a stated reason it has none
  it('compares every state the frames show, keyed by frame caption', async () => {
    const g = await guardedContext(browser, [], VIEW);
    const captions: Record<string, string[]> = {};
    for (const f of FRAMES) {
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(f)).href, { waitUntil: 'load' });
      captions[f] = await fp.evaluate(() => {
        const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
        return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
      });
      await fp.close();
    }
    await g.context.close();
    for (const f of FRAMES) expect(captions[f]!.length, f).toBeGreaterThan(0);
    expect(uncovered(captions)).toEqual([]);
  }, 120_000);

  // why: FR-TECH-11 each screen matches its frame in the state the frame shows (G-LOOK-PARITY)
  it.each(TECH_MAP_CASES)('look case: $name', async (c) => {
    // The frame is a file: page; the guard allows no other origin.
    const g = await guardedContext(browser, [], VIEW);
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

  // why: FR-TECH-11 a look case must be able to fail: the Me screen's heading read against the Parts frame's heading differs
  it('flags the Me screen read against another frame (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: app.origin + '/shell-preview/tech-me/success',
      framePath: PARTS_FRAME,
      pairs: [{ app: '.bw-tech .prof h1', frame: '.apphead h1' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
