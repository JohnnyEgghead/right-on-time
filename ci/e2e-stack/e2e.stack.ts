// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: NFR-12, SC-07 (BUILD_PLAN P7-E2E Acceptance: the 7-step happy path of REQUIREMENTS section 2 on Chromium and WebKit, every page through the outside-origin guard)
// The scripted end-to-end test of SC-07, driven only through the copy's own address: no docker, no SQL, no stack internals. The base URL is a setting
// (BW_E2E_BASE_URL), so the same file runs on a local copy whose network blocks every outside host after install (ci/e2e-stack.sh, NFR-12) and, at sign-off,
// on the hosted demo (P9-SIGNOFF-RUNS). Settings:
//   BW_E2E_BASE_URL       the copy's address (required)
//   BW_E2E_SEED           the copy's SAMPLE_PASSWORD_SEED: the sample people's passwords derive from it (or give BW_E2E_PASSWORD_DANA, _KEISHA, _MARIA)
//   BW_E2E_ACCESS_CODE    the hosted demo's access code, when the copy asks for one (FR-AUTH-6)
//   BW_E2E_PLANT=1        the planted request: the run plants 1 request to an outside origin and must FAIL on the guard (ci/e2e-stack.sh --plant)
// The 7 steps (REQUIREMENTS section 2), on each engine, in its own fresh world (the clock page's Reset when the world is not at Tue, Sep 15, 7:00 AM):
//   1. A customer books Thu, Sep 17, 8-10 AM through the 6 steps and finds the confirmation text in the on-screen inbox; the dispatcher gives the visit to Maria.
//   2. The manager moves the clock to 6:05 PM the evening before; the reminder arrives; the customer replies C and the visit is confirmed.
//   3. Maria signs in on the technician app, opens her day (the clock at 8:00 AM, Thu, Sep 17), taps On my way and confirms.
//   4. The customer gets the on-the-way text, follows the van on the live map; Maria taps Arrived and the link ends.
//   5. With no signal Maria adds a note and a photo; when signal returns they send and the office sees both.
//   6. Maria finishes the job with its parts; the pretend billing system holds 1 invoice for it.
//   7. The manager sees the job in the reports, labeled Simulated pilot data, and exports them.
import { deflateSync, crc32 } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, BrowserType, Cookie, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext, guardedPersistentContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_E2E_BASE_URL;
if (!base) throw new Error('BW_E2E_BASE_URL is not set: run ci/e2e-stack.sh, or set it to the copy\'s address');
const origin = new URL(base).origin;
const plant = process.env.BW_E2E_PLANT === '1';
const accessCode = process.env.BW_E2E_ACCESS_CODE ?? '';

const PEOPLE = {
  dana: { email: 'dana.ruiz@brightwater.example', login: 'dana.ruiz@brightwater.example' },
  keisha: { email: 'keisha.t@brightwater.example', login: 'keisha.t@brightwater.example' },
  maria: { email: 'maria.santos@brightwater.example', login: '40712' },
} as const;
type Who = keyof typeof PEOPLE;
/** A person's password: the one given, or the sample password the copy's seed derives (SD-9). */
async function passwordOf(who: Who): Promise<string> {
  const given = process.env[`BW_E2E_PASSWORD_${who.toUpperCase()}`];
  if (given) return given;
  const seed = process.env.BW_E2E_SEED;
  if (!seed) throw new Error(`no password for ${who}: set BW_E2E_SEED or BW_E2E_PASSWORD_${who.toUpperCase()}`);
  const { samplePassword, showSamplePassword } = await import('../../packages/db/src/passwords.ts');
  return showSamplePassword(samplePassword(seed, PEOPLE[who].email));
}

