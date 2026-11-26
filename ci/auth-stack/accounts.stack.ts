// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: UC-18, UC-19, FR-AUTH-8, FR-AUTH-9, FR-AUTH-12, F-333 (P4-ACCOUNTS Acceptance: Playwright on Chromium and WebKit against the Compose stack)
// The users page, Forgot password and the email pages against the Compose stack at its default settings (real PostgreSQL 18, real
// handlers, pbs running), through its proxy, access code on, RESET_PROTECTION unset (OI-29), every page opened through the
// outside-origin guard (no request leaves the app's origin; ci/auth-stack.sh also checks the image holds no mail transport).
// ci/auth-stack.sh runs this file in 2 phases (BW_ACCOUNTS_PHASE):
//   nodemo  DEMO_MODE=off, every engine in 1 run: UC-19, a staff member resets a password from the on-screen email inbox by the
//           one-time link the request page shows; the old password is refused, the new one works; the link opened twice answers its
//           spent state. Nina Ford (not a sample person) is the staff member: each engine resets her, so the old password of the second
//           engine is the first engine's new one (kept here, never printed).
//   demo    DEMO_MODE=on, 1 engine per run (BW_AUTH_STACK_ENGINE) on a fresh web process: owner ruling 5a554f12 (F-333), a sample
//           person's forgot password is refused and the password the start page lists still signs in; UC-18, a manager invites a
//           technician, who opens the invite by the link the manager is shown, sets a password and signs in with the employee number.
import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { tlsFront } from './tls-front.ts';

const base = process.env.BW_AUTH_STACK_URL;
const code = process.env.BW_AUTH_STACK_CODE;
const seed = process.env.BW_AUTH_STACK_SEED;
const tls = process.env.BW_AUTH_STACK_TLS;
const phase = process.env.BW_ACCOUNTS_PHASE;
if (!base || !code || !seed || !tls || (phase !== 'nodemo' && phase !== 'demo')) {
  throw new Error('BW_AUTH_STACK_URL, _CODE, _SEED, _TLS and BW_ACCOUNTS_PHASE (nodemo or demo) are not set: run ci/auth-stack.sh');
}
const only = process.env.BW_AUTH_STACK_ENGINE;
const run = phase === 'demo' ? engines.filter(([name]) => name === only) : engines;
if (phase === 'demo' && run.length !== 1) throw new Error(`BW_AUTH_STACK_ENGINE=${only} is not 1 of this run's engines`);
const front = await tlsFront(base, tls);
afterAll(() => front.close());
const origin = front.origin;
const APP_ORIGIN = 'http://localhost:8080';
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true };

const NINA = 'nina.ford@brightwater.example';
const DANA = 'dana.ruiz@brightwater.example';
const MARIA = 'maria.santos@brightwater.example';
const derived = async (email: string, form: 'plain' | 'shown') => {
  const { samplePassword, showSamplePassword } = await import('../../packages/db/src/passwords.ts');
  const p = samplePassword(seed!, email);
  return form === 'shown' ? showSamplePassword(p) : p;
};
/** A fresh password for a run, never printed. */
const freshPassword = () => `run ${randomBytes(9).toString('base64url')} phrase`;

/**
 * Every write leaves with APP_ORIGIN (the kernel's Origin check, SD-8), on every page of the context (the email opens in a new tab). The route is
 * the context's, which the guard's close does not wait for (origin-guard.ts), so the returned settle does: it forwards no write after it and waits
 * for the ones in flight, so no route callback runs on after its test (F-1421).
 */
async function writeOrigin(ctx: BrowserContext): Promise<() => Promise<void>> {
  const running = new Set<Promise<void>>();
  let settling = false;
  await ctx.route(`${origin}/api/v1/**`, (r) => {
    if (settling || r.request().method() === 'GET') return r.continue();
    const forward = (async () => {
      const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
      await r.fulfill({ response });
    })();
    running.add(forward);
    const done = () => running.delete(forward);
    forward.then(done, done);
    return forward;
  });
  return async () => {
    settling = true;
    await Promise.allSettled([...running]);
  };
}

const api = (p: Page, method: string, path: string, body?: unknown) =>
  p.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
      const text = await r.text();
      return { status: r.status, body: text ? (JSON.parse(text) as { data?: Record<string, unknown>; code?: string }) : null };
    },
    { method, path, body },
  );

/**
 * The access code by API-01 from the gate page (the gate screen itself is covered by the auth stack suite): a click on a page WebKit has not
 * hydrated yet would submit the form natively (seen on the Linux WebKit run), so the code goes by the call, then the start page.
 */
async function enterCode(p: Page): Promise<void> {
  await p.goto(origin + '/', { waitUntil: 'networkidle' });
  const r = await api(p, 'POST', '/api/v1/access-code', { code });
  expect(r.status).toBe(204);
  await p.goto(origin + '/', { waitUntil: 'networkidle' });
  await p.waitForSelector('[data-screen="SCR-GATE-02"]');
}

