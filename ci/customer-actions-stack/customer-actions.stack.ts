// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-31, FR-DISP-30, FR-TEXT-17, FR-TEXT-20, FR-TEXT-13 (P4-CUSTOMER-ACTIONS Acceptance: Playwright on Chromium and WebKit against the Compose stack)
// The customer page's actions and the customer search's Also found in jobs line (SCR-OFC-05, SCR-OFC-06 and the 3 dialogs it hosts, SCR-OFC-35, -36,
// -37) against the Compose stack at its default settings (real PostgreSQL 18, real handlers, pbs running, the worker delivering texts), set up
// by the setup service (the seeded world), through its proxy, every page opened through the outside-origin guard. The people are
// ci/job-stack/fixture.sql's sessions. Run by ci/job-stack.sh after the new job page suite (the same stack, no second bring-up). The
// suite shares 1 world and 1 clock: each engine adds its own equipment, notes and texts to Harold Jenkins, and puts his settings back.
//   FR-DISP-31: Add equipment adds a water heater that his next job's page shows; Add note saves an office note shown with its author and
//   time; Text sends a text that reaches his inbox as 1 message and shows in Recent texts; Edit on a piece of equipment saves it.
//   FR-TEXT-20: with his texts off Text is disabled with its reason (and with no mobile), a direct API-143 answers texts_off and his inbox
//   gains nothing. Last, once (the clock held at 6:01 PM): his next-day visit made through API-28 is on API-42's call list and
//   gets no reminder text when 6:00 PM comes (FR-TEXT-13).
//   FR-TEXT-17: saving a new zone (CTL-OFC-06-07) moves that visit's text.reminder due_at to 6:00 PM in the new zone (F-672).
//   FR-DISP-31: CTL-OFC-06-02 opens API-37's URL in a new tab, and a failed read shows the inline message; the controls read API-07's keys.
//   FR-DISP-30: a search with a matching job shows Also found in jobs, each Job <n> opens SCR-OFC-03, no match hides the line, a failed
//   read shows "Jobs could not be searched." with the customer results standing, and the query is in no URL or log (NFR-05).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Temporal } from '../../packages/time/src/index.ts';
import { guardedContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_JOB_STACK_URL;
const db = process.env.BW_JOB_DB_CONTAINER;
const containers = { web: process.env.BW_JOB_WEB_CONTAINER, proxy: process.env.BW_JOB_PROXY_CONTAINER };
const people = { keisha: process.env.BW_JOB_KEISHA, dana: process.env.BW_JOB_DANA };
if (!base || !db || Object.values(containers).some((v) => !v) || Object.values(people).some((v) => !v)) {
  throw new Error('BW_JOB_STACK_URL, _DB_CONTAINER, _WEB_CONTAINER, _PROXY_CONTAINER and the session tokens are not set: run ci/job-stack.sh');
}
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the suite's proxy listens on a free port, so writes carry the default origin.
const APP_ORIGIN = 'http://localhost:8080';
const ZONE = 'America/New_York';
const HAROLD = 24830;
const PAGE = '.r1-screen[data-screen="SCR-OFC-06"]';
const SEARCH = '.r1-screen[data-screen="SCR-OFC-05"]';
const WHEN = '\\d{1,2}:\\d\\d [AP]M';
type Lang = 'en' | 'es';
const CATALOG = {
  en: JSON.parse(readFileSync('packages/i18n/catalog/en.json', 'utf8')) as Record<string, string>,
  es: JSON.parse(readFileSync('packages/i18n/catalog/es.json', 'utf8')) as Record<string, string>,
};
const msg = (key: string, values: Record<string, string | number> = {}, lang: Lang = 'en') => (CATALOG[lang][key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** SQL in the stack's database as its owner. */
function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** Everything a container has logged (stdout and stderr). */
function logsOf(container: string): string {
  const r = spawnSync('docker', ['logs', container], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return `${r.stdout}\n${r.stderr}`;
}

/** A call with a session token, with the default origin on writes (the kernel's Origin check, SD-8). */
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

/** The demo clock to a demo time, held there (SQL: the clock API moves forward only), read back through API-10. */
async function holdClockAt(iso: string): Promise<void> {
  psql(`UPDATE system.demo_clock SET demo_anchor = ${q(iso)}, real_anchor = now(), paused = true WHERE id = 1`);
  const deadline = performance.now() + 30_000;
  for (;;) {
    const now = (await api('dana', 'GET', '/clock')).body.data;
    if (Math.abs(ms(now.demoNow) - Date.parse(iso)) < 1_000) return;
    if (performance.now() > deadline) throw new Error(`the clock did not read ${iso}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
let clockSaved = '';
beforeAll(async () => {
  // The job page suite ends with the clock at 9:30 PM (quiet hours): this suite needs the daytime, so it holds Sep 15, 10:30 AM, and puts the clock back.
  clockSaved = psql(`SELECT json_build_object('demo', demo_anchor, 'real', real_anchor, 'rate', rate, 'paused', paused) FROM system.demo_clock WHERE id = 1`);
  await holdClockAt('2026-09-15T10:30:00-04:00');
});
afterAll(() => {
  if (!clockSaved) return;
  const c = JSON.parse(clockSaved) as Json;
  psql(`UPDATE system.demo_clock SET demo_anchor = ${q(c.demo)}, real_anchor = ${q(c.real)}, rate = ${c.rate}, paused = ${c.paused} WHERE id = 1`);
});

/** The page's API writes carry the default origin: Playwright resends them itself (a browser will not let a route set Origin). */
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

interface Open { page: Page; g: GuardedContext }
async function open(browser: Browser, path: string, ready: string, before?: (p: Page) => unknown, lang: Lang = 'en'): Promise<Open> {
  const g = await guardedContext(browser, [origin], { viewport: { width: 1440, height: 1100 } });
  await g.context.addCookies([{ name: 'bw_session', value: people.keisha!, url: origin, httpOnly: true }, { name: 'bw_lang', value: lang, url: origin }]);
  const page = await g.context.newPage();
  await writeOrigin(page);
  if (before) await before(page);
  const res = await page.goto(origin + path, { waitUntil: 'load' });
  expect(res?.status()).toBe(200);
  await page.waitForSelector(ready, { timeout: 60_000 });
  return { page, g };
}
const close = (o: Open) => o.g.context.close();
const toast = (p: Page) => p.locator('.r1-toast').last();
const customerPath = (id: string) => `/office/customers/${id}`;

const harold = (): string => (psql(`SELECT customer_id FROM world.job WHERE job_number = ${HAROLD}`));
const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * The whole minute after the later of the held demo now and the newest time on a customer's texts (made, delivered, or in his inbox),
 * moved out of quiet hours (9:00 PM to 8:00 AM in his zone, FR-TEXT-7): a demo now at which a text the office sends him is his latest.
 */
function sendTime(id: string): Temporal.ZonedDateTime {
  const newest = psql(`SELECT to_char(max(t) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM (
      SELECT greatest(created_at, delivered_at) AS t FROM world.outbox_text WHERE customer_id = ${q(id)}
      UNION ALL SELECT at FROM world.inbox_message WHERE customer_id = ${q(id)}
      UNION ALL SELECT demo_anchor FROM system.demo_clock WHERE id = 1) x`);
  const at = Temporal.Instant.from(newest).toZonedDateTimeISO(ZONE).round({ smallestUnit: 'minute', roundingMode: 'floor' }).add({ minutes: 1 });
  if (at.hour >= 21) return at.add({ days: 1 }).with({ hour: 8, minute: 30 });
  return at.hour < 8 ? at.with({ hour: 8, minute: 30 }) : at;
}
const setTexts = async (id: string, on: boolean) => {
  const r = await api('keisha', 'PATCH', `/customers/${id}`, { textsOn: on });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const inboxCount = (id: string) => Number(psql(`SELECT count(*) FROM world.inbox_message m JOIN world.outbox_text t ON t.id = m.text_id WHERE t.customer_id = ${q(id)}`));
const officeTexts = (id: string) => Number(psql(`SELECT count(*) FROM world.outbox_text WHERE customer_id = ${q(id)} AND kind = 'office'`));

/** The first open window of a day on or after `from` (API-29, office channel), for a visit of its own. */
async function firstRoom(from: string, to: string): Promise<{ date: string; windowId: string }> {
  const days = (await api('keisha', 'GET', `/availability?branch=columbus&serviceId=furnace_tune_up&from=${from}&to=${to}&channel=office`)).body.data.days as Json[];
  for (const d of days) {
    const w = d.state === 'open' ? (d.windows as Json[]).find((x) => x.state === 'open' && x.left > 0) : undefined;
    if (w) return { date: d.date, windowId: w.windowId };
  }
  throw new Error(`no open window for furnace_tune_up from ${from} to ${to}`);
}
/** A visit made through API-28 as the dispatcher makes it (no technician): the write plans its reminder. */
async function visit(customerId: string, from: string, to: string): Promise<{ n: number; date: string }> {
  const room = await firstRoom(from, to);
  const r = await api('keisha', 'POST', '/jobs', { customerId, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: room.date, windowId: room.windowId, technicianId: null });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { n: r.body.data.job.jobNumber as number, date: room.date };
}
const cancelJob = async (n: number) => {
  const r = await api('keisha', 'POST', `/jobs/${n}/cancellation`, { baseVersion: Number(psql(`SELECT version FROM world.job WHERE job_number = ${n}`)) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const reminderDue = (n: number) => psql(`SELECT to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM world.scheduled_event WHERE kind = 'text.reminder' AND subject = ${q(String(n))} AND state = 'due'`);
/** 6:00 PM the day before `date`, in `zone`, as a UTC instant (the FR-TEXT-17 oracle, computed here and not by the handler). */
const sixPmBefore = (date: string, zone: string) => Temporal.ZonedDateTime.from(`${Temporal.PlainDate.from(date).subtract({ days: 1 }).toString()}T18:00:00[${zone}]`).toInstant().toString().replace(/\.000Z$/, 'Z');

describe.each(engines)('the customer page actions on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-DISP-31 Add equipment adds a water heater that his next job's page shows, and Edit on a piece of equipment saves its details (API-141, API-142)
  it('adds a water heater to Harold Jenkins, shown on his next job\'s page, and edits it', async () => {
    const id = harold();
    const details = `50 gallon, new tank (${engine})`;
    const o = await open(browser, customerPath(id), `${PAGE} [data-ctl="CTL-OFC-06-10"]`);
    try {
      const p = o.page;
      await p.locator('[data-ctl="CTL-OFC-06-17"]').click();
      const save = p.locator('[data-ctl="CTL-OFC-37-05"]');
      expect(await p.locator('.r1-dlg[data-screen="SCR-OFC-37"] .r1-dlg-h h2').innerText()).toBe(msg('job.equipment.addTitle'));
      expect(await save.getAttribute('aria-disabled')).toBe('true');
      await p.locator('#bw-eq-type').fill('Water heater');
      await p.locator('#bw-eq-year').fill('2024');
      await p.locator('#bw-eq-location').fill('garage');
      await p.locator('#bw-eq-details').fill(details);
      expect(await save.getAttribute('aria-disabled')).toBeNull();
      await save.click();
      await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toBe(msg('job.equipment.saved'));
      // The page re-reads API-35: the piece shows under Equipment.
      await expect.poll(() => p.locator('[data-ctl="CTL-OFC-06-10"]').innerText(), { timeout: 30_000 }).toContain(details);
      expect(psql(`SELECT type || '|' || year || '|' || location FROM world.equipment WHERE customer_id = ${q(id)} AND details = ${q(details)}`)).toBe('water_heater|2024|garage');
      // Edit on that piece opens SCR-OFC-37 in edit mode with its values and saves through API-142.
      const edited = `${details}, anode replaced`;
      await p.locator('[data-ctl="CTL-OFC-06-10"] .eq', { hasText: details }).locator('[data-ctl="CTL-OFC-06-18"]').click();
      expect(await p.locator('#bw-eq-type').inputValue()).toBe('Water heater');
      expect(await p.locator('.r1-dlg[data-screen="SCR-OFC-37"] .r1-dlg-h h2').innerText()).toBe(msg('job.equipment.title'));
      await p.locator('#bw-eq-details').fill(edited);
      await p.locator('[data-ctl="CTL-OFC-37-05"]').click();
      await expect.poll(() => p.locator('[data-ctl="CTL-OFC-06-10"]').innerText(), { timeout: 30_000 }).toContain(edited);
      expect(psql(`SELECT count(*) FROM world.equipment WHERE customer_id = ${q(id)} AND details = ${q(edited)}`)).toBe('1');
    } finally {
      await close(o);
    }
    // His next job's page (job 24830) lists the water heater.
    const j = await open(browser, `/office/jobs/${HAROLD}`, '.r1-screen[data-screen="SCR-OFC-03"] .jh h1');
    try {
      await expect.poll(() => j.page.locator('.r1-screen[data-screen="SCR-OFC-03"] [data-ctl="CTL-OFC-03-11"]').innerText(), { timeout: 30_000 }).toContain(`${details}, anode replaced`);
    } finally {
      await close(j);
    }
  });

  // why: FR-DISP-31 Add note saves an office note on the customer (API-140 with his id), shown with its author and time and announced "Note added."
  it('adds an office note to Harold Jenkins shown with its author and time', async () => {
    const id = harold();
    const body = `Customer note: call before coming, dog loose (${engine}).`;
    const o = await open(browser, customerPath(id), `${PAGE} [data-ctl="CTL-OFC-06-22"]`);
    try {
      const p = o.page;
      await p.locator('[data-ctl="CTL-OFC-06-19"]').click();
      expect(await p.locator('[data-ctl="CTL-OFC-36-02"]').getAttribute('aria-disabled')).toBe('true');
      await p.locator('#bw-nt').fill(body);
      await p.locator('[data-ctl="CTL-OFC-36-02"]').click();
      await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toBe(msg('customers.note.added'));
      const line = p.locator('[data-ctl="CTL-OFC-06-22"] .note').filter({ hasText: body });
      await line.waitFor({ timeout: 30_000 });
      expect((await line.innerText()).replace(/\s+/g, ' ')).toMatch(new RegExp(`Office note - Keisha T\\., Tue, Sep 15, ${WHEN}$`));
      expect(psql(`SELECT author_kind || '|' || coalesce(job_number::text, 'none') FROM world.note WHERE customer_id = ${q(id)} AND body = ${q(body)}`)).toBe('office|none');
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-31, FR-TEXT-20 Text opens SCR-OFC-35 for the customer and sends through API-143 with no job: 1 message in his inbox and a row of Recent texts
  it('texts Harold Jenkins from his page: 1 message reaches his inbox and shows in Recent texts', async () => {
    const id = harold();
    const body = `Harold, the office will call you this afternoon (${engine}).`;
    // F-904: the suites before this one held the clock later than this suite's 10:30 AM (the job page suite's 9:30 PM text, the new job
    // suite's confirmations at 10:30 PM and at 8:02 AM on Sep 16), and this suite set it back by SQL, which the product never does
    // (FR-DEMO-4: backward only by a reset, which restores the snapshot). So Harold has texts dated after this suite's now, and a send at
    // 10:30 AM is not among his latest. The send is made at a time the product's clock can be at: the minute after his newest text.
    expect(psql(`SELECT count(*) FROM world.outbox_text WHERE customer_id = ${q(id)} AND status IN ('queued', 'held', 'retrying')`),
      'a text of his still waiting to go would be stamped with the send\'s time').toBe('0');
    const at = sendTime(id);
    const when = `${DAY[at.dayOfWeek - 1]}, ${MONTH[at.month - 1]} ${at.day}, ${at.hour % 12 || 12}:${String(at.minute).padStart(2, '0')} ${at.hour < 12 ? 'AM' : 'PM'}`;
    await holdClockAt(at.toInstant().toString());
    const before = { texts: officeTexts(id), inbox: inboxCount(id) };
    const o = await open(browser, customerPath(id), `${PAGE} [data-ctl="CTL-OFC-06-13"]`);
    try {
      const p = o.page;
      const rows = () => p.locator('[data-ctl="CTL-OFC-06-13"] .ev .t').evaluateAll((els) => els.map((e) => `${(e.firstChild?.textContent ?? '').trim()} | ${(e.querySelector('small')?.textContent ?? '').trim()}`));
      // No row of Recent texts has the send's time before the send: the row that shows it after is the text just sent.
      expect((await rows()).filter((r) => r.endsWith(`| ${when}`))).toEqual([]);
      expect(await p.locator('[data-ctl="CTL-OFC-06-14"]').getAttribute('aria-disabled')).toBeNull();
      await p.locator('[data-ctl="CTL-OFC-06-14"]').click();
      expect(await p.locator('[data-ctl="CTL-OFC-35-01"]').innerText()).toContain(msg('job.text.inEnglish'));
      await p.locator('#bw-tx').fill(body);
      await p.locator('[data-ctl="CTL-OFC-35-04"]').click();
      await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toBe(msg('job.text.sent'));
      await expect.poll(() => officeTexts(id), { timeout: 30_000 }).toBe(before.texts + 1);
      expect(psql(`SELECT coalesce(job_number::text, 'none') FROM world.outbox_text WHERE customer_id = ${q(id)} AND kind = 'office' AND body = ${q(body)}`)).toBe('none');
      await expect.poll(() => psql(`SELECT status FROM world.outbox_text WHERE customer_id = ${q(id)} AND kind = 'office' AND body = ${q(body)}`), { timeout: 60_000 }).toBe('delivered');
      expect(inboxCount(id)).toBe(before.inbox + 1);
      expect(psql(`SELECT count(*) FROM world.inbox_message m JOIN world.outbox_text t ON t.id = m.text_id WHERE t.body = ${q(body)}`)).toBe('1');
      // F-853: the job page suite already sent Harold office texts on this stack, so the word alone proves nothing. The text just sent is his
      // latest, so it shows in Recent texts (CTL-OFC-06-13: the customer's latest texts, office texts included): 1 office text row at the send's time.
      await expect.poll(async () => (await rows()).filter((r) => r.endsWith(`| ${when}`)), { timeout: 30_000 }).toEqual([`${msg('customers.text.office')} | ${when}`]);
    } finally {
      await close(o);
      // The cases after this one read the suite's own time again (Tue, Sep 15, 10:30 AM).
      await holdClockAt('2026-09-15T10:30:00-04:00');
    }
  });

  // why: FR-DISP-31, FR-TEXT-20 with his texts off Text is disabled with its reason, a direct API-143 answers texts_off and his inbox gains nothing; with no mobile phone it is disabled with that reason
  it('disables Text with its reason when his texts are off or he has no mobile, and API-143 answers texts_off', async () => {
    const id = harold();
    await setTexts(id, false);
    try {
      const before = { texts: officeTexts(id), inbox: inboxCount(id) };
      const o = await open(browser, customerPath(id), `${PAGE} [data-ctl="CTL-OFC-06-14"]`);
      try {
        const text = o.page.locator('[data-ctl="CTL-OFC-06-14"]');
        expect(await text.getAttribute('aria-disabled')).toBe('true');
        expect(await text.getAttribute('title')).toBe(msg('customers.text.off'));
        await text.click({ force: true });
        await o.page.waitForTimeout(500);
        expect(await o.page.locator('#bw-tx').count()).toBe(0);
      } finally {
        await close(o);
      }
      const direct = await api('keisha', 'POST', `/customers/${id}/texts`, { body: 'Hello', jobNumber: null });
      expect(direct.status).toBe(409);
      expect(direct.body.code).toBe('texts_off');
      expect(officeTexts(id)).toBe(before.texts);
      expect(inboxCount(id)).toBe(before.inbox);
    } finally {
      await setTexts(id, true);
    }
    const noMobile = psql(`SELECT id FROM world.customer WHERE branch_id = 'columbus' AND status = 'active' AND mobile IS NULL ORDER BY name LIMIT 1`);
    expect(noMobile).not.toBe('');
    const n = await open(browser, customerPath(noMobile), `${PAGE} [data-ctl="CTL-OFC-06-14"]`);
    try {
      const text = n.page.locator('[data-ctl="CTL-OFC-06-14"]');
      expect(await text.getAttribute('aria-disabled')).toBe('true');
      expect(await text.getAttribute('title')).toBe(msg('customers.text.noMobile'));
    } finally {
      await close(n);
    }
  });

  // why: FR-DISP-31 the page's role-gated controls read API-07's permission keys: each control shows with its key and is gone without it
  it('shows Text, Add equipment, Edit, Add note and Open text inbox only with their API-07 permission keys', async () => {
    const id = harold();
    const KEYS = { 'CTL-OFC-06-14': 'API-143', 'CTL-OFC-06-17': 'API-141', 'CTL-OFC-06-18': 'API-142', 'CTL-OFC-06-19': 'API-140', 'CTL-OFC-06-02': 'API-37' } as const;
    const all = await open(browser, customerPath(id), `${PAGE} [data-ctl="CTL-OFC-06-10"]`);
    try {
      for (const ctl of Object.keys(KEYS)) expect(await all.page.locator(`${PAGE} [data-ctl="${ctl}"]`).count(), ctl).toBeGreaterThan(0);
    } finally {
      await close(all);
    }
    for (const [ctl, key] of Object.entries(KEYS)) {
      const o = await open(browser, customerPath(id), `${PAGE} [data-ctl="CTL-OFC-06-10"]`, async (p) => {
        await p.route(`${origin}/api/v1/me`, async (r) => {
          const res = await r.fetch();
          const json = await res.json();
          json.data.permissions = (json.data.permissions as string[]).filter((k) => k !== key);
          await r.fulfill({ response: res, json });
        });
      });
      try {
        await expect.poll(() => o.page.locator('.topbar').count(), { timeout: 30_000 }).toBeGreaterThan(0);
        expect(await o.page.locator(`${PAGE} [data-ctl="${ctl}"]`).count(), `${ctl} without ${key}`).toBe(0);
      } finally {
        await close(o);
      }
    }
  });

  // why: FR-TEXT-17 saving a new zone (CTL-OFC-06-07) moves that visit's text.reminder due_at to 6:00 PM in the new zone (F-672)
  it('moves the 6:00 PM reminder of his future visit to the new zone when the zone is saved on his page', async () => {
    const id = harold();
    const v = await visit(id, '2026-09-17', '2026-10-30');
    try {
      expect(reminderDue(v.n)).toBe(sixPmBefore(v.date, ZONE));
      const o = await open(browser, customerPath(id), `${PAGE} [data-ctl="CTL-OFC-06-05"]`);
      try {
        const p = o.page;
        await p.locator('[data-ctl="CTL-OFC-06-05"]').click();
        await p.locator('[data-ctl="CTL-OFC-06-06"] select').selectOption('America/Chicago');
        await p.locator('button[data-ctl="CTL-OFC-06-07"]').click();
        await expect.poll(() => p.locator('[data-ctl="CTL-OFC-06-04"]').innerText(), { timeout: 30_000 }).toContain('Central');
      } finally {
        await close(o);
      }
      expect(reminderDue(v.n)).toBe(sixPmBefore(v.date, 'America/Chicago'));
    } finally {
      const back = await api('keisha', 'PATCH', `/customers/${id}`, { timeZone: ZONE });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      await cancelJob(v.n);
    }
  });

  // why: FR-DISP-31 Open text inbox (CTL-OFC-06-02) opens the URL API-37 answers in a new tab, and a failed read shows the inline message and opens nothing
  it('opens his text inbox in a new tab from the link, and shows the inline message when the read fails', async () => {
    const id = harold();
    const url = (await api('keisha', 'GET', `/customers/${id}/inbox-link`)).body.data.url as string;
    expect(url).toMatch(/^\/inbox\/.+/);
    const o = await open(browser, customerPath(id), `${PAGE} [data-ctl="CTL-OFC-06-02"]`);
    try {
      const opened = o.g.context.waitForEvent('page', { timeout: 30_000 });
      await o.page.locator('[data-ctl="CTL-OFC-06-02"]').click();
      const tab = await opened;
      await tab.waitForLoadState('domcontentloaded');
      expect(new URL(tab.url()).pathname).toBe(url);
      expect(await o.page.locator(`${PAGE} [role="alert"]`, { hasText: msg('job.feed.inboxError') }).count()).toBe(0);
    } finally {
      await close(o);
    }
    const f = await open(browser, customerPath(id), `${PAGE} [data-ctl="CTL-OFC-06-02"]`, async (p) => {
      await p.route(`${origin}/api/v1/customers/*/inbox-link`, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"code":"server_error","status":500}' }));
    });
    try {
      const pages = f.g.context.pages().length;
      await f.page.locator('[data-ctl="CTL-OFC-06-02"]').click();
      await f.page.locator(`${PAGE} [role="alert"]`, { hasText: msg('job.feed.inboxError') }).waitFor({ timeout: 30_000 });
      await f.page.waitForTimeout(500);
      expect(f.g.context.pages().length).toBe(pages);
    } finally {
      await close(f);
    }
  });

  // why: FR-DISP-30 a search with a matching job shows Also found in jobs with each Job <n> link opening SCR-OFC-03; no match hides the line; a failed read shows the message with the customer results standing
  it('shows Also found in jobs for a search with a matching job, hides it with no match, and says so when the read fails', async () => {
    const names = (p: Page) => p.locator(`${SEARCH} table[data-ctl="CTL-OFC-05-03"] tbody a.nm`).allTextContents();
    const also = (p: Page) => p.locator(`${SEARCH} [data-ctl="CTL-OFC-05-15"]`);
    const ask = async (p: Page, text: string) => {
      await p.fill(`${SEARCH} input.bw-cu-q`, text);
    };
    // The jobs the search text matches, as API-133 answers them (the independent oracle for the line).
    const oracle = async (text: string) => (await api('keisha', 'POST', '/job-searches', { branch: 'columbus', query: text, tab: 'all', date: 'upcoming' })).body.data.rows as Json[];
    const o = await open(browser, '/office/customers', `${SEARCH} input.bw-cu-q`);
    try {
      const p = o.page;
      // A match: Harold's job 24830 is Today and upcoming.
      const rows = await oracle('Jenkins');
      expect(rows.map((r) => r.jobNumber)).toContain(HAROLD);
      await ask(p, 'Jenkins');
      await expect.poll(() => names(p), { timeout: 30_000 }).toContain('Harold Jenkins');
      await also(p).waitFor({ timeout: 30_000 });
      const text = (await also(p).innerText()).replace(/\s+/g, ' ');
      expect(text.startsWith(msg('customers.also.label'))).toBe(true);
      expect(text).toContain(`${msg('customers.also.job', { n: HAROLD })} - Harold Jenkins, furnace tune-up, Tue, Sep 15`);
      expect(await also(p).locator('a').count()).toBe(rows.length);
      // Each Job <n> link opens SCR-OFC-03.
      await also(p).locator('a', { hasText: msg('customers.also.job', { n: HAROLD }) }).click();
      await p.waitForSelector('.r1-screen[data-screen="SCR-OFC-03"] .jh h1', { timeout: 60_000 });
      expect(new URL(p.url()).pathname).toBe(`/office/jobs/${HAROLD}`);
      // No match: a customer with no job at all matches a customer and no job, so the line is hidden.
      const lone = psql(`SELECT name FROM world.customer c WHERE branch_id = 'columbus' AND status = 'active' AND name ~ '^[A-Z][a-z]+ [A-Z][a-z]+$' AND NOT EXISTS (SELECT 1 FROM world.job j WHERE j.customer_id = c.id) ORDER BY name LIMIT 1`);
      expect(lone).not.toBe('');
      expect(await oracle(lone)).toEqual([]);
      await p.goto(`${origin}/office/customers`, { waitUntil: 'load' });
      await p.waitForSelector(`${SEARCH} input.bw-cu-q`);
      await ask(p, lone);
      await expect.poll(() => names(p), { timeout: 30_000 }).toContain(lone);
      await p.waitForTimeout(500);
      expect(await also(p).count()).toBe(0);
    } finally {
      await close(o);
    }
    // A failed read: the line says so and the customer results stand.
    const f = await open(browser, '/office/customers', `${SEARCH} input.bw-cu-q`, async (p) => {
      await p.route(`${origin}/api/v1/job-searches`, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"code":"server_error","status":500}' }));
    });
    try {
      await ask(f.page, 'Jenkins');
      await expect.poll(() => names(f.page), { timeout: 30_000 }).toContain('Harold Jenkins');
      await expect.poll(async () => (await also(f.page).innerText().catch(() => '')).trim(), { timeout: 30_000 }).toBe(msg('customers.also.error'));
    } finally {
      await close(f);
    }
    // F-850: a held read (API-133 never answers): the customer results still arrive, and the line does not claim a failure it has not seen.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const h = await open(browser, '/office/customers', `${SEARCH} input.bw-cu-q`, async (p) => {
      await p.route(`${origin}/api/v1/job-searches`, async (r) => {
        await held;
        await r.abort().catch(() => undefined);
      });
    });
    try {
      await ask(h.page, 'Jenkins');
      await expect.poll(() => names(h.page), { timeout: 30_000 }).toContain('Harold Jenkins');
    } finally {
      release();
      await close(h);
    }
  });

  // why: FR-DISP-30 NFR-05 the search text of Also found in jobs is in the request body only: in no request URL, no address bar and no log of the web process or the proxy
  it('sends the search text in the request body only: in no URL and in no log', async () => {
    // Harold's mobile number, as the office types it: it matches him (API-34) and his jobs (API-133), and it is the kind of text the logs must never carry (NFR-05).
    const word = '555-0148';
    const sent: { url: string; body: string | null }[] = [];
    const urls: string[] = [];
    const o = await open(browser, '/office/customers', `${SEARCH} input.bw-cu-q`, (p) => {
      p.on('request', (r) => {
        urls.push(r.url());
        if (r.url().includes('/api/v1/job-searches')) sent.push({ url: r.url(), body: r.postData() });
      });
    });
    try {
      await o.page.fill(`${SEARCH} input.bw-cu-q`, word);
      await expect.poll(() => sent.length, { timeout: 30_000 }).toBeGreaterThan(0);
      expect(sent.some((s) => s.body?.includes(word))).toBe(true);
      expect(o.page.url()).not.toContain(word);
    } finally {
      await close(o);
    }
    expect(urls.filter((u) => u.includes(word) || u.includes('5550148'))).toEqual([]);
    for (const c of [containers.web!, containers.proxy!]) {
      const log = logsOf(c);
      expect(log.includes(word) || log.includes('5550148'), `the ${c} log holds the search text`).toBe(false);
    }
  });
});

// The reminder of a visit comes at 6:00 PM the day before, so this runs once, last (it holds the clock at 6:01 PM).
describe(`the next-day visit of a customer whose texts are off, on the Compose stack, ${engines[0]?.[0]}`, () => {
  // why: FR-DISP-31, FR-TEXT-13 with his texts off his next-day visit made through API-28 is on API-42's call list and gets no reminder text (the write plans the reminder: no direct planReminder call here)
  it('puts the visit on API-42\'s call list before any event and sends no reminder text at 6:00 PM', async () => {
    const id = harold();
    await setTexts(id, false);
    let n = 0;
    try {
      const v = await visit(id, '2026-09-16', '2026-09-16');
      n = v.n;
      expect(v.date).toBe('2026-09-16');
      expect(reminderDue(n)).toBe(sixPmBefore('2026-09-16', ZONE));
      // Before any event: API-42 for Sep 15 already lists the visit, with the reason texts_off.
      const list = (await api('keisha', 'GET', '/call-list?branch=columbus&date=2026-09-15')).body.data;
      expect(list.reminderCalls.find((c: Json) => c.customerId === id)).toMatchObject({ reason: 'texts_off', visit: { jobNumber: n } });
      // 6:00 PM comes: the event goes to the call list, and no reminder text is made.
      await holdClockAt('2026-09-15T18:01:00-04:00');
      await expect.poll(() => psql(`SELECT state || ':' || coalesce(result, '') FROM world.scheduled_event WHERE kind = 'text.reminder' AND subject = ${q(String(n))}`), { timeout: 90_000 }).toBe('done:call_list');
      expect(psql(`SELECT count(*) FROM world.outbox_text WHERE job_number = ${n} AND kind = 'reminder'`)).toBe('0');
      expect(psql(`SELECT count(*) FROM world.call_list_entry WHERE job_number = ${n} AND reason = 'texts_off'`)).toBe('1');
    } finally {
      await setTexts(id, true);
      if (n) await cancelJob(n);
    }
  });
});
