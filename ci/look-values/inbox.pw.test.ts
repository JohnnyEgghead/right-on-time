// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-14, FR-TEXT-8 (the look of the text inbox and Change your visit time is held by the comparator, OA-84)
// G-LOOK-PARITY on the P5-INBOX screens (SCR-INB-01, SCR-CUS-06), against the real app (the harness build
// served by ci/web-app.ts) in each state its frame shows, light theme. Run by ci/gates/look-values-comparator.sh (Chromium)
// and the nightly gate (WebKit); the unit-tests gate excludes *.pw.test.ts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { INBOX_CASES, INBOX_FRAMES, uncovered } from './inbox-cases.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
const VIEW = { viewport: { width: 1440, height: 900 }, colorScheme: 'light' as const, reducedMotion: 'reduce' as const };
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('inbox look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-TEXT-14 every captioned state of the 2 screens has a case that compares it, or a stated reason it has none
  it('compares every state the 4 frames show, keyed by frame caption', async () => {
    const g = await guardedContext(browser, [], VIEW);
    const captions: Record<string, string[]> = {};
    for (const f of INBOX_FRAMES) {
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(f)).href, { waitUntil: 'load' });
      captions[f] = await fp.evaluate(() => {
        const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
        return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
      });
      await fp.close();
    }
    await g.context.close();
    expect(Object.values(captions).flat().length).toBeGreaterThan(8);
    expect(uncovered(captions)).toEqual([]);
  }, 120_000);

  // why: FR-TEXT-14, FR-TEXT-8 each screen matches its frame page in the state the frame shows (G-LOOK-PARITY)
  it.each(INBOX_CASES)('look case: $name', async (c) => {
    let widths: number[] = [];
    if (c.widthFrom) {
      const g = await guardedContext(browser, [], VIEW);
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
        await page.waitForSelector(`.r1-screen[data-screen="${c.screen}"] .screen`, { state: 'attached' });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-TEXT-14 a look case must be able to fail: the inbox read against the reschedule frame differs
  it('flags the users page read against the email frame (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: `${app.origin}/shell-preview/inbox/success`,
      framePath: 'mockups/pages/customer-reschedule.html',
      pairs: [{ app: '.r1-screen[data-screen="SCR-INB-01"] .screen .whose', frame: '[data-bw-cap="SCR-CUS-06 Change your visit time: Choosing"] .screen .keep' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
