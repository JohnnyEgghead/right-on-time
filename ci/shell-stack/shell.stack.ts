// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DEMO-1, FR-DISP-10, FR-DISP-11, FR-DISP-20 (P2-SHELL Acceptance: Playwright on Chromium and WebKit against the Compose stack)
// The shell against the Compose stack at its default settings (real PostgreSQL 18, real handlers, pbs running), through
// its proxy: the real demo time from API-10 in every surface header, the office top bar on the real API-07 (menu by
// role), API-130 (search) and API-08 (the "/" switch, kept in the database), the Call control as a dialer link on a
// coarse-pointer phone and as a number shown on a desktop, the shared pages with their status codes, and the 11.5
// headers on page answers. The web image is the harness build (BW_WEB_PREVIEW=1, a build argument, not a setting): the
// surface frames have no page of their own before the page lanes merge, so the stack serves them on
// /shell-preview/surface/<name>. The rows the suite reads (the clock row, 1 office user and its session, the search
// rows) are ci/shell-stack/fixture.sql's: setup, sign-in and the sample data are later lanes'.
import type { Browser, BrowserContextOptions, Page, Request } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engines } from '../pw-engines.ts';
import { guardedContext } from '../page-walkers/origin-guard.ts';

const base = process.env.BW_SHELL_STACK_URL;
if (!base) throw new Error('BW_SHELL_STACK_URL is not set: run ci/shell-stack.sh');
const origin = new URL(base).origin;
const session = process.env.BW_SHELL_STACK_SESSION;
if (!session) throw new Error('BW_SHELL_STACK_SESSION is not set: run ci/shell-stack.sh');
// APP_ORIGIN's default (SPECIFICATIONS 11.1). The suite's proxy listens on a free port, so a browser write would carry
// that port's origin, which the kernel's Origin check (SD-8) refuses; the suite's writes carry the default origin.
const APP_ORIGIN = 'http://localhost:8080';

const SURFACES = ['office', 'admin', 'pbs', 'booking', 'public', 'tech'] as const;
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
// FR-DISP-20: WebKit at 520 x 980 with a touch phone profile; on Chromium the same coarse-pointer emulation.
const PHONE: BrowserContextOptions = { viewport: { width: 520, height: 980 }, isMobile: true, hasTouch: true };

/**
 * The strip's text "Tue, Sep 15, 10:41 AM EDT" as minutes of the day (null when it is not a time). The fixture clock row
 * starts at 10:41 AM EDT, a time no preview state or default uses (the previews show 10:28, 6:05 PM and 7:00 AM), so a
 * strip that ignores API-10 cannot land on the value API-10 answers (F-228).
 */
const DEMO_TIME = /^Tue, Sep 15, (\d{1,2}):(\d{2}) (AM|PM) EDT$/;
function stripMinutes(text: string | null): number | null {
  const m = DEMO_TIME.exec(text ?? '');
  return m ? ((Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + Number(m[2]) : null;
}
const DEMO_WIRE = /^2026-09-15T(\d{2}):(\d{2}):\d{2}(\.\d+)?-04:00\[America\/New_York\]$/;
/** API-10's demoNow as minutes of the day, read through the proxy with no browser in between. */
async function apiMinutes(): Promise<number> {
  const direct = (await (await fetch(`${origin}/api/v1/clock`)).json()) as { data: { demoNow: string; paused: boolean; rate: number } };
  expect(direct.data).toMatchObject({ paused: false, rate: 1 });
  const m = DEMO_WIRE.exec(direct.data.demoNow);
  expect(m, direct.data.demoNow).not.toBeNull();
  return Number(m![1]) * 60 + Number(m![2]);
}

/**
 * The page's API writes reach the real handlers carrying the default stack's origin (APP_ORIGIN above): a browser will
 * not let a route rewrite Origin, so Playwright sends the same request itself (route.fetch, cookies included) and hands
 * the real answer back to the page. Reads go untouched.
 */
async function writeOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
    return r.fulfill({ response });
  });
}

