// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-8, FR-DISP-28, FR-DISP-29, FR-DISP-32, UC-16 (the look of SCR-OFC-04 is held by the comparator, OA-84)
// G-LOOK-PARITY on the P4-NEWJOB screen (SCR-OFC-04), on Chromium and WebKit, against the real app (the harness build served by
// ci/web-app.ts) in each of the 7 states DK-89 draws. Run by ci/gates/look-values-comparator.sh (Chromium) and the nightly half (WebKit); the
// unit-tests gate excludes *.pw.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { NEWJOB_CASES, NEWJOB_FRAME, NEWJOB_SCREEN, uncoveredNewJob } from './newjob-cases.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe('new job page sheets', () => {
  // why: FR-DISP-8 the page's own rules are the frame's last style block, copied byte for byte (UI-DESIGN-KIT 1.1)
  it('copies the frame page\'s own style block byte for byte', () => {
    const frame = readFileSync(NEWJOB_FRAME, 'utf8');
    const blocks = [...frame.matchAll(/<style>\n([\s\S]*?)<\/style>/g)].map((m) => m[1] as string);
    const copy = readFileSync('apps/web/styles/page-office-new-job.css', 'utf8');
    const body = copy.slice(copy.indexOf('*/\n') + 3);
    expect(body).toBe(blocks.at(-1));
  });
});

describe.each(engines)('new job page look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-DISP-8 every captioned state of SCR-OFC-04 has a case that compares it, or a stated reason it has none
  it('compares every state the frame shows for SCR-OFC-04, keyed by caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const fp = await g.context.newPage();
    await fp.goto(pathToFileURL(path.resolve(NEWJOB_FRAME)).href, { waitUntil: 'load' });
    const captions = await fp.evaluate(() => {
      const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
      return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
    });
    await g.context.close();
    expect(captions).toHaveLength(7);
    expect(uncoveredNewJob(captions)).toEqual([]);
  }, 120_000);

  // why: FR-DISP-8, FR-DISP-28 each state of the screen matches its frame (G-LOOK-PARITY)
  it.each(NEWJOB_CASES)('look case: $name', async (c) => {
    let widths: number[] = [];
    if (c.widthFrom) {
      const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(NEWJOB_FRAME)).href, { waitUntil: 'load' });
      widths = await frameWidths(fp, c.widthFrom);
      await g.context.close();
    }
    const r = await compareLook({
      appUrl: app.origin + c.app,
      framePath: NEWJOB_FRAME,
      pairs: c.pairs,
      browser,
      setup: async (page, which) => {
        if (which === 'frame') return tagFrames(page);
        await page.waitForSelector('.r1-screen', { state: 'visible' }); // visible: a streamed screen is first attached in React's hidden segment (F-1909)
        if (c.ready) await page.waitForSelector(c.ready, { state: 'visible', timeout: 60_000 });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-DISP-28 a look case must be able to fail: the Customer picked frame read against the page with nobody picked differs
  it('flags the Start page read against the Customer picked frame (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: app.origin + '/shell-preview/newjob/start',
      framePath: NEWJOB_FRAME,
      pairs: [{ app: `${NEWJOB_SCREEN} .left > .card:nth-child(1) .in`, frame: '[data-bw-cap="SCR-OFC-04 New job: Customer picked"] .left > .card:nth-child(1) .in' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
        else await page.waitForSelector(NEWJOB_SCREEN, { state: 'attached' });
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