/** The page's screen root is hydrated (React has attached to it), so a click runs the page's handler, never a native submit. */
async function hydrated(p: Page): Promise<void> {
  await p.waitForFunction(() => {
    const el = (globalThis as unknown as { document: { querySelector(s: string): object | null } }).document.querySelector('[data-screen]');
    return el !== null && Object.keys(el).some((k) => k.startsWith('__react'));
  });
}

/** Click a link that opens in a new tab and answer that tab once it shows its screen. */
async function opensTab(ctx: BrowserContext, p: Page, selector: string, screen: string): Promise<Page> {
  const [tab] = await Promise.all([ctx.waitForEvent('page'), p.click(selector)]);
  await tab.waitForSelector(`[data-screen="${screen}"]`);
  return tab;
}

// Nina's password across the engines of the nodemo run: the fixture's, then each engine's new one.
let ninaPassword: string | null = null;

describe.each(run)(`the account pages on the Compose stack (${phase}), %s`, (_engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function session<T>(fn: (p: Page, ctx: BrowserContext) => Promise<T>): Promise<T> {
    const g = await guardedContext(browser, [origin], DESKTOP);
    let settle = async () => {};
    try {
      settle = await writeOrigin(g.context);
      return await fn(await g.context.newPage(), g.context);
    } finally {
      await settle();
      // Closing the guarded context throws when any page asked another origin: no email, link or page left the app.
      await g.context.close();
    }
  }

  if (phase === 'nodemo') {
    // why: UC-19 on a copy with reset protection off, a staff member resets a password from the on-screen email inbox opened by the one-time link the request page shows; the new password works and the old one is refused
    // why: FR-AUTH-8 the link opens the email once: a second use answers its spent state
    it('resets a password by Forgot password, the email link and Set a password; the old password is refused', async () => {
      const old = ninaPassword ?? (await derived(NINA, 'plain'));
      const next = freshPassword();
      await session(async (p, ctx) => {
        await enterCode(p);
        await p.goto(origin + '/sign-in', { waitUntil: 'networkidle' });
        await hydrated(p);
        await p.click('[data-ctl="CTL-OFC-01-07"]');
        await p.waitForSelector('[data-screen="SCR-EML-03"]');
        await hydrated(p);
        await p.fill('#fp-email', NINA);
        await p.click('[data-ctl="CTL-EML-03-02"]');
        await p.waitForSelector('.res .okbox');
        const href = await p.getAttribute('[data-ctl="CTL-EML-03-04"]', 'href');
        expect(href).toMatch(/^\/email\/[A-Za-z0-9_-]{43}$/);
        const mail = await opensTab(ctx, p, '[data-ctl="CTL-EML-03-04"]', 'SCR-EML-01');
        await mail.waitForSelector('[data-ctl="CTL-EML-01-02"]');
        await hydrated(mail);
        expect(await mail.locator('[data-ctl="CTL-EML-01-01"] b').textContent()).toBe(NINA);
        // The request page's link is spent: the page says so, and opening it again shows the spent state, no email.
        expect(await p.locator('[data-ctl="CTL-EML-03-04"]').count()).toBe(0);
        const again = await ctx.newPage();
        await again.goto(origin + href!, { waitUntil: 'networkidle' });
        await again.waitForSelector('[data-screen="SCR-EML-01"] .warnbox');
        expect(await again.locator('[data-ctl="CTL-EML-01-02"]').count()).toBe(0);
        await again.close();
        // The email's button opens Set a password; the new password is stored and the sign-in page says so.
        await mail.click('[data-ctl="CTL-EML-01-03"]');
        await mail.waitForSelector('#sp-password');
        await hydrated(mail);
        await mail.fill('#sp-password', next);
        await mail.click('[data-ctl="CTL-EML-02-04"]');
        await mail.waitForURL('**/sign-in?set=1');
        await mail.waitForSelector('.msgb.info');
        expect(await mail.locator('.msgb.info').textContent()).toContain('Your password is set');
        expect((await api(mail, 'POST', '/api/v1/sessions', { login: NINA, password: old, client: 'web' })).status).toBe(401);
        expect((await api(mail, 'POST', '/api/v1/sessions', { login: NINA, password: next, client: 'web' })).status).toBe(200);
      });
      ninaPassword = next;
    });

    // why: FR-AUTH-9 an unknown address gets no email and no link
    it('sends nothing to an address no account uses', async () => {
      await session(async (p) => {
        await enterCode(p);
        await p.goto(origin + '/forgot-password?app=office', { waitUntil: 'networkidle' });
        await hydrated(p);
        await p.fill('#fp-email', 'nobody.here@brightwater.example');
        await p.click('[data-ctl="CTL-EML-03-02"]');
        await p.waitForSelector('.res .infobox2');
        expect(await p.locator('[data-ctl="CTL-EML-03-04"]').count()).toBe(0);
      });
    });
    return;
  }

  // why: F-333 owner ruling 5a554f12 (Nov 2, 2026, "Block their reset"): with DEMO_MODE=on and RESET_PROTECTION unset, a sample person's forgot password (API-165) is refused and the sample password the start page lists still signs in
  it('refuses a sample person\'s forgot password in demo mode, and the listed sample password still signs in', async () => {
    await session(async (p) => {
      await enterCode(p);
      await p.goto(origin + '/forgot-password?app=tech', { waitUntil: 'networkidle' });
      await hydrated(p);
      await p.fill('#fp-email', MARIA);
      await p.click('[data-ctl="CTL-EML-03-02"]');
      await p.waitForSelector('.res .infobox2');
      expect(await p.locator('[data-ctl="CTL-EML-03-04"]').count()).toBe(0);
      expect(await p.getAttribute('[data-ctl="CTL-EML-03-05"]', 'href')).toBe('/tech/sign-in');
      const listed = await api(p, 'GET', '/api/v1/demo/tech-sign-ins');
      const maria = (listed.body?.data?.signIns as { email: string; password: string }[]).find((s) => s.email === MARIA);
      expect(maria).toBeDefined();
      expect((await api(p, 'POST', '/api/v1/sessions', { login: MARIA, password: maria!.password, client: 'web' })).status).toBe(200);
    });
  });

  // why: UC-18 a manager invites a new technician, who opens the invite email by the one-time link the manager is shown, sets a password and signs in with an employee number; the user is listed Active with the Technician role
  // why: FR-AUTH-12 the invited user is listed Invited with the picked role and branch, then Active after the invite's link sets a password
  it('invites a technician who sets a password from the link and signs in with the employee number', async () => {
    const email = `uc18.${only}@brightwater.example`;
    const password = freshPassword();
    await session(async (p, ctx) => {
      await p.goto(origin + '/sign-in', { waitUntil: 'networkidle' });
      await hydrated(p);
      await p.fill('#si-email', DANA);
      await p.fill('#si-password', await derived(DANA, 'shown'));
      await p.click('[data-ctl="CTL-OFC-01-04"]');
      await p.waitForURL('**/office/board');
      // 'load', not network idle: the page holds the bell's event stream open (F-690).
      await p.goto(origin + '/office/admin/users', { waitUntil: 'load' });
      await p.waitForSelector('[data-screen="SCR-OFC-43"] table.u');
      await hydrated(p);
      await p.click('[data-ctl="CTL-OFC-43-01"]');
      await p.fill('#inv-name', `Uc Eighteen ${only}`);
      await p.fill('#inv-email', email);
      await p.click('[data-ctl="CTL-OFC-44-03"] [role="radio"]:has-text("Technician")');
      await p.selectOption('#inv-branch', 'dayton');
      await p.click('[data-ctl="CTL-OFC-44-05"]');
      // The link, or the dialog's message saying why not (so a refusal names itself).
      await p.waitForSelector('[data-ctl="CTL-OFC-44-06"], .r1-dlg .r1-fmsg');
      expect(await p.locator('.r1-dlg .r1-fmsg').allTextContents()).toEqual([]);
      // Listed Invited, Technician, Dayton.
      await p.fill('[data-ctl="CTL-OFC-43-02"] input', email);
      const row = p.locator('table.u tbody tr', { hasText: email });
      await row.waitFor();
      expect(await row.locator('.chip').textContent()).toContain('Invited');
      expect(await row.locator('.rl').textContent()).toContain('Technician');
      expect(await row.textContent()).toContain('Dayton');
      const mail = await opensTab(ctx, p, '[data-ctl="CTL-OFC-44-06"]', 'SCR-EML-01');
      await mail.waitForSelector('[data-ctl="CTL-EML-01-02"]');
      await hydrated(mail);
      const body = (await mail.locator('.mb').textContent()) ?? '';
      const employee = /employee number is (\d{5})/.exec(body)?.[1];
      expect(employee, 'the invite email prints the employee number (OI-26)').toMatch(/^\d{5}$/);
      await mail.click('[data-ctl="CTL-EML-01-03"]');
      await mail.waitForSelector('#sp-password');
      await hydrated(mail);
      expect(await mail.locator('[data-ctl="CTL-EML-02-01"]').textContent()).toContain('Technician, Dayton');
      await mail.fill('#sp-password', password);
      await mail.click('[data-ctl="CTL-EML-02-04"]');
      await mail.waitForURL('**/tech/sign-in?set=1');
      // FR-AUTH-11: the technician signs in with the employee number (API-03, the technician apps' sign-in).
      const signed = await api(mail, 'POST', '/api/v1/sessions', { login: employee, password, client: 'native' });
      expect([signed.status, (signed.body?.data?.user as { role?: string } | undefined)?.role]).toEqual([200, 'technician']);
      // The manager's list now shows the user Active.
      await p.reload({ waitUntil: 'load' });
      await p.waitForSelector('[data-screen="SCR-OFC-43"] table.u');
      await hydrated(p);
      await p.fill('[data-ctl="CTL-OFC-43-02"] input', email);
      const active = p.locator('table.u tbody tr', { hasText: email });
      await active.locator('.chip', { hasText: 'Active' }).waitFor();
    });
  });
});
