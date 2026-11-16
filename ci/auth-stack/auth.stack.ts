// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-AUTH-2, FR-AUTH-3, FR-AUTH-5, FR-AUTH-6, FR-AUTH-7, FR-AUTH-10, FR-AUTH-11, FR-DISP-11 (P2-AUTH Acceptance: Playwright on Chromium and WebKit against the Compose stack)
// The sign-in screens against the Compose stack (real PostgreSQL 18, real handlers, pbs running), through its proxy, with
// ACCESS_CODE_ON=on and DEMO_MODE=on (ci/auth-stack.sh sets them and the secrets, and loads ci/auth-stack/fixture.ts's rows):
// every route answers the gate before the code, the Sign in as list appears only after it, a password sign-in works without it,
// Sign out clears the httpOnly cookie, the "/" shortcut a user turns off is still off at their next real sign-in, and the start page names
// a listed technician's language Español or English in either page language (FR-LANG-1, F-1280).
// Each run of this file takes 1 engine (BW_AUTH_STACK_ENGINE) on a fresh web process: ci/auth-stack.sh runs it once per
// engine and starts web afresh in between, so neither engine's sign-ins count against the other's 10-a-minute window
// (SPECIFICATIONS 7.1; the counters live in the web process, packages/api-server/src/kernel/rate-limit.ts). No sleep, with 1 bounded
// exception: roomForSignIns waits for the sliding 60 s window only as long as this run's own recorded sign-in sends still fill it (F-1243).
// The browsers reach the proxy through the suite's https front (tls-front.ts, F-290: WebKit refuses the Secure bw_access
// cookie over plain http).
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { tlsFront } from './tls-front.ts';

const base = process.env.BW_AUTH_STACK_URL;
const code = process.env.BW_AUTH_STACK_CODE;
const seed = process.env.BW_AUTH_STACK_SEED;
const tls = process.env.BW_AUTH_STACK_TLS;
const only = process.env.BW_AUTH_STACK_ENGINE;
if (!base || !code || !seed || !tls || !only) throw new Error('BW_AUTH_STACK_URL, _CODE, _SEED, _TLS and _ENGINE are not set: run ci/auth-stack.sh');
const run = engines.filter(([name]) => name === only);
if (run.length !== 1) throw new Error(`BW_AUTH_STACK_ENGINE=${only} is not 1 of this run's engines (${engines.map(([n]) => n).join(', ')})`);
const front = await tlsFront(base, tls);
afterAll(() => front.close());
const origin = front.origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the proxy listens on a free port, so a browser write would carry that port's origin,
// which the kernel's Origin check (SD-8) refuses; the suite's writes carry the default origin.
const APP_ORIGIN = 'http://localhost:8080';
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true };
// The page's item store, which an init script breaks (that callback runs in the browser; this config has no DOM lib).
declare const IDBFactory: { prototype: { open: (...args: unknown[]) => unknown } };

const DANA = { email: 'dana.ruiz@brightwater.example' };
const MARIA = { email: 'maria.santos@brightwater.example', employee: '40712' };

/** A sample person's password in its shown form (SD-9), derived as the stack's seed derives it: the helper the seed uses. */
async function shown(email: string): Promise<string> {
  const { samplePassword, showSamplePassword } = await import('../../packages/db/src/passwords.ts');
  return showSamplePassword(samplePassword(seed!, email));
}

async function writeOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
    return r.fulfill({ response });
  });
}

/**
 * F-1303: delays every later task React's scheduler posts (a MessagePort message) by `ms`, so the first render after a click, the one that
 * clears the old message, lands late. A delay on the POST cannot open that window (the form action clears the message before the call).
 */
const slowRender = (p: Page, ms: number): Promise<unknown> =>
  p.evaluate(`(() => { const post = MessagePort.prototype.postMessage; MessagePort.prototype.postMessage = function (...a) { setTimeout(() => post.apply(this, a), ${ms}); }; })()`);

/**
 * F-1037, F-1061: holds every script of the release build (/_next/static/**.js) from hold() until release(), so the page shows its server HTML
 * and nothing hydrates, as on a slow phone: the fields can be typed and the buttons tapped, and what comes of that is the product's doing.
 */
