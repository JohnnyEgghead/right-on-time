// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-4, FR-TECH-7 (the look of the technician app's sync strip and tab bar is held by the comparator, OA-84)
// G-LOOK-PARITY on P5-TWA-OUTBOX's components (CMP-10 against DK-111, CMP-09 and the Today header on DK-107), on Chromium
// and WebKit, against the real app (the harness build served by ci/web-app.ts). Run by ci/gates/look-values-comparator.sh;
// the unit-tests gate excludes *.pw.test.ts.
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
import { OFFLINE_FRAME, TECH_SHELL_CASES, TODAY_FRAME, uncoveredCmp10 } from './tech-shell-cases.ts';

const SCREEN_BUDGET_S = 30;
const VIEW = { viewport: { width: 1440, height: 900 }, colorScheme: 'light' as const, reducedMotion: 'reduce' as const };
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe('technician app page sheets', () => {
  // why: FR-TECH-7 the pages' own rules are their frames' last style blocks, copied byte for byte (UI-DESIGN-KIT 1.1)
  it.each([[OFFLINE_FRAME, 'apps/web/styles/page-tech-offline.css'], [TODAY_FRAME, 'apps/web/styles/page-tech-today.css']])('copies %s\'s own style block byte for byte', (frame, sheet) => {
    const blocks = [...readFileSync(frame, 'utf8').matchAll(/<style>\n([\s\S]*?)<\/style>/g)].map((m) => m[1] as string);
    const copy = readFileSync(sheet, 'utf8');
    expect(copy.slice(copy.indexOf('*/\n') + 3)).toBe(blocks.at(-1));
  });
});

describe.each(engines)('technician app shell look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-TECH-7 every captioned CMP-10 state of DK-111 has a case that compares it (F-226)
  it('compares every CMP-10 state DK-111 captions', async () => {
    const g = await guardedContext(browser, [], VIEW);
    const fp = await g.context.newPage();
    await fp.goto(pathToFileURL(path.resolve(OFFLINE_FRAME)).href, { waitUntil: 'load' });
    const caps = await fp.evaluate(() => {
      const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
      return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
    });
    await g.context.close();
    expect(caps.filter((c) => c.startsWith('CMP-10 ')).length).toBe(2);
    expect(uncoveredCmp10(caps)).toEqual([]);
  }, 120_000);

  // why: FR-TECH-4, FR-TECH-7 each piece matches its frame in the state the frame shows (G-LOOK-PARITY)
  it.each(TECH_SHELL_CASES)('look case: $name', async (c) => {
    let widths: number[] = [];
    if (c.widthFrom) {
      const g = await guardedContext(browser, [], VIEW);
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
        await page.waitForSelector(c.ready, { state: 'attached' });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-TECH-7 a look case must be able to fail: the No signal strip read against the 24-hour banner differs
  it('flags the No signal strip read against the 24-hour banner (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: `${app.origin}/shell-preview/tech-sync/nosignal`,
      framePath: OFFLINE_FRAME,
      pairs: [{ app: '.banner', frame: '[data-bw-cap="CMP-10 Sync strip: 24-hour banner"] .r1p-old' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') return tagFrames(page);
        await page.waitForSelector('.banner', { state: 'attached' });
      },
    });
    expect(r.differences.map((d) => d.property)).toContain('background-color');
  }, 120_000);
});
