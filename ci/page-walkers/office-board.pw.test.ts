// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-BOARD-1, NFR-09 (P10-OFFICE-BOARD: the board shows the strip's time, a clock poll does not overlap, the top bar fits again after a language change)
// Playwright on Chromium and WebKit against the harness app (ci/web-app.ts): the live office screens at /shell-preview/live-reads/<name>. Every /api/v1
// request is answered by the test (a request nobody names fails, so the screen shows its own failed state for it), and the page clock is the test's
// (page.clock), so a run of 30 s takes no time. Run with the page walkers (ci/gates/page-walkers*.sh). The outside-origin guard is on for every page.
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engines } from '../pw-engines.ts';
import { startWebApp, type WebApp } from '../web-app.ts';
import { guardedContext } from './origin-guard.ts';
import { fixtures, rig, ZONE, type Answer, type Rec } from './rig.ts';

const [shell, boardFx] = await Promise.all([fixtures<Rec>('shell/preview-fixtures.ts'), fixtures<Rec>('board/preview-fixtures.ts')]);
const { CLOCK_RUNNING, MANAGER } = shell;

let app: WebApp;
beforeAll(async () => {
  app = await startWebApp();
}, 300_000);
afterAll(async () => {
  await app?.stop();
});

/** API-07's whole answer for the preview manager. */
const ME = { ...MANAGER, userId: 'u-dana', skill: null, employeeNumber: null, language: 'en' };
/** API-10's whole answer, with the demo time at `demoNow`. */
const clockAt = (demoNow: string, replay = { running: false, done: 0, total: 0 }) => ({ ...CLOCK_RUNNING, demoNow, realNow: demoNow, resetAvailableInSeconds: 0, replay });