async function holdScripts(p: Page): Promise<{ hold: () => void; release: () => void; pending: () => number }> {
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => {};
  let held = 0;
  await p.route((u) => u.origin === origin && u.pathname.startsWith('/_next/static/') && u.pathname.endsWith('.js'), async (r) => {
    held += 1;
    try {
      await gate;
    } finally {
      held -= 1;
    }
    await r.continue().catch(() => undefined); // the page went on to another address while its script was held
  });
  return {
    hold: () => {
      gate = new Promise<void>((resolve) => {
        open = () => resolve();
      });
    },
    release: () => open(),
    pending: () => held,
  };
}

const screen = (p: Page) => p.locator('[data-screen]').first().getAttribute('data-screen');

const api = (p: Page, method: string, path: string, body?: unknown) =>
  p.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
      const text = await r.text();
      return { status: r.status, body: text ? (JSON.parse(text) as { data?: Record<string, unknown>; code?: string }) : null };
    },
    { method, path, body },
  );

describe.each(run)('the sign-in screens on the Compose stack, %s', (_engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // F-1243: when this run's browsers sent API-03 (every page of every session), so a row that needs room in the sign-in rate window waits
  // only for the sends that are still inside it, and not at all when there is room.
  const signInSends: number[] = [];
  const SIGN_IN_LIMIT = 10; // API-03, per address, per minute (SPECIFICATIONS 7.1; kernel/rate-limit.ts rateRules)
  const SIGN_IN_WINDOW_MS = 60_000;
  const SIGN_IN_MARGIN_MS = 2_000; // the server counts a send when it arrives, a little after the browser sent it
  /** The one bounded wait of this file: until `needed` more sign-ins fit in the sliding window, computed from the sends this run made. */
  async function roomForSignIns(p: Page, needed: number): Promise<void> {
    const t = Date.now();
    const inWindow = signInSends.filter((s) => t - s < SIGN_IN_WINDOW_MS + SIGN_IN_MARGIN_MS).sort((a, b) => a - b);
    const over = inWindow.length + needed - SIGN_IN_LIMIT;
    if (over <= 0) return;
    await p.waitForTimeout(Math.max(0, inWindow[over - 1]! + SIGN_IN_WINDOW_MS + SIGN_IN_MARGIN_MS - t));
  }

  async function session<T>(fn: (p: Page, ctx: BrowserContext) => Promise<T>, opts: BrowserContextOptions = DESKTOP): Promise<T> {
    const g = await guardedContext(browser, [origin], opts);
    try {
      g.context.on('request', (r) => {
        if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/sessions') signInSends.push(Date.now());
      });
      const p = await g.context.newPage();
      await writeOrigin(p);
      return await fn(p, g.context);
    } finally {
      await g.context.close();
    }
  }

  // why: FR-AUTH-6 every route answers the gate before the code, and the gate shows neither the demo clock nor the clock banner (UD-13)
  it('answers every page with the access-code screen before the code, with no demo clock', async () => {
    await session(async (p) => {
      for (const path of ['/', '/office/board', '/book', '/tech/install', '/m/sometoken', '/office/admin/users']) {
        const res = await p.goto(origin + path, { waitUntil: 'networkidle' });
        expect(res?.status(), path).toBe(403);
        expect(await screen(p), path).toBe('SCR-GATE-01');
        expect(await p.locator('.r1-demobar').count(), `${path}: no demo clock or banner`).toBe(0);
        // The gate's own sheets reach the page they are shown on (they load on demand, not on every page): the brand column is 600 px wide.
        expect(await p.locator('.g-a .side').evaluate((el) => el.getBoundingClientRect().width), `${path}: the gate is styled`).toBe(600);
      }
      const people = await api(p, 'GET', '/api/v1/demo/people?app=office');
      expect([people.status, people.body?.code]).toEqual([403, 'access_code_required']);
      expect((await api(p, 'GET', '/api/v1/demo/tech-sign-ins')).body?.code).toBe('access_code_required');
      expect((await api(p, 'GET', '/api/v1/me')).body?.code).toBe('access_code_required');
      const info = await api(p, 'GET', '/api/v1/app-info');
      expect([info.status, info.body?.data]).toEqual([200, expect.objectContaining({ demoMode: true, accessCodeOn: true })]);
    });
  });

  // why: FR-AUTH-5 the sign-in page answers before the code, and its Sign in as list is absent until the code is entered
  it('shows the sign-in page before the code, without the Sign in as list', async () => {
    await session(async (p) => {
      const res = await p.goto(origin + '/sign-in', { waitUntil: 'networkidle' });
      expect(res?.status()).toBe(200);
      expect(await screen(p)).toBe('SCR-OFC-01');
      await p.waitForSelector('#si-email');
      expect(await p.locator('.aslist, .asl').count()).toBe(0);
    });
  });

  // why: FR-AUTH-6 a named password account signs in without the access code; FR-AUTH-3 the password is checked against its hash
  it('signs a manager in by password without the code, refuses a wrong password, and keeps the session cookie httpOnly', async () => {
    await session(async (p, ctx) => {
      await p.goto(origin + '/sign-in', { waitUntil: 'networkidle' });
      await p.fill('#si-email', DANA.email);
      await p.fill('#si-password', 'not-the-password');
      await p.click('[data-ctl="CTL-OFC-01-04"]');
      await p.waitForSelector('.msgb.bad');
      expect(await p.inputValue('#si-email')).toBe(DANA.email); // kept
      expect(await p.inputValue('#si-password')).toBe(''); // cleared
      await p.fill('#si-password', await shown(DANA.email)); // the shown form, with its hyphen
      await p.click('[data-ctl="CTL-OFC-01-04"]');
      await p.waitForURL('**/office/board');
      const cookie = (await ctx.cookies()).find((c) => c.name === 'bw_session');
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.expires, 'a browser-session cookie without Keep me signed in').toBe(-1);
      const me = await api(p, 'GET', '/api/v1/me');
      expect([me.status, me.body?.data?.role, me.body?.data?.name]).toEqual([200, 'manager', 'Dana Ruiz']);
    });
  });

  // why: FR-AUTH-3 (F-1061, F-1037) the office sign-in typed and tapped before the page's scripts have run signs in on that 1st tap: React holds the tap and sends it once the form hydrates, with the fields as typed (1 API-03, inside this suite's API-01 and API-03 budget)
  it('signs a manager in on a tap made before the sign-in page has hydrated', async () => {
    await session(async (p) => {
      const seen: string[] = [];
      p.on('framenavigated', (f) => {
        if (f !== p.mainFrame()) return;
        const u = new URL(f.url());
        seen.push(u.pathname + '?' + [...u.searchParams.keys()].join('&'));
      });
      const scripts = await holdScripts(p);
      scripts.hold();
      await p.goto(origin + '/sign-in', { waitUntil: 'domcontentloaded' });
      await p.fill('#si-email', DANA.email);
      await p.fill('#si-password', await shown(DANA.email));
      await p.click('[data-ctl="CTL-OFC-01-04"]');
      expect(scripts.pending(), 'the page scripts are still held at the tap').toBeGreaterThan(0);
      scripts.release();
      await p.waitForURL('**/office/board');
      expect(seen.filter((x) => /[?&](email|password)(&|$)/.test(x)), 'no address carried a form field').toEqual([]);
    });
  });

  // why: FR-AUTH-10 Keep me signed in sets a 90-day cookie
  it('keeps the session 90 days when Keep me signed in is ticked', async () => {
    await session(async (p, ctx) => {
      await p.goto(origin + '/sign-in', { waitUntil: 'networkidle' });
      await p.fill('#si-email', 'keisha.t@brightwater.example');
      await p.fill('#si-password', await shown('keisha.t@brightwater.example'));
      await p.click('[data-ctl="CTL-OFC-01-08"]');
      expect(await p.isChecked('[data-ctl="CTL-OFC-01-08"]')).toBe(true);
      await p.click('[data-ctl="CTL-OFC-01-04"]');
      await p.waitForURL('**/office/board');
      const cookie = (await ctx.cookies()).find((c) => c.name === 'bw_session');
      const days = ((cookie?.expires ?? 0) - Date.now() / 1000) / 86_400;
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThanOrEqual(90);
    });
  });

  // why: FR-AUTH-6 the gate accepts the code, refuses a wrong one, and opens the page that was asked for; the cookie is httpOnly and Secure
  it('opens the asked page after the right code, with a Secure httpOnly bw_access cookie', async () => {
    await session(async (p, ctx) => {
      await p.goto(origin + '/', { waitUntil: 'networkidle' });
      expect(await screen(p)).toBe('SCR-GATE-01');
      await p.click('[data-ctl="CTL-GATE-01-02"]');
      expect(await p.locator('.r1-fmsg').textContent()).toContain('Type the access code'); // empty: no call
      await p.fill('#code', 'definitely-not-it');
      await slowRender(p, 1500); // F-1303: the old empty-code message stays drawn for 1.5 s after the click, so a wait that reads it too early fails
      await p.click('[data-ctl="CTL-GATE-01-02"]');
      // F-1300: the empty-code message is still drawn until the form action clears it, so waiting for any .r1-fmsg can read the old one;
      // wait for the answer's own words.
      await p.waitForFunction(() => (globalThis as unknown as { document: { querySelector(s: string): { textContent: string | null } | null } }).document.querySelector('.r1-fmsg')?.textContent?.includes('not right') === true);
      expect(await p.locator('.r1-fmsg').textContent()).toContain('not right');
      expect(await p.inputValue('#code')).toBe('definitely-not-it'); // the code stays
      await p.fill('#code', code);
      await p.click('button[data-ctl="CTL-GATE-01-02"]');
      await p.waitForSelector('[data-screen="SCR-GATE-02"]');
      const cookie = (await ctx.cookies()).find((c) => c.name === 'bw_access');
      expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
      expect(((cookie?.expires ?? 0) - Date.now() / 1000) / 86_400).toBeGreaterThan(29);
    });
  });

  // why: FR-AUTH-7 the start page lists the sample technicians who can sign in, with passwords that sign in, and says the iPhone app is coming
  it('lists the sample technician sign-ins after the code, and the install line says the app is coming', async () => {
    await session(async (p) => {
      await p.goto(origin + '/', { waitUntil: 'networkidle' });
      await p.fill('#code', code);
      await p.click('[data-ctl="CTL-GATE-01-02"]');
      await p.waitForSelector('[data-ctl="CTL-GATE-02-04"] td');
      const rows = await p.locator('table.signs tbody tr').allTextContents();
      expect(rows).toHaveLength(1); // Maria Santos: Derek Simmons is Invited, has no password, and is not listed
      expect(rows[0]).toContain('Maria Santos');
      expect(rows[0]).toContain(await shown(MARIA.email));
      expect(await p.textContent('[data-ctl="CTL-GATE-02-05"]')).toContain("The iPhone app is coming. It is waiting for Apple's approval.");
      expect(await p.locator('[data-ctl="CTL-GATE-02-05"] a').count()).toBe(0);
      expect(await p.locator('.r1-demobar').count()).toBe(1); // the start page carries the demo clock
      // The listed password signs the technician in on the native app's route: API-03 by employee number (FR-AUTH-11).
      const native = await api(p, 'POST', '/api/v1/sessions', { login: MARIA.employee, password: await shown(MARIA.email), client: 'native' });
      expect([native.status, native.body?.data?.token]).toEqual([200, expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)]);
    });
  });

  // why: FR-LANG-1 on the real stack the start page's iPhone app sign-ins name a Spanish speaker's language Español and an English speaker's English, in either page language (F-1280)
  it('names a listed technician\'s language in its own name, Español or English, with the page in English and in Spanish', async () => {
    // Maria Santos sets her own language through her settings (API-08, a password session: it passes the gate with no code), so the
    // list the start page reads (API-15) holds her as a Spanish speaker, then as an English one; the fixture writes every user English.
    await session(async (maria) => {
      await maria.goto(origin + '/', { waitUntil: 'networkidle' });
      await roomForSignIns(maria, 1);
      expect((await api(maria, 'POST', '/api/v1/sessions', { login: MARIA.email, password: await shown(MARIA.email), client: 'web' })).status).toBe(200);
      const speak = async (language: 'en' | 'es') => expect((await api(maria, 'PATCH', '/api/v1/me', { language })).body?.data?.language).toBe(language);
      await session(async (p, ctx) => {
        await p.goto(origin + '/', { waitUntil: 'networkidle' });
        await p.fill('#code', code);
        await p.click('[data-ctl="CTL-GATE-01-02"]');
        await p.waitForSelector('[data-ctl="CTL-GATE-02-04"] td');
        /** Maria Santos's Language cell on the start page with the page in `lang` (the visitor's choice, the bw_lang cookie). */
        const cell = async (lang: 'en' | 'es') => {
          await ctx.addCookies([{ name: 'bw_lang', value: lang, url: origin }]);
          await p.goto(origin + '/', { waitUntil: 'networkidle' });
          await p.waitForSelector('[data-ctl="CTL-GATE-02-04"] td');
          expect(await p.evaluate(() => (globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang)).toBe(lang);
          return p.locator('[data-ctl="CTL-GATE-02-04"] tbody tr', { hasText: 'Maria Santos' }).locator('td:nth-child(3)').textContent();
        };
        try {
          await speak('es');
          for (const lang of ['en', 'es'] as const) expect(await cell(lang), `a Spanish speaker, page in ${lang}`).toBe('Español');
          await speak('en');
          for (const lang of ['en', 'es'] as const) expect(await cell(lang), `an English speaker, page in ${lang}`).toBe('English');
        } finally {
          await speak('en');
        }
      });
    });
  });

  // why: FR-AUTH-5 the Sign in as list appears only after the code, and a button signs in as that person
  it('shows the Sign in as list only after the code and signs in as a person', async () => {
    await session(async (p) => {
      await p.goto(origin + '/', { waitUntil: 'networkidle' });
      await p.fill('#code', code);
      await p.click('[data-ctl="CTL-GATE-01-02"]');
      await p.waitForSelector('[data-screen="SCR-GATE-02"]');
      await p.goto(origin + '/sign-in', { waitUntil: 'networkidle' });
      await p.waitForSelector('.aslist .who');
      const names = await p.locator('.aslist .who b').allTextContents();
      expect(names).toEqual(['Dana Ruiz', 'Keisha Thompson', 'Maria Santos']);
      expect(await p.locator('.aslist h4').allTextContents()).toEqual(['Managers', 'Office', 'Technicians']);
      await p.click('.aslist .who >> text=Keisha Thompson');
      await p.waitForURL('**/office/board');
      const me = await api(p, 'GET', '/api/v1/me');
      expect([me.status, me.body?.data?.role]).toEqual([200, 'office']);
    });
  });

  // why: F-288 (owner ruling cb5d1273 "Code required") a password session with no access code entered gets no Sign in as list from
  // API-04, API-05 or API-15, and the same session gets it once the code is entered
  it('gives a password session the sample lists only after the access code is entered', async () => {
    await session(async (p) => {
      await p.goto(origin + '/sign-in', { waitUntil: 'networkidle' });
      await p.fill('#si-email', DANA.email);
      await p.fill('#si-password', await shown(DANA.email));
      await p.click('[data-ctl="CTL-OFC-01-04"]');
      await p.waitForURL('**/office/board');
      expect((await api(p, 'GET', '/api/v1/me')).status).toBe(200); // past the gate by the password session alone
      const people = await api(p, 'GET', '/api/v1/demo/people?app=office');
      expect([people.status, people.body?.code]).toEqual([403, 'access_code_required']);
      expect((await api(p, 'GET', '/api/v1/demo/tech-sign-ins')).body?.code).toBe('access_code_required');
      const as = await api(p, 'POST', '/api/v1/demo/sessions', { personId: '0192f000-0000-7000-8000-000000000000' });
      expect(as.body?.code).toBe('access_code_required');
      expect((await api(p, 'POST', '/api/v1/access-code', { code })).status).toBe(204);
      expect((await api(p, 'GET', '/api/v1/demo/people?app=office')).status).toBe(200);
      expect((await api(p, 'GET', '/api/v1/demo/tech-sign-ins')).status).toBe(200);
    });
  });

  // why: FR-AUTH-1 F-230 sign out clears the httpOnly session cookie in the server's answer, and the session no longer works
  it('signs out: the cookie is cleared by the answer and the session is gone', async () => {
    await session(async (p, ctx) => {
      await p.goto(origin + '/sign-in', { waitUntil: 'networkidle' });
      await p.fill('#si-email', DANA.email);
      await p.fill('#si-password', await shown(DANA.email));
      await p.click('[data-ctl="CTL-OFC-01-04"]');
      await p.waitForURL('**/office/board');
      expect((await ctx.cookies()).some((c) => c.name === 'bw_session')).toBe(true);
      const out = await api(p, 'DELETE', '/api/v1/sessions/current');
      expect(out.status).toBe(204);
      expect((await ctx.cookies()).some((c) => c.name === 'bw_session')).toBe(false);
      // The session is gone: a signed-out caller with no code entered is asked for the code, not shown the user.
      expect((await api(p, 'GET', '/api/v1/me')).body?.code).toBe('access_code_required');
    });
  });

  // why: FR-DISP-11 a user who turns the "/" shortcut off finds it still off at their next real sign-in
  it('keeps the "/" shortcut off across a sign-out and the next real sign-in', async () => {
    await session(async (p) => {
      const signIn = async () => {
        await p.goto(origin + '/sign-in', { waitUntil: 'networkidle' });
        await p.fill('#si-email', DANA.email);
        await p.fill('#si-password', await shown(DANA.email));
        await p.click('[data-ctl="CTL-OFC-01-04"]');
        await p.waitForURL('**/office/board');
      };
      await signIn();
      const first = await api(p, 'GET', '/api/v1/me');
      expect(first.body?.data?.slashShortcut, JSON.stringify(first.body)).toBe('on');
      expect((await api(p, 'PATCH', '/api/v1/me', { slashShortcut: 'off' })).status).toBe(200);
      expect((await api(p, 'DELETE', '/api/v1/sessions/current')).status).toBe(204);
      await signIn();
      expect((await api(p, 'GET', '/api/v1/me')).body?.data?.slashShortcut).toBe('off');
      const restore = await api(p, 'PATCH', '/api/v1/me', { slashShortcut: 'on' });
      expect([restore.status, restore.body], 'the cleanup restores the shortcut').toEqual([200, expect.anything()]); // leave the fixture as found for the next engine
    });
  });

  // why: FR-AUTH-2 a customer needs no account: the booking, live map, reschedule and inbox routes need no session, only the code (UD-13)
  it('lets a visitor with only the code reach the customer pages without signing in', async () => {
    await session(async (p) => {
      await p.goto(origin + '/', { waitUntil: 'networkidle' });
      await p.fill('#code', code);
      await p.click('[data-ctl="CTL-GATE-01-02"]');
      await p.waitForSelector('[data-screen="SCR-GATE-02"]');
      for (const path of ['/book', '/m/aaaaaaaaaaaaaaaaaaaaaaaa', '/inbox/aaaaaaaaaaaaaaaaaaaaaaaa']) {
        const res = await p.goto(origin + path, { waitUntil: 'networkidle' });
        // The pages themselves are later lanes': a visitor is never sent to a sign-in page, and never shown the gate again.
        expect(new URL(p.url()).pathname, path).toBe(path);
        expect(await screen(p), path).not.toBe('SCR-GATE-01');
        expect(res?.status(), path).not.toBe(303);
      }
    });
  });

  // why: F-320 a Sign in as tap marks that person's row busy and leaves the form's Sign in button as it was (F-285, UI-SPECIFICATION Signing in)
  it('marks the pressed Sign in as row busy, not the Sign in button', async () => {
    await session(async (p) => {
      await p.goto(origin + '/', { waitUntil: 'networkidle' });
      await p.fill('#code', code);
      await p.click('button[data-ctl="CTL-GATE-01-02"]');
      await p.waitForSelector('[data-screen="SCR-GATE-02"]');
      await p.goto(origin + '/sign-in', { waitUntil: 'networkidle' });
      await p.waitForSelector('.aslist .who');
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      // API-05 is held until the assertions are made; fallback() hands the call on to the origin rewrite writeOrigin set.
      await p.route(`${origin}/api/v1/demo/sessions`, async (r) => {
        await held;
        return r.fallback();
      });
      await p.click('.aslist .who >> text=Keisha Thompson');
      try {
        await p.waitForSelector('.aslist .who.busy');
        expect(await p.locator('.aslist .who.busy').count()).toBe(1);
        expect(await p.locator('.aslist .who.busy').textContent()).toContain('Keisha Thompson');
        const go = p.locator('button[data-ctl="CTL-OFC-01-04"]');
        expect(await go.getAttribute('aria-busy'), 'the Sign in button is not the busy control').toBeNull();
        expect(await go.getAttribute('class')).not.toContain('busy');
        expect(await p.locator('button[data-ctl="CTL-OFC-01-04"] .r1-spin').count()).toBe(0);
      } finally {
        release();
      }
      await p.waitForURL('**/office/board');
    });
  });

  // why: F-320 SCR-GATE-01 keeps the Enter button in the failed state, and it is the button (not the error panel) that data-ctl CTL-GATE-01-02 names there (F-285)
  it('keeps the Enter button after a failed check, beside the error panel that shares its data-ctl', async () => {
    await session(async (p) => {
      await p.goto(origin + '/', { waitUntil: 'networkidle' });
      expect(await screen(p)).toBe('SCR-GATE-01');
      await p.route(`${origin}/api/v1/access-code`, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
      await p.fill('#code', 'any-code-at-all');
      await p.click('button[data-ctl="CTL-GATE-01-02"]');
      await p.waitForSelector('.r1-errpanel');
      expect(await p.locator('.r1-errpanel').getAttribute('data-ctl')).toBe('CTL-GATE-01-02');
      const enter = p.locator('button[data-ctl="CTL-GATE-01-02"]');
      expect(await enter.count(), 'the Enter button stays in the failed state').toBe(1);
      expect(await enter.isVisible()).toBe(true);
      expect(await enter.isEnabled()).toBe(true);
      expect(await enter.getAttribute('type')).toBe('submit');
    });
  });

  // why: FR-AUTH-1, F-1064, F-1128 two taps on Sign in made before the page hydrated send one sign-in (the guard that stops a second send), on the office and the technician screens
  it.each([
    ['the office sign-in', '/sign-in', '#si-email', '#si-password', '[data-ctl="CTL-OFC-01-04"]', 'keisha.t@brightwater.example', 'keisha.t@brightwater.example'],
    ['the technician sign-in', '/tech/sign-in', '#ts-login', '#ts-password', '[data-ctl="CTL-TEC-01-04"]', MARIA.employee, MARIA.email],
  ] as const)('sends %s once for two taps made before the page hydrated', async (_name, route, loginSel, passwordSel, buttonSel, login, passwordOf) => {
    await session(async (p) => {
      // Sign-in is rate limited by address (10 a minute per web process): this row needs room for its 1 send plus 1 spare, and waits only
      // for the earlier sends this run made that are still in the window (none when the run's sends so far leave room).
      await roomForSignIns(p, 2);
      let sends = 0;
      const answers: number[] = [];
      p.on('request', (r) => {
        if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/sessions') sends += 1;
      });
      p.on('response', (r) => {
        if (r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/sessions') answers.push(r.status());
      });
      const scripts = await holdScripts(p);
      scripts.hold();
      await p.goto(origin + route, { waitUntil: 'domcontentloaded' });
      await p.fill(loginSel, login);
      await p.fill(passwordSel, await shown(passwordOf));
      await p.click(buttonSel);
      await p.click(buttonSel).catch(() => undefined); // the second tap may find the button busy or gone: that is the guard working
      expect(scripts.pending(), 'the page scripts are still held at the taps').toBeGreaterThan(0);
      scripts.release();
      const left = await p.waitForURL((u) => !u.pathname.endsWith('/sign-in'), { timeout: 20_000 }).then(() => true, () => false);
      expect(sends, `API-03 sends (answers ${answers.join(',')}, left the page: ${left})`).toBe(1);
      expect(left, `the page did not leave sign-in (answers ${answers.join(',')})`).toBe(true);
    });
  }, 150_000);

  // why: FR-AUTH-10, F-1063 a Stay signed in or Keep me signed in tick made before the page's script has run is sent as the box shows it: API-03 carries keepSignedIn true and the session lasts 90 days, on the office and the technician screens
  it.each([
    ['the office sign-in', '/sign-in', '#si-email', '#si-password', '[data-ctl="CTL-OFC-01-04"]', '[data-ctl="CTL-OFC-01-08"]', 'keisha.t@brightwater.example', 'keisha.t@brightwater.example'],
    ['the technician sign-in', '/tech/sign-in', '#ts-login', '#ts-password', '[data-ctl="CTL-TEC-01-04"]', '[data-ctl="CTL-TEC-01-08"]', MARIA.employee, MARIA.email],
  ] as const)('signs %s in with the box ticked before the page hydrated', async (_name, route, loginSel, passwordSel, buttonSel, boxSel, login, passwordOf) => {
    await session(async (p, ctx) => {
      await roomForSignIns(p, 2);
      const sent: unknown[] = [];
      p.on('request', (r) => {
        if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/sessions') sent.push(r.postDataJSON());
      });
      const scripts = await holdScripts(p);
      scripts.hold();
      await p.goto(origin + route, { waitUntil: 'domcontentloaded' });
      await p.fill(loginSel, login);
      await p.fill(passwordSel, await shown(passwordOf));
      await p.locator(boxSel).click();
      expect(await p.locator(boxSel).isChecked(), 'the box shows the tick before any script has run').toBe(true);
      await p.click(buttonSel);
      expect(scripts.pending(), 'the page scripts are still held at the tap').toBeGreaterThan(0);
      scripts.release();
      await p.waitForURL((u) => !u.pathname.endsWith('/sign-in'), { timeout: 20_000 });
      expect(sent.map((b) => (b as { keepSignedIn?: boolean }).keepSignedIn), 'the 1 API-03 send carries the box as it showed').toEqual([true]);
      const cookie = (await ctx.cookies()).find((c) => c.name === 'bw_session');
      expect(((cookie?.expires ?? 0) - Date.now() / 1000) / 86_400, 'a 90-day session').toBeGreaterThan(89);
    });
  }, 150_000);

  // why: UD-20, F-1126, F-1067 a technician sign-in on a phone whose item store cannot be read keeps the last person's login and says why, without a count
  it('locks the technician sign-in to the saved login with a words line when the item store cannot be read', async () => {
    await session(async (p) => {
      // F-1287: the break goes on IDBFactory.prototype, not on the object window.indexedDB gives the init script. On WebKit that object is not
      // always the factory the page uses (measured: 3 of 112 runs of Linux WebKit 1.64.1 under load; the init script ran once, the login was
      // saved, and the page's factory had no override). Every factory inherits the prototype's open, whenever WebKit makes it.
      await p.addInitScript(() => {
        localStorage.setItem('bw.tech.login', '40712');
        IDBFactory.prototype.open = () => {
          throw new Error('the item store is unreadable');
        };
      });
      await p.goto(origin + '/tech/sign-in', { waitUntil: 'networkidle' });
      const notice = p.locator('.bw-tech-signin .msg.info');
      await notice.waitFor({ timeout: 30_000 });
      expect(await notice.innerText()).toContain('Items may be waiting to send on this phone. Sign in as 40712 to send them.');
      expect(await p.locator('#ts-login').inputValue()).toBe('40712');
      expect(await p.locator('#ts-login').getAttribute('readonly')).not.toBeNull();
    });
  });
});

// why: F-304 over plain http (no TLS front) bw_access is not Secure, so WebKit stores it and the code sticks across a reload
describe.each(run)('the access code over plain http, %s', (_engine, type) => {
  it('keeps the entered code across a reload when the site is served over http', async () => {
    expect(base.startsWith('http:'), 'this arm reaches the stack directly, over http').toBe(true);
    const browser = await type.launch({ headless: true });
    try {
      const g = await guardedContext(browser, [new URL(base).origin], { viewport: { width: 1440, height: 900 } });
      try {
        const p = await g.context.newPage();
        await p.goto(base + '/', { waitUntil: 'networkidle' });
        expect(await screen(p)).toBe('SCR-GATE-01');
        await p.fill('#code', code);
        await p.click('button[data-ctl="CTL-GATE-01-02"]');
        await p.waitForSelector('[data-screen="SCR-GATE-02"]');
        const cookie = (await g.context.cookies()).find((c) => c.name === 'bw_access');
        expect(cookie, 'the browser stored the cookie').toMatchObject({ httpOnly: true, secure: false, sameSite: 'Lax' });
        await p.reload({ waitUntil: 'networkidle' });
        expect(await screen(p), 'the gate does not come back').toBe('SCR-GATE-02');
      } finally {
        await g.context.close();
      }
    } finally {
      await browser.close();
    }
  });
});
