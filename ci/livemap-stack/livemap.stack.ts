// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-4, FR-TEXT-22, FR-TEXT-23, FR-MAP-1, FR-TEXT-17, FR-DISP-20, NFR-04 (P5-LIVEMAP Acceptance: Playwright on the Compose stack; G-CI5 step 3)
// The customer's live map page (SCR-CUS-04) and its ended page (SCR-CUS-05) against the Compose stack at its default settings (real PostgreSQL 18,
// real handlers, pbs and the worker running), set up by the setup service (the seeded world, the clock at Tue, Sep 15, 7:00 AM, moved once to
// 10:28 AM), through its proxy, every page opened through the outside-origin guard. Every shown field comes from the real API: a technician's On my
// way goes through API-102 as that technician (the phone's own call), and the page reads API-116 at the link the text printed. Run by
// ci/livemap-stack.sh. The suite shares 1 world and 1 clock: each engine picks its own trips.
//   A. While the van is on the way: the minutes, the progress bar, the van number, Call Brightwater, and the map drawn with the outside-origin
//      guard on and 0 outside requests (FR-MAP-1, F-363).
//   B. Arrival with the page open: the page answers 410 from then on (page and data, no coordinate), the open page shows the ended page, and on a
//      back and forward navigation after arrival the ended page shows (WebKit and Chromium; FR-TEXT-4).
//   C. The office's cancel, reassign and reschedule of a trip in progress (owner ruling 2142ce69 "End the link"): the page and the data answer
//      410 and the page says the visit changed, with the office phone only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Temporal, toWire } from '../../packages/time/src/index.ts';
import { guardedContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { readWebLog, waitFor } from './api116.ts';

const base = process.env.BW_LIVEMAP_STACK_URL;
const db = process.env.BW_LIVEMAP_DB_CONTAINER;
const web = process.env.BW_LIVEMAP_WEB_CONTAINER;
const techSeed = process.env.BW_LIVEMAP_TECHSEED;
const people = { keisha: process.env.BW_LIVEMAP_KEISHA, dana: process.env.BW_LIVEMAP_DANA };
if (!base || !db || !web || !techSeed || Object.values(people).some((v) => !v)) {
  throw new Error('BW_LIVEMAP_STACK_URL, _DB_CONTAINER, _WEB_CONTAINER, _TECHSEED and the session tokens are not set: run ci/livemap-stack.sh');
}
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the suite's proxy listens on a free port, so writes carry the default origin.
const APP_ORIGIN = 'http://localhost:8080';
const ZONE = 'America/New_York';
const LIVE = '.r1-screen[data-screen="SCR-CUS-04"]';
const ENDED = '.r1-screen[data-screen="SCR-CUS-05"]';
const CATALOG = JSON.parse(readFileSync('packages/i18n/catalog/en.json', 'utf8')) as Record<string, string>;
const msg = (key: string, values: Record<string, string | number> = {}) => (CATALOG[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ''));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** SQL in the stack's database as its owner (reads, and the customer a trip's text needs). */
function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

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

/** A technician's session token as ci/livemap-stack/fixture.sql made it: base64url of sha256(techseed + user id). */
const techToken = (userId: string) => createHash('sha256').update(`${techSeed}${userId}`).digest('base64url');

