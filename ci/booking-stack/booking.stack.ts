// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-BOOK-1, FR-BOOK-2, FR-BOOK-3, FR-BOOK-4, FR-BOOK-7, FR-BOOK-9, FR-BOOK-11, FR-BOOK-12, FR-BOOK-14, FR-BOOK-15, FR-BOOK-16, FR-DEMO-1, FR-TEXT-1 (P5-BOOKING Acceptance: Playwright on Chromium and WebKit against the Compose stack)
// The online booking site (SCR-CUS-01 to SCR-CUS-03) against the Compose stack at its default settings (real PostgreSQL 18, real handlers, pbs running, the
// worker delivering texts), set up by the setup service (the seeded world), through its proxy, every page opened through the outside-origin guard. The
// customer has no account: the pages are driven as a visitor. The office (ci/job-stack/fixture.sql's sessions) reads the board and switches a day. Run by
// ci/booking-stack.sh. The suite shares 1 world: each engine makes its own customers and jobs and cancels them. The demo clock is set by SQL (the world
// starts at Tue, Sep 15, 7:00 AM, and online booking never offers today) and put back after.
//   FR-BOOK-1, FR-BOOK-14: a visitor books Sep 15, 10 AM-12 PM, through the 6 steps; the page prints the live API's services, prices and windows; the booking is on the board.
//   FR-TEXT-1 (F-782, F-421): at 10:00 AM the confirmation is in the customer's inbox by 10:01 AM; at 12:30 AM EDT it is held and arrives at 8:00 AM EDT.
//   FR-BOOK-3: 2 visitors race for the last place: exactly 1 books, the other lands on the Window just taken page with windows still open.
//   FR-BOOK-2 (F-756): the office switches Wed, Sep 16 (API-91) and the booking site offers only the 4-hour windows for it, and the 2-hour ones when it is switched back.
//   FR-BOOK-7: Wed, Sep 16 and Fri, Sep 18 (the sample peak days) list exactly the 4 overlapping 4-hour windows.
//   FR-BOOK-4: a full booking at 520 x 980 and at 1440 x 900; at 520 the buttons visible on the Confirm step are at least 44 px high (every other step and
//   every tap target's width are the page walkers' tap-target-44 rule, F-965).
//   FR-DEMO-1: the real /book header shows "Demo clock" with the demo time.
//   FR-BOOK-11: a booking with the texts box unticked sends no text and the visit's reminder is on the call list the day before.
//   FR-BOOK-9: after 5:00 PM on Sep 14 the site shows Sep 15 as Booking closed and a booking for it is refused (booking_closed).
import { spawnSync } from 'node:child_process';
import type { Browser, Locator, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_BOOKING_STACK_URL;
const db = process.env.BW_BOOKING_DB_CONTAINER;
const worker = process.env.BW_BOOKING_WORKER_CONTAINER;
const people = { keisha: process.env.BW_BOOKING_KEISHA, dana: process.env.BW_BOOKING_DANA };
if (!base || !db || !worker || Object.values(people).some((v) => !v)) {
  throw new Error('BW_BOOKING_STACK_URL, _DB_CONTAINER, _WORKER_CONTAINER and the session tokens are not set: run ci/booking-stack.sh');
}
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the suite's proxy listens on a free port, so writes carry the default origin.
const APP_ORIGIN = 'http://localhost:8080';
const S1 = '.r1-screen[data-screen="SCR-CUS-01"]';
const S3 = '.r1-screen[data-screen="SCR-CUS-03"]';
/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** SQL in the stack's database as its owner. */
function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
/** Waits for what a locator shows (the matchers of Playwright's own runner are not this runner's): polls up to 30 s. */
const textNow = (loc: Locator) => loc.innerText({ timeout: 1_000 }).catch(() => '');
const see = (loc: Locator) => ({
  containsText: (text: string) => expect.poll(() => textNow(loc), { timeout: 30_000, interval: 300 }).toContain(text),
  hasText: (text: string) => expect.poll(async () => (await textNow(loc)).replace(/\s+/g, ' ').trim(), { timeout: 30_000, interval: 300 }).toBe(text),
});
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function call(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { ...(token ? { cookie: `bw_session=${token}` } : {}), ...(method === 'GET' ? {} : { origin: APP_ORIGIN, 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const office = (who: keyof typeof people, method: string, path: string, body?: unknown) => call(people[who]!, method, path, body);
const visitor = (method: string, path: string, body?: unknown) => call(null, method, path, body);

/** The page's API writes carry the default origin: Playwright resends them itself (a browser will not let a route set Origin). */
async function writeOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    try {
      const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
      await r.fulfill({ response });
    } catch {
      await r.abort('failed').catch(() => undefined);
    }
  });
}
interface Open { page: Page; g: GuardedContext }
// F-1077: the visitor's browser is in the Columbus branch's zone. A booking stores the browser's zone as the customer's (FR-TEXT-17) and
// You're booked shows the visit in the customer's zone (UD-15), so a context left at the host's zone (UTC in the wave container) books a
// UTC customer and the 10 AM-12 PM window reads 2-4 PM. The zone is the suite's, never the run host's.
const VISITOR_ZONE = 'America/New_York';
async function open(browser: Browser, path: string, ready: string, size = { width: 1440, height: 1100 }): Promise<Open> {
  const g = await guardedContext(browser, [origin], { viewport: size, timezoneId: VISITOR_ZONE });
  const page = await g.context.newPage();
  await writeOrigin(page);
  const res = await page.goto(origin + path, { waitUntil: 'load' });
  expect(res?.status()).toBe(200);
  await page.waitForSelector(ready, { timeout: 60_000 });
  return { page, g };
}
const close = async (o: Open) => o.g.context.close();

let clockSaved = '';
beforeAll(async () => {
  // F-958 (the F-917 wait of ci/clock-ui-stack/clock.ui.stack.ts): setup leaves pbs_epoch behind world_epoch and the worker's reset confirmer
  // (every 5 s) then lets the clock run, which would undo a hold made before it. Wait for the confirmation and the running clock first.
  const waitUntil = Date.now() + 60_000;
  while (psql('SELECT pbs_epoch = world_epoch AND NOT paused FROM system.demo_clock WHERE id = 1') !== 't') {
    if (Date.now() > waitUntil) throw new Error('the reset was not confirmed by the billing service within 60 s (pbs_epoch behind world_epoch, or the clock paused)');
    await new Promise((r) => setTimeout(r, 500));
  }
  clockSaved = psql(`SELECT json_build_object('demo', demo_anchor, 'real', real_anchor, 'rate', rate, 'paused', paused) FROM system.demo_clock WHERE id = 1`);
});
afterAll(() => {
  if (!clockSaved) return;
  const c = JSON.parse(clockSaved) as Json;
  psql(`UPDATE system.demo_clock SET demo_anchor = ${q(c.demo)}, real_anchor = ${q(c.real)}, rate = ${c.rate}, paused = ${c.paused} WHERE id = 1`);
});

/** The demo clock to a demo time, held there (SQL: the clock API moves forward only), read back through API-10. */
async function holdClockAt(iso: string): Promise<void> {
  psql(`UPDATE system.demo_clock SET demo_anchor = ${q(iso)}, real_anchor = now(), paused = true WHERE id = 1`);
  await expect.poll(async () => Math.abs(Date.parse(((await office('dana', 'GET', '/clock')).body.data.demoNow as string).replace(/\[.*\]$/, '')) - Date.parse(iso)), { timeout: 30_000, interval: 300 }).toBeLessThan(1_000);
}

const streetName = () => psql(`SELECT name FROM world.street WHERE branch_id = 'columbus' AND length(name) >= 6 ORDER BY name LIMIT 1`);
/** The Columbus street's own ZIP code picks its row from the results (a search also lists other branches' streets of a like name). */
const streetZip = () => psql(`SELECT zip FROM world.street WHERE branch_id = 'columbus' AND length(name) >= 6 ORDER BY name LIMIT 1`);
const pickStreet = async (p: Page, full = false) => {
  await p.locator('#bw-street').fill(full ? streetName() : streetName().slice(0, 6));
  await p.locator(`${S1} [role="option"]`, { hasText: streetZip() }).first().click();
};
const jobBy = (token: string) => JSON.parse(psql(`SELECT json_build_object('n', job_number, 'date', date::text, 'via', booked_via, 'tech', technician_id, 'status', status, 'customer', customer_id, 'window', to_char(window_start AT TIME ZONE zone, 'HH24:MI'), 'version', version) FROM world.job WHERE booking_token = ${q(token)}`)) as Json;
const confirmation = (n: number) => psql(`SELECT id || '|' || status || '|' || coalesce(held_until::text, '') || '|' || due_at::text FROM world.outbox_text WHERE job_number = ${n} AND kind = 'confirmation'`).split('|');
const inboxBodies = (textId: string) => psql(`SELECT body FROM world.inbox_message WHERE text_id = '${textId}'`).split('\n').filter(Boolean);
const cancelJob = async (n: number) => {
  const version = psql(`SELECT version FROM world.job WHERE job_number = ${n}`);
  const r = await office('keisha', 'POST', `/jobs/${n}/cancellation`, { baseVersion: Number(version) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const tokenOf = (p: Page) => decodeURIComponent(new URL(p.url()).pathname.split('/').pop() as string);

/** The 6 steps as a visitor takes them, to the Confirm step (not pressed): service, street, day, window, details. */
async function toConfirm(p: Page, o: { service: string; street: string; day: string; window: string; name: string; mobile: string | null; untick?: boolean }): Promise<void> {
  await p.locator(`${S1} button.tile`, { hasText: o.service }).click();
  await p.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
  await pickStreet(p, true);
  await p.locator('#bw-house').fill('418');
  await p.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
  await p.locator(`${S1} button.d[aria-label*=", ${o.day}"]`).click();
  await p.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
  await p.locator(`${S1} button.win`, { hasText: o.window }).click();
  await p.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
  await p.locator('#bw-name').fill(o.name);
  if (o.mobile) await p.locator('#bw-mobile').fill(o.mobile);
  if (o.untick) await p.locator(`${S1} button[data-ctl="CTL-CUS-01-15"]`).click();
  await p.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
  await p.locator(`${S1} button[data-ctl="CTL-CUS-01-13"]`).waitFor({ state: 'visible' });
}

describe.each(engines)('the booking site on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  const made: number[] = [];
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
    spawnSync('docker', ['start', worker!], { encoding: 'utf8' });
  });
  afterAll(async () => {
    await browser?.close();
    for (const n of made.splice(0)) await cancelJob(n);
  });

  // why: FR-BOOK-1, FR-BOOK-14, FR-BOOK-12, FR-TEXT-1 a visitor books Sep 15, 10 AM-12 PM, through the 6 steps at 10:00 AM on Sep 14: the services, prices and windows are the live API's, the job is online with no technician, it is on the board, and the confirmation is in the inbox by 10:01 AM
  it('books Sep 15, 10 AM-12 PM at 10:00 AM: the live words, the board, and the confirmation in the inbox by 10:01 AM', async () => {
    await holdClockAt('2026-09-14T14:00:00Z');
    const o = await open(browser, '/book?new=1', `${S1} button.tile`);
    try {
      // The services and their price lines are what API-110 and the catalog say (FR-BOOK-14).
      const lines = await o.page.locator(`${S1} button.tile`).evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
      expect(lines).toEqual(['Furnace tune-up$89, about 1 hr', 'AC tune-up$89, about 1 hr', 'Heating or AC fix$79 visit fee', 'Plumbing repair$79 visit fee', 'Water heaterRepair or replace', 'ThermostatInstall or repair']);
      await o.page.locator(`${S1} button.tile`, { hasText: 'Furnace tune-up' }).click();
      await o.page.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
      await pickStreet(o.page);
      await see(o.page.locator(`${S1} [data-ctl="CTL-CUS-01-04"] .hint`)).containsText('Columbus');
      await o.page.locator('#bw-house').fill('418');
      await o.page.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
      // The calendar: Sep 15 is bookable until 5:00 PM today; today and Sundays are not.
      await o.page.locator(`${S1} button.d[aria-label*=", Tue, Sep 15"]`).click();
      await see(o.page.locator(`${S1} .d.sel`)).hasText('15');
      expect(await o.page.locator(`${S1} .d.today`).getAttribute('aria-label')).toContain('Mon, Sep 14');
      expect(await o.page.locator(`${S1} .d.closed[aria-label*=", Sun, Sep 20"]`).getAttribute('aria-label')).toContain('Closed on Sundays');
      await o.page.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
      await o.page.locator(`${S1} button.win`, { hasText: '10 AM-12 PM' }).click();
      await o.page.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
      const name = `Booking ${engine} Ten`;
      await o.page.locator('#bw-name').fill(name);
      await o.page.locator('#bw-mobile').fill(`(614) 555-01${engine === 'chromium' ? '10' : '11'}`);
      await o.page.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
      await see(o.page.locator(`${S1} [data-ctl="CTL-CUS-01-12"]`)).containsText('Furnace tune-up, $89');
      await see(o.page.locator(`${S1} [data-ctl="CTL-CUS-01-12"]`)).containsText('10 AM-12 PM');
      await o.page.locator(`${S1} button[data-ctl="CTL-CUS-01-13"]`).click();
      await o.page.waitForURL(/\/book\/done\/[A-Za-z0-9_-]{22}$/, { timeout: 60_000 });
      const job = jobBy(tokenOf(o.page));
      made.push(job.n);
      expect(job).toMatchObject({ date: '2026-09-15', via: 'online', tech: null, status: 'scheduled', window: '10:00' });
      await o.page.locator(`${S3} .visit`).waitFor({ state: 'visible' });
      await see(o.page.locator(`${S3} h1`)).hasText("You're booked");
      await see(o.page.locator(`${S3} .visit`)).containsText(`Visit number ${job.n}`);
      await see(o.page.locator(`${S3} .visit`)).containsText('$89, about 1 hr');
      await see(o.page.locator(`${S3} .visit`)).containsText('10 AM-12 PM');
      // The board shows the booking, unassigned (UD-2).
      const board = (await office('keisha', 'GET', '/board?branch=columbus&date=2026-09-15')).body.data;
      expect((board.unassigned as Json[]).map((j) => j.jobNumber)).toContain(job.n);
      // FR-TEXT-1 (F-782, F-421): the confirmation was queued in the booking's transaction, due 10:00 AM, and the worker puts it in the inbox.
      const [textId, , held, due] = confirmation(job.n);
      expect(held).toBe('');
      expect(Date.parse(due!.replace(' ', 'T').replace(/\+00$/, 'Z'))).toBe(Date.parse('2026-09-14T14:00:00Z'));
      await expect.poll(() => inboxBodies(textId!).length, { timeout: 60_000, interval: 500 }).toBe(1);
      expect(inboxBodies(textId!)[0]).toContain("You're booked");
      await o.page.reload({ waitUntil: 'load' });
      await see(o.page.locator(`${S3} .next li.done b`)).hasText('Confirmation text: sent');
      await see(o.page.locator(`${S3} [data-ctl="CTL-CUS-03-06"] .sentchip`)).containsText('Sent 10:00 AM');
    } finally {
      await close(o);
    }
  });

  // why: FR-TEXT-1 a booking at 12:30 AM EDT is held by quiet hours and the confirmation arrives at 8:00 AM EDT, not before
  it('holds the confirmation of a 12:30 AM EDT booking until 8:00 AM EDT', async () => {
    await holdClockAt('2026-09-14T04:30:00Z');
    const r = await visitor('POST', '/public/bookings', {
      serviceId: 'furnace_tune_up', streetId: psql(`SELECT id FROM world.street WHERE branch_id = 'columbus' ORDER BY name, id LIMIT 1`), houseNumber: 12, date: '2026-09-17',
      windowId: psql(`SELECT id FROM world.arrival_window WHERE branch_id = 'columbus' AND mode = 'two_hour' AND start_local = '14:00'`), name: `Night ${engine}`, mobile: `(614) 555-01${engine === 'chromium' ? '20' : '21'}`,
      textsOn: true, textLanguage: 'en', timeZone: 'America/New_York',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const job = jobBy(r.body.data.bookingToken);
    made.push(job.n);
    const [textId, status, held] = confirmation(job.n);
    expect(status).toBe('held');
    expect(Date.parse(held!.replace(' ', 'T').replace(/\+00$/, 'Z'))).toBe(Date.parse('2026-09-14T12:00:00Z'));
    const o = await open(browser, `/book/done/${r.body.data.bookingToken}`, `${S3} .visit`);
    try {
      await see(o.page.locator(`${S3} .next li b`).first()).hasText('Confirmation text: held until 8:00 AM your time');
    } finally {
      await close(o);
    }
    expect(inboxBodies(textId!)).toEqual([]);
    await holdClockAt('2026-09-14T12:00:00Z');
    await expect.poll(() => inboxBodies(textId!).length, { timeout: 60_000, interval: 500 }).toBe(1);
  });

  // why: FR-BOOK-3 2 visitors race for the last place: exactly 1 books, the other lands on the Window just taken page with windows still open
  it('lets exactly 1 of 2 visitors booking the last place succeed, and shows the other the open windows', async () => {
    await holdClockAt('2026-09-14T14:00:00Z');
    const win = psql(`SELECT id FROM world.arrival_window WHERE branch_id = 'columbus' AND mode = 'two_hour' AND start_local = '12:00'`);
    const was = psql(`SELECT capacity FROM world.arrival_window WHERE id = ${q(win)}`);
    psql(`UPDATE world.arrival_window SET capacity = 1 WHERE id = ${q(win)}`);
    const a = await open(browser, '/book?new=1', `${S1} button.tile`);
    const b = await open(browser, '/book?new=1', `${S1} button.tile`);
    try {
      const day = 'Thu, Sep 24';
      await Promise.all([a, b].map((x, i) => toConfirm(x.page, { service: 'Furnace tune-up', street: streetName().slice(0, 6), day, window: '12-2 PM', name: `Racer ${engine} ${i}`, mobile: null })));
      await Promise.all([a, b].map((x) => x.page.locator(`${S1} button[data-ctl="CTL-CUS-01-13"]`).click()));
      await expect.poll(async () => [a, b].filter((x) => /\/book\/done\//.test(x.page.url())).length, { timeout: 60_000 }).toBeGreaterThan(0);
      // F-958: every job made is owned by the cleanup before any assertion can fail.
      for (const x of [a, b]) if (/\/book\/done\//.test(x.page.url())) made.push(jobBy(tokenOf(x.page)).n);
      const seen = psql(`SELECT json_agg(json_build_object('n', job_number, 'win', window_id, 'cap', (SELECT capacity FROM world.arrival_window w WHERE w.id = window_id))) FROM world.job WHERE date = '2026-09-24' AND booked_via = 'online'`);
      expect([a, b].filter((x) => /\/book\/done\//.test(x.page.url())).length, `online jobs on Sep 24: ${seen}`).toBe(1);
      const loser = [a, b].find((x) => !/\/book\/done\//.test(x.page.url())) as Open;
      await loser.page.locator('.r1-screen .alert').waitFor({ state: 'visible', timeout: 60_000 });
      // A customer page names the branch zone after a window (UD-15, owner ruling 037420bb; DK-120's taken heading; F-1122, F-1181).
      await see(loser.page.locator('.r1-screen .alert h2')).hasText('12-2 PM EDT just filled');
      await see(loser.page.locator('.r1-screen .alert')).containsText('Nothing was booked for you');
      const options = loser.page.locator('.r1-screen .alts [role="radio"]');
      expect(await options.count()).toBeGreaterThan(0);
      expect(await options.count()).toBeLessThanOrEqual(3);
      // The one that booked is in the world once; the loser left no job and no customer (the transaction rolled back).
      expect(psql(`SELECT count(*) FROM world.job WHERE date = '2026-09-24' AND window_id = ${q(win)} AND status <> 'canceled'`)).toBe('1');
      expect(psql(`SELECT count(*) FROM world.customer WHERE name LIKE ${q(`Racer ${engine} %`)}`)).toBe('1');
      // Picking a nearest window books it: the page goes to You're booked for that window.
      await options.first().click();
      await loser.page.locator('.r1-screen button[data-ctl="CTL-CUS-02-03"]').click();
      await loser.page.waitForURL(/\/book\/done\//, { timeout: 60_000 });
      made.push(jobBy(tokenOf(loser.page)).n);
    } finally {
      psql(`UPDATE world.arrival_window SET capacity = ${was} WHERE id = ${q(win)}`);
      await close(a);
      await close(b);
    }
  });

  /**
   * The windows the booking site lists for a day (its heading, then each window's label), read through the 6-step page as a visitor.
   * Each label names the branch zone, EDT in September (UD-15, owner ruling 037420bb; DK-118; F-1122, F-1181).
   */
  const windowsOn = async (day = 'Wed, Sep 16'): Promise<string[]> => {
    const o = await open(browser, '/book?new=1', `${S1} button.tile`);
    try {
      await o.page.locator(`${S1} button.tile`, { hasText: 'Furnace tune-up' }).click();
      await o.page.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
      await pickStreet(o.page);
      await o.page.locator('#bw-house').fill('418');
      await o.page.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
      await o.page.locator(`${S1} button.d[aria-label*=", ${day}"]`).click();
      await o.page.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
      await o.page.locator(`${S1} button.win`).first().waitFor({ state: 'visible' });
      const heading = await o.page.locator(`${S1} #bw-h4`).innerText();
      const wins = await o.page.locator(`${S1} button.win`).evaluateAll((els) => els.map((e) => (e.firstChild?.nextSibling?.textContent ?? '').trim()));
      return [heading.replace(/\s+/g, ' ').trim(), ...wins];
    } finally {
      await close(o);
    }
  };

  // why: FR-BOOK-2 the office switches Wed, Sep 16 (API-91) and the booking site then offers only the 4-hour windows for that day; switched back it offers the 2-hour ones (F-756)
  it('offers the 4-hour windows on a day the office switched to 4-hour, and the 2-hour ones when it is switched back', async () => {
    await holdClockAt('2026-09-14T14:00:00Z');
    const mode = async (m: 'two_hour' | 'four_hour') => {
      const r = await office('dana', 'PUT', '/branches/columbus/days/2026-09-16/mode', { mode: m, ...(m === 'four_hour' ? { reason: 'Heat wave' } : {}) });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    try {
      await mode('two_hour');
      const two = await windowsOn();
      expect(two[0], 'two').toContain('Pick a 2-hour arrival window');
      expect(two.slice(1)).toEqual(['8-10 AM EDT', '10 AM-12 PM EDT', '12-2 PM EDT', '2-4 PM EDT', '4-6 PM EDT']);
      await mode('four_hour');
      const four = await windowsOn();
      expect(four[0], `API-112: ${JSON.stringify((await visitor('POST', '/public/availability', { streetId: psql(`SELECT id FROM world.street WHERE branch_id = 'columbus' ORDER BY name, id LIMIT 1`), serviceId: 'furnace_tune_up', from: '2026-09-16', to: '2026-09-16' })).body?.data?.days?.[0]?.mode)}; day_mode: ${psql(`SELECT mode FROM world.day_mode WHERE branch_id = 'columbus' AND date = '2026-09-16'`)}`).toContain('Pick a 4-hour arrival window');
      expect(four.slice(1)).toEqual(['8 AM-12 PM EDT', '10 AM-2 PM EDT', '12-4 PM EDT', '2-6 PM EDT']);
    } finally {
      await mode('four_hour'); // the seeded peak day, as the world has it
    }
  });

  // why: FR-BOOK-7 on Wed, Sep 16 and Fri, Sep 18 (the sample peak days) the booking site lists exactly the 4 overlapping 4-hour windows
  it('lists exactly the 4 four-hour windows on Wed, Sep 16 and Fri, Sep 18', async () => {
    await holdClockAt('2026-09-14T14:00:00Z');
    for (const day of ['Wed, Sep 16', 'Fri, Sep 18']) {
      const listed = await windowsOn(day);
      expect(listed[0], day).toContain('Pick a 4-hour arrival window');
      expect(listed.slice(1), day).toEqual(['8 AM-12 PM EDT', '10 AM-2 PM EDT', '12-4 PM EDT', '2-6 PM EDT']);
    }
  });

  // why: FR-BOOK-4 a booking is completed at 520 x 980 and at 1440 x 900, and at 520 the buttons visible on the Confirm step are at least 44 px high (F-965)
  it('completes a booking at 520 x 980 and at 1440 x 900', async () => {
    await holdClockAt('2026-09-14T14:00:00Z');
    const sizes = [{ width: 520, height: 980, window: '10 AM-12 PM' }, { width: 1440, height: 900, window: '2-4 PM' }];
    for (const size of sizes) {
      const o = await open(browser, '/book?new=1', `${S1} button.tile`, size);
      try {
        await toConfirm(o.page, { service: 'Furnace tune-up', street: streetName().slice(0, 6), day: 'Wed, Sep 23', window: size.window, name: `Size ${size.width} ${engine}`, mobile: null });
        if (size.width === 520) {
          const small = await o.page.locator(`${S1} button`).evaluateAll((els) =>
            els.map((e) => ({ what: e.getAttribute('data-ctl') ?? e.className, h: e.getBoundingClientRect().height })).filter((x) => x.h > 0 && x.h < 44));
          expect(small, 'buttons under 44 px at 520 wide').toEqual([]);
        }
        await o.page.locator(`${S1} button[data-ctl="CTL-CUS-01-13"]`).click();
        await o.page.waitForURL(/\/book\/done\/[A-Za-z0-9_-]{22}$/, { timeout: 60_000 });
        const job = jobBy(tokenOf(o.page));
        made.push(job.n);
        expect(job).toMatchObject({ date: '2026-09-23', via: 'online', tech: null, status: 'scheduled', window: size.window === '2-4 PM' ? '14:00' : '10:00' });
        await see(o.page.locator(`${S3} h1`)).hasText("You're booked");
        await see(o.page.locator(`${S3} .visit`)).containsText(`Visit number ${job.n}`);
      } finally {
        await close(o);
      }
    }
  });

  // why: FR-DEMO-1 the real booking site's header shows "Demo clock" with the demo time the clock row holds
  it('shows Demo clock and the demo time in the /book header', async () => {
    await holdClockAt('2026-09-14T14:00:00Z');
    const o = await open(browser, '/book?new=1', `${S1} button.tile`);
    try {
      const strip = o.page.locator('.r1-demobar [data-ctl="CTL-CMP-01-01"]');
      await see(strip.locator('.lbl')).hasText('Demo clock');
      await see(strip.locator('b')).hasText('Mon, Sep 14, 10:00 AM EDT');
    } finally {
      await close(o);
    }
  });

  // why: FR-BOOK-11 a booking with the texts box unticked sends no text, and the visit's reminder is on the call list the day before (FR-TEXT-13)
  it('puts the reminder of a booking with the texts box unticked on the call list and sends it no text', async () => {
    await holdClockAt('2026-09-14T14:00:00Z');
    const callListFor = async () => ((await office('dana', 'GET', '/call-list?branch=columbus&date=2026-09-16')).body.data.reminderCalls as Json[]).map((c) => [c.visit.jobNumber, c.reason]);
    const o = await open(browser, '/book?new=1', `${S1} button.tile`);
    try {
      await toConfirm(o.page, { service: 'Furnace tune-up', street: streetName().slice(0, 6), day: 'Thu, Sep 17', window: '8-10 AM', name: `Unticked ${engine}`, mobile: `(614) 555-01${engine === 'chromium' ? '30' : '31'}`, untick: true });
      await o.page.locator(`${S1} button[data-ctl="CTL-CUS-01-13"]`).click();
      await o.page.waitForURL(/\/book\/done\/[A-Za-z0-9_-]{22}$/, { timeout: 60_000 });
      const job = jobBy(tokenOf(o.page));
      made.push(job.n);
      expect(psql(`SELECT texts_on FROM world.customer WHERE id = ${q(job.customer)}`)).toBe('f');
      expect(psql(`SELECT count(*) FROM world.outbox_text WHERE job_number = ${job.n}`)).toBe('0');
      expect(await callListFor()).toContainEqual([job.n, 'texts_off']);
    } finally {
      await close(o);
    }
  });

  // why: FR-BOOK-9 after 5:00 PM on Sep 14 the site shows Sep 15 as Booking closed and refuses to book it
  it('closes Sep 15 at 5:00 PM on Sep 14', async () => {
    await holdClockAt('2026-09-14T21:01:00Z');
    // The booking itself is refused with booking_closed and writes no job and no customer (API-113).
    const jobsBefore = psql('SELECT count(*) FROM world.job');
    const late = await visitor('POST', '/public/bookings', {
      serviceId: 'furnace_tune_up', streetId: psql(`SELECT id FROM world.street WHERE branch_id = 'columbus' ORDER BY name, id LIMIT 1`), houseNumber: 12, date: '2026-09-15',
      windowId: psql(`SELECT id FROM world.arrival_window WHERE branch_id = 'columbus' AND mode = 'two_hour' AND start_local = '14:00'`), name: `Closed ${engine}`, mobile: null,
      textsOn: true, textLanguage: 'en', timeZone: 'America/New_York',
    });
    expect([late.status, late.body?.code], JSON.stringify(late.body)).toEqual([409, 'booking_closed']);
    expect(psql('SELECT count(*) FROM world.job')).toBe(jobsBefore);
    expect(psql(`SELECT count(*) FROM world.customer WHERE name = ${q(`Closed ${engine}`)}`)).toBe('0');
    const o = await open(browser, '/book?new=1', `${S1} button.tile`);
    try {
      await o.page.locator(`${S1} button.tile`, { hasText: 'Furnace tune-up' }).click();
      await o.page.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
      await pickStreet(o.page);
      await o.page.locator('#bw-house').fill('418');
      await o.page.locator(`${S1} button[data-ctl="CTL-CUS-01-10"]`).click();
      await o.page.locator(`${S1} .grid7`).waitFor({ state: 'visible' });
      expect(await o.page.locator(`${S1} .d[aria-label*=", Tue, Sep 15"]`).getAttribute('aria-label')).toContain('Booking closed');
      expect(await o.page.locator(`${S1} button.d[aria-label*=", Wed, Sep 16"]`).count()).toBe(1);
    } finally {
      await close(o);
    }
  });
});
