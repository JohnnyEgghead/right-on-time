// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1896 (P9-UG-WEB Acceptance: the user-guide web findings on Chromium and WebKit against the Compose stack)
// The user guide's web findings, read in the release image on the Compose stack (ci/job-stack.sh brings it up: real PostgreSQL 18, real
// handlers, the seeded world), every page opened through the outside-origin guard, with ci/job-stack/fixture.sql's sessions. Run after the
// job, new job and customer-actions suites on the same stack. The class behind most of them (F-1896): a page sheet's rules leaked into
// the next screen after a client move and were missing on a screen that drew another screen's markup. The web build now scopes every
// page-*.css to its screens (apps/web/src/shell/css/page-scope.ts), and each screen loads the sheets its markup needs.
//   F-1884: the Reassign dialog, its move preview, its no-others note and the conflict dialog on the job page are styled as the board
//   styles them, on a fresh load and after a client move from the board; the picked row is marked.
//   F-1887: after the client move from /book to You're booked, the day and window line is plain text inside its block.
//   F-1885: at phone width with a moved clock, the strip's second line never sits under the header (7 screens); the header clock fits.
//   F-1886: on /book from 1201 px the 6 service cards are inside the step panel; at 1200 px the 3-column layout holds.
//   F-1888: a stored E.164 mobile and a typed home phone both read "(614) 555-0100" on the call list and on the call button, which dials.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Temporal, toWire } from '../../packages/time/src/index.ts';
import { guardedContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_JOB_STACK_URL;
const db = process.env.BW_JOB_DB_CONTAINER;
const techSeed = process.env.BW_JOB_TECHSEED;
const people = { keisha: process.env.BW_JOB_KEISHA, dana: process.env.BW_JOB_DANA };
if (!base || !db || !techSeed || Object.values(people).some((v) => !v)) {
  throw new Error('BW_JOB_STACK_URL, _DB_CONTAINER, _TECHSEED and the session tokens are not set: run ci/job-stack.sh');
}
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the suite's proxy listens on a free port, so writes carry the default origin.
const APP_ORIGIN = 'http://localhost:8080';
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 1100 } };
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const JOB = '.r1-screen[data-screen="SCR-OFC-03"]';
const REASSIGN = '[data-screen="SCR-OFC-18"]';
const CONFLICT = '[data-screen="SCR-OFC-19"]';
const S1 = '.r1-screen[data-screen="SCR-CUS-01"]';
const S3 = '.r1-screen[data-screen="SCR-CUS-03"]';
const CATALOG = JSON.parse(readFileSync('packages/i18n/catalog/en.json', 'utf8')) as Record<string, string>;
const msg = (key: string, values: Record<string, string | number> = {}) => (CATALOG[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
// The page functions below run in the browser. The root program has no DOM lib (the ci/ convention), so the few browser globals
// they read are typed here, in this module only.
interface Rect { top: number; bottom: number; left: number; right: number; width: number; height: number }
interface HTMLElement {
  tagName: string; classList: Iterable<string>; nextElementSibling: unknown; parentElement: unknown;
  getBoundingClientRect(): Rect; closest(s: string): unknown; querySelector(s: string): unknown;
}
declare const window: Json;
declare const document: { querySelector(s: string): unknown };
declare function getComputedStyle(el: unknown): { [k: string]: string } & { gridTemplateColumns: string; getPropertyValue(k: string): string };

function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { cookie: `bw_session=${token}`, ...(method === 'GET' ? {} : { origin: APP_ORIGIN, 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const api = (who: keyof typeof people, method: string, path: string, body?: unknown) => call(people[who]!, method, path, body);
const ms = (wire: string) => Date.parse(wire.replace(/\[.*\]$/, ''));
/** A technician's session token as ci/job-stack/fixture.sql made it: base64url of sha256(techseed + user id). */
const techToken = (userId: string) => createHash('sha256').update(`${techSeed}${userId}`).digest('base64url');
/** The US display form, written here from the digits (not the product's formatter): "(614) 555-0100". */
const shown = (stored: string) => stored.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1').replace(/^(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');

/** The page's API writes carry the default origin: Playwright resends them itself (a browser will not let a route set Origin). */
async function writeOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    try {
      await r.fulfill({ response: await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } }) });
    } catch {
      // the page or its context closed while the write was in flight: nothing to hand back
    }
  });
}