const DESKTOP = { viewport: { width: 1440, height: 900 }, timezoneId: 'America/New_York' };
const PHONE = { viewport: { width: 390, height: 844 }, timezoneId: 'America/New_York' };
const S1 = '.r1-screen[data-screen="SCR-CUS-01"]';
const S3 = '.r1-screen[data-screen="SCR-CUS-03"]';
const INBOX = '.r1-screen[data-screen="SCR-INB-01"]';
const LIVE = '.r1-screen[data-screen="SCR-CUS-04"]';
const ENDED = '.r1-screen[data-screen="SCR-CUS-05"]';
const REPORTS = '.r1-screen[data-screen="SCR-OFC-11"]';
/** The demo week, where the live visits are: the reports end at the last whole week unless asked for it (FR-REP-5). */
const LIVE_WEEK = '2026-09-14';
const LIVE_WEEK_QUERY = `?toWeek=${LIVE_WEEK}`;
const BOOK_DAY = ', Thu, Sep 17';
const BOOK_WINDOW = '8-10 AM';
const WORK_DONE = ['Furnace tune-up, all readings normal', 'Replaced the filter'];
const PART = 'FLT-16254';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, read: () => Promise<T> | T, cond: (v: T) => boolean, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (cond(last)) return last;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last read: ${JSON.stringify(last).slice(0, 400)}`);
    await sleep(500);
  }
}

/**
 * F-1735: the phone's API requests (sent, answered, failed) and the item engine's state every 5 s, kept in memory and added to the error
 * only when the step fails, so a red names where the send stopped (a call that never answered, an engine that never started a sync, or
 * one that never ended). A green run prints nothing.
 */
function phoneTrail(ctx: BrowserContext, page: Page, origin: string) {
  const t0 = Date.now();
  const lines: string[] = [];
  const note = (m: string) => {
    lines.push(`+${Date.now() - t0}ms ${m}`);
    if (lines.length > 300) lines.shift();
  };
  const at = (u: string) => u.replace(origin, '').replace(/[?].*$/, '');
  const api = (u: string) => u.startsWith(`${origin}/api/`);
  const onReq = (r: { url(): string; method(): string }) => { if (api(r.url())) note(`sent ${r.method()} ${at(r.url())}`); };
  const onFin = (r: { url(): string; method(): string }) => { if (api(r.url())) note(`answered ${r.method()} ${at(r.url())}`); };
  const onFail = (r: { url(): string; method(): string; failure(): { errorText: string } | null }) => {
    if (api(r.url())) note(`failed ${r.method()} ${at(r.url())} ${r.failure()?.errorText ?? ''}`);
  };
  ctx.on('request', onReq);
  ctx.on('requestfinished', onFin);
  ctx.on('requestfailed', onFail);
  const sampler = setInterval(() => {
    void page.evaluate(() => {
      const g = globalThis as unknown as { navigator: { onLine: boolean }; __bwTechOutbox?: { state(): { sending: boolean; online: boolean; waiting: { kind: string; lastTry?: { outcome?: string } | null }[] } } };
      const st = g.__bwTechOutbox?.state();
      return JSON.stringify({ onLine: g.navigator.onLine, sending: st?.sending, online: st?.online, waiting: st?.waiting.map((w) => `${w.kind}:${w.lastTry?.outcome ?? '-'}`) });
    }).then((x) => note(`engine ${x}`), (e: unknown) => note(`engine unread ${String(e).slice(0, 120)}`));
  }, 5000);
  const stop = () => {
    clearInterval(sampler);
    ctx.off('request', onReq);
    ctx.off('requestfinished', onFin);
    ctx.off('requestfailed', onFail);
  };
  return {
    note,
    async around<T>(run: () => Promise<T>): Promise<T> {
      try {
        return await run();
      } catch (e) {
        if (e instanceof Error) e.message += `\nphone trail (F-1735):\n${lines.join('\n')}`;
        throw e;
      } finally {
        stop();
      }
    },
  };
}

/** A PNG of noise, width x height RGB (the photo Maria picks). */
function noisePng(width: number, height: number): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  let x = 0x9e3779b9;
  for (let i = 0; i < raw.length; i++) {
    if (i % row === 0) { raw[i] = 0; continue; }
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    raw[i] = x & 0xff;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

/** One API call as the signed-in context's person; a write carries the copy's own origin, as the app's pages do. */
async function api(ctx: BrowserContext, method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; data: Json; text: string }> {
  const r = await ctx.request.fetch(`${origin}/api/v1${route}`, {
    method,
    headers: method === 'GET' ? {} : { origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { data: JSON.stringify(body) }),
  });
  const text = await r.text();
  let data: Json = null;
  try { data = (JSON.parse(text) as { data?: Json }).data; } catch { /* a file or an error page */ }
  return { status: r.status(), data, text };
}
const demoMs = (iso: string) => Date.parse(iso.replace(/\[.*\]$/, ''));

let gate: Cookie[] = [];
const entered = () => (gate.length > 0 ? { storageState: { cookies: gate, origins: [] } } : {});
/** The hosted demo's access code, entered once; its cookie then rides every context (FR-AUTH-6). A copy with no code has none to enter. */
async function enterCode(browser: Browser): Promise<void> {
  if (!accessCode || gate.length > 0) return;
  const g = await guardedContext(browser, [origin], DESKTOP);
  try {
    const p = await g.context.newPage();
    await p.goto(`${origin}/`, { waitUntil: 'load' });
    await p.fill('#code', accessCode);
    await p.click('button[data-ctl="CTL-GATE-01-02"]');
    await p.waitForSelector('[data-screen="SCR-GATE-02"]');
    gate = (await g.context.cookies()).filter((c) => c.name === 'bw_access');
    expect(gate.length, 'the code entry set the access cookie').toBe(1);
  } finally {
    await g.context.close();
  }
}

interface Staff { g: GuardedContext; page: Page }
/** An office person signed in on the office sign-in page, on a computer. */
async function office(browser: Browser, who: 'dana' | 'keisha'): Promise<Staff> {
  const g = await guardedContext(browser, [origin], { ...DESKTOP, ...entered() });
  const page = await g.context.newPage();
  await page.goto(`${origin}/sign-in`, { waitUntil: 'load' });
  await page.fill('#si-email', PEOPLE[who].login);
  await page.fill('#si-password', await passwordOf(who));
  await page.click('[data-ctl="CTL-OFC-01-04"]');
  await page.waitForURL('**/office/board', { timeout: 60_000 });
  return { g, page };
}
const closeAll = async (...xs: (GuardedContext | undefined)[]) => {
  for (const x of xs) await x?.context.close();
};

const clock = async (ctx: BrowserContext) => (await api(ctx, 'GET', '/clock')).data as { demoNow: string; paused: boolean; replay: { running: boolean }; resetAvailableInSeconds: number };
/** Waits for the clock to reach `iso` with its replay finished (a jump replays every due event in order, FR-DEMO-3). */
async function clockAtLeast(ctx: BrowserContext, iso: string): Promise<void> {
  await until(`the clock to reach ${iso}`, () => clock(ctx), (c) => !c.replay.running && demoMs(c.demoNow) >= Date.parse(iso), 240_000);
}

/** The clock page: a typed jump (CTL-OFC-17-03). `iso` is the wall time's UTC-offset form, which the wait compares against. */
async function typedJump(dana: Staff, date: string, time: string, iso: string): Promise<void> {
  await dana.page.goto(`${origin}/office/admin/clock`, { waitUntil: 'load' });
  await dana.page.waitForSelector('[data-ctl="CTL-OFC-17-01"]');
  await dana.page.fill('#bw-clock-date', date);
  await dana.page.fill('#bw-clock-time', time);
  await dana.page.locator('[data-ctl="CTL-OFC-17-03"] button.primary').click();
  await clockAtLeast(dana.g.context, iso);
}
async function preset(dana: Staff, id: string, iso: string): Promise<void> {
  await dana.page.goto(`${origin}/office/admin/clock`, { waitUntil: 'load' });
  const b = dana.page.locator(`button[data-preset="${id}"]`);
  await b.waitFor();
  await until(`the ${id} preset to be reachable`, async () => (await b.getAttribute('aria-disabled')) === null, (v) => v, 60_000);
  await b.click();
  await clockAtLeast(dana.g.context, iso);
}

/** The world must start at Tue, Sep 15, 7:00 AM: a fresh copy does; any other (a second engine, the hosted demo in use) is reset first through the clock page. */
async function freshWorld(browser: Browser): Promise<void> {
  await enterCode(browser);
  const dana = await office(browser, 'dana');
  try {
    const c0 = await clock(dana.g.context);
    if (c0.demoNow.startsWith('2026-09-15T07:0') && !c0.paused && !c0.replay.running) return;
    await dana.page.goto(`${origin}/office/admin/clock`, { waitUntil: 'load' });
    await dana.page.waitForSelector('[data-ctl="CTL-OFC-17-01"]');
    // The reset has a cool-down (FR-DEMO-6): wait it out rather than fail on it.
    await until('the reset cool-down to end', () => clock(dana.g.context), (c) => c.resetAvailableInSeconds === 0 && !c.replay.running, 600_000);
    await dana.page.locator('[data-ctl="CTL-OFC-17-06"]').click();
    await dana.page.locator('button[data-ctl="CTL-OFC-27-02"]').click();
  } finally {
    await closeAll(dana.g);
  }
  // The reset removes the sessions of the old world: sign in again to read the clock.
  const again = await office(browser, 'dana');
  try {
    await until('the world to be back at Tue, Sep 15, 7:00 AM and running', () => clock(again.g.context), (c) => c.demoNow.startsWith('2026-09-15T07:0') && !c.paused && !c.replay.running, 240_000);
  } finally {
    await closeAll(again.g);
  }
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe.each(engines)('the planted outside request on %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
    await enterCode(browser);
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: NFR-12, SC-07 the outside-origin guard is armed on this engine against this copy: a request to an outside origin is aborted and recorded (the run's own proof that a clean run means no outside request)
  it.skipIf(plant)('records and aborts a request to an outside origin', async () => {
    const g = await guardedContext(browser, [origin], { ...DESKTOP, ...entered() }, { assertOnClose: false });
    try {
      const page = await g.context.newPage();
      await page.goto(`${origin}/book?new=1`, { waitUntil: 'load' });
      // A page navigation: the page's own Content-Security-Policy refuses a script's fetch before it reaches the guard.
      await page.goto('https://planted.example.invalid/probe').catch(() => undefined);
      expect(g.outside).toEqual(['https://planted.example.invalid/probe']);
    } finally {
      await g.context.close();
    }
  });

  // why: NFR-12, SC-07 a planted request to an outside origin fails the run: the guard throws when the context closes (ci/e2e-stack.sh --plant expects this failure)
  it.runIf(plant)('plants 1 request to an outside origin and the run fails on the guard', async () => {
    const g = await guardedContext(browser, [origin], { ...DESKTOP, ...entered() });
    const page = await g.context.newPage();
    await page.goto(`${origin}/book?new=1`, { waitUntil: 'load' });
    await page.goto('https://planted.example.invalid/x').catch(() => undefined);
    await g.context.close(); // throws: outside-origin-guard: request(s) to another origin
  });
});

// F-1460: the planted run runs the planted request only, so its happy-path suites are skipped, not left empty (an empty suite fails in vitest 5).
describe.skipIf(plant).each(engines)('the 7-step happy path on %s', (engine, type) => {
  let browser: Browser;
  const customer = { name: `E2E Customer ${engine}`, mobile: `(614) 555-01${engine === 'chromium' ? '71' : '72'}` };
  const s = { phone: undefined as unknown as GuardedContext, maria: undefined as unknown as Page, job: 0, inbox: '', technician: '', phoneDir: '', liveToken: '', headlineBefore: 0 };
  const open: GuardedContext[] = [];
  let keisha: Staff;
  let dana: Staff;

  beforeAll(async () => {
    browser = await type.launch({ headless: true });
    await freshWorld(browser);
    keisha = await office(browser, 'keisha');
    dana = await office(browser, 'dana');
  }, 900_000);
  afterAll(async () => {
    await closeAll(keisha?.g, dana?.g, ...open);
    await browser?.close();
  });

  // why: NFR-12, SC-07 step 1 a customer with no account books a 2-hour window online through the 6 steps (the street from the bundled list), the confirmation text is in the on-screen inbox, and the dispatcher gives the visit to Maria
  it('1. books online, finds the confirmation in the inbox, and the dispatcher assigns Maria', async () => {
    // The customer books on Tue, Sep 15 at 10:00 AM (texts go out in the day, not in quiet hours).
    await typedJump(dana, '2026-09-15', '10:00', '2026-09-15T10:00:00-04:00');
    const g = await guardedContext(browser, [origin], { ...PHONE, ...entered() });
    open.push(g);
    const page = await g.context.newPage();
    await page.goto(`${origin}/book?new=1`, { waitUntil: 'load' });
    await page.waitForSelector(`${S1} button.tile`, { timeout: 60_000 });
    const next = page.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`);
    await page.locator(`${S1} button.tile`, { hasText: 'Furnace tune-up' }).click();
    await next.click();
    await page.locator('#bw-street').fill('Broad');
    await page.locator(`${S1} [role="option"]`).first().click();
    await page.locator('#bw-house').fill('418');
    await next.click();
    await page.locator(`${S1} button.d[aria-label*="${BOOK_DAY}"]`).click();
    await next.click();
    await page.locator(`${S1} button.win`).first().waitFor({ timeout: 30_000 });
    const wins = await page.locator(`${S1} button.win`).evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
    if (!wins.some((w) => w.includes(BOOK_WINDOW))) throw new Error(`windows offered: ${JSON.stringify(wins)}`);
    await page.locator(`${S1} button.win`, { hasText: BOOK_WINDOW }).click();
    await next.click();
    await page.locator('#bw-name').fill(customer.name);
    await page.locator('#bw-mobile').fill(customer.mobile);
    await next.click();
    await page.locator(`${S1} button[data-ctl="CTL-CUS-01-13"]`).click();
    await page.waitForURL(/\/book\/done\/[A-Za-z0-9_-]{22}$/, { timeout: 60_000 });
    await page.locator(`${S3} .visit`).waitFor({ state: 'visible' });
    const visit = await page.locator(`${S3} .visit`).innerText();
    s.job = Number(/Visit number (\d+)/.exec(visit)?.[1]);
    expect(s.job, `the visit number in "${visit}"`).toBeGreaterThan(0);
    expect(visit).toContain(BOOK_WINDOW);
    // The confirmation is in the on-screen inbox, opened from the page's own link, no outside service.
    s.inbox = (await page.locator(`${S3} a[data-ctl="CTL-CUS-03-03"]`).getAttribute('href'))!;
    await page.locator(`${S3} a[data-ctl="CTL-CUS-03-03"]`).click();
    await page.waitForSelector(`${INBOX} [data-ctl="CTL-INB-01-01"]`, { timeout: 60_000 });
    await expect.poll(() => page.locator(`${INBOX} .bub.in`).count(), { timeout: 90_000 }).toBeGreaterThanOrEqual(1);
    expect(await page.locator(`${INBOX} .bub.in`).first().innerText()).toContain('Brightwater');
    // The dispatcher gives the visit to Maria Santos (API-22).
    const techs = await api(keisha.g.context, 'GET', '/technicians?branch=columbus');
    s.technician = techs.data.technicians.find((t: Json) => t.name === 'Maria Santos').id;
    const job = await api(keisha.g.context, 'GET', `/jobs/${s.job}`);
    expect(job.status, job.text.slice(0, 300)).toBe(200);
    const assigned = await api(keisha.g.context, 'POST', `/jobs/${s.job}/assignment`, { technicianId: s.technician, baseVersion: job.data.job.version });
    expect(assigned.status, assigned.text.slice(0, 300)).toBe(200);
    await closeAll(g);
  });

  // why: NFR-12, SC-07 step 2 the manager moves the clock to 6:05 PM the evening before; the reminder reaches the inbox and the customer's reply C confirms the visit
  it('2. moves the clock to 6 PM the evening before; the reminder arrives and the customer replies C', async () => {
    await typedJump(dana, '2026-09-16', '18:05', '2026-09-16T18:05:00-04:00');
    const g = await guardedContext(browser, [origin], { ...PHONE, ...entered() });
    open.push(g);
    const page = await g.context.newPage();
    await page.goto(`${origin}${s.inbox}`, { waitUntil: 'load' });
    await page.waitForSelector(`${INBOX} [data-ctl="CTL-INB-01-01"]`, { timeout: 60_000 });
    await expect.poll(() => page.locator(`${INBOX} .bub.in`).count(), { timeout: 120_000 }).toBeGreaterThanOrEqual(2);
    await page.locator(`${INBOX} [data-ctl="CTL-INB-01-04"]`).click();
    await expect.poll(() => page.locator(`${INBOX} .bub.out`, { hasText: /^C$/ }).count(), { timeout: 30_000 }).toBeGreaterThan(0);
    await until('the visit to be confirmed', async () => (await api(keisha.g.context, 'GET', `/jobs/${s.job}`)).data.job.confirmed, (v) => v === true, 60_000);
    await closeAll(g);
  });

  // why: NFR-12, SC-07 steps 3 and 4 Maria signs in on the technician app and opens her day, taps On my way and confirms; the customer's on-the-way text carries the live map link, the map shows the van, and the link ends when Maria taps Arrived
  it('3-4. Maria taps On my way; the customer follows the van on the live map; Arrived ends the link', async () => {
    await preset(dana, 'tomorrow_8am', '2026-09-17T08:00:00-04:00');
    s.phoneDir = mkdtempSync(path.join(tmpdir(), 'bw-e2e-phone-'));
    dirs.push(s.phoneDir);
    const phone = await guardedPersistentContext(type as BrowserType, s.phoneDir, [origin], { ...PHONE, serviceWorkers: 'allow', ...entered() });
    open.push(phone);
    const maria = phone.context.pages()[0] ?? (await phone.context.newPage());
    s.phone = phone;
    s.maria = maria;
    await maria.goto(`${origin}/tech/sign-in`, { waitUntil: 'load' });
    await maria.fill('#ts-login', PEOPLE.maria.login);
    await maria.fill('#ts-password', await passwordOf('maria'));
    await maria.click('[data-ctl="CTL-TEC-01-04"]');
    await maria.waitForURL('**/tech', { timeout: 60_000 });
    await maria.waitForSelector('[data-screen="SCR-TEC-02"]');
    // Today lists the booked visit first: it is the next job.
    await expect.poll(() => maria.locator('.next[data-job]').getAttribute('data-job'), { timeout: 60_000 }).toBe(String(s.job));
    await maria.locator('[data-ctl="CTL-TEC-02-04"]').click();
    await maria.waitForSelector('[data-dialog="SCR-TEC-03"]');
    await maria.locator('[data-ctl="CTL-TEC-03-02"]').click();
    await maria.waitForSelector('[data-dialog="SCR-TEC-03"]', { state: 'detached' });
    // why: F-1469, F-1483 a refused first tap shows the Connect-once notice (TodayView's, by its text: the Sent announcement shares the class); read it on
    // every poll, since the refusal comes seconds after the sheet closes, and fail naming that cause, not a 90 s wait for a status that never comes
    const refusedFirstTap = maria.locator('.r1p-notice', { hasText: /Connect once with signal before the first status change/ });
    const first = await until('the job to be On the way, or the first tap refused with a notice', async () => ({
      status: (await api(keisha.g.context, 'GET', `/jobs/${s.job}`)).data.job.status as string,
      refused: await refusedFirstTap.count(),
    }), (v) => v.status === 'on_the_way' || v.refused > 0, 90_000);
    expect(first.refused, 'the first On my way was refused with a notice').toBe(0);

    // The customer reads the on-the-way text and follows the van.
    const cg = await guardedContext(browser, [origin], { ...PHONE, ...entered() });
    open.push(cg);
    const cust = await cg.context.newPage();
    await cust.goto(`${origin}${s.inbox}`, { waitUntil: 'load' });
    const link = cust.locator(`${INBOX} a[data-ctl="CTL-INB-01-03"]`).last();
    await link.waitFor({ timeout: 120_000 });
    const href = (await link.getAttribute('href'))!;
    expect(href).toMatch(/^\/m\/[0-9A-Za-z]{8}$/);
    s.liveToken = href.split('/').pop()!;
    expect(await cust.locator(`${INBOX} [data-ctl="CTL-INB-01-11"] .pt b`).innerText()).toBe('Maria is on the way');
    await link.click();
    await cust.waitForURL((u) => u.pathname === href, { timeout: 30_000 });
    await cust.locator(`${LIVE} .hero h1`).waitFor({ timeout: 60_000 });
    expect(await cust.locator(`${LIVE} .hero h1`).innerText()).toContain('Maria');
    // The map is drawn from the copy's own files: the guard sees no outside request (it fails the run on one).
    await cust.locator(`${LIVE} .r1-map[data-map-state="ready"]`).waitFor({ timeout: 120_000 });
    expect(Number(await cust.locator(`${LIVE} .r1-map`).getAttribute('data-map-markers'))).toBeGreaterThanOrEqual(2);

    // Arrived: the link stops.
    await maria.locator('[data-ctl="CTL-TEC-02-05"]').click();
    await maria.waitForSelector('[data-dialog="SCR-TEC-13"]');
    await maria.locator('[data-ctl="CTL-TEC-13-02"]').click();
    await until('the job to be On site', async () => (await api(keisha.g.context, 'GET', `/jobs/${s.job}`)).data.job.status, (v) => v === 'on_site', 90_000);
    await until('the live link to end', async () => (await cust.request.get(`${origin}/m/${s.liveToken}/data`)).status(), (v) => v === 410, 60_000);
    // Back on the cached live page: it reads again when shown and shows the ended page.
    await cust.goto(`${origin}/sign-in`, { waitUntil: 'load' });
    await cust.goBack({ waitUntil: 'load' });
    await until('the customer\'s page to show the ended page', () => cust.locator('.r1-screen').first().getAttribute('data-screen'), (v) => v === 'SCR-CUS-05', 90_000);
    expect(await cust.locator(`${ENDED} .r1-map`).count()).toBe(0);
    await closeAll(cg);
  });

  // why: NFR-12, SC-07 step 5 with no signal Maria adds a note and a photo on the technician app; they wait on the phone, and when signal returns they send and the office sees both
  it('5. adds a note and a photo with no signal; both send when signal returns', async () => {
    const note = `Basement furnace: flame sensor cleaned (${engine})`;
    // The same phone, still signed in (a session without Stay signed in lives as long as the app is open).
    const { phone, maria } = s;
    await maria.goto(`${origin}/tech/jobs/${s.job}`, { waitUntil: 'load' });
    await maria.waitForSelector('[data-ctl="CTL-TEC-04-02"] h1', { timeout: 60_000 });
    // The phone keeps the day's pages while there is signal (the service worker); the basement has none.
    await maria.waitForFunction(async () => Boolean(await (globalThis as unknown as { navigator: { serviceWorker: { ready: Promise<unknown> } } }).navigator.serviceWorker.ready), undefined, { timeout: 30_000 });
    const pages = [`/tech/jobs/${s.job}/note`, `/tech/jobs/${s.job}/photo`, `/tech/jobs/${s.job}/finish`, '/tech'];
    await until('the phone to hold the day\'s pages', () => maria.evaluate(async (list) => {
      const w = globalThis as unknown as { caches: { match(u: string): Promise<unknown> }; location: { origin: string } };
      const held: string[] = [];
      for (const p of list) if (await w.caches.match(`${w.location.origin}${p}`)) held.push(p);
      return held.length;
    }, pages), (n) => n === pages.length, 90_000);
    // F-1735: what the phone did from here, kept and printed only if the items do not send (the nightly WebKit red left no trace of it).
    const trail = phoneTrail(phone.context, maria, origin);
    await maria.reload({ waitUntil: 'load' });
    await maria.waitForSelector('[data-ctl="CTL-TEC-04-02"] h1', { timeout: 60_000 });
    trail.note('signal off');
    await phone.context.setOffline(true);
    await maria.locator('[data-ctl="CTL-TEC-04-09"]').click();
    await maria.waitForSelector('[data-ctl="CTL-TEC-05-01"]', { timeout: 30_000 });
    await maria.locator('[data-ctl="CTL-TEC-05-01"]').fill(note);
    await maria.locator('[data-ctl="CTL-TEC-05-02"]').click();
    await maria.waitForSelector(`.note[data-kind="technician"]:has-text("${note}") .r1p-wait`, { timeout: 30_000 });
    await maria.locator('[data-ctl="CTL-TEC-04-12"]').click();
    await maria.waitForSelector('[data-ctl="CTL-TEC-06-01"]', { timeout: 30_000 });
    await maria.locator('input[type="file"]').setInputFiles({ name: 'basement.png', mimeType: 'image/png', buffer: noisePng(64, 48) });
    await maria.waitForSelector('[data-ctl="CTL-TEC-06-02"] img', { timeout: 60_000 });
    await maria.locator('button[data-ctl="CTL-TEC-06-03"]').click();
    await maria.waitForSelector('[data-ctl="CTL-TEC-04-02"] h1', { timeout: 30_000 });
    // Nothing reached the office while the phone had no signal.
    const during = await api(keisha.g.context, 'GET', `/jobs/${s.job}`);
    expect(JSON.stringify(during.data)).not.toContain(note);
    // Signal returns: the waiting items send by themselves.
    trail.note('signal on');
    await phone.context.setOffline(false);
    await trail.around(() => until('both items to send', async () => {
      const seen = JSON.stringify((await api(keisha.g.context, 'GET', `/jobs/${s.job}`)).data);
      return seen.includes(note);
    }, (v) => v, 120_000));
    await until('the photo to reach the job', async () => ((await api(keisha.g.context, 'GET', `/jobs/${s.job}`)).data.photos ?? []).length, (n) => n >= 1, 120_000);
    await expect.poll(() => maria.locator('.r1p-wait').count(), { timeout: 60_000 }).toBe(0);
    s.headlineBefore = ((await api(dana.g.context, 'GET', `/reports${LIVE_WEEK_QUERY}`)).data.headline.noOneHome.visits as number) ?? 0;
  });

  // why: NFR-12, SC-07 step 6 Maria finishes the job with its parts and the pretend billing system gets 1 invoice for it, with the work done and its part
  it('6. finishes with parts; the pretend billing system holds 1 invoice', async () => {
    // The same phone, still signed in (a session without Stay signed in lives as long as the app is open).
    const { maria } = s;
    await maria.goto(`${origin}/tech/jobs/${s.job}/finish`, { waitUntil: 'load' });
    await maria.waitForSelector('[data-ctl="CTL-TEC-07-06"]', { timeout: 60_000 });
    const find = maria.locator('[data-ctl="CTL-TEC-07-02"] input');
    await find.fill(PART);
    await maria.locator(`#bw-part-res [role="option"][data-part="${PART}"]`).click();
    await maria.locator(`[data-ctl="CTL-TEC-07-01"] .pt[data-part="${PART}"]`).waitFor();
    await maria.locator('[data-ctl="CTL-TEC-07-11"] input').first().fill(WORK_DONE[0]!);
    await maria.locator('[data-ctl="CTL-TEC-07-12"]').click();
    await maria.locator('[data-ctl="CTL-TEC-07-11"] input').nth(1).fill(WORK_DONE[1]!);
    await maria.locator('[data-ctl="CTL-TEC-07-07"] input').first().fill('1');
    await maria.locator('[data-ctl="CTL-TEC-07-07"] input').nth(1).fill('5');
    await sleep(400); // the last change's write
    await maria.locator('[data-ctl="CTL-TEC-07-06"]').click();
    await maria.locator('.cstep').waitFor();
    await maria.locator('[data-ctl="CTL-TEC-07-08"]').click();
    await maria.waitForURL(`**/tech/jobs/${s.job}?finished=1`, { timeout: 60_000 });
    await until('the job to be done', async () => (await api(keisha.g.context, 'GET', `/jobs/${s.job}`)).data.job.status, (v) => v === 'done', 90_000);
    // The pretend billing system holds 1 invoice for the job (the worker sends it to the billing service).
    const invoices = await until('the invoice at the pretend billing system', async () => (await api(keisha.g.context, 'GET', '/pretend-billing/invoices')).data.invoices as Json[], (v) => v.some((i) => i.jobNumber === s.job), 120_000);
    expect(invoices.filter((i) => i.jobNumber === s.job)).toHaveLength(1);
    const view = await guardedContext(browser, [origin], { ...DESKTOP, ...entered() });
    open.push(view);
    await view.context.addCookies(await keisha.g.context.cookies());
    const p = await view.context.newPage();
    await p.goto(`${origin}/billing-system/invoices/${s.job}`, { waitUntil: 'load' });
    await p.waitForSelector('table.lines');
    expect(await p.locator('.pbtag').innerText()).toBe('Pretend billing system: not a real product');
    expect(await p.locator('table.lines').innerText()).toContain('Furnace filter');
    await closeAll(view);
  });

  // why: NFR-12, SC-07 step 7 the manager sees the live visit counted in the reports, which carry the Simulated pilot data label, and exports them to a spreadsheet file
  it('7. the manager sees the job in the reports, labeled simulated, and exports them', async () => {
    const after = (await api(dana.g.context, 'GET', `/reports${LIVE_WEEK_QUERY}`)).data.headline.noOneHome.visits as number;
    expect(after, 'the finished live visit is in the visits the reports count').toBe(s.headlineBefore + 1);
    await dana.page.goto(`${origin}/office/reports`, { waitUntil: 'load' });
    await dana.page.waitForSelector(`${REPORTS} .kpis`, { timeout: 60_000 });
    // why: F-1461 the property is what the manager sees: the page's own visits count (CTL-OFC-11-17, "<n> of <visits> visits"), as the page formats it
    // F-1596: the report's default range ends at the last whole week (F-1157), so the manager picks the demo week in the To select, where the live visit is
    await dana.page.locator(`${REPORTS} .rh select[aria-label="To"]`).selectOption(LIVE_WEEK);
    await dana.page.waitForFunction((w) => (globalThis as unknown as { location: { search: string } }).location.search.includes(`to=${w}`), LIVE_WEEK);
    await dana.page.waitForFunction((t) => (globalThis as unknown as { document: { querySelector(q: string): { textContent: string | null } | null } }).document.querySelector('[data-ctl="CTL-OFC-11-17"]')?.textContent?.includes(t), ` of ${new Intl.NumberFormat('en').format(after)} visits`);
    const seen = await dana.page.locator('[data-ctl="CTL-OFC-11-17"]').innerText();
    expect(seen, 'the reports page counts the finished live visit').toContain(` of ${new Intl.NumberFormat('en').format(after)} visits`);
    expect(await dana.page.locator(`${REPORTS} .rh .sim .chip`).allInnerTexts()).toEqual(['Simulated pilot data']);
    const [download] = await Promise.all([dana.page.waitForEvent('download', { timeout: 60_000 }), dana.page.locator('[data-ctl="CTL-OFC-11-04"]').click()]);
    const file = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of file) chunks.push(c as Buffer);
    const lines = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '').split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('Data source,Branch,Technician,Week,Booked window,Actual arrival');
    expect(lines.length).toBeGreaterThan(100);
    expect(lines.slice(1).every((l) => l.startsWith('Simulated pilot data,'))).toBe(true);
    // The whole run never asked an outside origin for anything: each context's guard throws when it closes with 1 recorded.
  });
});
