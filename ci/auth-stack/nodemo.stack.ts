// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-AUTH-5, FR-AUTH-7 (P2-AUTH Acceptance: with DEMO_MODE off the Sign in as list is absent and no demo log line is written)
// The same stack with DEMO_MODE=off and the access code on (ci/auth-stack.sh, its first phase): even after the code, no Sign in as list, no
// sample technician sign-ins, no iPhone app line, no Demo mode on marker. The script then checks the web log for the demo line.
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { tlsFront } from './tls-front.ts';

const base = process.env.BW_AUTH_STACK_URL;
const code = process.env.BW_AUTH_STACK_CODE;
const tls = process.env.BW_AUTH_STACK_TLS;
if (!base || !code || !tls) throw new Error('BW_AUTH_STACK_URL, _CODE and _TLS are not set: run ci/auth-stack.sh');
// Through the suite's https front, as auth.stack.ts (F-290: WebKit refuses the Secure bw_access cookie over plain http).
const front = await tlsFront(base, tls);
afterAll(() => front.close());
const origin = front.origin;
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true };

const api = (p: Page, path: string) =>
  p.evaluate(async (path) => {
    const r = await fetch(path);
    return { status: r.status, body: (await r.json()) as { code?: string; data?: Record<string, unknown> } };
  }, path);

describe.each(engines)('demo mode off on the Compose stack, %s', (_engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-AUTH-5 with DEMO_MODE off the Sign in as list is absent after the code, the sample sign-ins and the iPhone line are absent, and the calls answer demo_mode_off
  it('has no Sign in as list, no sample sign-ins and no demo marker, even after the code', async () => {
    const g = await guardedContext(browser, [origin], DESKTOP);
    try {
      const p = await g.context.newPage();
      await p.goto(origin + '/', { waitUntil: 'networkidle' });
      await p.fill('#code', code);
      await p.click('[data-ctl="CTL-GATE-01-02"]');
      await p.waitForSelector('[data-screen="SCR-GATE-02"]');
      expect(await p.locator('.iph, [data-ctl="CTL-GATE-02-04"], [data-ctl="CTL-GATE-02-05"]').count()).toBe(0);
      expect(await p.locator('.r1-foot .demo').count()).toBe(0);
      expect(await p.locator('.doors .door').count()).toBe(3);
      await p.goto(origin + '/sign-in', { waitUntil: 'networkidle' });
      await p.waitForSelector('#si-email');
      expect(await p.locator('.aslist, .asl').count()).toBe(0);
      expect((await api(p, '/api/v1/demo/people?app=office')).body.code).toBe('demo_mode_off');
      expect((await api(p, '/api/v1/demo/tech-sign-ins')).body.code).toBe('demo_mode_off');
      expect((await api(p, '/api/v1/app-info')).body.data).toMatchObject({ demoMode: false, accessCodeOn: true });
    } finally {
      await g.context.close();
    }
  });
});