describe.each(engines)('the shell on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  /**
   * The page is ready: its client code ran and its first read answered. The screen root and the bars are in the server's HTML, so they
   * prove neither. The strip's time is not: it starts empty and only the strip's own read fills it, or says the clock is not updated, and
   * by then every effect of that first render has run, the top bar's "/" listener among them. Never network idle here: a signed-in office
   * page holds its event stream open for as long as it lives, so it is never idle (F-690).
   */
  const ready = (p: Page) => p.waitForSelector('.r1-demobar [data-ctl="CTL-CMP-01-01"] b:not(:empty), .r1-demobar .moved', { state: 'attached' });

  // Every surface page must answer 200 with its own screen root: an error page also carries a demo strip.
  async function open<T>(path: string, opts: BrowserContextOptions, fn: (p: Page) => Promise<T>, route?: (p: Page) => Promise<void>, signedIn = false) {
    const g = await guardedContext(browser, [origin], opts);
    try {
      if (signedIn) await g.context.addCookies([{ name: 'bw_session', value: session!, url: origin, httpOnly: true }]);
      const p = await g.context.newPage();
      if (route) await route(p);
      const res = await p.goto(origin + path, { waitUntil: 'load' });
      expect(res?.status(), path).toBe(200);
      await p.waitForSelector('[data-screen^="PREVIEW-SURF-"]', { state: 'attached' });
      await ready(p);
      return await fn(p);
    } finally {
      await g.context.close();
    }
  }
  const strip = (p: Page) => p.locator('.r1-demobar [data-ctl="CTL-CMP-01-01"]');

  for (const s of SURFACES) {
    // why: FR-DEMO-1 the office board, booking site and web technician app each show "Demo clock" with the demo time
    it(`${s}: the header shows the real demo time API-10 answers from the clock row, running`, async () => {
      const before = await apiMinutes();
      expect(before).toBeGreaterThanOrEqual(10 * 60 + 41); // the fixture row (10:41), never a preview state's time
      await open(`/shell-preview/surface/${s}`, DESKTOP, async (p) => {
        await expect.poll(() => strip(p).locator('b').textContent().then(stripMinutes), { timeout: 10_000 }).not.toBeNull();
        // The strip shows the time API-10 answered: the same minute, within 1 minute either side of the 2 reads around it.
        const shown = stripMinutes(await strip(p).locator('b').textContent()) as number;
        const after = await apiMinutes();
        expect(shown, `strip ${shown}, API-10 ${before} to ${after}`).toBeGreaterThanOrEqual(before - 1);
        expect(shown, `strip ${shown}, API-10 ${before} to ${after}`).toBeLessThanOrEqual(after + 1);
        expect(await strip(p).locator('.lbl').textContent()).toBe('Demo clock');
        expect(await p.locator('.r1-demobar .run').textContent()).toBe('Running');
        // The header strip is the first thing in the screen, above the surface's own header.
        expect(await p.locator('[data-surface] > :first-child').getAttribute('class')).toMatch(/^r1-demobar/);
      });
    });

    // why: FR-DEMO-1, F-228 after a good read, a failing read keeps the last known time and says the clock is not updated
    it(`${s}: with API-10 failing after a good read, the header keeps the last time and says the clock is not updated`, async () => {
      let failing = false;
      await open(
        `/shell-preview/surface/${s}`,
        DESKTOP,
        async (p) => {
          await expect.poll(() => strip(p).locator('b').textContent().then(stripMinutes), { timeout: 10_000 }).not.toBeNull();
          expect(await p.locator('.r1-demobar .moved').count()).toBe(0);
          const good = stripMinutes(await strip(p).locator('b').textContent()) as number;
          failing = true; // the 2nd read, made when the window regains focus, answers 500
          await p.evaluate("window.dispatchEvent(new Event('focus'))");
          await expect.poll(() => p.locator('.r1-demobar .moved').textContent(), { timeout: 10_000 }).toBe('Clock not updated');
          const kept = stripMinutes(await strip(p).locator('b').textContent());
          expect(kept, 'the last known time stays').not.toBeNull();
          expect(Math.abs((kept as number) - good)).toBeLessThanOrEqual(1);
        },
        async (p) => {
          await p.route(`${origin}/api/v1/clock`, (r) => (failing ? r.fulfill({ status: 500, contentType: 'application/problem+json', body: '{}' }) : r.continue()));
        },
      );
    });

    // why: FR-DEMO-1 when API-10 fails the strip shows no invented time
    it(`${s}: with API-10 failing, the header says the clock is not updated and shows no time`, async () => {
      await open(
        `/shell-preview/surface/${s}`,
        DESKTOP,
        async (p) => {
          await expect.poll(() => p.locator('.r1-demobar .moved').textContent()).toBe('Clock not updated');
          expect(await strip(p).locator('b').textContent()).toBe('');
        },
        async (p) => {
          await p.route(`${origin}/api/v1/clock`, (r) => r.fulfill({ status: 500, contentType: 'application/problem+json', body: '{}' }));
        },
      );
    });
  }

  // why: FR-DISP-10, FR-AUTH-1 the menu comes from the signed-in user's own API-07 answer: office staff see no Reports
  it('the office top bar of a signed-in office user shows the menu its API-07 permissions allow', async () => {
    await open('/shell-preview/surface/office?me=live', DESKTOP, async (p) => {
      const bar = p.locator('header.topbar');
      await expect.poll(() => bar.locator('nav a').allTextContents(), { timeout: 10_000 }).toEqual(['Board', 'Jobs', 'Customers', 'Technicians', 'Messages', 'Billing', 'Admin']);
      expect(await bar.locator('.user .role').textContent()).toBe('Office');
      // No Change link on the demo strip: the demo clock page is a manager's (SCR-OFC-17).
      expect(await p.locator('.r1-demobar a[href="/office/admin/clock"]').count()).toBe(0);
    }, undefined, true);
    // Signed out, API-07 refuses and no top bar renders.
    await open('/shell-preview/surface/office?me=live', DESKTOP, async (p) => {
      // Network idle is true here: with no top bar there is no bell and no event stream, so idle means API-07's refusal has been answered
      // (a condition, not a fixed second: F-276). A top bar drawn by mistake is on the page by then, and the count below goes red.
      await p.waitForLoadState('networkidle');
      expect(await p.locator('header.topbar').count()).toBe(0);
    });
  });

  type StreamRow = { status: number | null; ended: boolean };
  /** Records the page's event stream requests from before it loads: each one's status, and whether it has ended. */
  function watchStream(seen: StreamRow[]) {
    const rows = new Map<Request, StreamRow>();
    const ended = (r: Request) => {
      const row = rows.get(r);
      if (row) row.ended = true;
    };
    return async (p: Page) => {
      p.on('request', (r) => {
        if (new URL(r.url()).pathname !== '/api/v1/events') return;
        const row: StreamRow = { status: null, ended: false };
        rows.set(r, row);
        seen.push(row);
      });
      p.on('response', (r) => {
        const row = rows.get(r.request());
        if (row) row.status = r.status();
      });
      p.on('requestfinished', ended);
      p.on('requestfailed', ended);
    };
  }
  /** Longer than the client's first retry wait (1 s), so a stream that reconnects shows a 2nd request. */
  const PAST_FIRST_RETRY_MS = 2_500;

  // why: FR-DISP-12 the bell stays current from 1 event stream: a signed-in page's stream answers 200, stays open and does not reconnect (F-690)
  it('a signed-in office page holds 1 open event stream and does not reconnect', async () => {
    const seen: StreamRow[] = [];
    await open('/shell-preview/surface/office?me=live', DESKTOP, async (p) => {
      await expect.poll(() => seen.length, { timeout: 10_000 }).toBe(1);
      await expect.poll(() => seen[0]!.status, { timeout: 10_000 }).toBe(200);
      await p.waitForTimeout(PAST_FIRST_RETRY_MS);
      expect(seen).toEqual([{ status: 200, ended: false }]);
    }, watchStream(seen), true);
  });

  // why: FR-DISP-12, SPECIFICATIONS 7.3 the stream closes on unauthenticated: a refused stream ends at once, with no retry and no request left open (F-690: Chromium kept the unread refusal open, so the page was never idle)
  it('a signed-out page has its event stream refused, with no retry and no request left open', async () => {
    const seen: StreamRow[] = [];
    await open('/shell-preview/surface/office', DESKTOP, async (p) => {
      await expect.poll(() => seen.length, { timeout: 10_000 }).toBe(1);
      await p.waitForLoadState('networkidle', { timeout: 10_000 });
      await p.waitForTimeout(PAST_FIRST_RETRY_MS);
      expect(seen).toEqual([{ status: 401, ended: true }]);
    }, watchStream(seen));
  });

  // why: FR-DISP-11, NFR-05 the 1 box finds a job by number, a customer by name and an address by street, the query in the body only
  it('the search box finds the fixture job, customer and address through API-130, never putting the query in a URL', async () => {
    const urls: string[] = [];
    await open('/shell-preview/surface/office?me=live', DESKTOP, async (p) => {
      p.on('request', (r) => urls.push(r.url()));
      const box = p.locator('header.topbar .search input');
      await box.waitFor();
      await box.fill('24800');
      await expect.poll(() => p.locator('[role="option"]').allTextContents(), { timeout: 10_000 }).toEqual([expect.stringMatching(/24800.*Ann Lee/)]);
      await box.fill("o'brien");
      await expect.poll(() => p.locator('[role="option"]').allTextContents(), { timeout: 10_000 }).toEqual(["Anne O'Brien"]);
      await box.fill('12 high');
      await expect.poll(() => p.locator('[role="option"]').allTextContents(), { timeout: 10_000 }).toEqual(['12 High St, Columbus']);
    }, writeOrigin, true);
    expect(urls.some((u) => u.endsWith('/api/v1/searches'))).toBe(true);
    expect(urls.filter((u) => /24800|brien|high/i.test(u))).toEqual([]);
  });

  // why: FR-DISP-11, OI-30 the "/" switch is saved with the user (API-08) and read back on the next page load (API-07)
  it('turning the "/" switch off is kept in the database: the next page load has it off, and "/" does nothing', async () => {
    const toggle = async (p: Page, want: 'on' | 'off') => {
      await p.locator('header.topbar .user').click();
      const sw = p.locator('[data-ctl="CTL-CMP-07-09"] [role="switch"]');
      if ((await sw.getAttribute('aria-checked')) !== String(want === 'on')) {
        const saved = p.waitForResponse((r) => r.url() === `${origin}/api/v1/me` && r.request().method() === 'PATCH');
        await sw.click();
        expect((await saved).status()).toBe(200);
      }
    };
    try {
      await open('/shell-preview/surface/office?me=live', DESKTOP, (p) => toggle(p, 'off'), writeOrigin, true);
      await open('/shell-preview/surface/office?me=live', DESKTOP, async (p) => {
        await p.locator('header.topbar').waitFor();
        await p.locator('body').click({ position: { x: 700, y: 600 } });
        const before = await p.evaluate('document.activeElement && document.activeElement.tagName');
        await p.keyboard.press('/');
        expect(await p.evaluate('document.activeElement && document.activeElement.tagName')).toBe(before);
        await p.locator('header.topbar .user').click();
        expect(await p.locator('[data-ctl="CTL-CMP-07-09"] [role="switch"]').getAttribute('aria-checked')).toBe('false');
      }, writeOrigin, true);
    } finally {
      await open('/shell-preview/surface/office?me=live', DESKTOP, (p) => toggle(p, 'on'), writeOrigin, true);
    }
  });

  // why: NFR-12, F-214 a real page answer from the real Next.js app carries the 11.5 headers with its nonce, whatever its status
  it('page answers carry the CSP with a nonce on every script, and nosniff and no-referrer, at 200, 403, 404 and 500', async () => {
    for (const [path, status] of [['/shell-preview/surface/office', 200], ['/shell-preview/status/403', 403], ['/no-such-page', 404], ['/shell-preview/status/500', 500]] as const) {
      const r = await fetch(`${origin}${path}`);
      expect(r.status, path).toBe(status);
      const csp = r.headers.get('content-security-policy') ?? '';
      const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
      expect(nonce, path).toBeTruthy();
      expect(csp, path).toBe(`default-src 'self' 'nonce-${nonce}'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'`);
      expect(r.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(r.headers.get('referrer-policy'), path).toBe('no-referrer');
      const html = await r.text();
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
      expect(scripts.length, path).toBeGreaterThan(0);
      for (const tag of scripts) expect(tag, path).toContain(`nonce="${nonce}"`);
    }
  });

  for (const [lang, app, menu] of [
    ['en', 'Dispatch', ['Board', 'Jobs', 'Customers', 'Technicians', 'Messages', 'Billing', 'Admin']],
    ['es', 'Despacho', ['Tablero', 'Trabajos', 'Clientes', 'Técnicos', 'Mensajes', 'Facturación', 'Administración']],
  ] as const) {
    // why: FR-DISP-10 "Dispatch" beside "Brightwater Right On Time" and Board, Jobs, Customers, Technicians and Reports in that order, in both languages
    it(`the office top bar shows Dispatch beside the name and the menu in spec order, in ${lang}`, async () => {
      const run = async (path: string, items: readonly string[]) => {
        const g = await guardedContext(browser, [origin], DESKTOP);
        try {
          await g.context.addCookies([{ name: 'bw_lang', value: lang, url: origin }]);
          const p = await g.context.newPage();
          await p.goto(origin + path, { waitUntil: 'load' });
          await ready(p);
          const bar = p.locator('header.topbar');
          // textContent: the kit shows the product line in capitals by text-transform; the words are the catalog's.
          expect(await bar.locator('.brand .word').textContent()).toMatch(/^Brightwater\s*Right On Time$/);
          expect(await bar.locator('.appname').textContent()).toBe(app);
          expect(await bar.locator('nav a').allTextContents()).toEqual(items);
          const hrefs = await bar.locator('nav a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
          expect(hrefs.every((h) => h?.startsWith('/office/'))).toBe(true);
        } finally {
          await g.context.close();
        }
      };
      // Office staff: no Reports (section 2.4); a manager: the 5 booklet items with Reports between Billing and Admin.
      await run('/shell-preview/surface/office', menu);
      const reports = lang === 'en' ? 'Reports' : 'Informes';
      await run('/shell-preview/surface/admin', [...menu.slice(0, 6), reports, menu[6]]);
    });
  }

  // why: FR-DISP-11 with the shortcut on "/" focuses the box and "/" typed in a note stays in the note; with it off "/" leaves focus where it was
  it('"/" moves focus to the search box, stays in a text field, and does nothing with the switch off', async () => {
    await open('/shell-preview/surface/office', DESKTOP, async (p) => {
      await p.locator('body').click({ position: { x: 700, y: 600 } });
      await p.keyboard.press('/');
      expect(await p.evaluate('document.activeElement && document.activeElement.getAttribute("aria-label")')).toBe('Search jobs, customers, addresses');
      expect(await p.locator('header.topbar .search input').inputValue()).toBe('');
      await p.locator('[data-preview="note"]').click();
      await p.keyboard.type('a/b');
      expect(await p.locator('[data-preview="note"]').inputValue()).toBe('a/b');
      expect(await p.evaluate('document.activeElement && document.activeElement.getAttribute("data-preview")')).toBe('note');
    });
    await open('/shell-preview/surface/office?slash=off', DESKTOP, async (p) => {
      await p.locator('body').click({ position: { x: 700, y: 600 } });
      const before = await p.evaluate('document.activeElement && document.activeElement.tagName');
      await p.keyboard.press('/');
      expect(await p.evaluate('document.activeElement && document.activeElement.tagName')).toBe(before);
      expect(await p.locator('header.topbar .search kbd').count()).toBe(0);
    });
  });

  // why: FR-DISP-20 on a touch phone profile each Call control is a telephone link to its number
  it('the Call control opens the dialer on a coarse-pointer phone', async () => {
    await open('/shell-preview/surface/office', PHONE, async (p) => {
      expect(await p.evaluate('matchMedia("(pointer: coarse) and (hover: none)").matches')).toBe(true);
      const call = p.locator('[data-ctl="CTL-CMP-16-01"]');
      await expect.poll(() => call.evaluate((e) => e.tagName)).toBe('A');
      expect(await call.getAttribute('href')).toBe('tel:+16145550112');
    });
    await open('/shell-preview/surface/booking', PHONE, async (p) => {
      await expect.poll(() => p.locator('[data-ctl="CTL-CMP-16-01"]').getAttribute('href')).toBe('tel:+16145550100');
    });
  });

  // why: FR-DISP-20 on a desktop profile pressing it shows the number and starts no call
  it('the Call control reveals the number on a desktop and starts no call', async () => {
    await open('/shell-preview/surface/office', DESKTOP, async (p) => {
      const call = p.locator('[data-ctl="CTL-CMP-16-01"]');
      expect(await call.evaluate((e) => e.tagName)).toBe('BUTTON');
      expect(await p.locator('a[href^="tel:"]').count()).toBe(0);
      await expect(p.locator('[data-call-number]').count()).resolves.toBe(0);
      await call.click();
      expect(await p.locator('[data-call-number]').textContent()).toBe('(614) 555-0112');
      expect(await p.locator('[role="status"]:has([data-call-number])').count()).toBe(1);
      expect(p.url()).toBe(`${origin}/shell-preview/surface/office`);
    });
  });

  // why: FR-DEMO-1 the shared pages carry the demo strip too, and keep their status (F-129: keyed on the code)
  it('the shared pages answer 403, 404 and 500 with their screens; access_code_required is not No access', async () => {
    for (const [path, status, screen] of [
      ['/shell-preview/status/403', 403, 'SCR-SHR-01'],
      ['/this-page-does-not-exist', 404, 'SCR-SHR-02'],
      ['/shell-preview/status/500', 500, 'SCR-SHR-03'],
    ] as const) {
      const g = await guardedContext(browser, [origin], DESKTOP);
      try {
        const p = await g.context.newPage();
        const res = await p.goto(origin + path, { waitUntil: 'networkidle' });
        expect(res?.status(), path).toBe(status);
        await p.waitForSelector(`[data-screen="${screen}"] .r1-demobar`, { state: 'attached' });
      } finally {
        await g.context.close();
      }
    }
    const g = await guardedContext(browser, [origin], DESKTOP);
    try {
      const p = await g.context.newPage();
      const res = await p.goto(`${origin}/shell-preview/status/code-needed`, { waitUntil: 'networkidle' });
      expect(res?.status()).not.toBe(403);
      expect(await p.locator('[data-screen="SCR-SHR-01"]').count()).toBe(0);
    } finally {
      await g.context.close();
    }
  });

  // why: FR-DEMO-1 the stack under test is up and its web process is the Next.js app (API-171 kept)
  it('serves /healthz with the plain body through the proxy', async () => {
    const r = await fetch(`${origin}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{"status":"ok"}');
    process.stdout.write(`shell-stack: ${engine} done\n`);
  });
});
