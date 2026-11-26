// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-12, FR-TEXT-13, FR-TEXT-15, FR-TEXT-24, FR-TEXT-25 (P4-MESSAGES Acceptance: Playwright on Chromium and WebKit against the Compose stack)
// The Messages text log and call list against the Compose stack at its default settings (real PostgreSQL 18, real handlers, the worker and pbs
// running), through its proxy, with the outside-origin guard on. The demo clock is paused and moved by the suite (UPDATE system.demo_clock), the
// way a jump moves it; the worker sends the texts and fires the reminders at the clock's time. The rows the suite stands on are
// ci/shell-stack/fixture.sql's and ci/messages-stack/fixture.sql's. Each engine works on its own pair of days (2 days later than the engine
// before), so the demo clock only moves forward.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoDayCases } from '../demo-day.ts';
import { guardedContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_MESSAGES_STACK_URL;
const session = process.env.BW_MESSAGES_STACK_SESSION;
const dbContainer = process.env.BW_MESSAGES_DB_CONTAINER;
if (!base || !session || !dbContainer) throw new Error('BW_MESSAGES_STACK_URL, _SESSION and _DB_CONTAINER are not set: run ci/messages-stack.sh');
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): a write carries it, as a browser on the default stack's own origin would.
const APP_ORIGIN = 'http://localhost:8080';
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };

const ANN = '0192f000-0000-7000-8000-00000000c001';
const ANNE = '0192f000-0000-7000-8000-00000000c002';
const TESSA = '0192f000-0000-7000-8000-00000000c010'; // texts off
const MIA = '0192f000-0000-7000-8000-00000000c011'; // texts on, a mobile
const NOLAN = '0192f000-0000-7000-8000-00000000c012'; // no mobile
const WINDOW = '0192f000-0000-7000-8000-00000000b001';

function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', dbContainer!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The demo clock, paused at `iso`. The web kernel and the worker cache the clock row for 250 ms. */
async function setClock(iso: string): Promise<void> {
  psql(`UPDATE system.demo_clock SET demo_anchor = '${iso}', real_anchor = now(), paused = true`);
  await sleep(450);
}

/** Poll until `cond` holds; the worker acts within its own poll, so a test waits for its result rather than for a time. */
async function until<T>(what: string, read: () => T | Promise<T>, cond: (v: T) => boolean, tries = 240): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i += 1) {
    last = await read();
    if (cond(last)) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}; last read: ${JSON.stringify(last).slice(0, 600)}`);
}

/** One API call with the stack's session cookie and the default origin (node's fetch drops a script's Origin header; the kernel refuses a write without it, SD-8). */
function api<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: T; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(`${origin}/api/v1${path}`, {
      method,
      headers: { cookie: `bw_session=${session}`, origin: APP_ORIGIN, ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode ?? 0, data: (JSON.parse(text) as { data?: T }).data as T, raw: text });
        } catch {
          resolve({ status: res.statusCode ?? 0, data: text as unknown as T, raw: text });
        }
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** The page's API writes reach the real handlers carrying the default stack's origin (the way billing.stack.ts does it). */
async function writeOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    try {
      const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
      return await r.fulfill({ response });
    } catch {
      return undefined; // the page closed under the request
    }
  });
}

const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** An instant at a New York wall time in September (EDT is UTC-4 until Nov 1). */
const edt = (date: string, hh: number, mm: number): string => {
  const utc = new Date(Date.parse(`${date}T00:00:00Z`) + ((hh + 4) * 60 + mm) * 60_000);
  return utc.toISOString().replace('.000Z', 'Z');
};
const FIRST_DAY = '2026-09-15';

/** A text and its first try as the outbox writes them (enqueueText): the row, and the 1 text.try event at `tryAt` when it has one. */
function plantText(o: { customer: string; job: number | null; body: string; status: 'queued' | 'retrying'; at: string; tries?: number; tryAt?: string | null; number?: number }): string {
  const id = psql(`
    INSERT INTO world.outbox_text (customer_id, job_number, kind, language, encoding, body, characters, status, tries, due_at, created_at, next_try_at)
    VALUES ('${o.customer}', ${o.job ?? 'NULL'}, 'confirmation', 'en', 'gsm7', '${o.body}', ${o.body.length}, '${o.status}', ${o.tries ?? 0}, '${o.at}', '${o.at}', ${o.tryAt ? `'${o.tryAt}'` : 'NULL'})
    RETURNING id`).split('\n')[0]!;
  if ((o.tries ?? 0) > 0) psql(`INSERT INTO world.text_attempt (text_id, number, at, result, reason) VALUES ('${id}', 1, '${o.at}', 'failed', 'simulator_all_fail')`);
  if (o.tryAt) {
    psql(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ('${o.tryAt}', 'text.try', '${id}', '{"textId":"${id}","number":${o.number ?? 1}}', 'due')`);
  }
  return id;
}
const attempts = (id: string): number => Number(psql(`SELECT count(*) FROM world.text_attempt WHERE text_id = '${id}'`));

