// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DEMO-6, FR-DEMO-3 (P3-REPLAY Acceptance: Playwright against the Compose stack at its default settings)
// The shared-world banner (P3-REPLAY Acceptance; SPECIFICATIONS 6.9 FR-DEMO-6, section 5.2 step 6; UI-SPECIFICATION
// CTL-CMP-02-01): Playwright on Chromium and WebKit against the Compose stack at its default settings (real PostgreSQL
// 18, real handlers, pbs running), through its proxy. 3 visitors have a page open: an office user, an anonymous
// visitor and the manager herself. The manager jumps the clock (API-12 through the proxy, her own session), the worker
// replays and sets the clock to the target, and every open visitor's banner then names her: "Dana Ruiz moved the clock
// to <target>". A strip re-reads API-10 on focus and on its interval (CTL-CMP-01-01, GAP-7); the suite gives each page
// focus, as a visitor coming back to the tab does, instead of waiting a minute. Run by ci/shell-stack.sh after the shell
// suite, on its stack and fixture (ci/shell-stack/fixture.sql, then ./fixture.sql: the manager and her session, whose
// token the script hands over as BW_CLOCK_BANNER_MANAGER). A *.stack.ts file, as the shell suite's: its own config runs it.
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engines } from '../pw-engines.ts';
import { guardedContext } from '../page-walkers/origin-guard.ts';

const base = process.env.BW_SHELL_STACK_URL;
if (!base) throw new Error('BW_SHELL_STACK_URL is not set: run ci/shell-stack.sh');
const origin = new URL(base).origin;
const session = process.env.BW_SHELL_STACK_SESSION;
if (!session) throw new Error('BW_SHELL_STACK_SESSION is not set: run ci/shell-stack.sh');
const managerSession = process.env.BW_CLOCK_BANNER_MANAGER;
if (!managerSession) throw new Error('BW_CLOCK_BANNER_MANAGER is not set: run ci/shell-stack.sh');
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the kernel refuses a cookie-carrying write from any other origin (SD-8).
const APP_ORIGIN = 'http://localhost:8080';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${origin}/api/v1${path}`, init);
  return { status: r.status, body: await r.json() };
};
const asManager = { cookie: `bw_session=${managerSession}`, origin: APP_ORIGIN, 'content-type': 'application/json' };

/** "Wed, Sep 16, 8:00 AM" for a wire time, as the banner writes it (shell.clock.short, en). */
function bannerTime(wire: string): string {
  const at = new Date(wire.replace(/\[.*\]$/, ''));
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...o }).format(at);
  return `${part({ weekday: 'short' })}, ${part({ month: 'short' })} ${part({ day: 'numeric' })}, ${part({ hour: 'numeric', minute: '2-digit' })}`;
}

describe.each(engines)('every open visitor sees who moved the clock, %s', (_engine, type) => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    for (const c of contexts) await c.close();
    await browser?.close();
  });

  async function visitor(cookie: string | null): Promise<Page> {
    const g = await guardedContext(browser, [origin], { viewport: { width: 1440, height: 900 } });
    contexts.push(g.context);
    if (cookie) await g.context.addCookies([{ name: 'bw_session', value: cookie, url: origin, httpOnly: true }]);
    const p = await g.context.newPage();
    // 'load', not network idle: a signed-in visitor's page holds the bell's event stream open (F-690). The filled strip is the readiness.
    const res = await p.goto(`${origin}/shell-preview/surface/office`, { waitUntil: 'load' });
    expect(res?.status()).toBe(200);
    await p.waitForSelector('.r1-demobar [data-ctl="CTL-CMP-01-01"] b:not(:empty)');
    return p;
  }
  const banner = (p: Page) => p.locator('.r1-demobar [data-ctl="CTL-CMP-02-01"]');

  // why: FR-DEMO-6, FR-DEMO-3
  it('names the manager on the office user\'s, an anonymous visitor\'s and her own banner after her jump', async () => {
    const pages = [await visitor(session), await visitor(null), await visitor(managerSession)];
    // The jump: the next preset "Tomorrow 8:00 AM" (API-11), always after the clock, so each engine's run moves it on.
    const presets = await api('/clock/presets', { headers: asManager });
    expect(presets.status).toBe(200);
    const target = (presets.body.data.presets as { presetId: string; target: string }[]).find((x) => x.presetId === 'tomorrow_8am')!.target;
    const jump = await api('/clock/jumps', { method: 'POST', headers: asManager, body: JSON.stringify({ presetId: 'tomorrow_8am' }) });
    expect(jump.status, JSON.stringify(jump.body)).toBe(202);
    // The worker replays the due events and then sets the clock to the target, running, with the jump as the last move.
    await expect.poll(async () => (await api('/clock')).body.data, { timeout: 60_000, interval: 250 })
      .toMatchObject({ replay: { running: false }, paused: false, lastMove: { by: 'Dana Ruiz', kind: 'jump', toDemo: target } });
    const want = `Dana Ruiz moved the clock to ${bannerTime(target)}`;
    for (const [i, p] of pages.entries()) {
      await expect.poll(async () => {
        await p.evaluate('window.dispatchEvent(new Event("focus"))');
        return (await banner(p).count()) > 0 ? banner(p).textContent() : null;
      }, { timeout: 20_000, interval: 500 }).toBe(want);
      expect(await banner(p).locator('b').textContent(), `visitor ${i}`).toBe('Dana Ruiz');
    }
  });
});