/** A technician's item as the phone sends it (API-102, section 5.1 step 1): the offset saved now, the item entered now. */
async function sendItem(userId: string, kind: 'on_my_way' | 'arrived', jobNumber: number): Promise<void> {
  const clock = (await api('dana', 'GET', '/clock')).body.data;
  const real = toWire(Temporal.Now.instant(), ZONE);
  const version = (await jobOf(jobNumber)).job.version as number;
  const item = {
    key: crypto.randomUUID(), kind, jobNumber, baseVersion: version, worldEpoch: clock.worldEpoch,
    deviceTime: real, offsetSavedReal: real, sinceSaveMs: 0, demoTime: clock.demoNow,
  };
  const r = await call(techToken(userId), 'POST', '/tech/items', { items: [item] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.data.items[0], JSON.stringify(r.body)).toMatchObject({ result: 'applied' });
}

/** A Columbus technician with no job On the way or On site and a scheduled job today, not one used already. */
const used = new Set<number>();
/** A technician whose trip ended at arrival stays On site and so is never free again; each case lets its own trip go once it has run, so the next case (and the other engine) finds a technician. */
function releaseTrips(): void {
  if (used.size === 0) return;
  psql(`UPDATE world.job SET status = 'no_one_home', ended_at = now() WHERE status = 'on_site' AND job_number IN (${[...used].join(',')})`);
}
async function freeTrip(): Promise<{ tech: Json; job: Json; userId: string }> {
  const b = await board();
  for (const t of b.technicians as Json[]) {
    if (t.jobs.some((j: Json) => j.status === 'on_the_way' || j.status === 'on_site')) continue;
    const job = (t.jobs as Json[]).find((j) => j.status === 'scheduled' && !used.has(j.jobNumber));
    if (!job) continue;
    used.add(job.jobNumber);
    const userId = psql(`SELECT user_id FROM world.technician WHERE id = ${q(t.id)}`);
    // The customer gets a mobile and texts on, so the On my way sends its text with the link (FR-TEXT-3).
    psql(`UPDATE world.customer SET mobile = '+16145550142', texts_on = true WHERE id = (SELECT customer_id FROM world.job WHERE job_number = ${job.jobNumber})`);
    return { tech: t, job, userId };
  }
  const seen = (b.technicians as Json[]).map((t) => `${t.name}: ${(t.jobs as Json[]).map((j) => `${j.jobNumber} ${j.status}${used.has(j.jobNumber) ? ' (used)' : ''}`).join(', ')}`).join('; ');
  throw new Error(`no Columbus technician is free with a scheduled job today (${seen})`);
}
/**
 * F-1269, F-1420: API-116 (live map data, a link-token route) allows 60 calls a minute per address, and every page load reads it on the server under
 * the visitor's address too (./api116.ts). The cases run back to back from 1 address and made 70-73 calls with 52 in the busiest minute, so a slow
 * run met a 429 where it expects 410. Before each case the suite waits only until the web log's last minute leaves room for a case: ROOM calls, or
 * the most any case of the run has made if that is more; no 60 s window can then pass the limit while a case runs. The limit and every assertion
 * stay as they are. The fixed 12 s pause after every case that this replaces cost 120 s a run and took G-CI5 past its 300 s limit on Spectre
 * (F-1420); the cases make 6 to 9 calls each.
 */
const ROOM = 20;
let room = ROOM;
let callsAtStart = 0;
async function paceCase(): Promise<void> {
  for (;;) {
    // A call of ours first (not API-116), so the newest line of the log is the web process's time now.
    await api('dana', 'GET', '/clock');
    const log = readWebLog(web!);
    const wait = waitFor(log.hits, log.newest, room);
    if (wait <= 0) {
      callsAtStart = log.hits.length;
      return;
    }
    // 250 ms over: a timer can fire a little early (F-1328), and the loop reads the log again before the case starts.
    await new Promise((done) => setTimeout(done, wait + 250));
  }
}
/** After a case, its pages closed: the calls it made, which raise the room the next case waits for. */
function countCase(): void {
  room = Math.max(room, readWebLog(web!).hits.length - callsAtStart);
}
const linkOf = (n: number): string => psql(`SELECT token FROM world.link_token WHERE job_number = ${n} AND kind = 'live_map' ORDER BY created_at DESC LIMIT 1`);
const officePhone = (): string => psql(`SELECT office_phone FROM world.branch WHERE id = 'columbus'`);
const firstName = (n: string) => n.trim().split(/\s+/)[0]!;
const clockText = (wire: string): string => {
  const z = Temporal.ZonedDateTime.from(wire);
  return `${z.hour % 12 === 0 ? 12 : z.hour % 12}:${String(z.minute).padStart(2, '0')} ${z.hour >= 12 ? 'PM' : 'AM'}`;
};

/** A visit window as a customer page names it, from the wire times: "10 AM-12 PM EDT" (UD-15, FR-TEXT-17). Written from Intl, not from the product's formatter. */
const zonedWindow = (w: { start: string; end: string }): string => {
  const part = (wire: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: ZONE, ...o }).formatToParts(ms(wire));
  const hour = (wire: string) => Number(part(wire, { hour: 'numeric', hourCycle: 'h23' }).find((x) => x.type === 'hour')!.value);
  const [s, e] = [hour(w.start), hour(w.end)];
  const n = (h: number) => (h % 12 === 0 ? 12 : h % 12);
  const mer = (h: number) => (h < 12 ? 'AM' : 'PM');
  const zone = part(w.start, { timeZoneName: 'short' }).find((x) => x.type === 'timeZoneName')!.value;
  return `${mer(s) === mer(e) ? `${n(s)}-${n(e)} ${mer(e)}` : `${n(s)} ${mer(s)}-${n(e)} ${mer(e)}`} ${zone}`;
};

