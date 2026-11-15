// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-5, FR-DISP-25, FR-DISP-26, FR-DISP-27, FR-TEXT-20 (the look of SCR-OFC-03 and its 7 dialogs is held by the comparator, OA-84)
// G-LOOK-PARITY on the P4-JOB screens (SCR-OFC-03, -20, -21, -22, -23, -35, -36, -37), on Chromium and WebKit, against the real
// app (the harness build served by ci/web-app.ts) in each state DK-87 draws. Run by ci/gates/look-values-comparator.sh
// (Chromium) and the nightly half (WebKit); the unit-tests gate excludes *.pw.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { compareLook, formatDifferences } from './compare.ts';
import { JOB_CASES, JOB_FRAME, JOB_SCREEN, uncoveredJob } from './job-cases.ts';
import { applyWidths, frameWidths, tagFrames } from './shell-cases.ts';

const SCREEN_BUDGET_S = 30;
let app: WebApp;

beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

describe('job page sheets', () => {
  // why: FR-DISP-5 the page's own rules are the frame's last style block, copied byte for byte (UI-DESIGN-KIT 1.1)
  it('copies the frame page\'s own style block byte for byte', () => {
    const frame = readFileSync(JOB_FRAME, 'utf8');
    const blocks = [...frame.matchAll(/<style>\n([\s\S]*?)<\/style>/g)].map((m) => m[1] as string);
    const copy = readFileSync('apps/web/styles/page-office-job.css', 'utf8');
    const body = copy.slice(copy.indexOf('*/\n') + 3);
    expect(body).toBe(blocks.at(-1));
  });
});

describe.each(engines)('job page look on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-DISP-5 every captioned state of the 8 screens has a case that compares it, or a stated reason it has none
  it('compares every state the frame shows for SCR-OFC-03 and its 7 dialogs, keyed by caption', async () => {
    const g = await guardedContext(browser, [], { viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
    const fp = await g.context.newPage();
    await fp.goto(pathToFileURL(path.resolve(JOB_FRAME)).href, { waitUntil: 'load' });
    const captions = await fp.evaluate(() => {
      const d = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ textContent: string | null }> } }).document;
      return Array.from(d.querySelectorAll('p.frame-cap'), (c) => (c.textContent ?? '').trim());
    });
    await g.context.close();
    expect(captions.length).toBeGreaterThan(40);
    expect(uncoveredJob(captions)).toEqual([]);
  }, 120_000);

  // why: F-698, CTL-OFC-03-11, CTL-OFC-03-17 the preview answers the stored codes API-23 answers, so a code printed raw shows here, in both languages
  it.each(['en', 'es'] as const)('prints the words of the stored codes in the preview\'s answer (%s)', async (lang) => {
    const words = JSON.parse(readFileSync(`packages/i18n/catalog/${lang}.json`, 'utf8')) as Record<string, string>;
    const g = await guardedContext(browser, [app.origin], { viewport: { width: 1440, height: 900 } });
    await g.context.addCookies([{ name: 'bw_lang', value: lang, url: app.origin }]);
    const page = await g.context.newPage();
    await page.goto(`${app.origin}/shell-preview/job/success`, { waitUntil: 'load' });
    await page.waitForSelector(`${JOB_SCREEN} .arrive .tech`, { state: 'visible', timeout: 60_000 });
    expect(await page.locator(`${JOB_SCREEN} [data-ctl="CTL-OFC-03-11"] .eq b`).allInnerTexts()).toEqual([
      `${words['customers.equipment.furnace']} - 2014`, `${words['customers.equipment.air_conditioner']} - 2014`, `${words['customers.equipment.thermostat']} - 2019`,
    ]);
    const feed = await page.locator(`${JOB_SCREEN} [data-ctl="CTL-OFC-03-17"]`).innerText();
    expect(feed).not.toMatch(/\b(delivered|on_the_way)\b/);
    expect(feed).toContain(words['msg.status.delivered']);
    expect(feed).toContain(words['job.feed.kind.status.on_the_way']);
    await g.context.close();
  }, 120_000);

  // why: FR-DISP-5, F-1543, F-1550 every panel's drawn body text starts at the panel's inset (the title's left edge, or the 18px the frame's rows use), never on the panel's edge
  it.each(['success', 'done', 'no-one-home', 'bare'])('keeps every panel body line inside the panel padding (%s)', async (state) => {
    const g = await guardedContext(browser, [app.origin], { viewport: { width: 1440, height: 900 } });
    const page = await g.context.newPage();
    await page.goto(`${app.origin}/shell-preview/job/${state}`, { waitUntil: 'load' });
    await page.waitForSelector(`${JOB_SCREEN} .card`, { state: 'visible', timeout: 60_000 });
    // F-1550: only drawn text is measured. Before the page's scripts run, the Call control is drawn in both forms and the
    // style rule hides one (UD-56, display: none); that text has no box, so its range reads 0 and would sit at -(panel left).
    const rows = (await page.evaluate(`(() => {
      const out = [];
      for (const card of document.querySelectorAll(${JSON.stringify(JOB_SCREEN)} + ' .card')) {
        const box = card.getBoundingClientRect();
        const h = card.querySelector('.card-h h3');
        const inset = h ? h.getBoundingClientRect().left - box.left : 18;
        const title = h ? h.textContent : card.getAttribute('data-ctl');
        const walk = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const text = (n.textContent || '').trim();
          if (text === '' || n.parentElement.closest('.mapm')) continue;
          const r = document.createRange();
          r.selectNodeContents(n);
          if (r.getClientRects().length === 0) continue;
          const left = r.getBoundingClientRect().left - box.left;
          out.push({ title, text: text.slice(0, 40), left: Math.round(left * 10) / 10, inset: Math.round(inset * 10) / 10 });
        }
      }
      return out;
    })()`)) as { title: string; text: string; left: number; inset: number }[];
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => r.left < r.inset - 0.5), 'text that starts left of its panel inset').toEqual([]);
    await g.context.close();
  }, 120_000);

  // why: FR-DISP-5, FR-DISP-25, FR-DISP-26, FR-DISP-27, FR-TEXT-20 each screen matches its frame in the state the frame shows (G-LOOK-PARITY)
  it.each(JOB_CASES)('look case: $name', async (c) => {
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

  // why: FR-DISP-27 a look case must be able to fail: a disabled Send read against an enabled one differs
  it('flags a disabled Send read against an enabled one (the cases are not vacuous)', async () => {
    const r = await compareLook({
      appUrl: app.origin + '/shell-preview/job/text-empty',
      framePath: JOB_FRAME,
      pairs: [{ app: '[data-bw-hosted="text-empty"] .r1-dlg-f .btn.primary', frame: '[data-bw-cap="SCR-OFC-35 Text customer: Typing"] .r1-dlg-f .btn.primary' }],
      browser,
      setup: async (page, which) => {
        if (which === 'frame') await tagFrames(page);
        else await page.waitForSelector(JOB_SCREEN, { state: 'attached' });
      },
    });
    expect(r.differences.length).toBeGreaterThan(0);
  }, 120_000);
});
