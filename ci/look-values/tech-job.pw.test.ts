// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-3, FR-TECH-8, FR-TECH-14 (the look of the technician app's job screens is held by the comparator, OA-84)
// G-LOOK-PARITY on P5-TWA-JOB's screens (SCR-TEC-04, -05, -07, -09 against DK-110 to DK-112), on Chromium and WebKit, against the real
// app (the harness build served by ci/web-app.ts). Run by ci/gates/look-values-comparator.sh; the unit-tests gate excludes *.pw.test.ts.
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
import { noSignalHtml, serveHtml } from './sw-page.ts';
import { FINISH_FRAME, JOB_FRAME, OFFLINE_FRAME, TECH_JOB_CASES, uncoveredStates } from './tech-job-cases.ts';

const SCREEN_BUDGET_S = 30;
const VIEW = { viewport: { width: 1440, height: 900 }, colorScheme: 'light' as const, reducedMotion: 'reduce' as const };
/**
 * F-1137 (owner ruling 362101fd, "Redraw at 44 px"): the cases run at the desktop window the frames are read at and at the 520 x 980 phone
 * window, where the frames' phone rule (the media block of DK-110 to DK-112) and the app's own rules are both in force, so a phone-only
 * departure from a frame is caught.
 */
const WINDOWS = [{ label: '1440 x 900', width: 1440, height: 900 }, { label: '520 x 980', width: 520, height: 980 }] as const;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe('technician job page sheets', () => {
  // why: FR-TECH-8 the pages' own rules are their frames' last style blocks, copied byte for byte (UI-DESIGN-KIT 1.1)
  it.each([[JOB_FRAME, 'apps/web/styles/page-tech-job.css'], [FINISH_FRAME, 'apps/web/styles/page-tech-finish.css']])('copies %s\'s own style block byte for byte', (frame, sheet) => {
    const blocks = [...readFileSync(frame, 'utf8').matchAll(/<style>\n([\s\S]*?)<\/style>/g)].map((m) => m[1] as string);
    const copy = readFileSync(sheet, 'utf8');
    expect(copy.slice(copy.indexOf('*/\n') + 3)).toBe(blocks.at(-1));
  });
});

describe.each(engines)('technician job screens look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-TECH-3, FR-TECH-8, FR-TECH-14 every captioned state of SCR-TEC-04 to -07 and -09 in DK-110 to DK-112 has a case, or a named reason for none (F-1024)
  it('compares every state DK-110 to DK-112 caption for the 5 screens', async () => {
    const g = await guardedContext(browser, [], VIEW);
    const fp = await g.context.newPage();
    const caps: string[] = [];
    for (const f of [JOB_FRAME, OFFLINE_FRAME, FINISH_FRAME]) {
      await fp.goto(pathToFileURL(path.resolve(f)).href, { waitUntil: 'load' });
      caps.push(...await fp.evaluate(() => {
        const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
        return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
      }));
    }
    await g.context.close();
    // Kit 0.9 added SCR-TEC-04 Offline, screen not saved and SCR-TEC-09 Refused (F-1144): 31. Kit 0.12 added SCR-TEC-04 Reading the phone (web) (57520d6c): 32.
    expect(caps.filter((c) => /^SCR-TEC-0[4-79] /.test(c)).length).toBe(32);
    expect(uncoveredStates(caps)).toEqual([]);
  }, 120_000);

  // why: FR-TECH-3, FR-TECH-8, FR-TECH-14, NFR-06 each screen matches its frame in the state the frame shows, at the desktop and the phone window (G-LOOK-PARITY, F-1137)
  describe.each(WINDOWS)('at $label', (win) => {
  const view = { ...VIEW, viewport: { width: win.width, height: win.height } };
  it.each(TECH_JOB_CASES)('look case: $name', async (c) => {
    let widths: number[] = [];
    if (c.widthFrom) {
      const g = await guardedContext(browser, [], view);
      const fp = await g.context.newPage();
      await fp.goto(pathToFileURL(path.resolve(c.frame)).href, { waitUntil: 'load' });
      await tagFrames(fp);
      widths = await frameWidths(fp, c.widthFrom);
      await g.context.close();
    }
    // F-1144: the service worker's no-signal page is served as the worker answers it (sw-page.ts), not from the harness build.
    const sw = c.swNoSignal ? await serveHtml((await noSignalHtml(c.app)).html) : null;
    const r = await compareLook({
      appUrl: (sw?.origin ?? app.origin) + c.app,
      framePath: c.frame,
      pairs: c.pairs,
      browser,
      viewport: view.viewport,
      setup: async (page, which) => {
        if (which === 'frame') return tagFrames(page);
        await page.waitForSelector(c.ready, { state: 'attached' });
        if (c.widthFrom) await applyWidths(page, c.widthFrom, widths);
      },
    });
    await sw?.stop();
    console.log(`screen-seconds ${engine} ${c.app} ${r.seconds}`);
    expect(formatDifferences(r)).toMatch(/^PASS /);
    expect(r.seconds).toBeLessThanOrEqual(SCREEN_BUDGET_S);
  }, 120_000);
  });
});
