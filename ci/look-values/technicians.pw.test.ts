// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-33, FR-TEXT-11, FR-AUTH-12 (the look of SCR-OFC-07 and its 2 dialogs is held by the comparator, OA-84)
// G-LOOK-PARITY on the P4-TECHNICIANS screens (SCR-OFC-07, -41, -42), on Chromium and WebKit, against the real app (the harness build served by
// ci/web-app.ts) in each state DK-92 draws. Run by ci/gates/look-values-comparator.sh (Chromium) and the nightly half (WebKit); the unit-tests gate
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
import { TECH_CASES, TECH_FRAME, TECH_SCREEN, uncoveredTech } from './technicians-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe('technicians page sheets', () => {
  // why: FR-DISP-33 the page's own rules are the frame's last style block, copied byte for byte (UI-DESIGN-KIT 1.1)
  it('copies the frame page\'s own style block byte for byte', () => {
    const frame = readFileSync(TECH_FRAME, 'utf8');
    const blocks = [...frame.matchAll(/<style>\n([\s\S]*?)<\/style>/g)].map((m) => m[1] as string);
    const copy = readFileSync('apps/web/styles/page-office-technicians.css', 'utf8');
    const body = copy.slice(copy.indexOf('*/\n') + 3);
    expect(body).toBe(blocks.at(-1));
  });
});

describe.each(engines)('technicians page look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-DISP-33 every captioned state of the 3 screens has a case that compares it, or a stated reason it has none
  it('compares every state the frame shows for SCR-OFC-07, SCR-OFC-41 and SCR-OFC-42, keyed by caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const fp = await g.context.newPage();
    await fp.goto(pathToFileURL(path.resolve(TECH_FRAME)).href, { waitUntil: 'load' });
    const captions = await fp.evaluate(() => {
      const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
      return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
    });
    await g.context.close();
    expect(captions.length).toBe(16);
    expect(uncoveredTech(captions)).toEqual([]);
  }, 120_000);

  // why: FR-DISP-33, FR-TEXT-11 a page shown in Spanish prints the words of the stored codes (user status, Right now, phone apps) from the Spanish catalog
  it.each(['en', 'es'] as const)('prints the catalog words of the stored codes in the preview (%s)', async (lang) => {
    const words = JSON.parse(readFileSync(`packages/i18n/catalog/${lang}.json`, 'utf8')) as Record<string, string>;
    const g = await guardedContext(browser, [app.origin], { viewport: { width: 1440, height: 900 } });
    await g.context.addCookies([{ name: 'bw_lang', value: lang, url: app.origin }]);
    const page = await g.context.newPage();
    await page.goto(`${app.origin}/shell-preview/technicians/success`, { waitUntil: 'load' });
    await page.waitForSelector(`${TECH_SCREEN} .tbl tbody tr`, { state: 'visible', timeout: 60_000 });
    const text = await page.locator(`${TECH_SCREEN} .tbl`).innerText();
    expect(text).toContain(words['technicians.status.invited']);
    expect(text).toContain(words['technicians.status.active']);
    expect(text).toContain(words['status.job.onSite']);
    expect(text).toContain(words['status.job.onTheWay']);
    expect(text).not.toMatch(/\b(invited|on_site|on_the_way|turned_off)\b/);
    await g.context.close();
  }, 120_000);

  // why: FR-DISP-33 each screen matches its frame in the state the frame shows (G-LOOK-PARITY)
  it.each(TECH_CASES)('look case: $name', async (c) => {
    let widths: number[] = [];
    if (c.widthFrom) {
      const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(TECH_FRAME)).href, { waitUntil: 'load' });
      widths = await frameWidths(fp, c.widthFrom);
      await g.context.close();
    }
    const r = await compareLook({
      appUrl: app.origin + c.app,
      framePath: TECH_FRAME,
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

  // why: FR-DISP-33 a look case must be able to fail: a disabled Save read against an enabled one differs
  it('flags a disabled Save read against an enabled one (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: app.origin + '/shell-preview/technicians/problem',
      framePath: TECH_FRAME,
      pairs: [{ app: `${TECH_SCREEN} .det .acts > button.btn.primary`, frame: '[data-bw-cap="SCR-OFC-42 Add time off: Saved"] .toff .btn' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
        else await page.waitForSelector(TECH_SCREEN, { state: 'attached' });
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
