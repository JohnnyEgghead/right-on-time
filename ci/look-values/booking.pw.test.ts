// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-BOOK-1, FR-BOOK-3, FR-BOOK-4, FR-BOOK-14, FR-BOOK-15, FR-BOOK-16, FR-TEXT-1 (the look of SCR-CUS-01 to SCR-CUS-03 is held by the comparator, OA-84)
// G-LOOK-PARITY on the P5-BOOKING screens (SCR-CUS-01, SCR-CUS-02, SCR-CUS-03), on Chromium and WebKit, against the real app (the harness build served
// by ci/web-app.ts) in each state DK-118 to DK-121 draw, at 1440 x 900 and, for the phone frame, 520 x 980. Run by ci/gates/look-values-comparator.sh
// (Chromium) and the nightly half (WebKit); the unit-tests gate excludes *.pw.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { BOOKING_CASES, BOOKING_FRAMES, SCREENS, uncoveredBooking, type BookingFrameKey } from './booking-cases.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
const WIDE = { width: 1440, height: 900 };
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

/** The last <style> block of a frame: the page's own rules (UI-DESIGN-KIT 1.1). */
const lastBlock = (frame: string): string => {
  const blocks = [...readFileSync(frame, 'utf8').matchAll(/<style>\n([\s\S]*?)<\/style>/g)].map((m) => m[1] as string);
  return blocks.at(-1) as string;
};
const sheetBody = (file: string): string => {
  const copy = readFileSync(file, 'utf8');
  return copy.slice(copy.indexOf('*/\n') + 3);
};
/** The phone sheet: every selector of the frame's block prefixed with `.bw-ph` (the phone layout is drawn under that class). */
const scoped = (css: string): string =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => `${(m[1] as string).replace(/\/\*[\s\S]*?\*\//g, '').trim().split(',').map((x) => `.bw-ph ${x.trim()}`).join(', ')} {${m[2]}}`)
    .join('\n') + '\n';

describe('booking page sheets', () => {
  // why: FR-BOOK-1 the pages' own rules are the frames' last style blocks, copied byte for byte (UI-DESIGN-KIT 1.1)
  it('copies each frame page\'s own style block byte for byte', () => {
    expect(sheetBody('apps/web/styles/page-booking.css')).toBe(lastBlock(BOOKING_FRAMES.desktop));
    expect(sheetBody('apps/web/styles/page-booking-taken.css')).toBe(lastBlock(BOOKING_FRAMES.taken));
    expect(sheetBody('apps/web/styles/page-booking-done.css')).toBe(lastBlock(BOOKING_FRAMES.done));
  });
  // why: FR-BOOK-4 the phone sheet is the phone frame's block with every selector prefixed
  it('keeps the phone sheet as the phone frame\'s block with its selectors prefixed by .bw-ph', () => {
    expect(sheetBody('apps/web/styles/page-booking-phone.css')).toBe(scoped(lastBlock(BOOKING_FRAMES.phone)));
  });
});

describe.each(engines)('booking page look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-BOOK-1, FR-BOOK-3 every captioned state of SCR-CUS-01 to SCR-CUS-03 has a case that compares it, or a stated reason it has none
  it('compares every state the frames show for SCR-CUS-01 to SCR-CUS-03, keyed by caption', async () => {
    const byFrame = {} as Record<BookingFrameKey, string[]>;
    for (const key of Object.keys(BOOKING_FRAMES) as BookingFrameKey[]) {
      const g = await guardedContext(browser, [], { viewport: WIDE, colorScheme: 'light', reducedMotion: 'reduce' });
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(BOOKING_FRAMES[key])).href, { waitUntil: 'load' });
      byFrame[key] = await fp.evaluate(() => {
        const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
        return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
      });
      await g.context.close();
    }
    expect(byFrame.desktop).toHaveLength(10);
    expect(byFrame.phone).toHaveLength(2); // the second is CMP-15's Menu tile, the shell's
    expect(byFrame.taken).toHaveLength(4);
    expect(byFrame.done).toHaveLength(4);
    expect(uncoveredBooking(byFrame)).toEqual([]);
  }, 120_000);

  // why: FR-BOOK-1, FR-BOOK-3, FR-BOOK-4, FR-BOOK-14, FR-BOOK-15, FR-BOOK-16 each state of each screen matches its frame (G-LOOK-PARITY)
  it.each(BOOKING_CASES)('look case: $name', async (c) => {
    const view = c.viewport ?? WIDE;
    let widths: number[] = [];
    if (c.widthFrom) {
      const g = await guardedContext(browser, [], { viewport: view, colorScheme: 'light', reducedMotion: 'reduce' });
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(BOOKING_FRAMES[c.frame])).href, { waitUntil: 'load' });
      widths = await frameWidths(fp, c.widthFrom);
      await g.context.close();
    }
    const r = await compareLook({
      appUrl: app.origin + c.app,
      framePath: BOOKING_FRAMES[c.frame],
      pairs: c.pairs,
      browser,
      viewport: view,
      setup: async (page, which) => {
        if (which === 'frame') return tagFrames(page);
        await page.waitForSelector('.r1-screen', { state: 'attached' });
        await page.waitForSelector(c.ready, { state: 'visible', timeout: 60_000 });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);

  // why: FR-BOOK-3 a look case must be able to fail: the Step 1 to 6 frame read against the page with no street matching differs
  it('flags the No street match page read against the Step 1 to 6 frame (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: app.origin + '/shell-preview/booking/no-match',
      framePath: BOOKING_FRAMES.desktop,
      pairs: [{ app: `${SCREENS.s1} .main .left > .box:last-child .f .in`, frame: 'body > .main .left .box:nth-child(2) .f .in' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
        else await page.waitForSelector(`${SCREENS.s1} .msg`, { state: 'attached' });
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
