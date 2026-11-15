// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: NFR-06 (UI-SPECIFICATION 14.1 item 2: a modal dialog keeps Tab inside, closes on Escape and returns focus to its opener)
// P7-A11Y F-1471, F-1472: the Tab ring and the focus return on the real app (the harness build served by ci/web-app.ts), on Chromium
// and WebKit, through useModalFocus. Opened from a focused opener with the keyboard; closed with Escape. Run by
// ci/gates/look-values-comparator.sh (Chromium) and the nightly half (WebKit); the unit-tests gate excludes *.pw.test.ts.
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';

// The root tsconfig has no DOM lib, so page-side code reads the document through this narrow shape (types only, erased before the page sees it).
type El = { tagName: string; className: string; classList: { contains(c: string): boolean }; getAttribute(n: string): string | null; closest(s: string): unknown };
type Doc = { activeElement: El | null; body: unknown };

let app: WebApp;
beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

const where = (p: Page) =>
  p.evaluate(() => {
    const d = (globalThis as unknown as { document: Doc }).document;
    const a = d.activeElement;
    if (!a || a === d.body) return 'BODY';
    return `${a.tagName.toLowerCase()}[${a.getAttribute('data-ctl') ?? a.className}]`;
  });

describe.each(engines)('dialog focus on %s', (_engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  });

  async function open(path: string, width: number, opener: string, dialog: string, until: 'networkidle' | 'load' = 'networkidle', by: 'keyboard' | 'pointer' = 'keyboard') {
    const g = await guardedContext(browser, [app.origin], { viewport: { width, height: 980 } });
    const page = await g.context.newPage();
    await page.goto(app.origin + path, { waitUntil: until });
    const o = page.locator(opener).first();
    await o.waitFor({ timeout: 20_000 });
    await o.focus();
    // Activate by the keyboard where the opener is a button, by a script click where it is a focusable card.
    if (by === 'keyboard' && (await o.evaluate((e) => e.tagName)) === 'BUTTON') await page.keyboard.press('Enter');
    else await o.click();
    await page.waitForSelector(dialog, { timeout: 10_000 });
    return { g, page, opener: o };
  }
  const closeWithEscape = async (page: Page, dialog: string) => {
    await page.keyboard.press('Escape');
    await page.waitForSelector(dialog, { state: 'detached', timeout: 10_000 });
  };

  // why: UI-SPECIFICATION 14.1 item 2 (F-1471) Note discard moves focus in with autoFocus, so Escape must still return to the Discard button, not the body
  it('SCR-TEC-05 Note discard returns focus to Discard after Escape', async () => {
    const { g, page } = await open('/shell-preview/tech-note/typing', 520, 'button.disc', '.cdlg');
    await closeWithEscape(page, '.cdlg');
    expect(await where(page)).toBe('button[CTL-TEC-05-03]');
    expect(await page.evaluate(() => ((globalThis as unknown as { document: Doc }).document).activeElement?.classList.contains('disc'))).toBe(true);
    await g.context.close();
  });

  // why: UI-SPECIFICATION 14.1 item 2 (F-1479) WebKit never focuses a button on a click, so a pointer-opened dialog recorded the body as its opener and returned focus nowhere
  it('SCR-TEC-05 Note discard opened by a click returns focus to Discard after Escape', async () => {
    const { g, page } = await open('/shell-preview/tech-note/typing', 520, 'button.disc', '.cdlg', 'networkidle', 'pointer');
    await closeWithEscape(page, '.cdlg');
    expect(await where(page)).toBe('button[CTL-TEC-05-03]');
    await g.context.close();
  });

  // why: UI-SPECIFICATION 14.1 item 2 (F-1471) the Finish button is unmounted while the confirm step is up, so Escape must return to the remounted Finish button (CTL-TEC-07-06), not the body
  it('SCR-TEC-07 Finish confirm step returns focus to the Finish button after Escape', async () => {
    const { g, page } = await open('/shell-preview/tech-finish/signed', 520, '[data-ctl="CTL-TEC-07-06"]', '.cstep');
    await closeWithEscape(page, '.cstep');
    expect(await where(page)).toBe('button[CTL-TEC-07-06]');
    await g.context.close();
  });

  // why: UI-SPECIFICATION 14.1 item 2 and NFR-06 Tab at the last stop wraps to the first and Shift+Tab at the first to the last, so focus never leaves the dialog (F-1472)
  it('SCR-TEC-05 Note discard wraps Tab and Shift+Tab inside the dialog', async () => {
    const { g, page } = await open('/shell-preview/tech-note/typing', 520, 'button.disc', '.cdlg');
    const inside = () => page.evaluate(() => Boolean(((globalThis as unknown as { document: Doc }).document).activeElement?.closest('.cdlg')));
    const first = await page.evaluate(() => ((globalThis as unknown as { document: Doc }).document).activeElement?.className);
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      expect(await inside()).toBe(true);
    }
    // 5 Tabs over a ring of 2 leaves focus on the other button; 1 more is back on the first
    expect(await page.evaluate(() => ((globalThis as unknown as { document: Doc }).document).activeElement?.className)).not.toBe(first);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => ((globalThis as unknown as { document: Doc }).document).activeElement?.className)).toBe(first);
    await page.keyboard.press('Shift+Tab');
    expect(await inside()).toBe(true);
    expect(await page.evaluate(() => ((globalThis as unknown as { document: Doc }).document).activeElement?.className)).not.toBe(first);
    await g.context.close();
  });

  // why: UI-SPECIFICATION 14.1 item 2 the Finish confirm step keeps Tab inside too (3 stops: confirm, go back, and the ring wraps)
  it('SCR-TEC-07 Finish confirm step wraps Tab inside the dialog', async () => {
    const { g, page } = await open('/shell-preview/tech-finish/signed', 520, '[data-ctl="CTL-TEC-07-06"]', '.cstep');
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => Boolean(((globalThis as unknown as { document: Doc }).document).activeElement?.closest('.cstep')))).toBe(true);
    }
    await g.context.close();
  });

  // why: UI-SPECIFICATION 14.1 item 2 and NFR-06 (F-1464) the customers, import and accounts dialogs keep Tab and Shift+Tab inside through useModalFocus: on WebKit their own trap let a Tab step over the last button
  for (const path of ['/shell-preview/customers/new-empty', '/shell-preview/import-dry/dlg-asking', '/shell-preview/accounts-users/invite-editing']) {
    it(`${path} keeps Tab and Shift+Tab inside the dialog`, async () => {
      const g = await guardedContext(browser, [app.origin], { viewport: { width: 1440, height: 980 } });
      const page = await g.context.newPage();
      await page.goto(app.origin + path, { waitUntil: 'networkidle' });
      await page.waitForSelector('.r1-dlg', { timeout: 20_000 });
      const inside = () => page.evaluate(() => Boolean(((globalThis as unknown as { document: Doc }).document).activeElement?.closest('.r1-dlg')));
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press('Tab');
        expect(await inside(), `Tab ${i + 1}`).toBe(true);
      }
      for (let i = 0; i < 14; i++) {
        await page.keyboard.press('Shift+Tab');
        expect(await inside(), `Shift+Tab ${i + 1}`).toBe(true);
      }
      await g.context.close();
    });
  }

  // why: UI-SPECIFICATION 14.1 item 2 the board Dialog (SCR-OFC-35) is the control that already returned focus; it must keep doing so
  it('SCR-OFC-35 board Dialog returns focus to its opener after Escape', async () => {
    const { g, page, opener } = await open('/shell-preview/job/success', 1440, 'button:text-matches("^(Add note|Reschedule|Text customer)$")', '[role=dialog][aria-modal=true]', 'load');
    await closeWithEscape(page, '[role=dialog][aria-modal=true]');
    expect(await opener.evaluate((e) => e === (globalThis as unknown as { document: Doc }).document.activeElement)).toBe(true);
    await g.context.close();
  });
});
