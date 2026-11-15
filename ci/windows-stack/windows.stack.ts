// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-BOOK-2, FR-BOOK-8, FR-BOOK-17, FR-BOOK-18, UC-13 (P4-ADMIN-WINDOWS Acceptance: Playwright on Chromium and WebKit against the Compose stack)
// The arrival windows page and its switch dialog against the Compose stack at its default settings (real PostgreSQL 18, real handlers, the worker
// and pbs running), set up by the setup service (the seeded world, the clock at Tue, Sep 15, 7:00 AM), through its proxy, every page opened through
// the outside-origin guard. UC-13 runs for real: the manager switches Wed, Sep 16 back to 2-hour windows on the page, a booking is made for 10 AM to
// 12 PM that day, the manager switches the day to 4-hour windows with a reason in the dialog, and the booking still shows its 2-hour window on the
// board, on its job page and in its reminder text, which the worker sends at 6:00 PM. A capacity below the bookings is refused on its field and
// nothing is saved; the capacity saved at the bookings refuses the next booking. The people are ci/windows-stack/fixture.sql's sessions. Run by
// ci/windows-stack.sh. The suite shares 1 world and 1 clock: each engine puts back what it changed (Wed, Sep 16 on 4-hour windows, the limits).
import { spawnSync } from 'node:child_process';
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_WINDOWS_STACK_URL;
const db = process.env.BW_WINDOWS_DB_CONTAINER;
const people = { keisha: process.env.BW_WINDOWS_KEISHA, dana: process.env.BW_WINDOWS_DANA };
if (!base || !db || Object.values(people).some((v) => !v)) throw new Error('BW_WINDOWS_STACK_URL, _DB_CONTAINER and the session tokens are not set: run ci/windows-stack.sh');
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the suite's proxy listens on a free port, so writes carry the default origin.
const APP_ORIGIN = 'http://localhost:8080';
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 1100 } };
type Who = keyof typeof people;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** SQL in the stack's database as its owner (reads, and the customers a booking needs). */
function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}