interface Open { page: Page; g: GuardedContext }
async function open(browser: Browser, path: string, ready: string, o: { token?: string | undefined; size?: BrowserContextOptions; first?: (p: Page) => Promise<unknown> } = {}): Promise<Open> {
  const g = await guardedContext(browser, [origin], { ...(o.size ?? DESKTOP), timezoneId: 'America/New_York' });
  if (o.token) await g.context.addCookies([{ name: 'bw_session', value: o.token, url: origin, httpOnly: true }, { name: 'bw_lang', value: 'en', url: origin }]);
  const page = await g.context.newPage();
  await writeOrigin(page);
  await o.first?.(page);
  const res = await page.goto(origin + path, { waitUntil: 'load' });
  expect(res?.status(), path).toBe(200);
  await page.waitForSelector(ready, { timeout: 60_000 });
  return { page, g };
}
const close = (o: Open) => o.g.context.close();

/** A client move (the app router's push), proved to be one: a mark set on the window before it is still there after it. */
async function clientMove(p: Page, path: string, ready: string): Promise<void> {
  await p.evaluate(() => { (window as Json).__bwNoReload = true; });
  await p.evaluate((u) => (window as Json).next.router.push(u), path);
  await p.waitForSelector(ready, { timeout: 60_000 });
  expect(await p.evaluate(() => (window as Json).__bwNoReload === true), 'the move was a client move, not a page load').toBe(true);
}

const PROPS = ['display', 'gap', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-bottom', 'border-top-width', 'border-top-style',
  'border-top-color', 'border-top-left-radius', 'background-color', 'color', 'font-size', 'font-weight', 'min-height'];
/** The computed values of the first element each selector finds under root; a selector with no element is named in `missing`. */
async function styles(p: Page, root: string, sels: string[]): Promise<{ values: Record<string, Record<string, string>>; missing: string[] }> {
  return p.evaluate(({ root, sels, props }) => {
    const values: Record<string, Record<string, string>> = {};
    const missing: string[] = [];
    for (const s of sels) {
      const el = document.querySelector(`${root} ${s}`);
      if (!el) { missing.push(s); continue; }
      const cs = getComputedStyle(el);
      values[s] = Object.fromEntries(props.map((k) => [k, cs.getPropertyValue(k)]));
    }
    return { values, missing };
  }, { root, sels, props: PROPS });
}

/**
 * The reassign dialog as a dispatcher meets it, then the conflict dialog. Reassign opened (from the board's popover or the job page's
 * header) with the day's suggestions answered with only the current technician (API-30), so the no-others note shows; closed and opened
 * again with the real list, another technician picked (the move preview, API-131); another person's edit; then Reassign sent with the
 * version the dialog read, so the server's real version_conflict opens SCR-OFC-19. The dialogs' own elements are read at each step.
 */