/** What a live map link's page and data answer to a plain GET (no cookie): status, cache header and body. */
async function plain(path: string): Promise<{ status: number; cache: string | null; text: string }> {
  const r = await fetch(`${origin}${path}`, { headers: { accept: path.endsWith('/data') ? 'application/json' : 'text/html' } });
  return { status: r.status, cache: r.headers.get('cache-control'), text: await r.text() };
}
/** Nothing of the van's place in a body: no coordinate member, no map. */
const NO_PLACE = /"(lon|lat|destination|route|track)"\s*:|"van"\s*:\s*\{|maplibre|data-map-/;
const expectGone = async (token: string, why: string): Promise<void> => {
  const data = await plain(`/m/${token}/data`);
  expect(data.status, `${why}: data`).toBe(410);
  expect(data.cache, `${why}: data cache`).toMatch(/no-store/);
  expect(data.text, `${why}: data body`).not.toMatch(NO_PLACE);
  expect(JSON.parse(data.text), why).toMatchObject({ code: 'gone', officePhone: officePhone() });
  const page = await plain(`/m/${token}`);
  expect(page.status, `${why}: page`).toBe(410);
  expect(page.cache, `${why}: page cache`).toMatch(/no-store/);
  expect(page.text, `${why}: page body`).not.toMatch(NO_PLACE);
};

interface Open { page: Page; g: GuardedContext }
async function openLink(browser: Browser, token: string): Promise<Open> {
  const g = await guardedContext(browser, [origin], { viewport: { width: 390, height: 844 } });
  const page = await g.context.newPage();
  const res = await page.goto(`${origin}/m/${token}`, { waitUntil: 'load' });
  expect(res?.status()).toBe(200);
  expect(res?.headers()['cache-control']).toMatch(/no-store/);
  return { page, g };
}
const close = (o: Open) => o.g.context.close();
const screenOf = (p: Page) => p.locator('.r1-screen').first().getAttribute('data-screen');
const expectEnded = (p: Page) => expect.poll(() => screenOf(p), { timeout: 40_000, interval: 500 }).toBe('SCR-CUS-05');

/** FR-DISP-20 (UD-56, F-1192): with the page's scripts off the server-drawn Call shows the telephone link at 375 px and the button at 1280 px. */
async function expectCallFormsWithoutScripts(browser: Browser, token: string): Promise<void> {
    const digits = officePhone().replace(/\D/g, '');
    const tel = `tel:+${digits.length === 10 ? `1${digits}` : digits}`;
    const open = async (opts: Parameters<Browser['newContext']>[0]) => {
      const g = await guardedContext(browser, [origin], { ...opts, javaScriptEnabled: false });
      const p = await g.context.newPage();
      expect((await p.goto(`${origin}/m/${token}`, { waitUntil: 'load' }))?.status()).toBe(200);
      return { g, p };
    };
    const phone = await open({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    try {
      const link = phone.p.locator(`${LIVE} a.call[data-callform="tel"]`);
      const button = phone.p.locator(`${LIVE} .bw-call[data-callform="reveal"] button.call`);
      expect(await link.count(), 'the server draws the telephone link').toBe(1);
      expect(await button.count(), 'the server draws the button').toBe(1);
      expect(await link.isVisible(), 'the link shows on a phone').toBe(true);
      expect(await button.isVisible(), 'the button is hidden on a phone').toBe(false);
      expect(await link.getAttribute('href')).toBe(tel);
    } finally {
      await phone.g.context.close();
    }
    const wide = await open({ viewport: { width: 1280, height: 800 } });
    try {
      expect(await wide.p.locator(`${LIVE} .bw-call[data-callform="reveal"] button.call`).isVisible(), 'the button shows on a computer').toBe(true);
      expect(await wide.p.locator(`${LIVE} a.call[data-callform="tel"]`).isVisible(), 'the link is hidden on a computer').toBe(false);
    } finally {
      await wide.g.context.close();
    }
}

describe.each(engines)('the live map on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
    await clockAt(toWire(Temporal.ZonedDateTime.from(`2026-09-15T10:28:00[${ZONE}]`).toInstant(), ZONE));
  });
  beforeEach(async () => {
    await paceCase();
  });
  afterEach(() => {
    releaseTrips();
    countCase();
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-TEXT-22, FR-TEXT-23, FR-MAP-1, FR-TEXT-17 (the live map from the real API, drawn with 0 outside requests, its visit windows naming the zone; F-363, F-1162)
  it('shows the minutes, the progress bar, the van number, Call Brightwater and the drawn map while the technician is on the way, then the ended page at arrival, and back and forward after it', async () => {
    const { tech, job, userId } = await freeTrip();
    await sendItem(userId, 'on_my_way', job.jobNumber);
    const token = linkOf(job.jobNumber);
    expect(token).toMatch(/^[0-9A-Za-z]{8}$/);
    const data = (await plain(`/m/${token}/data`));
    expect(data.status).toBe(200);
    const answer = JSON.parse(data.text).data as Json;
    const o = await openLink(browser, token);
    try {
      const p = o.page;
      // Heading: the technician's first name, the minutes and the arrival time of API-116.
      await p.locator(`${LIVE} .hero h1`).waitFor({ timeout: 60_000 });
      expect(await p.locator(`${LIVE} .hero h1`).innerText()).toBe(msg('livemap.hero.title', { name: firstName(tech.name) }));
      // The demo clock runs between the data read above and the page's own read, so the minutes may be 1 fewer on the page; the arrival time is fixed.
      const leadOf = (n: number) => (n <= 1 ? msg('livemap.hero.min1') : msg('livemap.hero.min', { n }));
      expect([answer.minutesAway, Math.max(answer.minutesAway - 1, 0)].map((n) => `${leadOf(n)}${clockText(answer.eta)}`)).toContain(await p.locator(`${LIVE} .hero p`).innerText());
      // The bar from the time the technician left to the arrival time, its ends in words, its value in words.
      const bar = p.locator(`${LIVE} .eta[role="progressbar"]`);
      expect(await bar.innerText()).toContain(msg('livemap.eta.left', { time: clockText(answer.leftAt) }));
      expect(await bar.getAttribute('aria-valuetext')).toMatch(new RegExp(`^Left ${clockText(answer.leftAt)}, arriving ${clockText(answer.eta)}`));
      // The technician card: the van number.
      expect(await p.locator(`${LIVE} .who`).innerText()).toContain(`Van ${answer.technician.van}`);
      // FR-TEXT-17: the visit line names the visit's window with the branch zone after it.
      expect(zonedWindow(answer.visit.window)).toMatch(/^\d{1,2}( [AP]M)?-\d{1,2} [AP]M E[DS]T$/);
      expect(await p.locator(`${LIVE} .who`).innerText()).toContain(zonedWindow(answer.visit.window));
      // Call Brightwater: the branch office phone, shown on a computer by pressing the button (CMP-16).
      expect(await p.locator(`${LIVE} .brandrow .tel14`).innerText()).toBe(officePhone());
      await p.locator(`${LIVE} .call:visible`).click();
      expect(await p.locator(`${LIVE} [data-call-number]`).innerText()).toBe(officePhone());
      // FR-MAP-1: the map is drawn from the proxy's own files, with the outside-origin guard on.
      await p.locator(`${LIVE} .r1-map[data-map-state="ready"]`).waitFor({ timeout: 90_000 });
      expect(Number(await p.locator(`${LIVE} .r1-map`).getAttribute('data-map-markers'))).toBeGreaterThanOrEqual(2);
      expect(o.g.outside).toEqual([]);

      // B. The technician arrives with the page open; the link answers 410 from then on, page and data, with no coordinate.
      await p.goto(`${origin}/sign-in`, { waitUntil: 'load' });
      await sendItem(userId, 'arrived', job.jobNumber);
      await expectGone(token, 'after arrival');
      // Back to the cached live page: it reads again when shown (pageshow) and shows the ended page; forward and back again keeps it so.
      await p.goBack({ waitUntil: 'load' });
      await expectEnded(p);
      expect(await p.locator(`${ENDED} .hero h1`).innerText()).toBe(msg('livemap.ended.arrived', { name: firstName(tech.name) }));
      expect(await p.locator(`${ENDED} .r1-map`).count()).toBe(0);
      expect(await p.content()).not.toMatch(NO_PLACE);
      await p.goForward({ waitUntil: 'load' });
      await p.goBack({ waitUntil: 'load' });
      await expectEnded(p);
      expect(await p.locator(`${ENDED} .card2`).innerText()).toContain(tech.name);
      // FR-TEXT-17: the arrival line and the Arrival window row name the zone after the window.
      expect(await p.locator(`${ENDED} .hero p`).innerText()).toContain(`${zonedWindow(answer.visit.window)} window.`);
      expect(await p.locator(`${ENDED} .card2 .li`).filter({ hasText: msg('livemap.ended.window') }).innerText()).toContain(zonedWindow(answer.visit.window));
      expect(o.g.outside).toEqual([]);
    } finally {
      await close(o);
    }
  });

  // why: FR-TEXT-23, FR-DISP-20 (on a phone profile, Call Brightwater is a tel: link to the Columbus office number, on the live page and the ended page; F-947)
  it('makes Call Brightwater a tel: link to the office number on a phone, on the live page and on the ended page', async () => {
    const { job, userId } = await freeTrip();
    await sendItem(userId, 'on_my_way', job.jobNumber);
    const token = linkOf(job.jobNumber);
    const digits = officePhone().replace(/\D/g, '');
    const tel = `tel:+${digits.length === 10 ? `1${digits}` : digits}`;
    await expectCallFormsWithoutScripts(browser, token);
    const g = await guardedContext(browser, [origin], { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const p = await g.context.newPage();
      expect((await p.goto(`${origin}/m/${token}`, { waitUntil: 'load' }))?.status()).toBe(200);
      const live = p.locator(`${LIVE} .call:visible`);
      await live.waitFor({ timeout: 60_000 });
      // F-1191: Call shows from the first load (CTL-CUS-04-06). The server draws both forms and the SD-33 query shows 1 (UD-56, F-1192; the next test
      // runs it with scripts off); once the page's scripts have read the query one form is left. The context must present as a phone, and the link must be it.
      expect(await p.evaluate('matchMedia("(pointer: coarse) and (hover: none)").matches'), 'the phone context matches the SD-33 query').toBe(true);
      await expect.poll(() => live.evaluate((e) => e.tagName), { timeout: 10_000 }).toBe('A');
      expect(await live.getAttribute('href')).toBe(tel);
      await sendItem(userId, 'arrived', job.jobNumber);
      expect((await p.goto(`${origin}/m/${token}`, { waitUntil: 'load' }))?.status()).toBe(410);
      const ended = p.locator(`${ENDED} .call:visible`);
      await ended.waitFor({ timeout: 60_000 });
      expect(await ended.evaluate((e) => e.tagName)).toBe('A');
      expect(await ended.getAttribute('href')).toBe(tel);
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TEXT-4 (owner ruling 2142ce69 "End the link": the office's cancel, reassign and reschedule of a trip in progress end the link)
  it.each(['cancel', 'reassign', 'reschedule'] as const)('after the office %ss a trip in progress, the page and the data answer 410 and the page says the visit changed', async (action) => {
    const { tech, job, userId } = await freeTrip();
    await sendItem(userId, 'on_my_way', job.jobNumber);
    const token = linkOf(job.jobNumber);
    const o = await openLink(browser, token);
    try {
      const p = o.page;
      await p.locator(`${LIVE} .hero h1`).waitFor({ timeout: 60_000 });
      const version = (await jobOf(job.jobNumber)).job.version as number;
      if (action === 'cancel') {
        const r = await api('keisha', 'POST', `/jobs/${job.jobNumber}/cancellation`, { baseVersion: version });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
      } else if (action === 'reassign') {
        const others = ((await board()).technicians as Json[]).filter((t) => t.id !== tech.id);
        let done = false;
        for (const t of others) {
          const r = await api('keisha', 'POST', `/jobs/${job.jobNumber}/assignment`, { technicianId: t.id, baseVersion: version });
          if (r.status === 200) {
            done = true;
            break;
          }
        }
        expect(done, 'no other technician took the trip').toBe(true);
      } else {
        const days = (await api('keisha', 'GET', '/availability?branch=columbus&serviceId=furnace_tune_up&from=2026-10-01&to=2026-11-10&channel=office')).body.data.days as Json[];
        let done = false;
        for (const d of days.filter((x) => x.state === 'open')) {
          for (const w of (d.windows as Json[]).filter((x) => x.state === 'open')) {
            const r = await api('keisha', 'POST', `/jobs/${job.jobNumber}/schedule`, { date: d.date, windowId: w.windowId, baseVersion: version });
            if (r.status === 200) done = true;
            if (done) break;
          }
          if (done) break;
        }
        expect(done, 'no open window took the trip').toBe(true);
      }
      await expectGone(token, action);
      // The open page reads again within its interval and shows the Visit changed state: the office phone only, no old van, technician or window.
      await expectEnded(p);
      expect(await p.locator(`${ENDED} .hero h1`).innerText()).toBe(msg('livemap.ended.changed'));
      expect(await p.locator(`${ENDED} .card2`).count()).toBe(0);
      expect(await p.locator(`${ENDED} .who`).count()).toBe(0);
      expect(await p.locator(`${ENDED} .r1-map`).count()).toBe(0);
      expect(await p.locator(`${ENDED} .call:visible`).count()).toBe(1);
      expect(await p.content()).not.toContain(tech.name);
      expect(await p.content()).not.toMatch(NO_PLACE);
      // A fresh load of the link is the same page, status 410.
      const again = await p.goto(`${origin}/m/${token}`, { waitUntil: 'load' });
      expect(again?.status()).toBe(410);
      await expectEnded(p);
    } finally {
      await close(o);
    }
  });
});
