// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-23, UC-15 (the look of the Week board is held by the comparator, OA-84)
// G-LOOK-PARITY on P4-WEEK's screen (SCR-OFC-34), on Chromium and WebKit, against the real app (the harness build served by
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
import { uncovered, WEEK_CASES, WEEK_FRAME } from './week-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('week board look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-DISP-23 every captioned state of the frame has a case that compares it
  it('compares every state the frame shows, keyed by frame caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const fp = await g.context.newPage();
    await fp.goto(pathToFileURL(path.resolve(WEEK_FRAME)).href, { waitUntil: 'load' });
    const captions = await fp.evaluate(() => {
      const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
      return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
    });
    await g.context.close();
    expect(captions.length).toBeGreaterThan(0);
    expect(uncovered(captions)).toEqual([]);
  }, 120_000);

  // why: FR-DISP-23, UC-15 the Week board matches its frame page in the state the frame shows (G-LOOK-PARITY)
  it.each(WEEK_CASES)('look case: $name', async (c) => {
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
        await page.waitForSelector('.r1-screen[data-screen="SCR-OFC-34"]', { state: 'attached' });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
        if (c.miniGrid) {
          // The frame's Live tile draws a mini grid: 62 px header row, 48 px rows, no stretch.
          await page.evaluate(() => {
            const g = (globalThis as unknown as { document: { querySelector(s: string): { style: Record<string, string> } | null } }).document;
            const wk = g.querySelector('.r1-screen[data-screen="SCR-OFC-34"] .wk');
            if (wk) Object.assign(wk.style, { gridTemplateRows: '62px', gridAutoRows: '48px', flex: 'none', height: 'auto' });
          });
        }
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: F-1553 (FR-DISP-23) in English and Spanish at 390, 520 and 1440 px, no technician name or van and skill line is clipped by an overflow-hidden box and each stays inside its column
  it.each([['en', 390], ['en', 520], ['es', 390], ['es', 520], ['es', 1440]] as const)('F-1553: week board technician lines are whole and inside the column, %s at %d px', async (lang, width) => {
    const g = await guardedContext(browser, [app.origin], { viewport: { width, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      await g.context.addCookies([{ name: 'bw_lang', value: lang, url: app.origin }]);
      const page = await g.context.newPage();
      await page.goto(app.origin + '/shell-preview/week/success', { waitUntil: 'networkidle' });
      await page.waitForSelector('.r1-screen[data-screen="SCR-OFC-34"] .wk .who', { state: 'attached' });
      const bad = await page.evaluate(`(() => {
        const out = [];
        const lines = document.querySelectorAll('.r1-screen[data-screen="SCR-OFC-34"] .wk > .who:not(.unas):not(.tot)');
        for (const who of lines) {
          const col = who.getBoundingClientRect();
          for (const el of who.querySelectorAll('.nm, .sub')) {
            const cs = getComputedStyle(el);
            const cut = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
            const text = (el.textContent || '').trim();
            if (cut && el.scrollWidth > el.clientWidth + 1) out.push('clipped: ' + text);
            if (el.getBoundingClientRect().right > col.right + 0.5) out.push('past the column: ' + text);
          }
        }
        return { out, count: lines.length };
      })()`) as { out: string[]; count: number };
      expect(bad.count, 'technician rows').toBeGreaterThan(0);
      expect(bad.out).toEqual([]);
    } finally {
      await g.context.close();
    }
  }, 120_000);

  // why: FR-DISP-23 a look case must be able to fail: the grid read against a frame cell of another state differs
  it('flags a changed cell read against an unchanged one (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: app.origin + '/shell-preview/week/success',
      framePath: WEEK_FRAME,
      pairs: [{ app: '.r1-screen[data-screen="SCR-OFC-34"] .wk .c:nth-of-type(1)', frame: '[data-bw-cap="SCR-OFC-34 Week board: Live"] .wk .c.chg' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
