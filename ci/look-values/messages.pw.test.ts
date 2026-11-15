// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-13, FR-TEXT-15, FR-TEXT-24, FR-TEXT-25 (the look of the Messages text log and call list is held by the comparator, OA-84)
// G-LOOK-PARITY on the P4-MESSAGES screens (SCR-OFC-08, SCR-OFC-09), on Chromium and WebKit, against the real app (the harness build served by
// ci/web-app.ts) in each state its frame shows. Run by ci/gates/look-values-comparator.sh; the unit-tests gate excludes *.pw.test.ts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { MESSAGES_CASES, MESSAGES_FRAMES, root, uncovered } from './messages-cases.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('messages look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-TEXT-15 every captioned state of the 2 frames has a case that compares it, or a stated reason it has none
  it('compare every state the frames show, keyed by frame caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const captions: Record<string, string[]> = {};
    for (const f of MESSAGES_FRAMES) {
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

  // why: FR-TEXT-13, FR-TEXT-15, FR-TEXT-25 each screen matches its frame page in the state the frame shows (G-LOOK-PARITY)
  it.each(MESSAGES_CASES)('look case: $name', async (c) => {
    const screen = c.app.includes('/call-list/') ? 'SCR-OFC-09' : 'SCR-OFC-08';
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
        await page.waitForSelector(root(screen), { state: 'attached' });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-TEXT-15 a look case must be able to fail: the call list read against the text log frame differs
  it('flags the call list read against the text log frame (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: app.origin + '/shell-preview/call-list/success',
      framePath: 'mockups/pages/office-messages.html',
      pairs: [{ app: `${root('SCR-OFC-09')} .mh h1`, frame: `[data-bw-cap="SCR-OFC-08 Messages: text log: Success"] .mh .acts` }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
