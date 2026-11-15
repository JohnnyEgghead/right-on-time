// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-AUTH-12, FR-AUTH-8, FR-AUTH-9 (the look of the users page, its dialogs and the 3 email pages is held by the comparator, OA-84)
// G-LOOK-PARITY on the P4-ACCOUNTS screens (SCR-OFC-43 to -46, SCR-EML-01 to -03), against the real app (the harness build
// served by ci/web-app.ts) in each state its frame shows, light theme. Run by ci/gates/look-values-comparator.sh (Chromium)
// and the nightly gate (WebKit); the unit-tests gate excludes *.pw.test.ts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { ACCOUNTS_CASES, ACCOUNTS_FRAMES, uncovered } from './accounts-cases.ts';
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

describe.each(engines)('accounts look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-AUTH-12 every captioned state of the 7 screens has a case that compares it, or a stated reason it has none
  it('compares every state the 4 frames show, keyed by frame caption', async () => {
    const g = await guardedContext(browser, [], VIEW);
    const captions: Record<string, string[]> = {};
    for (const f of ACCOUNTS_FRAMES) {
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(f)).href, { waitUntil: 'load' });
      captions[f] = await fp.evaluate(() => {
        const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
        return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
      });
      await fp.close();
    }
    await g.context.close();
    expect(Object.values(captions).flat().length).toBeGreaterThan(20);
    expect(uncovered(captions)).toEqual([]);
  }, 120_000);

  // why: FR-AUTH-12, FR-AUTH-8, FR-AUTH-9 each screen matches its frame page in the state the frame shows (G-LOOK-PARITY)
  it.each(ACCOUNTS_CASES)('look case: $name', async (c) => {
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
        await page.waitForSelector(`.r1-screen[data-screen="${c.screen}"]`, { state: 'attached' });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-AUTH-12 a look case must be able to fail: the users page read against the email frame differs
  it('flags the users page read against the email frame (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: `${app.origin}/shell-preview/accounts-users/success`,
      framePath: 'mockups/pages/r1-eml-email.html',
      pairs: [{ app: '.r1-screen[data-screen="SCR-OFC-43"] .ah h1', frame: '[data-bw-cap="SCR-EML-01 Email inbox: 1 email: Shown"] .mh h1' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