describe.each(engines)('the office board screens on %s', (_name, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function open(path: string, width: number, demoNow: string, answers: Record<string, () => Answer>, lang: 'en' | 'es' = 'en', fakeClock = true) {
    const g = await guardedContext(browser, [app.origin], { viewport: { width, height: 900 }, colorScheme: 'light' });
    if (lang === 'es') await g.context.addCookies([{ name: 'bw_lang', value: 'es', url: app.origin }]);
    const page = await g.context.newPage();
    // The page's own fetch calls of the clock, counted in the page: the network stack may queue same-address reads behind an unanswered one,
    // which would hide a pile-up of reads the page made.
    await page.addInitScript(`(() => {
      window.__clockCalls = 0;
      const real = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url, window.location.href).pathname === '/api/v1/clock') window.__clockCalls += 1;
        return real(input, init);
      };
    })();`);
    if (fakeClock) await page.clock.install({ time: new Date('2026-09-15T14:28:50Z') });
    const r = await rig(page, { demoNow });
    for (const [key, answer] of Object.entries(answers)) r.on(key, answer);
    await page.goto(app.origin + path, { waitUntil: 'domcontentloaded' });
    return { page, r, context: g.context, close: () => g.context.close() };
  }

  // The bell's own alert, as API-43 answers it: an open text-gave-up alert that offers both the email link and Dismiss.
  const ALERT = '4b7c1f0e-5a1d-4c0e-9a55-2f6d1f0a7b11';
  const bellAlert = {
    id: ALERT, at: `2026-09-15T10:27:00-04:00${ZONE}`, type: 'text_gave_up', state: 'open', messageKey: 'alert.text_gave_up',
    messageValues: { kind: 'confirmation', customer: 'Linh Pham' }, link: '/office/messages/call-list?date=2026-09-15',
    emailed: true, emailWaiting: true, emailOpened: false, dismissible: true,
  };

  // why: F-2077 a double click on the bell's Dismiss sent 2 API-176, so the person heard "dismissed" and then "refused"; 1 action is 1 write and 1 outcome
  // why: F-2084 the guard let go when API-176 answered, but the button stays until the re-read lands; a press in that window sent a 2nd write (409, "refused")
  it('bell: a double click on Dismiss sends 1 write and the person hears 1 outcome', async () => {
    const at = `2026-09-15T10:28:50-04:00${ZONE}`;
    const key = `POST /alerts/${ALERT}/dismiss`;
    let dismissed = false;
    let holdReread = false;
    const { page, r, close } = await open('/shell-preview/live-reads/bell', 1440, at, {
      'GET /alerts': () => (holdReread ? 'hold' : { contract: 'API-43', data: { alerts: [dismissed ? { ...bellAlert, state: 'resolved', dismissible: false } : bellAlert] } }),
      [key]: () => 'hold',
    });
    try {
      await page.locator('[data-ctl="CTL-CMP-07-06"]').click();
      const dismiss = page.locator('[data-ctl="CTL-OFC-28-05"]');
      await dismiss.waitFor();
      await dismiss.dblclick();
      await expect.poll(() => r.count(key)).toBeGreaterThan(0);
      await page.waitForTimeout(500);
      expect(r.count(key)).toBe(1); // the 2nd press of the double click sent nothing
      dismissed = true;
      holdReread = true;
      const done = { alert: { id: ALERT, state: 'resolved', resolvedAt: at } };
      await r.release(key, 'API-176', done);
      // F-2084: the write has answered and the re-read is out, so the button is still on screen; a press now sends nothing and announces nothing
      await expect.poll(() => r.held('GET /alerts').length).toBeGreaterThan(0);
      expect(await dismiss.count()).toBe(1);
      await dismiss.click();
      await page.waitForTimeout(500);
      expect(r.count(key)).toBe(1);
      holdReread = false;
      await r.release('GET /alerts', 'API-43', { alerts: [{ ...bellAlert, state: 'resolved', dismissible: false }] });
      await expect.poll(() => page.getByText('Alert dismissed').count()).toBe(1);
      expect(await page.getByText('This alert can no longer be dismissed.').count()).toBe(0);
      expect(r.count(key)).toBe(1);
    } finally {
      await close();
    }
  });

  // why: F-2077 a double click on Open the email opened 2 tabs and sent 2 API-174, each retiring the last link, so 1 tab could show a dead link
  it('bell: a double click on Open the email opens 1 tab and sends 1 write', async () => {
    const at = `2026-09-15T10:28:50-04:00${ZONE}`;
    const key = `POST /alerts/${ALERT}/email-link`;
    const { page, r, context, close } = await open('/shell-preview/live-reads/bell', 1440, at, {
      'GET /alerts': () => ({ contract: 'API-43', data: { alerts: [bellAlert] } }),
      [key]: () => 'hold',
    });
    try {
      await page.locator('[data-ctl="CTL-CMP-07-06"]').click();
      const email = page.locator('[data-ctl="CTL-OFC-28-04"]');
      await email.waitFor();
      await email.dblclick();
      await expect.poll(() => r.count(key)).toBeGreaterThan(0);
      await page.waitForTimeout(500);
      expect(r.count(key)).toBe(1);
      expect(context.pages().length).toBe(2); // this page and 1 new tab
      await r.release(key, 'API-174', { link: `${app.origin}/shell-preview/live-reads/clock` });
      await expect.poll(() => context.pages().some((p) => p.url().includes('/live-reads/clock'))).toBe(true);
      expect(context.pages().length).toBe(2);
    } finally {
      await close();
    }
  });

  // why: K-08.12 the board's "Today, live" time moved every 30 s while the demo strip's moved every second, so the board showed the minute before the strip's
  it('board: Today, live shows the same minute as the demo strip 10 s after the minute turns', async () => {
    const at = `2026-09-15T10:28:50-04:00${ZONE}`;
    const board = boardFx.sampleBoard();
    const { page, close } = await open('/shell-preview/live-reads/board?branch=columbus&date=today', 1440, at, {
      'GET /me': () => ({ contract: 'API-07', data: ME }),
      'GET /clock': () => ({ contract: 'API-10', data: clockAt(at) }),
      'GET /board': () => ({ contract: 'API-20', data: { ...board, today: true, date: '2026-09-15' } }),
    });
    try {
      const live = page.locator('text=/Today, live, \\d/');
      await expect.poll(() => live.count(), { timeout: 15_000 }).toBeGreaterThan(0);
      expect(await live.first().innerText()).toContain('10:28');
      await page.clock.runFor(10_000);
      const strip = page.locator('[data-demo-time]').first();
      await expect.poll(() => strip.innerText()).toContain('10:29');
      await expect.poll(() => live.first().innerText(), { timeout: 3_000 }).toContain('10:29'); // the board draws each second, not each 30 s
    } finally {
      await close();
    }
  });

  // why: K-08.24 the clock page's replay poll read every second whether or not the last read had answered, so a slow clock read piled up reads
  it('clock: a replay poll is skipped while the last clock read is in flight', async () => {
    const at = `2026-09-15T10:28:50-04:00${ZONE}`;
    let slow = false;
    const { page, r, close } = await open('/shell-preview/live-reads/clock', 1440, at, {
      'GET /clock': () => {
        if (slow) return 'hold';
        return { contract: 'API-10', data: clockAt(at, { running: true, done: 120, total: 340 }) };
      },
    }, 'en', false);
    try {
      await expect.poll(() => page.getByText('120').count(), { timeout: 15_000 }).toBeGreaterThan(0);
      // The poll runs every second of real time here. From now on every clock read is slow: the first one goes out and is held (F-2081: the count
      // is taken once that read is held, so a poll that was already out before it cannot be the one counted).
      slow = true;
      const calls = () => page.evaluate('window.__clockCalls') as Promise<number>;
      await expect.poll(() => r.held('GET /clock').length, { timeout: 10_000 }).toBe(1);
      const out = await calls();
      await page.waitForTimeout(4_500);
      expect(await calls()).toBe(out); // 4 more polls came due while the read was unanswered, and each one was skipped
      expect(r.held('GET /clock').length).toBe(1);
      await r.release('GET /clock', 'API-10', clockAt(at, { running: true, done: 130, total: 340 }));
      await expect.poll(calls, { timeout: 10_000 }).toBeGreaterThan(out); // the answer landed, so the next poll reads again
    } finally {
      await close();
    }
  });

  // why: K-08.25 the top bar's fit of its links ran again for a new width only, so a language change that made the labels longer left links cut off
  it('top bar: switching to Spanish fits the links again', async () => {
    const at = `2026-09-15T10:28:50-04:00${ZONE}`;
    const { page, close } = await open('/shell-preview/live-reads/top-bar', 900, at, {
      'PATCH /me': () => ({ contract: 'API-08', data: { language: 'es', slashShortcut: 'on' } }),
    });
    try {
      const header = page.locator('header').first();
      const fits = () => header.evaluate((h) => h.scrollWidth <= h.clientWidth + 1);
      const links = () => page.locator('header nav a').count();
      await expect.poll(links).toBe(3);
      expect(await fits()).toBe(true);
      await page.locator('[data-ctl="CTL-CMP-07-07"]').click();
      await page.getByRole('button', { name: 'Español' }).click();
      await expect.poll(() => page.locator('html').getAttribute('lang'), { timeout: 15_000 }).toBe('es');
      await expect.poll(links).toBe(2); // what a page loaded in Spanish at this width shows
      expect(await fits()).toBe(true);
    } finally {
      await close();
    }
  });
});