const norm = (t: string | null) => (t ?? '').replace(/\s+/g, ' ').trim();

describe.each(engines.map((e, i) => [...e, i] as const))('messages on the stack, %s', (engine, type, k) => {
  let browser: Browser;
  // Each engine works 2 days later than the one before: the demo clock only moves forward.
  const DAY = addDays(FIRST_DAY, 2 * k);
  const NEXT = addDays(DAY, 1);
  const tag = `stack-${engine}`;

  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function open(path: string, opts: BrowserContextOptions = DESKTOP) {
    const g = await guardedContext(browser, [origin], opts);
    await g.context.addCookies([{ name: 'bw_session', value: session!, url: origin }]);
    const p = await g.context.newPage();
    await writeOrigin(p);
    await p.goto(origin + path, { waitUntil: 'load' });
    return { g, p };
  }

  // why: FR-TEXT-12, FR-TEXT-13, FR-TEXT-24 UC-06: after the 5th failed try (never a 6th) the customer is on the call list and the office has an alert; Add to call list and the export
  it('puts the customer on the call list after the 5th failed try, shows the text as Not sent, adds a failed text from the log, and exports the log\'s rows', async () => {
    await setClock(edt(DAY, 10, 0));
    psql(`UPDATE world.text_simulator SET mode = 'all_fail'`);
    const body5 = `${tag} five tries`;
    const body3 = `${tag} add to list`;
    const five = plantText({ customer: ANN, job: 24800, body: body5, status: 'queued', at: edt(DAY, 10, 0), tryAt: edt(DAY, 10, 0), number: 1 });
    const added = plantText({ customer: ANN, job: 24800, body: body3, status: 'retrying', tries: 1, at: edt(DAY, 9, 59) });
    // The tries are at 0, 2, 4, 9 and 19 minutes (SPECIFICATIONS 5.2 step 3): the clock moves to each and the worker makes it.
    for (const [i, minute] of [0, 2, 4, 9, 19].entries()) {
      await setClock(edt(DAY, 10, minute));
      await until(`try ${i + 1} of the text`, () => attempts(five), (n) => n >= i + 1);
    }
    await until('the text given up', () => psql(`SELECT status FROM world.outbox_text WHERE id = '${five}'`), (s) => s === 'gave_up');
    expect(attempts(five)).toBe(5);
    // Time passes: there is never a 6th try, and no try waits to be made.
    await setClock(edt(DAY, 11, 0));
    await sleep(2500);
    expect(attempts(five)).toBe(5);
    expect(psql(`SELECT count(*) FROM world.scheduled_event WHERE kind = 'text.try' AND subject = '${five}' AND state = 'due'`)).toBe('0');
    expect(psql(`SELECT reason || ' ' || call_date FROM world.call_list_entry WHERE text_id = '${five}'`)).toBe(`text_gave_up ${DAY}`);
    expect(psql(`SELECT count(*) FROM world.alert WHERE type = 'text_gave_up' AND subject = '${five}'`)).toBe('1');

    // The call list: the customer is in "Texts that could not be sent", with the fifth failure named.
    const calls = await open(`/office/messages/call-list?branch=columbus&date=${DAY}`);
    await calls.p.waitForSelector('[data-ctl="CTL-OFC-09-03"] .fr');
    const failed = calls.p.locator('[data-ctl="CTL-OFC-09-03"] .fr', { hasText: 'Ann Lee' });
    expect(await failed.count()).toBeGreaterThanOrEqual(1);
    expect(norm(await failed.first().innerText())).toContain('5th try failed');
    await calls.g.context.close();

    // The log: the text is Not sent; the failed text that is still retrying can be put on the call list by hand.
    const log = await open(`/office/messages?branch=columbus&date=${DAY}`);
    await log.p.waitForSelector('table.log tbody tr');
    const rowFive = log.p.locator('table.log tbody tr', { hasText: body5 });
    expect(norm(await rowFive.locator('.chip').innerText())).toBe('Not sent');
    const rowAdd = log.p.locator('table.log tbody tr', { hasText: body3 });
    expect(norm(await rowAdd.locator('.chip').innerText())).toBe('Failed - retrying');
    await rowAdd.click();
    await log.p.waitForSelector('.detp [data-ctl="CTL-OFC-08-19"]');
    expect(await log.p.locator('.detp [data-ctl="CTL-OFC-08-18"]').count(), 'Call customer shows on a failed text').toBe(1);
    await log.p.locator('.detp [data-ctl="CTL-OFC-08-19"]').click();
    await log.p.waitForSelector('.detp .bw-pm-added');
    expect(norm(await log.p.locator('.detp .bw-pm-added').innerText())).toMatch(/^On the call list, added by Keisha T\. at \d{1,2}:\d{2} [AP]M$/);
    expect(psql(`SELECT reason || ' ' || (added_by IS NOT NULL) FROM world.call_list_entry WHERE text_id = '${added}'`)).toBe('added_by_office true');
    expect(await log.p.locator('.detp [data-ctl="CTL-OFC-08-19"]').getAttribute('aria-disabled')).toBe('true');

    // Export to spreadsheet: the file's rows equal the rows on the screen (FR-TEXT-24).
    const [download] = await Promise.all([log.p.waitForEvent('download'), log.p.locator('[data-ctl="CTL-OFC-08-20"]').click()]);
    // The saved file starts with the UTF-8 byte order mark and carries the server's name (SPECIFICATIONS 7.5; F-654, F-657).
    const raw = readFileSync((await download.path())!);
    expect([...raw.subarray(0, 3)], 'the saved file starts with EF BB BF').toEqual([0xef, 0xbb, 0xbf]);
    expect(download.suggestedFilename()).toMatch(/^text-log-columbus-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = raw.toString('utf8').replace(/^﻿/, '');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Time,Customer,Type,Language,Text,Status');
    expect(lines.length - 1).toBe(await log.p.locator('table.log tbody tr').count());
    expect(lines.some((l) => l.includes(body5) && l.endsWith('Not sent - all 5 tries failed'))).toBe(true);
    await log.g.context.close();
    psql(`UPDATE world.text_simulator SET mode = 'up'`);
  }, 360_000);

  // why: FR-TEXT-13, FR-TEXT-25 owner ruling 86ecd5ae F-446 (Send it right away): an office-created job booked at 7:15 PM for the next morning gets its reminder at once, and for a customer with texts off it is on the call list
  it('gives a visit booked at 7:15 PM for tomorrow morning its reminder at once, puts a texts-off or no-mobile customer on the call list, and records the call outcomes', async () => {
    psql(`UPDATE world.text_simulator SET mode = 'up'`);
    await setClock(edt(DAY, 19, 15));
    const book = async (customer: string) => {
      const r = await api<{ job: { jobNumber: number } }>('POST', '/jobs', { customerId: customer, serviceId: 'tune_up', equipmentId: null, problem: null, date: NEXT, windowId: WINDOW, technicianId: null });
      if (r.status === 500) {
        const name = spawnSync('docker', ['ps', '--filter', 'name=web', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout.split('\n').find((n) => n.includes('messages')) ?? '';
        const logs = spawnSync('docker', ['logs', '--tail', '15', name], { encoding: 'utf8' });
        throw new Error(`booking answered 500; web log: ${(logs.stdout + logs.stderr).slice(-1800)}`);
      }
      if (r.status !== 201) throw new Error(`booking for ${customer} answered ${r.status}: ${r.raw.slice(0, 400)}`);
      return r.data.job.jobNumber;
    };
    const [off, mobile, none] = [await book(TESSA), await book(MIA), await book(NOLAN)];
    // The reminders are planned for now (not for 6:00 PM, which has passed) and the worker makes them within the minute.
    expect(psql(`SELECT count(*) FROM world.scheduled_event WHERE kind = 'text.reminder' AND subject = ANY(ARRAY['${off}', '${mobile}', '${none}']) AND payload ->> 'atOnce' = 'true'`)).toBe('3');
    await until('the reminder texts and call list rows', () => psql(`SELECT
      (SELECT count(*) FROM world.outbox_text WHERE job_number = ${mobile} AND kind = 'reminder' AND status = 'delivered') || ' ' ||
      coalesce((SELECT string_agg(status || ':' || tries, ',') FROM world.outbox_text WHERE job_number = ${mobile}), 'none') || ' ' ||
      coalesce((SELECT string_agg(state || ':' || coalesce(result, ''), ',') FROM world.scheduled_event WHERE subject IN ('${mobile}', '${off}')), 'noevents') || ' ' ||
      (SELECT count(*) FROM world.call_list_entry WHERE job_number IN (${off}, ${none}))`), (v) => v.startsWith('1 ') && v.endsWith(' 2'));
    expect(psql(`SELECT reason || ' ' || call_date FROM world.call_list_entry WHERE job_number = ${off}`)).toBe(`texts_off ${DAY}`);
    expect(psql(`SELECT reason || ' ' || call_date FROM world.call_list_entry WHERE job_number = ${none}`)).toBe(`no_mobile ${DAY}`);
    expect(psql(`SELECT count(*) FROM world.outbox_text WHERE job_number IN (${off}, ${none})`)).toBe('0');
    const reminder = psql(`SELECT body FROM world.outbox_text WHERE job_number = ${mobile} AND kind = 'reminder'`);
    expect(reminder).toContain('arrives tomorrow, 8-10 AM');

    const calls = await open(`/office/messages/call-list?branch=columbus&date=${DAY}`);
    await calls.p.waitForSelector('table.cl tbody tr');
    const row = (name: string) => calls.p.locator('table.cl tbody tr', { hasText: name });
    expect(norm(await row('Tessa Offtext').locator('td').nth(1).innerText())).toContain('Texts turned off');
    expect(norm(await row('Tessa Offtext').locator('td').nth(2).innerText())).toContain('8-10 AM');
    expect(norm(await row('Nolan Nomobile').locator('td').nth(1).innerText())).toContain('No mobile phone');
    expect(await row('Mia Mobile').count(), 'a customer who gets the text is not on the call list').toBe(0);
    // Tomorrow's reminders: 3 visits tomorrow, 1 reminder text and 2 calls.
    const tomorrow = norm(await calls.p.locator('[data-ctl="CTL-OFC-09-12"]').innerText());
    expect(tomorrow).toMatch(/3 visits/);
    expect(tomorrow).toMatch(/1 reminder text/);
    expect(tomorrow).toMatch(/2 calls/);
    expect(norm(await calls.p.locator('[data-ctl="CTL-OFC-08-02"] .n').innerText())).toBe(String((await api<{ count: number }>('GET', `/call-list?branch=columbus&date=${DAY}`)).data.count));
    // The script is the customer's language, with the visit's technician and window (Unassigned has no technician name).
    await row('Tessa Offtext').locator('td').first().click();
    expect(norm(await calls.p.locator('[data-ctl="CTL-OFC-09-09"] .script').innerText())).toContain('arrives between 8 and 10 AM');
    await calls.p.locator('[data-ctl="CTL-OFC-09-10"] [lang="es"]').click();
    expect(norm(await calls.p.locator('[data-ctl="CTL-OFC-09-09"] .script').innerText())).toContain('llega entre las 8 y las 10 AM');

    // No answer keeps the customer to call again; Change then Mark confirmed replaces it, with who and when; the visit shows as confirmed.
    await row('Tessa Offtext').locator('[data-ctl="CTL-OFC-09-07"]').click();
    await row('Tessa Offtext').locator('.chip.noans').waitFor();
    expect(norm(await row('Tessa Offtext').locator('.done small').innerText())).toMatch(/^Keisha T\., \d{1,2}:\d{2} [AP]M$/);
    expect(psql(`SELECT confirmed_at IS NULL FROM world.job WHERE job_number = ${off}`)).toBe('t');
    await row('Tessa Offtext').locator('[data-ctl="CTL-OFC-09-15"]').click();
    await row('Tessa Offtext').locator('[data-ctl="CTL-OFC-09-04"]').click();
    await row('Tessa Offtext').locator('.chip.conf').waitFor();
    expect(psql(`SELECT outcome FROM world.call_list_entry WHERE job_number = ${off}`)).toBe('confirmed');
    expect(psql(`SELECT confirmed_at IS NOT NULL FROM world.job WHERE job_number = ${off}`)).toBe('t');
    expect(await row('Tessa Offtext').locator('[data-ctl="CTL-OFC-09-07"]').count(), 'No answer is off once the row is Confirmed').toBe(0);

    // F-656: Reschedule opens the job page's dialog (SCR-OFC-20) in place on the call list, API-24 moves the visit, and the list then records the outcome (API-38).
    const callsUrl = calls.p.url();
    await row('Nolan Nomobile').locator('[data-ctl="CTL-OFC-09-05"]').click();
    await calls.p.waitForSelector('[data-screen="SCR-OFC-20"] [data-ctl="CTL-OFC-20-01"] button.dy');
    expect(calls.p.url(), 'the call list does not navigate away').toBe(callsUrl);
    const day = calls.p.locator('[data-ctl="CTL-OFC-20-01"] button.dy:not([aria-disabled="true"])').nth(2); // the list starts today; the visit is on the day after, so the 3rd is a different day
    await day.click();
    await calls.p.waitForSelector('[data-ctl="CTL-OFC-20-01"] button.dy[aria-checked="true"]');
    const win = calls.p.locator('[data-ctl="CTL-OFC-20-02"] button.win:not(.full)').first();
    await win.click();
    expect(await win.getAttribute('aria-checked'), await calls.p.locator('[data-screen="SCR-OFC-20"]').innerText()).toBe('true');
    const go = calls.p.locator('[data-screen="SCR-OFC-20"] [data-ctl="CTL-OFC-20-03"]');
    await go.click();
    await row('Nolan Nomobile').locator('.chip.resch').waitFor();
    expect(calls.p.url()).toBe(callsUrl);
    expect(psql(`SELECT outcome FROM world.call_list_entry WHERE job_number = ${none}`)).toBe('reschedule');
    expect(psql(`SELECT count(*) FROM world.job_change WHERE job_number = ${none} AND kind = 'rescheduled'`)).toBe('1');

    // Print call list: the printable page holds the day's rows and hides the screen.
    await calls.p.emulateMedia({ media: 'print' });
    expect(await calls.p.locator('.bw-print').isVisible()).toBe(true);
    expect(await calls.p.locator('.bw-print tbody tr').count()).toBeGreaterThanOrEqual(2);
    expect(await calls.p.locator('.mh').isVisible()).toBe(false);
    await calls.g.context.close();

    // The log: the reminder went out, Delivered.
    const log = await open(`/office/messages?branch=columbus&date=${DAY}`);
    await log.p.waitForSelector('table.log tbody tr');
    const mia = log.p.locator('table.log tbody tr', { hasText: 'Mia Mobile' });
    expect(norm(await mia.first().locator('.ty').innerText())).toBe('Reminder');
    expect(norm(await mia.first().locator('.chip').innerText())).toBe('Delivered');
    await log.g.context.close();
  }, 360_000);

  // why: FR-TEXT-24, FR-TEXT-12 UC-06: Try now on a failed text at 10:00 PM in the customer's zone is held to 8:00 AM, and counts as the next try
  it('holds Try now at 10:00 PM to 8:00 AM the customer\'s time, naming the hour, and leaves the try count alone', async () => {
    // 10:00 PM on DAY (EDT, the customer's zone): the text failed once at 9:50 PM and its 2nd try waits for 10:02 PM.
    await setClock(edt(DAY, 22, 0));
    const body = `${tag} try now at night`;
    const id = plantText({ customer: ANNE, job: null, body, status: 'retrying', tries: 1, at: edt(DAY, 21, 50), tryAt: edt(DAY, 22, 2), number: 2 });
    const log = await open(`/office/messages?branch=columbus&date=${DAY}`);
    await log.p.waitForSelector('table.log tbody tr');
    const row = log.p.locator('table.log tbody tr', { hasText: body });
    await row.click();
    await log.p.waitForSelector('.detp [data-ctl="CTL-OFC-08-17"]');
    await log.p.locator('.detp [data-ctl="CTL-OFC-08-17"]').click();
    await log.p.waitForSelector('.detp .try .w:has-text("Trying now")');
    expect(norm(await log.p.locator('.detp .try .w', { hasText: 'Trying now' }).innerText())).toContain('Quiet hours: this try waits until 8 AM, Eastern time.');
    const ev = psql(`SELECT due_at FROM world.scheduled_event WHERE kind = 'text.try' AND subject = '${id}' AND state = 'due'`);
    expect(new Date(ev.replace(' ', 'T').replace(/\+00$/, 'Z')).toISOString()).toBe(new Date(edt(NEXT, 8, 0)).toISOString());
    expect(attempts(id)).toBe(1);
    await log.g.context.close();
  }, 360_000);

  // why: FR-TEXT-13, FR-DEMO-2 the Call list tab's count follows the day shown: a count that comes back late for a day no longer shown is dropped (F-1977)
  it('keeps the Call list count of the day shown when the count of the day before it comes back late', async () => {
    const OTHER = addDays(DAY, 20); // no visits, so its list is empty
    const count = async (d: string) => (await api<{ count: number }>('GET', `/call-list?branch=columbus&date=${d}`)).data.count;
    const [onDay, onOther] = [await count(DAY), await count(OTHER)];
    expect(onDay, 'the 2 days must differ in their call counts for this case to tell them apart').not.toBe(onOther);
    const log = await open(`/office/messages?branch=columbus&date=${OTHER}`);
    const badge = log.p.locator('[data-ctl="CTL-OFC-08-02"] .n');
    await log.p.waitForSelector('.fbar');
    // The count read for DAY is held; the page then moves back to OTHER, whose own count is read at once.
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    let heldCalls = 0;
    let otherCalls = 0;
    await log.p.route('**/api/v1/call-list?*', async (route) => {
      const asked = new URL(route.request().url()).searchParams.get('date');
      if (asked === OTHER) otherCalls += 1;
      if (asked === DAY) {
        heldCalls += 1;
        await held;
      }
      await route.continue();
    });
    await log.p.locator('[data-ctl="CTL-OFC-08-03"] input').fill(DAY);
    await until('the held count read for the first day', () => heldCalls, (n) => n > 0, 40);
    await log.p.locator('[data-ctl="CTL-OFC-08-03"] input').fill(OTHER);
    // The page is on the other day again and has read its count (the badge alone cannot tell: it still shows that count while the first day is held).
    await log.p.waitForURL((u) => u.searchParams.get('date') === OTHER);
    await until('the count read of the day shown', () => otherCalls, (n) => n > 0, 40);
    release();
    await sleep(1500);
    const shownCount = (await badge.count()) === 0 ? '' : norm(await badge.innerText());
    expect(shownCount, 'the late count of the other day must not replace the count of the day shown').toBe(String(onOther));
    await log.g.context.close();
  }, 120_000);

  /** A signed-in page the demo-day cases load themselves. */
  const followed = (path: string, list: string, ctl: string) => {
    let g: GuardedContext | null = null;
    return {
      origin, list, key: 'date' as const,
      path: `${path}?branch=columbus`,
      pickedPath: `${path}?branch=columbus&date=2026-10-20`,
      picked: '2026-10-20',
      days: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'] as const,
      page: async () => {
        g = await guardedContext(browser, [origin], DESKTOP);
        await g.context.addCookies([{ name: 'bw_session', value: session!, url: origin }]);
        const p = await g.context.newPage();
        await writeOrigin(p);
        return p;
      },
      close: async () => g?.context.close(),
      shown: (p: Page) => p.locator(`[data-ctl="${ctl}"] input`).inputValue(),
    };
  };
  describe('Messages follows the demo day', () => demoDayCases(followed('/office/messages', '/api/v1/text-searches', 'CTL-OFC-08-03')));
  describe('Call list follows the demo day', () => demoDayCases(followed('/office/messages/call-list', '/api/v1/call-list', 'CTL-OFC-09-01')));
});
