// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DEMO-1, FR-DISP-10, FR-MAP-1 (the look of the shell's components and shared pages is held by the comparator, OA-84)
// G-LOOK-PARITY on the P2-SHELL components and shared pages, on Chromium and WebKit, against the real app (the harness
// build served by ci/web-app.ts). Run by ci/gates/look-values-comparator.sh; the unit-tests gate excludes *.pw.test.ts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { compareKitSheets, compareLook, formatDifferences } from './compare.ts';
import { mapFilesPresent, serveMapFiles } from './map-files.ts';
import { applyWidths, frameWidths, KIT_COPIES, LOOK_FRAMES, REQUIRED_COVERAGE, SHELL_CASES, tagFrames, uncoveredStates } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe('shell look cases', () => {
  // why: FR-DEMO-1 the acceptance look clause lists CMP-01, CMP-02, CMP-07, CMP-08, CMP-12, CMP-13 and SCR-SHR-01 to 03
  it('cover every component and shared page the look clause names', () => {
    const covered = new Set(SHELL_CASES.flatMap((c) => c.covers));
    expect(REQUIRED_COVERAGE.filter((id) => !covered.has(id))).toEqual([]);
  });
  // why: FR-DEMO-1 the shell renders from the kit sheets copied byte-identical (BUILD_PLAN P2-SHELL look clause)
  it('the copied kit sheets match the kit files byte for byte', () => {
    expect(compareKitSheets(KIT_COPIES)).toEqual([]);
  });
});

describe.each(engines)('shell look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-DEMO-1 every captioned state of the named components on their frames has a case that compares it (F-226)
  it('compare every state the look clause frames show, keyed by frame caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const captions: Record<string, string[]> = {};
    for (const f of LOOK_FRAMES) {
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
    expect(uncoveredStates(captions, SHELL_CASES)).toEqual([]);
  }, 120_000);

  // why: FR-DEMO-1 each component matches its kit frame in the state the frame shows (G-LOOK-PARITY)
  it.each(SHELL_CASES)('look case: $name', async (c) => {
      let widths: number[] = [];
      if (c.widthFrom) {
        // The frame is a file: page; the guard allows no other origin.
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
          if (c.maps) {
            // CMP-05 needs its map files: answered from .build/data/maps, then the page loads again with them.
            expect(mapFilesPresent(), 'the map files are missing: run pnpm run setup:maps').toBe(true);
            await serveMapFiles(page.context());
            await page.reload({ waitUntil: 'load' });
          }
          await page.waitForSelector('.r1-screen', { state: 'attached' });
          if (c.ready) await page.waitForSelector(c.ready, { state: 'attached', timeout: 60_000 });
          if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
        },
      });
      console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
      expect(formatDifferences(r)).toMatch(/^PASS /);
      expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-DEMO-1 a look case must be able to fail: the 403 card read against the 404 frame differs
  it('flags the No access page against the Page not found frame (the cases are not vacuous)', async () => {
    const c = SHELL_CASES[0]!;
    const r = await compareLook({
      appUrl: app.origin + c.app,
      framePath: 'mockups/pages/r1-shr-404.html',
      pairs: c.pairs.map((p) => ({ app: p.app, frame: p.frame!.replace('SCR-SHR-01 No access: Refused', 'SCR-SHR-02 Page not found: Missing') })),
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    const props = r.differences.map((d) => `${d.pair.split(' | ')[0]} ${d.property}`);
    expect(props).toContain('.r1-screen .shr-ico background-color');
    expect(props).toContain('.r1-screen .shr-card height');
  }, 120_000);
});