/** A call as a person, with the default origin on writes (the kernel's Origin check, SD-8). */
async function api(who: Who, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: { cookie: `bw_session=${people[who]}`, ...(method === 'GET' ? {} : { origin: APP_ORIGIN, 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const settings = async (who: Who = 'keisha') => (await api(who, 'GET', '/branches/columbus/booking-settings')).body.data as Json;
const dayOf = async (date: string) => ((await settings()).days as Json[]).find((d) => d.date === date)!;
/** Any 1 day, past the 2 weeks too: API-90 with the day as its range. */
const oneDay = async (date: string) => (await api('keisha', 'GET', `/branches/columbus/booking-settings?from=${date}&to=${date}`)).body.data.days[0] as Json;
const ms = (wire: string) => Date.parse(wire.replace(/\[.*\]$/, ''));
const sleep = (t: number) => new Promise((r) => setTimeout(r, t));

/** Poll until `cond` holds. */
async function until<T>(what: string, read: () => Promise<T> | T, cond: (v: T) => boolean, tries = 120): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i += 1) {
    last = await read();
    if (cond(last)) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}; last read: ${JSON.stringify(last).slice(0, 600)}`);
}

/** Jump the shared clock to a wire time (API-12, the manager): a replay still running refuses (409), so retry; then wait until it has caught up. */
async function jumpTo(to: string): Promise<void> {
  for (let i = 0; ; i += 1) {
    const r = await api('dana', 'POST', '/clock/jumps', { to });
    if (r.status === 202) break;
    if (r.status !== 409 || i > 240) expect(r.status, JSON.stringify(r.body)).toBe(202);
    await sleep(500);
  }
  await until('the clock to reach the target', async () => (await api('dana', 'GET', '/clock')).body, (b) => !b.data.replay?.running && ms(b.data.demoNow) >= ms(to) - 1_000);
}

/** The seeded Columbus customers who take texts (a mobile number, texts on), in the branch zone. */
function customer(skip: number): string {
  return psql(`SELECT id FROM world.customer WHERE branch_id = 'columbus' AND texts_on AND mobile IS NOT NULL AND zone = 'America/New_York' ORDER BY name, id OFFSET ${skip} LIMIT 1`);
}
const windowId = (start: string) => psql(`SELECT id FROM world.arrival_window WHERE branch_id = 'columbus' AND mode = 'two_hour' AND start_local = '${start}'`);

/** The page's writes carry the default origin: Playwright resends them itself (a browser will not let a route set Origin). */
async function writeOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    try {
      const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
      await r.fulfill({ response });
    } catch {
      // the page or its context closed while the write was in flight: nothing to hand back
    }
  });
}

/** "Tue, Sep 15, 7:00 AM": a wire time's own wall time, as the page words it (the zone's offset is in the string, the device's is never used). */
function wall(wire: string): string {
  const [date, time] = wire.slice(0, 16).split('T') as [string, string];
  const [h, m] = time.split(':').map(Number) as [number, number];
  const d = new Date(`${date}T12:00:00Z`);
  const name = (o: Intl.DateTimeFormatOptions) => d.toLocaleString('en-US', { ...o, timeZone: 'UTC' });
  return `${name({ weekday: 'short' })}, ${name({ month: 'short' })} ${d.getUTCDate()}, ${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
/** "5:00 PM" for an HH:MM rule time. */
const clock = (hhmm: string) => wall(`2026-09-15T${hhmm}`).split(', ')[2]!;

interface Open { page: Page; g: GuardedContext; streams: string[] }
async function open(browser: Browser, who: Who, path: string, lang: 'en' | 'es' = 'en'): Promise<Open> {
  const g = await guardedContext(browser, [origin], DESKTOP);
  await g.context.addCookies([{ name: 'bw_session', value: people[who]!, url: origin, httpOnly: true }, { name: 'bw_lang', value: lang, url: origin }]);
  const page = await g.context.newPage();
  await writeOrigin(page);
  const streams: string[] = [];
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/v1/events') streams.push(r.url()); });
  await page.goto(origin + path, { waitUntil: 'load' });
  return { page, g, streams };
}
const close = async (o: Open) => o.g.context.close();
const ready = (p: Page) => p.locator('table.w tbody tr').first().waitFor({ state: 'visible', timeout: 60_000 });
const text = async (p: Page, sel: string) => (await p.locator(sel).first().innerText()).replace(/\s+/g, ' ').trim();
const dayButton = (p: Page, label: string) => p.locator('button.day', { hasText: label });
const dialogTitle = (p: Page) => p.locator('[role="dialog"] h2').first().innerText();
/** A day's local time in the zone of the stack (the wire form of API-12 wants the offset). */
const WIRE_6PM = '2026-09-15T18:05:00-04:00[America/New_York]';

describe.each(engines)('The arrival windows page on %s', (engine, type) => {
  let browser: Browser;
  const index = engines.findIndex(([n]) => n === engine);
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  }, 300_000);
  afterAll(async () => {
    // Put back what a run changed: Wed, Sep 16 on 4-hour windows (the seed's), the window limits the seed wrote.
    await api('dana', 'PUT', '/branches/columbus/days/2026-09-16/mode', { mode: 'four_hour', reason: 'Heat advisory' });
    await browser?.close();
  });

  // why: FR-BOOK-17 the page loads with the 5 Columbus numbers from API-90; FR-BOOK-2 and FR-BOOK-18 the calendar draws the 2 weeks with Wed, Sep 16 and Fri, Sep 18 as 4-hour days and their reason; Today is the demo clock's day
  it('opens with the 5 limits, the booked of each, the 2 weeks of days, the sample peak days and their reason, from API-90', async () => {
    const s = await settings();
    expect(s.windows).toHaveLength(5);
    const o = await open(browser, 'keisha', '/office/admin/windows?branch=columbus');
    try {
      await ready(o.page);
      expect(await text(o.page, 'h1')).toBe('Arrival windows');
      const rows = o.page.locator('table.w tbody tr');
      expect(await rows.count()).toBe(5);
      for (let i = 0; i < 5; i += 1) {
        const w = s.windows[i];
        expect(await rows.nth(i).locator('input.bw-step-in').inputValue()).toBe(String(w.limit));
        expect(await rows.nth(i).locator('td').nth(1).innerText()).toBe(String(w.technicians));
        expect(await text(o.page, `table.w tbody tr:nth-child(${i + 1}) .fill`)).toContain(`${w.bookedToday} of ${w.limit}`);
      }
      expect(await o.page.locator('button.day').count()).toBe(14);
      for (const d of s.days as Json[]) {
        const label = new Date(`${d.date}T12:00:00Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
        const btn = dayButton(o.page, label).first();
        const cls = (await btn.getAttribute('class')) ?? '';
        expect(cls.includes('peak'), d.date).toBe(d.mode === 'four_hour');
        expect(cls.includes('closed'), d.date).toBe(d.mode === 'closed');
        if (d.mode !== 'closed') expect(await btn.locator('.m').innerText(), d.date).toBe(`${d.booked} of ${d.capacity}`);
        if (d.mode === 'four_hour') expect(await btn.locator('.why').innerText()).toBe(d.reason);
      }
      // The picked day opens on today.
      expect(await text(o.page, 'button.day.picked')).toContain('Today');
      expect(await text(o.page, '.dayset h4')).toBe('Tue, Sep 15 - 2-hour windows');
      // Nothing is changed yet: Save changes and Discard are off.
      expect(await o.page.locator('button[data-ctl="CTL-OFC-12-06"]').getAttribute('aria-disabled')).toBe('true');
      expect(await o.page.locator('button[data-ctl="CTL-OFC-12-07"]').getAttribute('aria-disabled')).toBe('true');
      expect(await o.page.locator('.dayset .kv').count()).toBe(0);
      // F-750: the page shares the tab's 1 event connection, which carries no ?branch: the page's own subscription names its branch.
      expect(o.streams.map((u) => new URL(u).search)).toEqual(['']);
    } finally {
      await close(o);
    }
  });

  // why: FR-BOOK-2, FR-BOOK-18 (F-589, F-781) the week board's day-mode menu opens the confirm on the week board itself (CTL-OFC-34-15, SCR-OFC-24), Cancel holding the first focus and Escape closing it with no change
  it('opens the confirm for Thu, Sep 17 from the week board\'s day-mode menu, on the week board, with Cancel focused, and Escape changes nothing', async () => {
    const o = await open(browser, 'keisha', '/office/board/week?branch=columbus&week=2026-09-14');
    try {
      const menu = o.page.locator('button[data-ctl="CTL-OFC-34-15"][aria-label="Day mode, Thu, Sep 17"]');
      await menu.waitFor({ state: 'visible', timeout: 60_000 });
      await menu.click();
      await o.page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 60_000 });
      expect(o.page.url()).toContain('/office/board/week');
      expect(await dialogTitle(o.page)).toBe('Switch Thu, Sep 17 to 4-hour windows?');
      expect(await o.page.evaluate("document.activeElement && document.activeElement.getAttribute('data-ctl')")).toBe('CTL-OFC-24-03');
      // Switch is off until a reason is typed.
      expect(await o.page.locator('button[data-ctl="CTL-OFC-24-02"]').getAttribute('aria-disabled')).toBe('true');
      await o.page.keyboard.press('Escape');
      await o.page.locator('[role="dialog"]').waitFor({ state: 'detached' });
      expect((await dayOf('2026-09-17')).mode).toBe('two_hour');
    } finally {
      await close(o);
    }
  });

  // why: F-752 CTL-OFC-12-06 the top bar's branch choice with unsaved numbers asks Leave without saving? as the page's own tabs do: Cancel keeps the branch and the typed number, OK leaves
  it('asks Leave without saving? on a top-bar branch choice with a typed number', async () => {
    const o = await open(browser, 'keisha', '/office/admin/windows?branch=columbus');
    try {
      await ready(o.page);
      const field = o.page.locator('table.w tbody tr input.bw-step-in').first();
      const original = await field.inputValue();
      const typed = String(Number(original) + 1);
      await field.fill(typed);
      expect(await text(o.page, 'span.unsaved')).toBe('Unsaved changes');
      const asked: string[] = [];
      let answer = false;
      o.page.on('dialog', (d) => {
        asked.push(d.message());
        void (answer ? d.accept() : d.dismiss());
      });
      const topBar = o.page.locator('.topbar select');
      await topBar.selectOption('dayton');
      await until('the question', async () => asked.length, (n) => n === 1);
      expect(asked).toEqual(['Leave without saving?']);
      expect(o.page.url()).toContain('branch=columbus');
      expect(await field.inputValue()).toBe(typed);
      answer = true;
      await topBar.selectOption('dayton');
      await until('the Dayton address', async () => o.page.url(), (u) => u.includes('branch=dayton'));
      expect(asked).toHaveLength(2);
    } finally {
      await close(o);
    }
  });

  // why: FR-BOOK-2, FR-BOOK-18 (F-748, F-589) the week board's day-mode menu works on a day past the 2 calendar weeks, and past API-90's 70-day range: the confirm opens for that day, the switch saves with its reason, and the link then opens the switch back
  it('opens the confirm from the week board for a day past the 2 calendar weeks, switches the day and switches it back', async () => {
    for (const [week, date, label] of [['2026-10-05', '2026-10-07', 'Wed, Oct 7'], ['2027-01-04', '2027-01-06', 'Wed, Jan 6']] as const) {
      const fromBoard = async (): Promise<Open> => {
        const o = await open(browser, 'dana', `/office/board/week?branch=columbus&week=${week}`);
        const menu = o.page.locator(`button[data-ctl="CTL-OFC-34-15"][aria-label="Day mode, ${label}"]`);
        await menu.waitFor({ state: 'visible', timeout: 60_000 });
        await menu.click();
        await o.page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 60_000 });
        return o;
      };
      const there = await fromBoard();
      try {
        expect(await dialogTitle(there.page)).toBe(`Switch ${label} to 4-hour windows?`);
        await there.page.locator('#bw-dlg-reason').fill('Heat advisory');
        await there.page.locator('button[data-ctl="CTL-OFC-24-02"]').click();
        await there.page.locator('[role="dialog"]').waitFor({ state: 'detached' });
        const day = await until('the far day to be a 4-hour day', () => oneDay(date), (d) => d.mode === 'four_hour');
        expect([day.reason, day.switchedBy]).toEqual(['Heat advisory', 'Dana Ruiz']);
        expect(there.page.url()).toContain('/office/board/week');
      } finally {
        await close(there);
      }
      const back = await fromBoard();
      try {
        expect(await dialogTitle(back.page)).toBe(`Switch ${label} back to 2-hour windows?`);
        await back.page.locator('button[data-ctl="CTL-OFC-24-02"]').click();
        await back.page.locator('[role="dialog"]').waitFor({ state: 'detached' });
        await until('the far day to be a 2-hour day', () => oneDay(date), (d) => d.mode === 'two_hour');
      } finally {
        await close(back);
        await api('dana', 'PUT', `/branches/columbus/days/${date}/mode`, { mode: 'two_hour' });
      }
    }
  });

  // why: FR-BOOK-2 after a switch booking offers only the 4 windows (API-29) and refuses a 2-hour window (API-28, rule_refused); a switch back offers the 5 again
  it('offers only the 4 windows after a switch and refuses a 2-hour booking, through API-29 and API-28', async () => {
    const date = '2026-09-24';
    const offered = async () => {
      const r = await api('keisha', 'GET', `/availability?branch=columbus&serviceId=furnace_tune_up&from=${date}&to=${date}&channel=office`);
      expect(r.status).toBe(200);
      const d = r.body.data.days[0] as Json;
      return [d.mode, (d.windows as Json[]).map((w) => [w.start.slice(11, 16), w.end.slice(11, 16)])];
    };
    expect((await offered())[0]).toBe('two_hour');
    expect((await api('dana', 'PUT', `/branches/columbus/days/${date}/mode`, { mode: 'four_hour', reason: 'Heat advisory' })).status).toBe(200);
    try {
      expect(await offered()).toEqual(['four_hour', [['08:00', '12:00'], ['10:00', '14:00'], ['12:00', '16:00'], ['14:00', '18:00']]]);
      const refused = await api('keisha', 'POST', '/jobs', { customerId: customer(index + 8), serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date, windowId: windowId('10:00'), technicianId: null });
      expect([refused.status, refused.body.code, refused.body.key]).toEqual([409, 'rule_refused', 'rule.windowNotOffered']);
    } finally {
      expect((await api('dana', 'PUT', `/branches/columbus/days/${date}/mode`, { mode: 'two_hour' })).status).toBe(200);
    }
    expect((await offered())[1]).toEqual([['08:00', '10:00'], ['10:00', '12:00'], ['12:00', '14:00'], ['14:00', '16:00'], ['16:00', '18:00']]);
  });

  // why: FR-BOOK-17 (CTL-OFC-12-02) the rules the page states are API-90's own numbers; FR-BOOK-18 (CTL-OFC-24-04) the reason typed in the panel is what the confirm's Reason field starts with, and Cancel changes nothing
  it('states the booking rules from API-90 and carries the reason typed in the panel into the confirm', async () => {
    const r = (await settings()).rules as Json;
    const o = await open(browser, 'keisha', '/office/admin/windows?branch=columbus&date=2026-09-17');
    try {
      await ready(o.page);
      const rules = await text(o.page, '[data-ctl="CTL-OFC-12-02"]');
      expect(rules).toContain(`${clock(r.onlineCutoff)} the day before, branch time`);
      expect(rules).toContain(`${r.capacities.twoHour}; ${r.capacities.fourHour} on a 4-hour day; ${r.capacities.saturday} on Saturday`);
      expect(rules).toContain(`${clock(r.reminder)} the evening before`);
      expect(rules).toContain(`Texts wait until ${clock(r.quietTo).replace(':00', '')} in the customer's own time.`);
      expect(await text(o.page, '.dayset h4')).toBe('Thu, Sep 17 - 2-hour windows');
      await o.page.locator('[data-ctl="CTL-OFC-12-13"] input').fill('Cold snap');
      await o.page.locator('[data-ctl="CTL-OFC-12-04"]').click();
      await o.page.locator('[role="dialog"]').waitFor({ state: 'visible' });
      expect(await o.page.locator('#bw-dlg-reason').inputValue()).toBe('Cold snap');
      await o.page.keyboard.press('Escape');
      await o.page.locator('[role="dialog"]').waitFor({ state: 'detached' });
      expect((await dayOf('2026-09-17')).mode).toBe('two_hour');
    } finally {
      await close(o);
    }
  });

  // why: UC-13, FR-BOOK-2, FR-BOOK-8, FR-BOOK-18 the manager switches Wed, Sep 16 with the reason "Heat advisory" while a 10 AM-12 PM booking holds that day: the booking keeps its 2-hour window on the board page (its card and the day's label), on its job page and in its reminder text; the page and the week board show the reason, who and when, the time included
  it('UC-13: switches Wed, Sep 16 to 4-hour windows and a 10 AM-12 PM booking still shows 10 AM-12 PM on the board, its job page and its reminder text', async () => {
    const o = await open(browser, 'dana', '/office/admin/windows?branch=columbus&date=2026-09-16');
    try {
      await ready(o.page);
      // The seed switched Wed, Sep 16: switch it back on the page, as the confirm for a switch back says.
      expect(await text(o.page, '.dayset h4')).toBe('Wed, Sep 16 - 4-hour windows');
      await o.page.locator('button[data-ctl="CTL-OFC-12-05"]').click();
      await o.page.locator('[role="dialog"]').waitFor({ state: 'visible' });
      expect(await dialogTitle(o.page)).toBe('Switch Wed, Sep 16 back to 2-hour windows?');
      await o.page.locator('button[data-ctl="CTL-OFC-24-02"]').click();
      await o.page.locator('[role="dialog"]').waitFor({ state: 'detached' });
      await until('the day to be a 2-hour day', () => dayOf('2026-09-16'), (d) => d.mode === 'two_hour');
      await until('the panel to re-read the day', () => text(o.page, '.dayset h4'), (v) => v === 'Wed, Sep 16 - 2-hour windows');

      // A booking for 10 AM to 12 PM that day, made by the office (API-28).
      const w10 = windowId('10:00');
      const made = await api('keisha', 'POST', '/jobs', { customerId: customer(index), serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: '2026-09-16', windowId: w10, technicianId: null });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const job: number = made.body.data.job.jobNumber;
      expect(made.body.data.job.window.start).toMatch(/T10:00:00-04:00/);
      const before = psql(`SELECT window_id || '|' || window_start || '|' || window_end FROM world.job WHERE job_number = ${job}`);

      // The switch: pick the day, turn 4-hour windows on, type the reason in the dialog, Switch.
      const d0 = await dayOf('2026-09-16');
      const kept = d0.bookedCount as number;
      expect(kept).toBeGreaterThan(0);
      // The open page has read the booking (the board event re-reads it) before the dialog counts the customers.
      await until('the page to count the booking', () => text(o.page, 'button.day.picked .m'), (v) => v === `${d0.booked} of ${d0.capacity}`);
      await o.page.locator('[data-ctl="CTL-OFC-12-04"]').click();
      await o.page.locator('[role="dialog"]').waitFor({ state: 'visible' });
      expect(await dialogTitle(o.page)).toBe('Switch Wed, Sep 16 to 4-hour windows?');
      expect(await text(o.page, '[data-ctl="CTL-OFC-24-01"]')).toContain(`The ${kept} customer${kept === 1 ? '' : 's'} already booked keep${kept === 1 ? 's' : ''} their 2-hour window${kept === 1 ? '' : 's'}.`);
      expect(await text(o.page, '[data-ctl="CTL-OFC-24-01"]')).toContain('Booking then offers only 8 AM-12 PM, 10 AM-2 PM, 12-4 PM and 2-6 PM that day.');
      await o.page.locator('#bw-dlg-reason').fill('Heat advisory');
      await o.page.locator('button[data-ctl="CTL-OFC-24-02"]').click();
      await o.page.locator('[role="dialog"]').waitFor({ state: 'detached' });
      const day = await until('the day to be a 4-hour day', () => dayOf('2026-09-16'), (d) => d.mode === 'four_hour');
      expect([day.reason, day.switchedBy]).toEqual(['Heat advisory', 'Dana Ruiz']);
      expect(ms(day.switchedAt)).toBeGreaterThan(0);

      // The page shows the new mode, the reason, who and when, and the bookings kept.
      await until('the panel to re-read the day', () => text(o.page, '.dayset h4'), (v) => v === 'Wed, Sep 16 - 4-hour windows');
      const kv = await text(o.page, '.dayset .kv');
      expect(kv).toContain('Reason: Heat advisory');
      expect(kv).toMatch(/Switched by Dana R\., (Tue|Wed|Thu), Sep \d+, \d+:\d\d (AM|PM)\./);
      expect(kv).toContain('Fri, Sep 18 is switched too.');
      expect(kv).toContain(`The ${kept} customer${kept === 1 ? '' : 's'} already booked keep${kept === 1 ? 's' : ''} their 2-hour window${kept === 1 ? '' : 's'}.`);
      expect(await o.page.locator('button.day.picked').getAttribute('class')).toContain('peak');

      // The booking keeps its 2-hour window: the row, the board, the job page.
      expect(psql(`SELECT window_id || '|' || window_start || '|' || window_end FROM world.job WHERE job_number = ${job}`)).toBe(before);
      const board = (await api('keisha', 'GET', '/board?branch=columbus&date=2026-09-16')).body.data;
      expect(board.dayMode).toBe('four_hour');
      const shown = [...board.technicians.flatMap((t: Json) => t.jobs), ...board.unassigned].find((j: Json) => j.jobNumber === job);
      expect([shown.windowId, shown.window.start.slice(11, 16), shown.window.end.slice(11, 16)]).toEqual([w10, '10:00', '12:00']);
      // The board page itself (F-749): the day's label and the job's card, in the words the dispatcher reads.
      const boardPage = await open(browser, 'keisha', '/office/board?branch=columbus&date=2026-09-16');
      try {
        await boardPage.page.locator(`[data-job="${job}"]`).waitFor({ state: 'visible', timeout: 60_000 });
        expect(await text(boardPage.page, '[data-ctl="CTL-OFC-02-07"]')).toBe('4-hour windows');
        expect(await boardPage.page.locator(`#jd${job}`).textContent()).toContain('Window 10 AM-12 PM.');
      } finally {
        await close(boardPage);
      }
      const jobPage = await open(browser, 'keisha', `/office/jobs/${job}`);
      try {
        await until('the job page to show its window', () => jobPage.page.locator('body').innerText(), (t) => t.includes('10 AM-12 PM'));
      } finally {
        await close(jobPage);
      }

      // The reminder text, sent by the worker at 6:00 PM the evening before, names the 2-hour window.
      const now = (await api('dana', 'GET', '/clock')).body.data.demoNow as string;
      if (ms(now) < ms(WIRE_6PM)) await jumpTo(WIRE_6PM);
      const body = await until('the reminder text', () => psql(`SELECT status || '|' || body FROM world.outbox_text WHERE job_number = ${job} AND kind = 'reminder'`), (v) => v.startsWith('delivered|'), 240);
      expect(body).toContain('10 AM-12 PM');
      expect(body).not.toMatch(/10 AM-2 PM|8 AM-12 PM/);

      // The week board shows the reason, who and when (FR-BOOK-18).
      const week = await open(browser, 'keisha', '/office/board/week?branch=columbus&week=2026-09-14');
      try {
        const peak = await until('the week board peak days', async () => (await week.page.locator('[data-ctl="CTL-OFC-34-09"]').count()) > 0 ? text(week.page, '[data-ctl="CTL-OFC-34-09"]') : '', (t) => t.includes('switched by Dana R.'));
        expect(peak).toContain('Heat advisory');
        expect(peak).toContain('Wed, Sep 16');
        // The time, as the page says it, from the switch's own zone (F-749).
        expect(peak).toContain(`Wed, Sep 16, Heat advisory, switched by Dana R., ${wall(day.switchedAt as string)}.`);
      } finally {
        await close(week);
      }
      const wk = (await api('keisha', 'GET', '/board/week?branch=columbus&week=2026-09-14')).body.data.days.find((d: Json) => d.date === '2026-09-16');
      expect([wk.peak, wk.reason, wk.switchedBy, wk.switchedAt]).toEqual([true, 'Heat advisory', 'Dana Ruiz', day.switchedAt]);
    } finally {
      await close(o);
    }
  });

  // why: FR-BOOK-17 a capacity below a window's bookings on an upcoming day is refused with the reason on the field and nothing saved, Discard puts the saved number back, the capacity saved at the bookings is kept, and the booking past it is refused (window_full)
  it('refuses a capacity below the bookings with the reason on its field, then saves the capacity at the bookings, and refuses the booking past it', async () => {
    const today = (await settings()).today as string;
    const top = psql(`SELECT w.id || '|' || to_char(w.start_local, 'HH24:MI') || '|' || j.date::text || '|' || count(*) FROM world.job j JOIN world.arrival_window w ON w.id = j.window_id
      WHERE j.branch_id = 'columbus' AND j.status <> 'canceled' AND j.date >= '${today}' AND w.mode = 'two_hour' GROUP BY w.id, w.start_local, j.date ORDER BY count(*) DESC, j.date, w.start_local LIMIT 1`).split('|');
    const [wid, start, date, n] = [top[0]!, top[1]!, top[2]!, Number(top[3])];
    expect(n).toBeGreaterThan(0);
    const original = ((await settings()).windows as Json[]).find((w) => w.windowId === wid).limit as number;
    const row = (p: Page) => p.locator('table.w tbody tr', { has: p.locator(`input[aria-label*="${labelOf(start)}"]`) });
    const o = await open(browser, 'keisha', '/office/admin/windows?branch=columbus');
    try {
      await ready(o.page);
      const field = row(o.page).locator('input.bw-step-in');
      const save = o.page.locator('button[data-ctl="CTL-OFC-12-06"]');
      const discard = o.page.locator('button[data-ctl="CTL-OFC-12-07"]');

      // One below the bookings: refused, the reason on that field, the number kept, nothing saved.
      await field.fill(String(n - 1));
      expect(await text(o.page, 'span.unsaved')).toBe('Unsaved changes');
      expect(await save.getAttribute('aria-disabled')).toBeNull();
      await save.click();
      const msg = await until('the refusal on the field', () => text(o.page, 'table.w .r1-fmsg'), (t) => t.length > 0);
      expect(msg).toMatch(new RegExp(`^Columbus ${labelOf(start)} has ${n} bookings? on \\w{3}, \\w{3} \\d+\\. Its capacity cannot go below ${n}\\.$`));
      expect(await field.inputValue()).toBe(String(n - 1));
      expect(((await settings()).windows as Json[]).find((w) => w.windowId === wid).limit).toBe(original);
      // Discard puts the saved number back.
      await discard.click();
      expect(await field.inputValue()).toBe(String(original));
      expect(await save.getAttribute('aria-disabled')).toBe('true');

      // Raise by 1 and save, then save the capacity at the bookings: both are kept.
      await field.fill(String(n + 1));
      await save.click();
      await until('the raised limit', async () => ((await settings()).windows as Json[]).find((w) => w.windowId === wid).limit, (v) => v === n + 1);
      await until('Save to be off again', () => save.getAttribute('aria-disabled'), (v) => v === 'true');
      await field.fill(String(n));
      await save.click();
      await until('the limit at the bookings', async () => ((await settings()).windows as Json[]).find((w) => w.windowId === wid).limit, (v) => v === n);
      expect(await field.inputValue()).toBe(String(n));

      // Booking now refuses the next place in that window on that day.
      const next = await api('keisha', 'POST', '/jobs', { customerId: customer(index + 5), serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date, windowId: wid, technicianId: null });
      expect([next.status, next.body.code]).toEqual([409, 'window_full']);
    } finally {
      await api('keisha', 'PUT', '/branches/columbus/window-limits', { limits: [{ windowId: wid, limit: original }] });
      await close(o);
    }
  });

  // why: FR-BOOK-2, FR-BOOK-10 (manager ruling X-2a) a Saturday offers only its 2 morning windows and no 4-hour switch, on the page and at the API; a Sunday and a past day are refused
  it('offers a Saturday no 4-hour switch: the panel lists 2 windows, the switch and reason are off, and API-91 refuses it, a Sunday and a past day', async () => {
    const o = await open(browser, 'keisha', '/office/admin/windows?branch=columbus&date=2026-09-19');
    try {
      await ready(o.page);
      expect(await text(o.page, '.dayset h4')).toBe('Sat, Sep 19 - 2-hour windows');
      expect(await o.page.locator('.dayset .wins span').allInnerTexts()).toEqual(['8-10 AM', '10 AM-12 PM']);
      expect(await o.page.locator('[data-ctl="CTL-OFC-12-04"]').getAttribute('aria-disabled')).toBe('true');
      expect(await o.page.locator('[data-ctl="CTL-OFC-12-13"] input').isDisabled()).toBe(true);
      expect(await text(o.page, '.dayset .bw-win-sat')).toBe('Saturdays are a half-day with 2-hour windows only.');
      await o.page.locator('[data-ctl="CTL-OFC-12-04"]').click({ force: true });
      expect(await o.page.locator('[role="dialog"]').count()).toBe(0);
      expect(await o.page.locator('button.day.closed .pill.off').first().innerText()).toBe('Closed');
    } finally {
      await close(o);
    }
    const put = (date: string, mode: string) => api('dana', 'PUT', `/branches/columbus/days/${date}/mode`, { mode, reason: 'Heat advisory' });
    const sat = await put('2026-09-19', 'four_hour');
    expect([sat.status, sat.body.code]).toEqual([409, 'rule_refused']);
    expect([(await put('2026-09-20', 'four_hour')).body.code, (await put('2026-09-14', 'four_hour')).body.code]).toEqual(['day_closed', 'day_past']);
    expect((await dayOf('2026-09-19')).mode).toBe('two_hour');
  });

  // why: FR-LANG-3 the page and its switch dialog read in Spanish, with the calendar's modes and the panel in the other language
  it('shows the page and the confirm in Spanish', async () => {
    const o = await open(browser, 'keisha', '/office/admin/windows?branch=columbus&date=2026-09-17&switch=1', 'es');
    try {
      await ready(o.page);
      expect(await text(o.page, 'h1')).toBe('Ventanas de llegada');
      await o.page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 60_000 });
      expect(await dialogTitle(o.page)).toMatch(/^¿Cambiar .* a ventanas de 4 horas\?$/);
      expect(await text(o.page, 'button.day .pill.four')).toBe('4 horas');
    } finally {
      await close(o);
    }
  });
});

/** "4-6 PM" for a window start (HH:MM) of the 5 two-hour windows, as the page labels the field. */
function labelOf(start: string): string {
  const h = Number(start.slice(0, 2));
  const end = h + 2;
  const mer = (n: number) => (n < 12 ? 'AM' : 'PM');
  const n12 = (n: number) => (n % 12 === 0 ? 12 : n % 12);
  return mer(h) === mer(end) ? `${n12(h)}-${n12(end)} ${mer(end)}` : `${n12(h)} ${mer(h)}-${n12(end)} ${mer(end)}`;
}
