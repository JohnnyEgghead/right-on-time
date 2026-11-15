// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-1, FR-TECH-2, FR-TECH-9, FR-TECH-12 (the look of the technician sign-in, Today and confirm sheets is held by the comparator, OA-84)
// G-LOOK-PARITY on P5-TWA-TODAY's screens (SCR-TEC-01, -02, -03, -13, -14 against DK-106 to DK-109), on Chromium and WebKit, against the
// real app (the harness build served by ci/web-app.ts). Run by ci/gates/look-values-comparator.sh; the unit-tests gate excludes *.pw.test.ts.
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
import { CONFIRM_FRAME, LATE_FRAME, NOT_COMPARED, SIGNIN_FRAME, TECH_TODAY_CASES, TODAY_FRAME } from './tech-today-cases.ts';

const SCREEN_BUDGET_S = 30;
const VIEW = { viewport: { width: 1440, height: 900 }, colorScheme: 'light' as const, reducedMotion: 'reduce' as const };
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe('technician sign-in page sheet', () => {
  // why: FR-TECH-1 the sign-in page's own rules are its frame's last style block, copied byte for byte (UI-DESIGN-KIT 1.1)
  it('copies mockups/pages/tech-signin.html\'s own style block byte for byte', () => {
    const blocks = [...readFileSync(SIGNIN_FRAME, 'utf8').matchAll(/<style>\n([\s\S]*?)<\/style>/g)].map((m) => m[1] as string);
    const copy = readFileSync('apps/web/styles/page-tech-signin.css', 'utf8');
    expect(copy.slice(copy.indexOf('*/\n') + 3)).toBe(blocks.at(-1));
  });
});

describe.each(engines)('technician sign-in, Today and confirm sheets look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-TECH-1 every captioned state of the 5 screens' frames has a case that compares it, or a reason it is not compared
  it('compares every state the frames caption, or names why not', async () => {
    const g = await guardedContext(browser, [], VIEW);
    const seen: string[] = [];
    for (const frame of [SIGNIN_FRAME, TODAY_FRAME, LATE_FRAME, CONFIRM_FRAME]) {
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(frame)).href, { waitUntil: 'load' });
      seen.push(...(await fp.evaluate(() => {
        const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
        return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
      })));
    }
    await g.context.close();
    const covered = new Set([...TECH_TODAY_CASES.flatMap((c) => c.captions), ...Object.keys(NOT_COMPARED)]);
    expect(seen.filter((c) => /^SCR-TEC-(01|02|03|13|14) /.test(c) && !covered.has(c))).toEqual([]);
  }, 120_000);

  // why: FR-TECH-1, FR-TECH-2, FR-TECH-9, FR-TECH-12 each screen matches its frame in the state the frame shows (G-LOOK-PARITY)
  it.each(TECH_TODAY_CASES)('look case: $name', async (c) => {
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
});
