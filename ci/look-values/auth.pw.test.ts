// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-AUTH-5, FR-AUTH-6, FR-AUTH-7 (the look of the sign-in, access-code and start screens is held by the comparator, OA-84)
// G-LOOK-PARITY on the P2-AUTH screens (SCR-OFC-01, SCR-GATE-01, SCR-GATE-02), on Chromium and WebKit, against the real app (the
// harness build served by ci/web-app.ts) in each state its frame shows. Run by ci/gates/look-values-comparator.sh; the unit-tests
// gate excludes *.pw.test.ts.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { AUTH_CASES, AUTH_FRAMES, uncovered } from './auth-cases.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe.each(engines)('auth look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-AUTH-6 every captioned state of the 3 screens has a case that compares it, or a stated reason it has none
  it('compare every state the 3 frames show, keyed by frame caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const captions: Record<string, string[]> = {};
    for (const f of AUTH_FRAMES) {
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

  // why: FR-AUTH-5, FR-AUTH-6, FR-AUTH-7 each screen matches its frame page in the state the frame shows (G-LOOK-PARITY)
  it.each(AUTH_CASES)('look case: $name', async (c) => {
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
        await page.waitForSelector(`.r1-screen[data-screen="${c.screen}"]`, { state: 'attached' });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-AUTH-6 the SCR-GATE-01 Checking state: the busy label, aria-busy and the spinner's box and border are the frame's (F-287);
  // the button's own box and font differ by design (the tile draws it outside .codeform), so the look case leaves it out
  it('draws the SCR-GATE-01 Checking button with the frame tile\'s label, aria-busy and spinner', async () => {
    const read = async (page: import('playwright').Page, sel: string) =>
      page.evaluate((s) => {
        const g = globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null; getAttribute(n: string): string | null; querySelector(s: string): unknown } | null }; getComputedStyle(e: unknown): Record<string, string> };
        const b = g.document.querySelector(s);
        if (!b) throw new Error(`no ${s}`);
        const sp = g.getComputedStyle(b.querySelector('.r1-spin'));
        return { label: (b.textContent ?? '').trim(), busy: b.getAttribute('aria-busy'), spin: [sp.width, sp.height, sp.borderTopWidth, sp.borderTopColor, sp.borderRadius] };
      }, sel);
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const fp = await g.context.newPage();
    await fp.goto(pathToFileURL(path.resolve(AUTH_FRAMES[1]!)).href, { waitUntil: 'load' });
    await tagFrames(fp);
    const want = await read(fp, `[data-bw-cap="SCR-GATE-01 Access code: Checking"] .btn.busy`);
    await g.context.close();
    expect(want.label).toBe('Checking');
    const ctx = await guardedContext(browser, [app.origin], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await ctx.context.newPage();
    await page.goto(app.origin + '/shell-preview/auth-gate/checking', { waitUntil: 'load' });
    await page.waitForSelector('.r1-screen[data-screen="SCR-GATE-01"] .codeform .btn.enter.busy', { state: 'attached' });
    const got = await read(page, '.r1-screen[data-screen="SCR-GATE-01"] .codeform .btn.enter.busy');
    await ctx.context.close();
    expect(got).toEqual(want);
  }, 120_000);

  // why: FR-AUTH-6 the SCR-GATE-02 List loading skeleton widths (40, 95, 95, 80 percent) are the frame's; the look case leaves them out
  // because the tile's skeleton height is a tile-only rule, so they are held here (F-287)
  it('draws the SCR-GATE-02 List loading skeleton at the widths the frame tile gives it', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const fp = await g.context.newPage();
    await fp.goto(pathToFileURL(path.resolve(AUTH_FRAMES[2]!)).href, { waitUntil: 'load' });
    const wanted = await fp.evaluate(() => {
      const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ style: { width: string } }> } }).document;
      return Array.from(d.querySelectorAll('[data-ctl="CTL-GATE-02-04"] .r1-skel'), (e) => e.style.width);
    });
    await g.context.close();
    expect(wanted).toEqual(['40%', '95%', '95%', '80%']);
    const ctx = await guardedContext(browser, [app.origin], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const page = await ctx.context.newPage();
    await page.goto(app.origin + '/shell-preview/auth-start/loading', { waitUntil: 'load' });
    const sel = '.r1-screen[data-screen="SCR-GATE-02"] [data-ctl="CTL-GATE-02-04"] .r1-skel';
    await page.waitForSelector(sel, { state: 'attached' });
    const got = await page.evaluate((s) => {
      const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ getBoundingClientRect(): { width: number }; parentElement: { getBoundingClientRect(): { width: number } } | null }> } }).document;
      return Array.from(d.querySelectorAll(s), (e) => `${Math.round((e.getBoundingClientRect().width / (e.parentElement?.getBoundingClientRect().width ?? 1)) * 100)}%`);
    }, sel);
    await ctx.context.close();
    expect(got).toEqual(wanted);
  }, 120_000);

  // why: FR-AUTH-6 a look case must be able to fail: the access-code screen read against the sign-in frame differs
  it('flags the access-code screen read against the sign-in frame (the cases are not vacuous)', async () => {
    const c = AUTH_CASES.find((x) => x.screen === 'SCR-GATE-01')!;
    const r = await compareLook({
      appUrl: app.origin + c.app,
      framePath: 'mockups/pages/office-signin.html',
      pairs: [{ app: `.r1-screen[data-screen="SCR-GATE-01"] .side`, frame: `[data-bw-cap="SCR-OFC-01 Staff sign-in: Default"] .side` }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