async function readDialogs(p: Page, n: number, techId: string, openDialog: () => Promise<void>): Promise<Record<string, Record<string, string>>> {
  let onlyCurrent = true;
  await p.route((u) => u.pathname === '/api/v1/technicians/room', async (r) => {
    const response = await r.fetch();
    const answer = (await response.json()) as Json;
    if (onlyCurrent) answer.data.technicians = answer.data.technicians.filter((x: Json) => x.id === techId);
    await r.fulfill({ response, json: answer });
  });
  const before = (await api('keisha', 'GET', `/jobs/${n}`)).body.data.job as Json;
  await p.route((u) => u.pathname === `/api/v1/jobs/${n}/assignment`, async (r) => {
    const body = { ...(r.request().postDataJSON() as Json), baseVersion: before.version };
    try {
      await r.fulfill({ response: await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN }, postData: JSON.stringify(body) }) });
    } catch {
      // the context closed while the write was in flight
    }
  });
  await openDialog();
  await p.locator(`${REASSIGN} .bw-noothers`).waitFor({ timeout: 30_000 });
  const note = await styles(p, REASSIGN, ['.bw-noothers']);
  await p.locator(`${REASSIGN} [data-ctl="CTL-OFC-18-03"]`).first().click();
  await p.locator(REASSIGN).waitFor({ state: 'detached', timeout: 30_000 });
  onlyCurrent = false;
  await openDialog();
  const other = p.locator(`${REASSIGN} .rl2`).filter({ hasNot: p.locator('.now') }).filter({ hasNotText: msg('board.reassign.none') }).first();
  await other.waitFor({ timeout: 30_000 });
  await other.click();
  await p.locator(`${REASSIGN} .pvw`).waitFor({ timeout: 30_000 });
  // The picked row carries its mark (F-1884): 1 row on, the one picked.
  expect(await p.locator(`${REASSIGN} .rl2.on`).count()).toBe(1);
  expect(await other.getAttribute('aria-checked')).toBe('true');
  expect(await other.getAttribute('class')).toMatch(/\bon\b/);
  const dialog = await styles(p, REASSIGN, ['.rl2:not(.on)', '.rl2.on', '.rl2.on i.rd', '.rl2 small', '.pvw']);
  const edit = await api('dana', 'PATCH', `/jobs/${n}`, { serviceId: before.serviceId, equipmentId: before.equipmentId, problem: before.problem, baseVersion: before.version });
  expect(edit.status, JSON.stringify(edit.body)).toBe(200);
  await p.locator('[data-ctl="CTL-OFC-18-02"]:not(.dis)').click();
  await p.locator(`${CONFLICT} .r1-fmsg.bw-conflict`).waitFor({ timeout: 30_000 });
  const conflict = await styles(p, CONFLICT, ['.r1-fmsg.bw-conflict']);
  expect([...note.missing, ...dialog.missing, ...conflict.missing]).toEqual([]);
  // Nothing was moved: the write was refused.
  expect((await api('keisha', 'GET', `/jobs/${n}`)).body.data.job.technician?.id ?? null).toBe(before.technician?.id ?? null);
  return { ...note.values, ...dialog.values, ...conflict.values };
}

let lastMoveSet = false;
/** The strip's second line needs a last move: jump the clock 1 minute forward (API-12, the manager) when the world has none yet. */
async function ensureMoved(): Promise<void> {
  if (lastMoveSet) return;
  const deadline = performance.now() + 150_000;
  for (;;) {
    const now = (await api('dana', 'GET', '/clock')).body.data as Json;
    if (now.lastMove) break;
    const to = toWire(Temporal.Instant.fromEpochMilliseconds(ms(now.demoNow) + 60_000), 'America/New_York');
    const r = await api('dana', 'POST', '/clock/jumps', { to });
    if (r.status === 202) break;
    expect(r.body?.code, JSON.stringify(r.body)).toBe('replay_running');
    if (performance.now() > deadline) throw new Error('the clock stayed in a replay for 150 s before the jump');
    await new Promise((res) => setTimeout(res, 500));
  }
  for (;;) {
    const reply = (await api('dana', 'GET', '/clock')).body;
    if (reply.data.lastMove && !reply.data.replay?.running) break;
    if (performance.now() > deadline) throw new Error('the clock replay did not finish in 150 s');
    await new Promise((r) => setTimeout(r, 250));
  }
  lastMoveSet = true;
}

/** Where the phone strip's second line sits against the strip and the element after it (the screen's header). */
async function stripFit(p: Page): Promise<{ moved: number; strip: number; next: number | null; nextName: string }> {
  return p.evaluate(() => {
    const strip = document.querySelector('.r1-demobar.ph') as HTMLElement;
    const moved = strip.querySelector('.moved') as HTMLElement;
    let next = strip.nextElementSibling as HTMLElement | null;
    while (next && next.getBoundingClientRect().height === 0) next = next.nextElementSibling as HTMLElement | null;
    return {
      moved: moved.getBoundingClientRect().bottom, strip: strip.getBoundingClientRect().bottom,
      next: next ? next.getBoundingClientRect().top : null, nextName: next ? `${next.tagName.toLowerCase()}.${[...next.classList].join('.')}` : '',
    };
  });
}

