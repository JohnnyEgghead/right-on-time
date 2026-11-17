// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: UC-17, FR-DISP-5, FR-DISP-6, FR-DISP-25, FR-DISP-26, FR-DISP-27, FR-TEXT-20, FR-TEXT-4, FR-BILL-3, FR-BILL-7 (P4-JOB Acceptance: Playwright on the Compose stack)
// The job page (SCR-OFC-03) and its dialogs against the Compose stack at its default settings (real PostgreSQL 18, real handlers,
// pbs running), set up by the setup service (the seeded world, the clock at Tue, Sep 15, 7:00 AM, moved once to 10:28 AM), through
// its proxy, every page opened through the outside-origin guard. The people are ci/job-stack/fixture.sql's sessions. Run by
// ci/job-stack.sh. The suite shares 1 world and 1 clock: each engine picks its own jobs.
//   UC-17: Maria's On my way on Harold Jenkins's job 24830 goes through API-102 as Maria (the phone's call); the office then texts
//   and calls Harold from his job page.
//   The On the way rulings (owner rulings 4241980e, 2142ce69 "End the link", d0c0a033 "Back to Scheduled", 7ccb76ec call 8): the
//   stack's worker is stopped while a technician's On my way is applied and the office acts, so the on-the-way text is still unsent
//   (queued) when Reassign, Reschedule or Cancel visit runs; started again, it delivers no on-the-way text for those jobs. The new
//   technician's API-100 half of Back to Scheduled is P5-TWA-TODAY's (F-703; API-100 is not built): only API-20 is read here.
//   Last, once, after every engine's cases (the shared clock only moves forward): Maria arrives on Harold's job with his page open,
//   and the clock moves to 9:30 PM for the quiet-hours hold.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { visitPosition } from '../../packages/maps/src/position.ts';
import { Temporal, toWire } from '../../packages/time/src/index.ts';
import { guardedContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_JOB_STACK_URL;
const db = process.env.BW_JOB_DB_CONTAINER;
const worker = process.env.BW_JOB_WORKER_CONTAINER;
const techSeed = process.env.BW_JOB_TECHSEED;
const people = { keisha: process.env.BW_JOB_KEISHA, dana: process.env.BW_JOB_DANA };
if (!base || !db || !worker || !techSeed || Object.values(people).some((v) => !v)) {
  throw new Error('BW_JOB_STACK_URL, _DB_CONTAINER, _WORKER_CONTAINER and the session tokens are not set: run ci/job-stack.sh');
}
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the suite's proxy listens on a free port, so writes carry the default origin.
const APP_ORIGIN = 'http://localhost:8080';
const ZONE = 'America/New_York';
const SCREEN = '.r1-screen[data-screen="SCR-OFC-03"]';
const HAROLD = 24830;
type Lang = 'en' | 'es';
const CATALOG = {
  en: JSON.parse(readFileSync('packages/i18n/catalog/en.json', 'utf8')) as Record<string, string>,
  es: JSON.parse(readFileSync('packages/i18n/catalog/es.json', 'utf8')) as Record<string, string>,
};
const msg = (key: string, values: Record<string, string | number> = {}, lang: Lang = 'en') => (CATALOG[lang][key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** SQL in the stack's database as its owner (reads, and the customer and time-off rows a later page would write). */
function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
function docker(...args: string[]): void {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr.slice(0, 300)}`);
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
const jobOf = async (n: number) => (await api('keisha', 'GET', `/jobs/${n}`)).body.data as Json;
const board = async () => (await api('keisha', 'GET', '/board?branch=columbus&date=today')).body.data as Json;

/** Jump the shared clock forward to a demo time (API-12, the manager) unless it is already past it, then wait for the replay. */
async function clockAt(to: string): Promise<void> {
  const deadline = performance.now() + 150_000;
  // A fresh world may still be replaying its own start (API-12 answers replay_running then): the jump waits for it.
  for (;;) {
    const now = (await api('dana', 'GET', '/clock')).body.data;
    if (ms(now.demoNow) >= ms(to)) break;
    const r = await api('dana', 'POST', '/clock/jumps', { to });
    if (r.status === 202) break;
    expect(r.body?.code, JSON.stringify(r.body)).toBe('replay_running');
    if (performance.now() > deadline) throw new Error('the clock stayed in a replay for 150 s before the jump');
    await new Promise((res) => setTimeout(res, 500));
  }
  for (;;) {
    const reply = (await api('dana', 'GET', '/clock')).body;
    if (!reply.data.replay?.running && Math.abs(ms(reply.meta.demoNow) - ms(reply.data.demoNow)) < 1_000) return;
    if (performance.now() > deadline) throw new Error('the clock replay did not finish in 150 s');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * A technician's On my way as the phone sends it (API-102, section 5.1 step 1): the offset saved now, the item entered now, so its
 * demo time is the clock's demo now. The answer must be applied.
 */
async function onMyWay(techUserId: string, jobNumber: number): Promise<void> {
  const clock = (await api('dana', 'GET', '/clock')).body.data;
  const real = toWire(Temporal.Now.instant(), ZONE);
  const version = (await jobOf(jobNumber)).job.version as number;
  const item = {
    key: crypto.randomUUID(), kind: 'on_my_way', jobNumber, baseVersion: version, worldEpoch: clock.worldEpoch,
    deviceTime: real, offsetSavedReal: real, sinceSaveMs: 0, demoTime: clock.demoNow,
  };
  const r = await call(techToken(techUserId), 'POST', '/tech/items', { items: [item] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.data.items[0], JSON.stringify(r.body)).toMatchObject({ result: 'applied' });
}

/** A technician's session token as ci/job-stack/fixture.sql made it: base64url of sha256(techseed + user id). */
const techToken = (userId: string) => createHash('sha256').update(`${techSeed}${userId}`).digest('base64url');

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
interface OpenAs { before?: (p: Page) => unknown; who?: keyof typeof people; lang?: Lang }
async function open(browser: Browser, n: number, { before, who = 'keisha', lang = 'en' }: OpenAs = {}): Promise<Open> {
  const g = await guardedContext(browser, [origin], { viewport: { width: 1440, height: 1100 } });
  await g.context.addCookies([{ name: 'bw_session', value: people[who]!, url: origin, httpOnly: true }, { name: 'bw_lang', value: lang, url: origin }]);
  const page = await g.context.newPage();
  await writeOrigin(page);
  if (before) await before(page);
  const res = await page.goto(`${origin}/office/jobs/${n}`, { waitUntil: 'load' });
  expect(res?.status()).toBe(200);
  await page.waitForSelector(`${SCREEN} .jh h1`, { timeout: 60_000 });
  return { page, g };
}
const close = (o: Open) => o.g.context.close();
const toast = (p: Page) => p.locator('.r1-toast').last();
const CONFLICT = '[data-screen="SCR-OFC-19"]';
const WHEN = '\\d{1,2}:\\d\\d [AP]M';

/** A scheduled job of its own, on the first open window from October on (each case changes it as it likes). */
let fresh = 0;
async function freshJob(customer?: string): Promise<number> {
  fresh += 1;
  // A full name: the generated world holds customers with no usable name on purpose, and billing refuses those (a data_error of its own).
  const id = customer ?? psql(`SELECT id FROM world.customer WHERE branch_id = 'columbus' AND status = 'active' AND name ~ '^[A-Z][a-z]+ [A-Z][a-z]+$' ORDER BY name LIMIT 1 OFFSET ${20 + fresh}`);
  const days = (await api('keisha', 'GET', '/availability?branch=columbus&serviceId=furnace_tune_up&from=2026-10-01&to=2026-11-10&channel=office')).body.data.days as Json[];
  const day = days.find((d) => d.state === 'open' && d.windows.some((w: Json) => w.state === 'open'));
  const r = await api('keisha', 'POST', '/jobs', {
    customerId: id, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: day.date, windowId: day.windows.find((w: Json) => w.state === 'open').windowId, technicianId: null,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.job.jobNumber as number;
}
/** Another person's save (API-27), so the job's version moves under an open dialog. */
async function theirEdit(n: number, problem: string): Promise<void> {
  const j = (await jobOf(n)).job;
  const r = await api('dana', 'PATCH', `/jobs/${n}`, { serviceId: j.serviceId, equipmentId: j.equipmentId, problem, baseVersion: j.version });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const billingState = (n: number) => psql(`SELECT billing_state FROM world.job WHERE job_number = ${n}`);
const setBilling = async (mode: string, n?: number) => {
  const r = await api('dana', 'PUT', '/pretend-billing/mode', n === undefined ? { mode } : { mode, n });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};

/** The texts of a job and kind, newest last (status, characters, encoding). */
const texts = (n: number, kind: string) => psql(`SELECT status || ':' || characters || ':' || encoding FROM world.outbox_text WHERE job_number = ${n} AND kind = ${q(kind)} ORDER BY created_at`)
  .split('\n').filter(Boolean);
const linkEnded = (n: number) => psql(`SELECT coalesce(bool_and(ended_at IS NOT NULL), false) FROM world.link_token WHERE job_number = ${n} AND kind = 'live_map'`) === 't';
const linkCount = (n: number) => Number(psql(`SELECT count(*) FROM world.link_token WHERE job_number = ${n} AND kind = 'live_map'`));

/** A Columbus technician (not Maria) with no job On the way or On site and a scheduled job today, not one used already. */
const used = new Set<number>([HAROLD]);
async function freeTrip(): Promise<{ tech: Json; job: Json; userId: string }> {
  const b = await board();
  for (const t of b.technicians as Json[]) {
    if (t.name === 'Maria Santos' || t.jobs.some((j: Json) => j.status === 'on_the_way' || j.status === 'on_site')) continue;
    const job = (t.jobs as Json[]).find((j) => j.status === 'scheduled' && !used.has(j.jobNumber));
    if (!job) continue;
    used.add(job.jobNumber);
    const userId = psql(`SELECT user_id FROM world.technician WHERE id = ${q(t.id)}`);
    // The customer gets a mobile and texts on, so the On my way queues its on-the-way text (FR-TEXT-3).
    psql(`UPDATE world.customer SET mobile = '+16145550142', texts_on = true WHERE id = (SELECT customer_id FROM world.job WHERE job_number = ${job.jobNumber})`);
    return { tech: t, job, userId };
  }
  throw new Error('no Columbus technician is free with a scheduled job today');
}

describe.each(engines)('the job page on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
    await clockAt(toWire(Temporal.ZonedDateTime.from(`2026-09-15T10:28:00[${ZONE}]`).toInstant(), ZONE));
    // Maria taps On my way for Harold's 10 AM-12 PM visit once (the sample day script leaves it to a visitor).
    if ((await jobOf(HAROLD)).job.status === 'scheduled') {
      await onMyWay(psql(`SELECT user_id FROM world.technician WHERE name = 'Maria Santos'`), HAROLD);
    }
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: UC-17, FR-DISP-25, FR-DEMO-8 (Harold's page while Maria is on the way: the van where its baked track and the clock put it, the panel, Call and Reassign, the live map link line)
  it('shows the on-the-way panel on Harold Jenkins\'s job while Maria is on the way, and the call shows his number', async () => {
    let answered: Promise<Json> | undefined;
    const o = await open(browser, HAROLD, { before: (pg) => {
      answered = pg.waitForResponse((r) => r.url().endsWith(`/jobs/${HAROLD}/on-the-way`)).then((r) => r.json());
    } });
    try {
      const p = o.page;
      // The page's own API-135 answer: the van is where the baked track and the answer's demo time put it (FR-DEMO-8: computed on read).
      const reply = await answered!;
      const way = reply.data;
      const row = JSON.parse(psql(`SELECT json_build_object('at', j.on_the_way_at, 'lon', c.lon, 'lat', c.lat, 'dlon', b.depot_lon, 'dlat', b.depot_lat, 'polyline', k.polyline, 'seconds', k.seconds, 'plon', pc.lon, 'plat', pc.lat)
        FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.branch b ON b.id = j.branch_id
        LEFT JOIN LATERAL (SELECT p.job_number, p.customer_id FROM world.job p WHERE p.technician_id = j.technician_id AND p.date = j.date AND p.job_number <> j.job_number AND p.status IN ('done', 'no_one_home')
                            ORDER BY p.ended_at DESC NULLS LAST, p.job_number DESC LIMIT 1) prev ON true
        LEFT JOIN world.customer pc ON pc.id = prev.customer_id
        LEFT JOIN world.van_track k ON k.branch_id = j.branch_id AND k.from_ref = coalesce(prev.job_number::text, 'depot') AND k.to_ref = j.job_number::text
        WHERE j.job_number = ${HAROLD}`)) as Json;
      expect(way.van.source).toBe('track');
      expect(row.polyline).toBeTruthy();
      const at = visitPosition({
        status: 'on_the_way', onTheWayAt: Date.parse(row.at), now: ms(reply.meta.demoNow),
        from: { lon: row.plon ?? row.dlon, lat: row.plat ?? row.dlat }, to: { lon: row.lon, lat: row.lat }, track: { polyline: row.polyline, seconds: row.seconds },
      })!;
      expect(way.van.lon).toBeCloseTo(at.lon, 3);
      expect(way.van.lat).toBeCloseTo(at.lat, 3);
      expect(await p.locator(`${SCREEN} .mapm [data-marker-id="van"]`).getAttribute('aria-label', { timeout: 30_000 })).toBe(msg('job.way.vanWords', { name: 'Maria Santos' }));
      expect(await p.locator(`${SCREEN} .jh h1`).innerText()).toContain('Harold Jenkins');
      const panel = p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-25"]`);
      await panel.locator('.tech').waitFor({ timeout: 30_000 });
      expect(await panel.locator('.sub').innerText()).toBe(msg(way.insideWindow ? 'job.way.insideWindow' : 'job.way.outsideWindow', { n: way.minutesAway, window: '10 AM-12 PM' }));
      expect(way.insideWindow).toBe(true);
      expect(await panel.locator('[data-ctl="CTL-OFC-03-26"] b').innerText()).toBe('Maria Santos');
      expect(await panel.locator('[data-ctl="CTL-OFC-03-27"]').count()).toBe(1);
      expect(await panel.locator('[data-ctl="CTL-OFC-03-28"]').count()).toBe(1);
      // The time is the live map link's own (FR-TECH-2's time: the link was made with the On my way tap), not any time-shaped text (F-726).
      const [sentAt, sentGapS] = psql(`SELECT to_char(l.created_at AT TIME ZONE 'America/New_York', 'FMHH12:MI AM') || '|' || abs(extract(epoch FROM (l.created_at - j.on_the_way_at)))::int
        FROM world.link_token l JOIN world.job j ON j.job_number = l.job_number WHERE l.job_number = ${HAROLD} AND l.kind = 'live_map' AND l.ended_at IS NULL ORDER BY l.created_at DESC LIMIT 1`).split('|') as [string, string];
      expect(Number(sentGapS), 'the link was sent with the On my way tap').toBeLessThanOrEqual(60);
      expect(await panel.locator('[data-ctl="CTL-OFC-03-29"]').innerText()).toBe(`Live map link sent ${sentAt}. Stops when Maria arrives.`);
      expect(await panel.locator('.mapm').count()).toBe(1);
      // On a computer the call shows Harold's number and starts no call (CMP-16).
      const harold = await jobOf(HAROLD);
      await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-22"] button`).click();
      await expect.poll(async () => p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-22"]`).innerText()).toContain(harold.customer.phone);
    } finally {
      await close(o);
    }
  });

  // why: UC-17, FR-TEXT-20 (160 GSM-7 characters show 0 left and send; the 161st cannot be sent; the text is 1 message in Harold's inbox)
  it('texts Harold from his job page: 1 message reaches his inbox, and the 161st character cannot be sent', async () => {
    const before = texts(HAROLD, 'office').length;
    const o = await open(browser, HAROLD);
    try {
      const p = o.page;
      await p.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-03-21"]`).click();
      const box = p.locator('#bw-tx');
      const count = p.locator('#bw-tx-cnt');
      const send = p.locator('[data-ctl="CTL-OFC-35-04"]');
      expect(await p.locator('[data-ctl="CTL-OFC-35-01"]').innerText()).toContain(msg('job.text.inEnglish'));
      // F-730: the To line prints the number as the customer card does, (614) 555-0148, never the stored +16145550148
      expect(await p.locator('[data-ctl="CTL-OFC-35-01"]').innerText()).toMatch(/\(\d{3}\) \d{3}-\d{4}/);
      expect(await p.locator('[data-ctl="CTL-OFC-35-01"]').innerText()).not.toMatch(/\+\d{10}/);
      await box.fill('a'.repeat(160));
      await expect.poll(() => count.innerText()).toBe(msg('job.text.zeroLeft'));
      expect(await send.getAttribute('aria-disabled')).toBeNull();
      await box.press('End');
      await box.pressSequentially('a');
      await expect.poll(() => count.innerText()).toBe(msg('job.text.tooLong'));
      expect(await send.getAttribute('aria-disabled')).toBe('true');
      await send.click({ force: true });
      await p.waitForTimeout(1_000);
      expect(texts(HAROLD, 'office').length).toBe(before);
      // Back to 160: 0 left, and it sends as 1 message that lands in his inbox.
      await box.press('Backspace');
      await expect.poll(() => count.innerText()).toBe(msg('job.text.zeroLeft'));
      await send.click();
      await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toBe(msg('job.text.sent'));
      await expect.poll(() => texts(HAROLD, 'office').length).toBe(before + 1);
      await expect.poll(() => texts(HAROLD, 'office').at(-1)!.split(':')[0], { timeout: 60_000 }).toBe('delivered');
      const [, chars, encoding] = texts(HAROLD, 'office').at(-1)!.split(':');
      expect(Number(chars)).toBe(160);
      expect(encoding).toMatch(/gsm/i);
      const inbox = psql(`SELECT count(*) FROM world.inbox_message m WHERE m.text_id = (SELECT id FROM world.outbox_text WHERE job_number = ${HAROLD} AND kind = 'office' ORDER BY created_at DESC, id DESC LIMIT 1)`);
      expect(inbox).toBe('1');
      // The inbox the text landed in opens from the page (API-37).
      const link = await api('keisha', 'GET', `/customers/${(await jobOf(HAROLD)).customer.id}/inbox-link`);
      expect(link.status).toBe(200);
      // FR-TEXT-20: and on the Messages page (FR-TEXT-15): the text sent from the job page is a row of that page's log (F-726).
      const log = await o.g.context.newPage();
      await writeOrigin(log);
      await log.goto(`${origin}/office/messages?branch=columbus&date=2026-09-15`, { waitUntil: 'load' });
      await expect.poll(() => log.locator('td[data-ctl="CTL-OFC-08-23"]', { hasText: 'a'.repeat(160) }).count(), { timeout: 60_000 }).toBeGreaterThan(0);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-5, FR-DISP-26, F-701 (Harold's Sep 15 job: 4 pieces of equipment, 8 past visits with the last 3 listed, his notes; Maintenance with its length, Customer since, the plan)
  it('shows Harold\'s equipment, past visits, notes, job type and length, Customer since and plan', async () => {
    const o = await open(browser, HAROLD);
    try {
      const p = o.page;
      const d = await jobOf(HAROLD);
      await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-11"] .eq`).first().waitFor();
      expect(await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-11"] .eq`).count()).toBe(4);
      expect(await p.locator(`${SCREEN} table.hist tbody tr`).count()).toBe(3);
      expect(await p.locator(`${SCREEN} table.hist tbody tr`).first().innerText()).toMatch(/Oct 14, 2025\s+Furnace tune-up\s+Maria Santos/);
      expect(d.history.count).toBe(8);
      expect(await p.locator(`${SCREEN} .card-h .muted`).first().innerText()).toContain('8 past visits');
      const kv = await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-10"]`).innerText();
      expect(kv).toContain('Oct 2014, 8 past visits');
      expect(kv).toContain(msg('job.customer.club'));
      expect(psql(`SELECT count(*) FROM world.membership m JOIN world.customer c ON c.id = m.customer_id WHERE c.name = 'Harold Jenkins'`)).toBe('1');
      expect(d.job.jobType).toBe('maintenance');
      const h = Math.floor(d.job.expectedMinutes / 60);
      const m = d.job.expectedMinutes % 60;
      const length = h === 0 ? msg('job.length.min', { m }) : m === 0 ? msg('job.length.hr', { h }) : msg('job.length.hrMin', { h, m });
      expect(await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-20"]`).innerText()).toContain(`${msg('job.type.maintenance')}, ${msg('job.meta.about', { length })}`);
      // His 2 notes as DK-87 Success draws them, each with its author and its date and time.
      const notes = await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-14"] .note`).allInnerTexts();
      const side = notes.find((n) => n.startsWith('Please use the side door'));
      const filter = notes.find((n) => n.startsWith('Bring a 16x25x4 filter'));
      expect(side, notes.join(' | ')).toMatch(new RegExp(`Office note - Keisha T., Thu, Sep 10, ${WHEN}$`));
      expect(filter, notes.join(' | ')).toMatch(new RegExp(`Technician note - Maria Santos, Oct 14, 2025, ${WHEN}$`));
    } finally {
      await close(o);
    }
  });

  // why: F-701, FR-DISP-5, FR-DISP-27 (a customer note reaches the customer's job page, with its author and time)
  it('shows a customer note on that customer\'s job page', async () => {
    const sean = psql(`SELECT n.customer_id FROM world.note n WHERE n.job_number IS NULL LIMIT 1`);
    const o = await open(browser, await freshJob(sean));
    try {
      const line = await o.page.locator(`${SCREEN} [data-ctl="CTL-OFC-03-14"] .note`).filter({ hasText: 'Dog in the back yard' }).innerText();
      expect(line).toMatch(new RegExp(`Office note - Marco P\\., Mon, Mar 2, ${WHEN}$`));
    } finally {
      await close(o);
    }
  });

  // why: F-698, CTL-OFC-03-11, CTL-OFC-03-17 (the page prints the catalog's words for stored codes, in both languages)
  it.each(['en', 'es'] as const)('prints words, never a stored code, on Harold\'s page and its dialogs (%s)', async (lang) => {
    await expect.poll(() => texts(HAROLD, 'on_the_way').at(-1)?.split(':')[0], { timeout: 60_000 }).toBe('delivered');
    const o = await open(browser, HAROLD, { lang });
    try {
      const p = o.page;
      const word = (type: string) => msg(`customers.equipment.${type}`, {}, lang);
      await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-11"] .eq`).first().waitFor();
      expect(await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-11"] .eq b`).allInnerTexts()).toEqual(
        [['air_conditioner', 2014], ['furnace', 2014], ['thermostat', 2019], ['water_heater', 2016]].map(([c, y]) => `${word(c as string)} - ${y}`));
      const feed = await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-17"]`).innerText();
      expect(feed).not.toMatch(/\b(queued|sending|delivered|retrying|gave_up|canceled|on_the_way|on_site)\b/);
      expect(feed).toContain(msg('job.feed.kind.status.on_the_way', {}, lang));
      expect(feed).toContain(msg('job.feed.text', { kind: msg('job.feed.textKind.on_the_way', {}, lang), status: msg('msg.status.delivered', {}, lang) }, lang));
      await p.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-03-06"]`).click();
      expect(await p.locator('#bw-ed-eq option').allInnerTexts()).toContain(`${word('furnace')}, 2014, basement`);
      await p.locator('button.btn[data-ctl="CTL-OFC-23-05"]').click();
      await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-11"] .eq`).filter({ hasText: word('furnace') }).locator('[data-ctl="CTL-OFC-03-24"]').click();
      expect(await p.locator('#bw-eq-type').inputValue()).toBe(word('furnace'));
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-27, F-701 (SCR-OFC-36 saves an office note shown with its author and time; SCR-OFC-37 saves the furnace's details, shown on his customer page)
  it('adds an office note and edits the furnace\'s details from Harold\'s page', async () => {
    const o = await open(browser, HAROLD);
    try {
      const p = o.page;
      const body = `Gate code changed to 4471 (${engine}).`;
      await p.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-03-23"]`).click();
      await p.locator('#bw-nt').fill(body);
      await p.locator('[data-ctl="CTL-OFC-36-02"]').click();
      await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toBe(msg('job.note.saved'));
      const line = p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-14"] .note`).filter({ hasText: body });
      await line.waitFor({ timeout: 30_000 });
      expect(await line.innerText()).toMatch(new RegExp(`Office note - Keisha T., Tue, Sep 15, ${WHEN}$`));

      const details = `Gas furnace, 80,000 BTU, 96% efficient. Filter 16x25x4 (${engine})`;
      await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-11"] .eq`).filter({ hasText: msg('customers.equipment.furnace') }).locator('[data-ctl="CTL-OFC-03-24"]').click();
      await p.locator('#bw-eq-details').fill(details);
      await p.locator('[data-ctl="CTL-OFC-37-05"]').click();
      await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toBe(msg('job.equipment.saved'));
      await expect.poll(() => p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-11"]`).innerText()).toContain(details);
      // An untouched Type keeps its stored code: the word is the page's, in the page's language.
      expect(psql(`SELECT type FROM world.equipment e JOIN world.customer c ON c.id = e.customer_id WHERE c.name = 'Harold Jenkins' AND e.details = ${q(details)}`)).toBe('furnace');
      const customer = (await jobOf(HAROLD)).customer.id as string;
      await p.goto(`${origin}/office/customers/${customer}`, { waitUntil: 'load' });
      await expect.poll(() => p.locator('[data-screen="SCR-OFC-06"]').innerText(), { timeout: 30_000 }).toContain(details);
    } finally {
      await close(o);
    }
  });

  // why: FR-TEXT-20 (an a-acute switches the count to the 70-character limit; Rosa Delgado's box names Spanish)
  it('switches the count to 70 on an a-acute, and Rosa Delgado\'s box names Spanish', async () => {
    const o = await open(browser, HAROLD);
    try {
      await o.page.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-03-21"]`).click();
      await o.page.locator('#bw-tx').fill('á');
      await expect.poll(() => o.page.locator('#bw-tx-cnt').innerText()).toBe(`${msg('job.text.left', { n: 69 })} ${msg('job.text.outside', { ch: 'á' })}`);
    } finally {
      await close(o);
    }
    const rosa = Number(psql(`SELECT j.job_number FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE c.name = 'Rosa Delgado' ORDER BY j.date LIMIT 1`));
    const r = await open(browser, rosa);
    try {
      await r.page.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-03-21"]`).click();
      expect(await r.page.locator('[data-ctl="CTL-OFC-35-01"]').innerText()).toContain(msg('job.text.inSpanish'));
    } finally {
      await close(r);
    }
  });

  // why: F-702, FR-TEXT-15, UC-17 (SCR-OFC-03's Live row: EVT-03 moves a text's status word with no reload); F-1838 (F-704 made an office text's row read "Office text sent by <name>" with the status word in its small line, so the row is matched by those 2 parts)
  it('moves an office text to Delivered in Texts and activity with no reload', async () => {
    const o = await open(browser, HAROLD);
    try {
      const p = o.page;
      const lead = msg('job.feed.kind.office_text', { by: '' }).trim();
      const rows = p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-17"] .ev`).filter({ hasText: lead }).filter({ hasText: msg('msg.status.delivered') });
      await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-17"] .ev`).first().waitFor();
      const before = await rows.count();
      await p.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-03-21"]`).click();
      await p.locator('#bw-tx').fill(`Maria is close (${engine}).`);
      await p.locator('[data-ctl="CTL-OFC-35-04"]').click();
      await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toBe(msg('job.text.sent'));
      await expect.poll(() => rows.count(), { timeout: 60_000, interval: 500 }).toBe(before + 1);
    } finally {
      await close(o);
    }
  });

  // why: F-697, FR-DISP-6, UD-6 (a dialog sends the version it opened on: another person's save opens SCR-OFC-19, and nothing is overwritten unasked)
  it('2 people on Edit details: the second save opens SCR-OFC-19, Keep leaves their words, Save anyway saves mine, a third change updates the message', async () => {
    const n = await freshJob();
    // F-855: the job-changed toast on page a needs its event stream connected before page b saves, so each page reports when its stream answered.
    const streams = [0, 1].map(() => {
      let done: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => { done = resolve; });
      return { ready, before: (pg: Page) => { pg.on('response', (res) => { if (new URL(res.url()).pathname.endsWith('/api/v1/events')) done(); }); } };
    });
    const a = await open(browser, n, { before: streams[0]!.before });
    const b = await open(browser, n, { who: 'dana', before: streams[1]!.before });
    try {
      await Promise.race([Promise.all(streams.map((x) => x.ready)), new Promise((_, no) => setTimeout(() => no(new Error('an event stream did not connect within 30 s')), 30_000))]);
      const p = a.page;
      const mine = 'Mine: rattles at start';
      const theirs = 'Theirs: the customer called about a gas smell';
      await p.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-03-06"]`).click();
      await p.locator('#bw-ed-pr').fill(mine);
      await b.page.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-03-06"]`).click();
      await b.page.locator('#bw-ed-pr').fill(theirs);
      await b.page.locator('[data-ctl="CTL-OFC-23-04"]').click();
      await expect.poll(() => toast(b.page).innerText(), { timeout: 30_000 }).toBe(msg('job.edit.done'));
      // Her page re-read the job (EVT-01) behind the open dialog: the dialog keeps what it opened on and what was typed.
      await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toBe(msg('job.changed'));
      expect(await p.locator('#bw-ed-pr').inputValue()).toBe(mine);
      await p.locator('[data-ctl="CTL-OFC-23-04"]').click();
      const dlg = p.locator(CONFLICT);
      await dlg.waitFor({ timeout: 30_000 });
      expect(await dlg.locator('[data-ctl="CTL-OFC-19-01"]').innerText()).toMatch(new RegExp(`^Dana R\\. changed this job's details at ${WHEN}\\. Your edit was not made\\.$`));
      expect(await dlg.locator('button[data-ctl="CTL-OFC-19-02"]').innerText()).toBe('Save anyway');
      expect(await p.evaluate(() => (globalThis as unknown as { document: { activeElement: { textContent: string } } }).document.activeElement.textContent)).toBe(msg('board.conflict.keep'));
      expect((await jobOf(n)).job.problem).toBe(theirs);
      // Keep their change closes, re-reads and leaves their words.
      await dlg.locator('button[data-keep="1"]').click();
      await dlg.waitFor({ state: 'detached' });
      expect((await jobOf(n)).job.problem).toBe(theirs);
      // Again, and this time Save anyway: a change made while the dialog is up updates the message; the second Save anyway saves.
      await p.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-03-06"]`).click();
      await expect.poll(() => p.locator('#bw-ed-pr').inputValue()).toBe(theirs);
      await p.locator('#bw-ed-pr').fill(mine);
      await theirEdit(n, 'Theirs again');
      await p.locator('[data-ctl="CTL-OFC-23-04"]').click();
      await dlg.waitFor({ timeout: 30_000 });
      await theirEdit(n, 'Theirs a third time');
      await dlg.locator('button[data-ctl="CTL-OFC-19-02"]').click();
      await expect.poll(() => dlg.locator('[data-ctl="CTL-OFC-19-01"]').innerText(), { timeout: 30_000 }).toMatch(/^It changed again: Dana R\. changed/);
      expect((await jobOf(n)).job.problem).toBe('Theirs a third time');
      await dlg.locator('button[data-ctl="CTL-OFC-19-02"]').click();
      await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toBe(msg('job.edit.done'));
      await dlg.waitFor({ state: 'detached' });
      expect((await jobOf(n)).job.problem).toBe(mine);
    } finally {
      await close(a);
      await close(b);
    }
  });

  // why: F-697, FR-DISP-6, UD-6 (Reassign, Reschedule, Cancel visit and Finish visit each hold their version and answer version_conflict with SCR-OFC-19 and their own Anyway)
  it.each([
    { action: 'reassign', ctl: '03-04', label: 'Move it anyway', word: 'move' },
    { action: 'reschedule', ctl: '03-05', label: 'Reschedule anyway', word: 'reschedule' },
    { action: 'cancel', ctl: '03-07', label: 'Cancel anyway', word: 'cancellation' },
    { action: 'finish', ctl: '03-08', label: 'Finish anyway', word: 'finish' },
  ] as const)('$action: another person\'s change opens SCR-OFC-19, and $label makes the change', async ({ action, ctl, label, word }) => {
    const n = await freshJob();
    const o = await open(browser, n);
    try {
      const p = o.page;
      await p.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-${ctl}"]`).click();
      let submit = '';
      if (action === 'reassign') {
        const pick = p.locator('[data-screen="SCR-OFC-18"] .rl2').filter({ hasNotText: msg('board.reassign.none') }).first();
        await pick.waitFor({ timeout: 30_000 });
        await pick.click();
        submit = '[data-ctl="CTL-OFC-18-02"]:not(.dis)';
      } else if (action === 'reschedule') {
        const day = p.locator('[data-screen="SCR-OFC-20"] .dy:not([aria-disabled])').nth(2);
        await day.waitFor({ timeout: 30_000 });
        await day.click();
        await p.locator('[data-screen="SCR-OFC-20"] .win:not([aria-disabled])').first().click();
        submit = '[data-ctl="CTL-OFC-20-03"]:not(.dis)';
      } else if (action === 'cancel') {
        submit = '[data-ctl="CTL-OFC-21-02"]';
      } else {
        await p.locator('[data-ctl="CTL-OFC-22-05"] input').check();
        submit = '[data-ctl="CTL-OFC-22-07"]';
      }
      await theirEdit(n, 'Their change');
      await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toBe(msg('job.changed'));
      await p.locator(submit).click();
      const dlg = p.locator(CONFLICT);
      await dlg.waitFor({ timeout: 30_000 });
      expect(await dlg.locator('[data-ctl="CTL-OFC-19-01"]').innerText()).toMatch(new RegExp(`^Dana R\\. changed this job's details at ${WHEN}\\. Your ${word} was not made\\.$`));
      expect(await dlg.locator('button[data-ctl="CTL-OFC-19-02"]').innerText()).toBe(label);
      await dlg.locator('button[data-ctl="CTL-OFC-19-02"]').click();
      await dlg.waitFor({ state: 'detached', timeout: 30_000 });
      const after = await jobOf(n);
      if (action === 'reassign') expect(after.job.technician).not.toBeNull();
      if (action === 'reschedule') expect(after.timeline.map((t: Json) => t.kind)).toContain('rescheduled');
      if (action === 'cancel') expect(after.job.status).toBe('canceled');
      if (action === 'finish') expect(after.job.status).toBe('done');
    } finally {
      await close(o);
    }
  });

  // why: F-702, OA-61, OI-12, FR-BILL-7, F-697 (EVT-07 moves the billing chip with no reload; SCR-OFC-22 in correction mode opens prefilled, and a real conflict there opens SCR-OFC-19 with Save and send anyway)
  it('a finish billing refuses: the chip turns live, the correction opens prefilled, and a conflict there opens SCR-OFC-19', async () => {
    const n = await freshJob();
    const parts = (await api('keisha', 'GET', '/parts')).body.data.parts as Json[];
    const lines = { parts: [{ partId: parts[0].partId, quantity: 2 }], noPartsUsed: false };
    const o = await open(browser, n);
    let list: Open | undefined;
    try {
      await setBilling('reject_next_n', 8);
      const finished = await api('keisha', 'POST', `/jobs/${n}/finish`, { ...lines, laborMinutes: 65, baseVersion: (await jobOf(n)).job.version });
      expect(finished.status, JSON.stringify(finished.body)).toBe(200);
      await expect.poll(() => billingState(n), { timeout: 60_000, interval: 500 }).toBe('waiting_person');
      await expect.poll(() => o.page.locator(`${SCREEN} [data-ctl="CTL-OFC-03-19"] .chip`).innerText(), { timeout: 15_000 }).toBe(msg('job.billing.waiting_person'));

      list = await open(browser, n);
      const p = list.page;
      await p.goto(`${origin}/office/billing?branch=columbus`, { waitUntil: 'load' });
      const row = p.locator('table[data-ctl="CTL-OFC-10-03"] tbody tr').filter({ hasText: String(n) }).first();
      await row.waitFor({ timeout: 60_000 });
      await row.locator('[data-ctl="CTL-OFC-10-06"]').click();
      const dlg = p.locator('[data-screen="SCR-OFC-22"]');
      await dlg.locator('[data-ctl="CTL-OFC-22-10"]').waitFor({ timeout: 30_000 });
      expect(await dlg.locator('[data-ctl="CTL-OFC-22-01"] .pn b').innerText()).toBe(parts[0].name);
      expect(await dlg.locator('[data-ctl="CTL-OFC-22-04"] input').inputValue()).toBe('2');
      expect(await dlg.locator('[data-ctl="CTL-OFC-22-05"] input').isChecked()).toBe(false);
      expect(await dlg.locator('[data-ctl="CTL-OFC-22-06"] input').nth(0).inputValue()).toBe('1');
      expect(await dlg.locator('[data-ctl="CTL-OFC-22-06"] input').nth(1).inputValue()).toBe('05');
      expect(await dlg.locator('p[data-ctl="CTL-OFC-22-09"]').innerText()).toBe(msg('job.finish.nothingChanged'));
      expect(await dlg.locator('button[data-ctl="CTL-OFC-22-09"]').getAttribute('aria-disabled')).toBe('true');
      await dlg.locator('[data-ctl="CTL-OFC-22-06"] input').nth(1).fill('17');

      // Another person corrects it first and billing refuses again, so the job waits at a newer version.
      const theirs = await api('dana', 'POST', `/billing/queue/${n}/correction`, { ...lines, laborMinutes: 70, baseVersion: (await jobOf(n)).job.version });
      expect(theirs.status, JSON.stringify(theirs.body)).toBe(202);
      await expect.poll(() => billingState(n), { timeout: 60_000, interval: 500 }).toBe('waiting_person');
      await setBilling('up');
      await dlg.locator('button[data-ctl="CTL-OFC-22-09"]').click();
      const conflict = p.locator(CONFLICT);
      await conflict.waitFor({ timeout: 30_000 });
      expect(await conflict.locator('button[data-ctl="CTL-OFC-19-02"]').innerText()).toBe('Save and send anyway');
      await conflict.locator('button[data-ctl="CTL-OFC-19-02"]').click();
      await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toMatch(new RegExp(`${n}`));
      await expect.poll(() => billingState(n), { timeout: 60_000, interval: 500 }).toBe('in_billing');
      const d = await jobOf(n);
      expect(d.finish.laborMinutes).toBe(77);
      expect(d.timeline.filter((t: Json) => t.kind === 'finish_corrected').map((t: Json) => t.by)).toEqual(['Dana Ruiz', 'Keisha Thompson']);
      await expect.poll(() => o.page.locator(`${SCREEN} [data-ctl="CTL-OFC-03-19"] .chip`).innerText(), { timeout: 15_000 }).toBe(msg('job.billing.in_billing'));
    } finally {
      await setBilling('up');
      await close(o);
      if (list) await close(list);
    }
  });

  // why: F-565 (a role-gated control shows only for a role whose API-07 keys hold its contract ID)
  it('shows a role-gated control only when the API-07 keys hold its contract ID', async () => {
    const me = (await api('keisha', 'GET', '/me')).body.data;
    for (const id of ['API-22', 'API-24', 'API-25', 'API-26', 'API-27', 'API-140', 'API-142', 'API-143']) expect(me.permissions).toContain(id);
    const all = await open(browser, HAROLD);
    try {
      for (const ctl of ['03-04', '03-05', '03-06', '03-07', '03-08', '03-21', '03-23']) expect(await all.page.locator(`${SCREEN} [data-ctl="CTL-OFC-${ctl}"]`).count(), ctl).toBeGreaterThan(0);
    } finally {
      await close(all);
    }
    // The same page for a role whose keys lack API-26 and API-143: Finish visit and Text customer are not drawn; the rest are.
    const less = await open(browser, HAROLD, { before: (p) => p.route(`${origin}/api/v1/me`, async (r) => {
      const res = await r.fetch();
      const j = (await res.json()) as Json;
      j.data.permissions = (j.data.permissions as string[]).filter((k) => k !== 'API-26' && k !== 'API-143');
      await r.fulfill({ response: res, json: j });
    }) });
    try {
      await less.page.locator(`${SCREEN} [data-ctl="CTL-OFC-03-05"]`).waitFor();
      expect(await less.page.locator(`${SCREEN} [data-ctl="CTL-OFC-03-08"]`).count()).toBe(0);
      expect(await less.page.locator(`${SCREEN} [data-ctl="CTL-OFC-03-21"]`).count()).toBe(0);
      expect(await less.page.locator(`${SCREEN} [data-ctl="CTL-OFC-03-07"]`).count()).toBe(1);
    } finally {
      await close(less);
    }
  });

  // why: FR-BILL-3 (F-358: an office finish with neither parts nor No parts used is refused, and no call is made)
  it('refuses an office finish with neither parts nor No parts used', async () => {
    const o = await open(browser, HAROLD);
    try {
      const p = o.page;
      let finishes = 0;
      p.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith(`/jobs/${HAROLD}/finish`)) finishes++; });
      await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-08"]`).click();
      await p.locator('[data-ctl="CTL-OFC-22-07"]').click();
      expect(await p.locator('[data-screen="SCR-OFC-22"] .r1-fmsg').innerText()).toBe(msg('job.finish.partsRequired'));
      expect(finishes).toBe(0);
      expect((await jobOf(HAROLD)).job.status).toBe('on_the_way');
    } finally {
      await close(o);
    }
  });

  // why: FR-TEXT-4 (F-566; owner rulings 4241980e, 2142ce69 "End the link", d0c0a033 "Back to Scheduled", 7ccb76ec call 8)
  it('for an On the way job, Reassign, Reschedule and Cancel visit are enabled and each ends the link and cancels the unsent on-the-way text', async () => {
    docker('stop', worker!);
    const trips: { action: string; jobNumber: number; from: string }[] = [];
    try {
      for (const action of ['reassign', 'reschedule', 'cancel'] as const) {
        const { tech, job, userId } = await freeTrip();
        await onMyWay(userId, job.jobNumber);
        expect(texts(job.jobNumber, 'on_the_way').map((x) => x.split(':')[0])).toEqual(['queued']);
        expect([linkCount(job.jobNumber), linkEnded(job.jobNumber)]).toEqual([1, false]);
        trips.push({ action, jobNumber: job.jobNumber, from: tech.id });
        const o = await open(browser, job.jobNumber);
        try {
          const p = o.page;
          for (const ctl of ['03-04', '03-05', '03-07']) {
            const b = p.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-${ctl}"]`);
            expect(await b.getAttribute('aria-disabled'), ctl).toBeNull();
            expect(await b.getAttribute('class'), ctl).not.toMatch(/\bdis\b/);
          }
          if (action === 'reassign') {
            await p.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-03-04"]`).click();
            // Another technician: not the row marked Now, not No technician (Back to Scheduled is for the new technician).
            const other = p.locator('[data-screen="SCR-OFC-18"] .rl2').filter({ hasNot: p.locator('.now') })
              .filter({ hasNotText: msg('board.reassign.none') }).first();
            await other.waitFor({ timeout: 30_000 });
            await other.click();
            await p.locator('[data-ctl="CTL-OFC-18-02"]:not(.dis)').click();
            await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toBe(msg('job.reassign.done'));
          } else if (action === 'reschedule') {
            await p.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-03-05"]`).click();
            const day = p.locator('[data-screen="SCR-OFC-20"] .dy:not([aria-disabled])').nth(1);
            await day.waitFor({ timeout: 30_000 });
            await day.click();
            await p.locator('[data-screen="SCR-OFC-20"] .win:not([aria-disabled])').first().click();
            await p.locator('[data-ctl="CTL-OFC-20-03"]:not(.dis)').click();
            // F-827: the catalog's whole line on the real toast, which the look case (a fixed line at the tile's width) does not read
            await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toMatch(/^The visit is moved to .+; .+ (A new confirmation text is going to the customer\.|No text goes to the customer\.)$/);
          } else {
            await p.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-03-07"]`).click();
            await p.locator('[data-ctl="CTL-OFC-21-02"]').click();
            await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toBe(msg('job.cancel.done'));
          }
        } finally {
          await close(o);
        }
        // The link ends and the unsent on-the-way text is canceled, in the office's own write.
        expect(linkEnded(job.jobNumber), `${action}: link_token.ended_at`).toBe(true);
        expect(texts(job.jobNumber, 'on_the_way').map((x) => x.split(':')[0]), `${action}: the on-the-way text`).toEqual(['canceled']);
        const after = (await jobOf(job.jobNumber)).job;
        expect(after.status, action).toBe(action === 'cancel' ? 'canceled' : 'scheduled');
        // Back to Scheduled clears the trip (owner ruling d0c0a033); a canceled visit keeps when its trip began, as history.
        if (action !== 'cancel') expect(after.onTheWayAt, action).toBeNull();
        if (action === 'reassign') {
          // Back to Scheduled for the new technician in API-20 (the API-100 half is P5-TWA-TODAY's, F-703).
          const b = await board();
          const row = (b.technicians as Json[]).find((t) => t.jobs.some((j: Json) => j.jobNumber === job.jobNumber));
          expect(row?.id).toBeDefined();
          expect(row.id).not.toBe(tech.id);
          expect(row.jobs.find((j: Json) => j.jobNumber === job.jobNumber).status).toBe('scheduled');
        }
      }
    } finally {
      docker('start', worker!);
    }
    // Started again, the worker delivers every due text; none of the 3 on-the-way texts reaches an inbox.
    await expect.poll(() => Number(psql(`SELECT count(*) FROM world.outbox_text WHERE status = 'queued' AND due_at <= now()`)), { timeout: 90_000, interval: 1_000 }).toBe(0);
    for (const t of trips) {
      expect(texts(t.jobNumber, 'on_the_way').map((x) => x.split(':')[0]), t.action).toEqual(['canceled']);
    }
  });

  // why: F-565, F-507 (SCR-OFC-23 shows its message for API-27's window_full and time_overlap answers)
  it('shows SCR-OFC-23\'s message for a window_full and a time_overlap answer from API-27', async () => {
    const week = engine === 'chromium' ? 0 : 7;
    const date = (d: number) => Temporal.PlainDate.from('2026-10-06').add({ days: d + week }).toString();
    const window8 = psql(`SELECT id FROM world.arrival_window WHERE branch_id = 'columbus' AND mode = 'two_hour' AND start_local = '08:00'`);
    const customer = psql(`SELECT id FROM world.customer WHERE branch_id = 'columbus' AND status = 'active' ORDER BY name LIMIT 1 OFFSET ${3 + week}`);
    const tech = psql(`SELECT id FROM world.technician WHERE branch_id = 'columbus' AND NOT installer AND 2 = ANY(working_days) AND 3 = ANY(working_days) ORDER BY name LIMIT 1`);
    const make = async (d: string) => {
      const r = await api('keisha', 'POST', '/jobs', { customerId: customer, serviceId: 'furnace_tune_up', equipmentId: null, problem: null, date: d, windowId: window8, technicianId: tech });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.data.job.jobNumber as number;
    };
    const editTo = async (n: number, serviceId: string): Promise<string> => {
      const o = await open(browser, n);
      try {
        const p = o.page;
        await p.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-03-06"]`).click();
        const svc = p.locator('#bw-ed-svc');
        await expect.poll(() => svc.locator(`option[value="${serviceId}"]`).count(), { timeout: 30_000 }).toBe(1);
        await svc.selectOption(serviceId);
        await p.locator('[data-ctl="CTL-OFC-23-04"]').click();
        const shown = p.locator('[data-screen="SCR-OFC-23"] .r1-fmsg');
        await shown.waitFor({ timeout: 30_000 });
        return await shown.innerText();
      } finally {
        await close(o);
      }
    };
    // window_full: an install on a day no installer works has no room in the installer pool (F-507 item 3). Edit job details has no window to pick, so its message is windowFullEdit (F-872).
    const full = await make(date(0));
    const keishaId = psql(`SELECT id FROM world."user" WHERE email = 'keisha.t@brightwater.example'`);
    psql(`INSERT INTO world.time_off (technician_id, from_date, to_date, note, created_by)
          SELECT id, DATE ${q(date(0))}, DATE ${q(date(0))}, 'p4-job stack suite', ${q(keishaId)} FROM world.technician WHERE branch_id = 'columbus' AND installer`);
    const install = psql(`SELECT id FROM world.service_type WHERE skill = 'install' ORDER BY id LIMIT 1`);
    expect(await editTo(full, install)).toBe(msg('job.refused.windowFullEdit'));
    expect((await jobOf(full)).job.serviceId).toBe('furnace_tune_up');
    // time_overlap: a longer service runs into a block the technician has right after the visit (FR-DISP-34).
    const over = await make(date(1));
    const j = (await jobOf(over)).job;
    const start = Temporal.Instant.from((j.plannedArrival ?? j.window.start).replace(/\[.*\]$/, '')).toZonedDateTimeISO(ZONE);
    const end = start.add({ minutes: j.expectedMinutes });
    const at = end.round({ smallestUnit: 'minute', roundingIncrement: 5, roundingMode: 'ceil' });
    const hhmm = (z: Temporal.ZonedDateTime) => `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
    const block = await api('keisha', 'POST', '/time-blocks', { technicianId: tech, date: date(1), label: 'Supply run', place: null, start: hhmm(at), end: hhmm(at.add({ minutes: 30 })) });
    expect(block.status, JSON.stringify(block.body)).toBe(201);
    const longer = psql(`SELECT id FROM world.service_type WHERE skill <> 'install' AND expected_minutes > ${j.expectedMinutes} ORDER BY expected_minutes DESC, id LIMIT 1`);
    const text = await editTo(over, longer);
    expect(text).toMatch(/^That would overlap (Supply run, \S+|a block on the technician's row)/);
    expect((await jobOf(over)).job.serviceId).toBe('furnace_tune_up');
  });
});

// The shared clock only moves forward and Harold's job stays On the way for every engine above, so these run once, last.
describe('after every engine: Maria arrives, and the clock reaches 9:30 PM', () => {
  const [, type] = engines[engines.length - 1]!;
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-DISP-25, NFR-04 (after arrival the panel shows no van position, and API-135 has none to give)
  it('takes the panel and the map off Harold\'s open page when Maria arrives, and the feed names Arrived', async () => {
    const o = await open(browser, HAROLD);
    try {
      const p = o.page;
      await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-25"] .tech`).waitFor({ timeout: 30_000 });
      const maria = psql(`SELECT user_id FROM world.technician WHERE name = 'Maria Santos'`);
      const clock = (await api('dana', 'GET', '/clock')).body.data;
      const real = toWire(Temporal.Now.instant(), ZONE);
      const item = { key: crypto.randomUUID(), kind: 'arrived', jobNumber: HAROLD, baseVersion: (await jobOf(HAROLD)).job.version, worldEpoch: clock.worldEpoch, deviceTime: real, offsetSavedReal: real, sinceSaveMs: 0, demoTime: clock.demoNow };
      const r = await call(techToken(maria), 'POST', '/tech/items', { items: [item] });
      expect(r.body.data?.items?.[0], JSON.stringify(r.body)).toMatchObject({ result: 'applied' });
      await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-25"]`).waitFor({ state: 'detached', timeout: 30_000 });
      expect(await p.locator(`${SCREEN} .mapm`).count()).toBe(0);
      expect(await p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-09"]`).innerText()).toContain(msg('status.job.onSite'));
      await expect.poll(() => p.locator(`${SCREEN} [data-ctl="CTL-OFC-03-17"]`).innerText()).toContain(msg('job.feed.kind.status.on_site'));
      // F-868 (UI-SPECIFICATION 12.2 API-135): after arrival the answer is 410 with no coordinates.
      const gone = await api('keisha', 'GET', `/jobs/${HAROLD}/on-the-way`);
      expect(gone.status).toBe(410);
      expect(JSON.stringify(gone.body)).not.toMatch(/"lon"|"lat"/);
    } finally {
      await close(o);
    }
  });

  // why: FR-TEXT-20, FR-TEXT-7 (a text sent at 9:30 PM in his zone is held to 8:00 AM)
  it('holds Harold\'s 9:30 PM text to 8:00 AM', async () => {
    await clockAt(toWire(Temporal.ZonedDateTime.from(`2026-09-15T21:30:00[${ZONE}]`).toInstant(), ZONE));
    const o = await open(browser, HAROLD);
    try {
      const p = o.page;
      await p.locator(`${SCREEN} .jh [data-ctl="CTL-OFC-03-21"]`).click();
      await p.locator('#bw-tx').fill('Harold, we will call you in the morning.');
      await p.locator('[data-ctl="CTL-OFC-35-04"]').click();
      await expect.poll(() => toast(p).innerText(), { timeout: 30_000 }).toBe('Held until 8:00 AM Eastern'); // F-704: the held time and zone, API-143's heldUntil (Harold and the office are both Eastern)
      expect(psql(`SELECT status || ' ' || to_char(held_until AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') FROM world.outbox_text WHERE job_number = ${HAROLD} AND kind = 'office' ORDER BY created_at DESC, id DESC LIMIT 1`)).toBe('held 2026-09-16 08:00');
    } finally {
      await close(o);
    }
  });
});
