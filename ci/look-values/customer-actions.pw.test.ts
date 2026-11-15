// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-31, FR-TEXT-20 (the look of the 3 dialogs the customer page hosts is held by the comparator, OA-84)
// G-LOOK-PARITY on SCR-OFC-35, SCR-OFC-36 and SCR-OFC-37 as the customer page hosts them (P4-CUSTOMER-ACTIONS), on Chromium and WebKit,
// against DK-87 (the job page's frame) in each state it draws for them, on the real app (the harness build served by ci/web-app.ts). Run by
// ci/gates/look-values-comparator.sh (Chromium) and the nightly half (WebKit); the unit-tests gate excludes *.pw.test.ts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { CUSTOMER_ACTION_CASES, uncoveredCustomerActions } from './customer-actions-cases.ts';
import { JOB_FRAME } from './job-cases.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('customer page hosted dialogs look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-DISP-31 every captioned state of SCR-OFC-35, -36 and -37 on DK-87 has a case that compares it on the customer page, or a stated reason it has none
  it('compares every state the frame shows for the 3 dialogs, keyed by caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const fp = await g.context.newPage();
    await fp.goto(pathToFileURL(path.resolve(JOB_FRAME)).href, { waitUntil: 'load' });
    const captions = await fp.evaluate(() => {
      const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
      return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
    });
    await g.context.close();
    expect(captions.length).toBeGreaterThan(40);
    expect(uncoveredCustomerActions(captions)).toEqual([]);
  }, 120_000);

  // why: FR-DISP-31, FR-TEXT-20 each hosted dialog matches DK-87 in the state the frame shows (G-LOOK-PARITY), on the customer page
  it.each(CUSTOMER_ACTION_CASES)('look case: $name', async (c) => {
    let widths: number[] = [];
    if (c.widthFrom) {
      const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(JOB_FRAME)).href, { waitUntil: 'load' });
      widths = await frameWidths(fp, c.widthFrom);
      await g.context.close();
    }
    const r = await compareLook({
      appUrl: app.origin + c.app,
      framePath: JOB_FRAME,
      pairs: c.pairs,
      browser,
      setup: async (page, which) => {
        if (which === 'frame') return tagFrames(page);
        await page.waitForSelector('.r1-screen', { state: 'attached' });
        if (c.ready) await page.waitForSelector(c.ready, { state: 'visible', timeout: 60_000 });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-DISP-31 a look case must be able to fail: the Text dialog read against the frame's Add note tile differs (it holds more fields)
  it('flags the Text dialog read against the frame\'s Add note tile (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: app.origin + '/shell-preview/customer/text-empty',
      framePath: JOB_FRAME,
      pairs: [{ app: '[data-bw-hosted="text-empty"] .r1-dlg', frame: '[data-bw-cap="SCR-OFC-36 Add note: Empty"] .r1-dlg' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
        else await page.waitForSelector('.r1-screen', { state: 'attached' });
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