describe.each(engines)('the user-guide web findings on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  let today = '';
  const made: number[] = [];
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
    today = ((await api('dana', 'GET', '/clock')).body.data.demoNow as string).slice(0, 10);
  });
  afterAll(async () => {
    await browser?.close();
    for (const n of made.splice(0)) {
      const version = psql(`SELECT version FROM world.job WHERE job_number = ${n}`);
      await api('keisha', 'POST', `/jobs/${n}/cancellation`, { baseVersion: Number(version) });
    }
  });

  // why: F-1884 the board's reassign and conflict dialogs drawn by the job page are styled as on the board, on a fresh load and after a client move from the board, with the picked row marked (F-1896 class: each screen loads the sheets its markup needs)
  it('styles the Reassign dialog, its preview, its no-others note and the conflict dialog on the job page as the board does', async () => {
    // 2 scheduled jobs with a technician. WebKit takes others than Chromium's when the world has them; after the suites before this one on
    // the shared stack it may have only a few, and sharing is safe: readDialogs reads each job's version fresh and moves nothing.
    const candidates = psql(`SELECT job_number || '|' || technician_id FROM world.job WHERE branch_id = 'columbus' AND date = '${today}' AND status = 'scheduled'
      AND technician_id IS NOT NULL ORDER BY job_number DESC`).split('\n').filter(Boolean);
    expect(candidates.length, 'at least 2 scheduled jobs with a technician today').toBeGreaterThanOrEqual(2);
    const offset = engine === 'chromium' || candidates.length < 5 ? 0 : 3;
    const pick = (k: number) => candidates[offset + k]!.split('|');
    const fromBoard = async (p: Page, n: number) => {
      await p.locator(`button[data-job="${n}"]`).first().click();
      await p.locator('[data-ctl="CTL-OFC-29-03"]').click();
    };
    const fromJob = async (p: Page) => p.locator(`${JOB} .jh [data-ctl="CTL-OFC-03-04"]`).click();
    const BOARD = '/office/board?branch=columbus&date=today';
    const BOARD_READY = '[data-screen="SCR-OFC-02"] .tl-row button.job';

    const [n1, t1] = pick(0) as [string, string];
    const b = await open(browser, BOARD, BOARD_READY, { token: people.keisha });
    let onBoard: Record<string, Record<string, string>>;
    try {
      onBoard = await readDialogs(b.page, Number(n1), t1, () => fromBoard(b.page, Number(n1)));
    } finally {
      await close(b);
    }
    // The values a reader sees: the frame's marked row and preview (page-office-board.css), so the board itself is not unstyled.
    expect(onBoard['.rl2.on']!['border-top-style']).toBe('solid');
    expect(onBoard['.rl2.on']!['border-top-color']).not.toBe(onBoard['.rl2:not(.on)']!['border-top-color']);
    expect(onBoard['.rl2.on']!['background-color']).not.toBe(onBoard['.rl2:not(.on)']!['background-color']);
    expect(onBoard['.pvw']!['border-top-left-radius']).toBe('8px');
    expect(onBoard['.bw-noothers']!['margin-bottom']).toBe('10px');
    expect(onBoard['.r1-fmsg.bw-conflict']!['font-size']).toBe('14px');

    const [n2, t2] = pick(1) as [string, string];
    const fresh = await open(browser, `/office/jobs/${n2}`, `${JOB} .jh h1`, { token: people.keisha });
    try {
      expect(await readDialogs(fresh.page, Number(n2), t2, () => fromJob(fresh.page)), 'a fresh load of the job page').toEqual(onBoard);
    } finally {
      await close(fresh);
    }

    const [n3, t3] = pick(2) as [string, string];
    const moved = await open(browser, BOARD, BOARD_READY, { token: people.keisha });
    try {
      await clientMove(moved.page, `/office/jobs/${n3}`, `${JOB} .jh h1`);
      expect(await readDialogs(moved.page, Number(n3), t3, () => fromJob(moved.page)), 'the job page after a client move from the board').toEqual(onBoard);
    } finally {
      await close(moved);
    }

    // A reassign row is a finger's size on a narrow screen, on the job page too (the board's 44 px rule, now the dialog's own sheet).
    const narrow = await open(browser, `/office/jobs/${n2}`, `${JOB} .jh h1`, { token: people.keisha, size: { viewport: { width: 700, height: 900 } } });
    try {
      await fromJob(narrow.page);
      await narrow.page.locator(`${REASSIGN} .rl2`).first().waitFor({ timeout: 30_000 });
      expect(await narrow.page.locator(`${REASSIGN} .rl2`).first().evaluate((e) => getComputedStyle(e).minHeight)).toBe('44px');
    } finally {
      await close(narrow);
    }
  });

  // why: F-1887 after the client move from /book to You're booked the day and window line is plain text inside its block: the booking page's .win (a window button) no longer follows the visitor (F-1896 class)
  it("shows You're booked's day and window as plain text inside its block after the client move from /book", async () => {
    const o = await open(browser, '/book?new=1', `${S1} button.tile`);
    try {
      const p = o.page;
      await p.evaluate(() => { (window as Json).__bwNoReload = true; });
      const next = () => p.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
      await p.locator(`${S1} button.tile`, { hasText: 'Furnace tune-up' }).click();
      await next();
      const street = psql(`SELECT name || '|' || zip FROM world.street WHERE branch_id = 'columbus' AND length(name) >= 6 ORDER BY name LIMIT 1`).split('|') as [string, string];
      await p.locator('#bw-street').fill(street[0]);
      await p.locator(`${S1} [role="option"]`, { hasText: street[1] }).first().click();
      await p.locator('#bw-house').fill('418');
      await next();
      await p.locator(`${S1} button.d:not(.closed):not(.today):not([disabled]):not([aria-disabled="true"])`).first().click();
      await next();
      await p.locator(`${S1} button.win:not(.full):not([disabled]):not([aria-disabled="true"])`).first().click();
      await next();
      await p.locator('#bw-name').fill(`Guide ${engine} Booked`);
      await p.locator('#bw-mobile').fill(`(614) 555-01${engine === 'chromium' ? '81' : '82'}`);
      await p.locator(`${S1} button[data-ctl="CTL-CUS-01-15"]`).click();
      await next();
      await p.locator(`${S1} button[data-ctl="CTL-CUS-01-13"]`).click();
      await p.waitForURL(/\/book\/done\/[A-Za-z0-9_-]{22}$/, { timeout: 60_000 });
      const token = decodeURIComponent(new URL(p.url()).pathname.split('/').pop() as string);
      made.push(Number(psql(`SELECT job_number FROM world.job WHERE booking_token = '${token.replace(/'/g, "''")}'`)));
      await p.locator(`${S3} .visit .win`).waitFor({ timeout: 30_000 });
      expect(await p.evaluate(() => (window as Json).__bwNoReload === true), 'You\'re booked came by a client move').toBe(true);
      const fit = await p.locator(`${S3} .visit .win`).evaluate((el) => {
        const cs = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        const parent = (el.parentElement as HTMLElement).getBoundingClientRect();
        return {
          border: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
          inside: box.left >= parent.left - 0.5 && box.right <= parent.right + 0.5 && box.top >= parent.top - 0.5 && box.bottom <= parent.bottom + 0.5,
          fits: el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1,
        };
      });
      expect(fit).toEqual({ border: ['0px', '0px', '0px', '0px'], inside: true, fits: true });
    } finally {
      await close(o);
    }
  });

  // why: F-1885 at phone width with a moved clock the demo strip's second line never sits under the header, on the 5 technician screens, the inbox and the live map; the header clock of Today and the technician's job page fits
  it("keeps the phone strip's moved line above the header on 7 screens, and the header clock unclipped", async () => {
    await ensureMoved();
    const maria = psql(`SELECT user_id FROM world.technician WHERE name = 'Maria Santos'`);
    const job = psql(`SELECT job_number FROM world.job WHERE technician_id = (SELECT id FROM world.technician WHERE name = 'Maria Santos') AND date = '${today}'
      ORDER BY window_start LIMIT 1`);
    const inbox = psql(`SELECT inbox_token FROM world.customer WHERE branch_id = 'columbus' AND texts_on AND inbox_token IS NOT NULL ORDER BY id LIMIT 1`);
    // A link that is live by the server's rule (liveMapLinkState, live-map.ts): not ended, its job on the way with a technician and a
    // departure stamp at or before demo now. The suites before this one on the shared stack end links (arrivals, office changes) and jump
    // the clock (a jump back puts a departure in the future), so the newest link may answer 410.
    const liveLink = async (): Promise<string> => {
      const demoNow = (await api('dana', 'GET', '/clock')).body.data.demoNow as string;
      return psql(`SELECT l.token FROM world.link_token l JOIN world.job j ON j.job_number = l.job_number
        WHERE l.kind = 'live_map' AND l.ended_at IS NULL AND j.status = 'on_the_way' AND j.technician_id IS NOT NULL
        AND j.on_the_way_at IS NOT NULL AND j.on_the_way_at <= to_timestamp(${ms(demoNow)} / 1000.0) ORDER BY l.created_at DESC LIMIT 1`);
    };
    let live = await liveLink();
    if (!live) {
      // No live link yet: Maria's On my way on her next scheduled job today makes one (API-102, the phone's call).
      const next = psql(`SELECT job_number FROM world.job WHERE technician_id = (SELECT id FROM world.technician WHERE name = 'Maria Santos') AND date = '${today}'
        AND status = 'scheduled' ORDER BY window_start LIMIT 1`);
      expect(next, 'a scheduled job of Maria today, to send On my way for').toBeTruthy();
      const clock = (await api('dana', 'GET', '/clock')).body.data as Json;
      const version = (await api('keisha', 'GET', `/jobs/${next}`)).body.data.job.version as number;
      const real = toWire(Temporal.Now.instant(), 'America/New_York');
      const item = { key: crypto.randomUUID(), kind: 'on_my_way', jobNumber: Number(next), baseVersion: version, worldEpoch: clock.worldEpoch, deviceTime: real, offsetSavedReal: real, sinceSaveMs: 0, demoTime: clock.demoNow };
      const r = await call(techToken(maria), 'POST', '/tech/items', { items: [item] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.data.items[0], JSON.stringify(r.body)).toMatchObject({ result: 'applied' });
      live = await liveLink();
    }
    expect([job, inbox, live].every(Boolean), 'a job of Maria today, an inbox and a live map link').toBe(true);
    const tech = techToken(maria);
    const screens: [string, string, string | undefined][] = [
      ['/tech/me', 'SCR-TEC-10', tech], ['/tech/parts', 'SCR-TEC-16', tech], ['/tech/map', 'SCR-TEC-15', tech],
      [`/tech/jobs/${job}/directions`, 'SCR-TEC-08', tech], ['/tech/install', 'SCR-TEC-11', tech], [`/inbox/${inbox}`, '', undefined], [`/m/${live}`, '', undefined],
    ];
    const bad: string[] = [];
    for (const [path, screen, token] of screens) {
      const ready = `${screen ? `.r1-screen[data-screen="${screen}"] ` : ''}.r1-demobar.ph .moved`;
      const o = await open(browser, path, ready, { token, size: PHONE });
      try {
        const f = await stripFit(o.page);
        if (f.moved > f.strip + 0.5 || (f.next !== null && f.moved > f.next + 0.5)) bad.push(`${path}: the moved line ends at ${f.moved}, the strip at ${f.strip}, ${f.nextName} starts at ${f.next}`);
      } finally {
        await close(o);
      }
    }
    expect(bad).toEqual([]);
    // The header variant (Today, the technician's job page) draws no moved line; its clock fits its box.
    for (const [path, screen] of [['/tech', 'SCR-TEC-02'], [`/tech/jobs/${job}`, 'SCR-TEC-04']] as const) {
      const o = await open(browser, path, `.r1-screen[data-screen="${screen}"] .r1p-clk [data-demo-time]`, { token: tech, size: PHONE });
      try {
        const clip = await o.page.locator('.r1p-clk').first().evaluate((el) => ({ w: el.scrollWidth - el.clientWidth, h: el.scrollHeight - el.clientHeight }));
        expect(clip.w, `${path} clock width overflow`).toBeLessThanOrEqual(1);
        expect(clip.h, `${path} clock height overflow`).toBeLessThanOrEqual(1);
      } finally {
        await close(o);
      }
    }
  });

  // why: F-1886 on /book from 1201 px every service card stays inside the step panel, and at 1200 px the 3-column layout holds
  it('keeps the 6 service cards inside the step panel at 1201 to 1440 px, and 3 columns at 1200 px', async () => {
    const o = await open(browser, '/book?new=1', `${S1} button.tile`);
    try {
      const p = o.page;
      const read = () => p.locator(`${S1} .svc`).evaluate((svc) => {
        const panel = (svc.closest('.box') as HTMLElement).getBoundingClientRect();
        const tiles = [...svc.querySelectorAll('button.tile')].map((t) => t.getBoundingClientRect());
        return {
          tiles: tiles.length,
          outside: tiles.filter((t) => t.left < panel.left - 0.5 || t.right > panel.right + 0.5).length,
          columns: getComputedStyle(svc).gridTemplateColumns.split(' ').length,
          rows: new Set(tiles.map((t) => Math.round(t.top))).size,
        };
      });
      for (const width of [1201, 1240, 1320, 1440]) {
        await p.setViewportSize({ width, height: 1000 });
        await expect.poll(read, { timeout: 5_000 }).toMatchObject({ tiles: 6, outside: 0, columns: 6, rows: 1 });
      }
      await p.setViewportSize({ width: 1200, height: 1000 });
      await expect.poll(read, { timeout: 5_000 }).toMatchObject({ tiles: 6, outside: 0, columns: 3, rows: 2 });
    } finally {
      await close(o);
    }
  });

  // why: F-1888 every stored phone number is shown in 1 form: an E.164 mobile and a typed home phone read "(614) 555-0100" on the call list and on the call button (text and label), and the tel: link dials the digits
  it('shows an E.164 mobile and a typed home phone as (614) 555-0100 on the call list and the call button, with a dialable tel: link', async () => {
    const list = (await api('keisha', 'GET', `/call-list?branch=columbus&date=${today}`)).body.data as Json;
    const rows = [...list.reminderCalls, ...list.failedTexts] as Json[];
    const e164 = rows.find((r) => /^\+1\d{10}$/.test(r.phone ?? ''));
    const typed = rows.find((r) => /^\(\d{3}\) \d{3}-\d{4}$/.test(r.phone ?? ''));
    expect(e164, 'a call list row with a stored E.164 mobile').toBeDefined();
    expect(typed, 'a call list row with a typed home phone').toBeDefined();
    const page = await open(browser, '/office/messages/call-list', `text=${e164.customer}`, { token: people.keisha });
    try {
      for (const r of [e164, typed]) {
        const cell = page.page.locator('tr', { hasText: r.customer }).first().locator('.bw-ph');
        expect(await cell.innerText(), r.customer).toBe(shown(r.phone));
      }
    } finally {
      await close(page);
    }
    // The job page's call button (CMP-16) for both customers: the number shown on a computer, the label and the link on a phone.
    for (const r of [e164, typed]) {
      const n = r.visit.jobNumber as number;
      const desk = await open(browser, `/office/jobs/${n}`, `${JOB} .jh h1`, { token: people.keisha });
      try {
        await desk.page.locator(`${JOB} [data-ctl="CTL-OFC-03-22"] button`).click();
        await expect.poll(() => desk.page.locator(`${JOB} [data-ctl="CTL-OFC-03-22"] [data-call-number]`).innerText(), { timeout: 10_000 }).toBe(shown(r.phone));
      } finally {
        await close(desk);
      }
      const phone = await open(browser, `/office/jobs/${n}`, `${JOB} .jh h1`, { token: people.keisha, size: { viewport: { width: 520, height: 980 }, isMobile: true, hasTouch: true } });
      try {
        const dial = phone.page.locator(`${JOB} [data-ctl="CTL-OFC-03-22"] a[data-ctl="CTL-CMP-16-01"]`);
        await dial.waitFor({ timeout: 30_000 });
        expect(await dial.getAttribute('aria-label'), r.customer).toBe(msg('shell.call.number', { name: r.customer, number: shown(r.phone) }));
        expect(await dial.getAttribute('href'), r.customer).toBe(`tel:+1${shown(r.phone).replace(/\D/g, '')}`);
      } finally {
        await close(phone);
      }
    }
  });
});
