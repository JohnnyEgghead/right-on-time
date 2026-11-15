// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-5, FR-MAP-3 (P6-WEB-STEPS Acceptance: Playwright on Chromium and WebKit at 520 x 980 against the Compose stack at its default settings, routing up)
// SCR-TEC-08 Directions on the web technician app, turn by turn (UI-SPECIFICATION v0.15; SPECIFICATIONS v0.13 SD-49; owner rulings a923acaa "Add live
// routing" and F-1233 "map works but directions don't show any steps"), against the Compose stack ci/mapme-stack.sh starts (real PostgreSQL 18, real
// handlers, pbs, the worker and the routing service running), signed in as Maria Santos through the outside-origin guard:
//   1. 1 tap from Harold Jenkins's job opens the route to Linda Miller's job: the steps in driving order from Harold's address to hers, each with its
//      words and distance as API-104 says them, the first marked Now, the Next turn card, the step distances adding up to the route's; a picked step
//      centers the map on its turn and Show the whole route frames the route again; in Spanish for a Spanish-speaking technician;
//   2. a new online booking's leg (outside the baked set, routed live at its assignment) shows a routed line and its steps;
//   3. with the routing service stopped the same kind of leg shows the Approximate route label and the not-available sentence in the page's language, and
//      once it runs again the next read redraws it with Route updated;
//   4. with the network off after a read, Offline, steps saved shows the kept steps (from the time of that read, with no step marked Now).
// Run by ci/mapme-stack.sh after mapme.stack.ts; this file stops and starts the routing service itself (the stack's Compose settings are exported).
import { spawnSync } from 'node:child_process';
import type { BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { techRoute } from '../../packages/api/src/contracts/tech-route.ts';
import { formatterFor } from '../../packages/i18n/src/format.ts';
import { stepDistanceText, stepText } from '../../packages/i18n/src/step-words.ts';
import { guardedContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_MAPME_STACK_URL;
const db = process.env.BW_MAPME_DB_CONTAINER;
const project = process.env.BW_MAPME_PROJECT;
const people = { maria: process.env.BW_MAPME_MARIA, keisha: process.env.BW_MAPME_KEISHA, dana: process.env.BW_MAPME_DANA };
if (!base || !db || !project || Object.values(people).some((v) => !v)) throw new Error('BW_MAPME_STACK_URL, _DB_CONTAINER, _PROJECT and the session tokens are not set: run ci/mapme-stack.sh');
const origin = new URL(base).origin;
const APP_ORIGIN = 'http://localhost:8080';
const PHONE = { viewport: { width: 520, height: 980 }, colorScheme: 'light' as const };
const DATE = '2026-09-15';
const NEXT_DAY = '2026-09-16';
const ZONE = 'America/New_York';
const TEN_TWENTY_SIX = '2026-09-15T10:26:00-04:00[America/New_York]';
type Who = keyof typeof people;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
declare const window: Json;
declare const document: Json;

function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
const json = <T = Json>(sql: string): T => JSON.parse(psql(sql) || 'null') as T;
function compose(args: string[]): { status: number | null; out: string } {
  const r = spawnSync('docker', ['compose', '-p', project!, '-f', 'infra/compose.yaml', ...args], { encoding: 'utf8', env: process.env, timeout: 180_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
async function api(who: Who, method: string, p: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${origin}/api/v1${p}`, {
    method,
    headers: { cookie: `bw_session=${people[who]}`, ...(method === 'GET' ? {} : { origin: APP_ORIGIN, 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
async function publicApi(method: string, p: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${origin}/api/v1${p}`, { method, headers: method === 'GET' ? {} : { origin: APP_ORIGIN, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const ms = (wire: string) => Date.parse(wire.replace(/\[.*\]$/, ''));
const sleep = (t: number) => new Promise((r) => setTimeout(r, t));
async function until<T>(what: string, read: () => Promise<T> | T, cond: (v: T) => boolean, tries = 240): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i += 1) {
    last = await read();
    if (cond(last)) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}; last read: ${JSON.stringify(last).slice(0, 600)}`);
}
async function jumpTo(to: string): Promise<void> {
  for (let i = 0; ; i += 1) {
    const r = await api('dana', 'POST', '/clock/jumps', { to });
    if (r.status === 202) break;
    if (r.status !== 409 || i > 240) expect(r.status, JSON.stringify(r.body)).toBe(202);
    await sleep(500);
  }
  await until('the clock to reach the target', async () => (await api('dana', 'GET', '/clock')).body, (b) => !b.data.replay?.running && ms(b.data.demoNow) >= ms(to) - 1_000);
}
async function pauseClock(): Promise<void> {
  const r = await api('dana', 'PUT', '/clock/paused', { paused: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await until('the clock to be paused', async () => (await api('dana', 'GET', '/clock')).body, (b) => b.data.paused === true);
}

/** The routing service's answer, asked from inside the web container (it has no published port). */
function routingAnswers(): boolean {
  const c = json<{ lon: number; lat: number }>(`SELECT json_build_object('lon', depot_lon, 'lat', depot_lat) FROM world.branch WHERE id = 'columbus'`);
  const url = `http://routing:5000/route/v1/driving/${c.lon},${c.lat};${c.lon + 0.01},${c.lat + 0.01}?overview=false`;
  const r = compose(['exec', '-T', 'web', 'node', '-e', `fetch(${JSON.stringify(url)}).then((r) => r.text()).then((t) => console.log(t), () => process.exit(7))`]);
  return r.status === 0 && r.out.includes('"code":"Ok"');
}
const routingReady = () => until('the routing service to answer a route', routingAnswers, Boolean, 240);

/** Maria's day as the database holds it, in the day's order. */
interface DbStop { job: number; status: string; customer: string }
const mariaDay = (date: string): DbStop[] => json(`SELECT coalesce(json_agg(x ORDER BY ord), '[]'::json) FROM (
    SELECT row_number() OVER (ORDER BY j.window_start, j.planned_arrival NULLS LAST, j.job_number) AS ord, j.job_number AS job, j.status, c.name AS customer
      FROM world.job j JOIN world.technician t ON t.id = j.technician_id JOIN world.customer c ON c.id = j.customer_id
     WHERE t.name = 'Maria Santos' AND j.date = '${date}' AND j.status <> 'canceled') x`);
const maria = () => json<{ id: string }>(`SELECT json_build_object('id', id) FROM world.technician WHERE name = 'Maria Santos'`).id;
let serviceId = '';
let streetOffset = 0;
/** API-112 then API-113 for the next street no customer lives on: the job number, booked for today when a window is open, else for the next day. */
async function bookOnline(name: string): Promise<{ job: number; date: string }> {
  for (const date of [DATE, NEXT_DAY]) {
    for (let tries = 0; tries < 60; tries += 1, streetOffset += 1) {
      const street = psql(`SELECT s.id FROM world.street s WHERE s.branch_id = 'columbus' AND jsonb_array_length(s.points) >= 2
          AND NOT EXISTS (SELECT 1 FROM world.customer c WHERE c.street_id = s.id) ORDER BY s.name, s.id LIMIT 1 OFFSET ${streetOffset}`);
      const a = await publicApi('POST', '/public/availability', { streetId: street, serviceId, from: date, to: date });
      if (a.status !== 200 || a.body.data.branch !== 'columbus') continue;
      const win = ((a.body.data.days as Json[]).find((d) => d.date === date)?.windows as Json[] | undefined)?.find((x) => x.state === 'open');
      if (!win) continue;
      const b = await publicApi('POST', '/public/bookings', {
        serviceId, streetId: street, houseNumber: 1, date, windowId: win.windowId, name, mobile: null, textsOn: false, textLanguage: 'en', timeZone: ZONE,
      });
      expect(b.status, JSON.stringify(b.body)).toBe(201);
      streetOffset += 1;
      return { job: b.body.data.visit.jobNumber as number, date };
    }
  }
  throw new Error('no Columbus street with an open window today or the next day');
}
/** API-22 as the office: the job to Maria. */
/** The suite's booking leaves Maria's day (the next test's booking needs room): canceled, as the office would. */
const release = (job: number): void => void psql(`UPDATE world.job SET status = 'canceled' WHERE job_number = ${job}`);
/** A job booked for the next day, put on today's day at 4-6 PM (the app's day lists only today's jobs, so only today's job has its destination in words). */
function bringToToday(job: number): void {
  psql(`UPDATE world.job SET date = '${DATE}', window_start = ('${DATE} 16:00' AT TIME ZONE '${ZONE}'), window_end = ('${DATE} 18:00' AT TIME ZONE '${ZONE}'), planned_arrival = NULL WHERE job_number = ${job}`);
}
async function assignToMaria(job: number): Promise<void> {
  const version = Number(psql(`SELECT version FROM world.job WHERE job_number = ${job}`));
  const r = await api('keisha', 'POST', `/jobs/${job}/assignment`, { technicianId: maria(), baseVersion: version });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
/** The job before `job` in Maria's day of `date` (the leg's start), or null for the depot. */
function stopBefore(date: string, job: number): number | null {
  const d = mariaDay(date);
  const i = d.findIndex((x) => x.job === job);
  expect(i, `job ${job} is on Maria's day of ${date}`).toBeGreaterThanOrEqual(0);
  return i === 0 ? null : d[i - 1]!.job;
}

interface Net { off: boolean }
async function wire(context: BrowserContext, net: Net, lang: 'en' | 'es'): Promise<void> {
  await context.addCookies([{ name: 'bw_session', value: people.maria!, url: origin, httpOnly: true }, { name: 'bw_lang', value: lang, url: origin }]);
  await context.route(`${origin}/api/v1/**`, async (r) => {
    const req = r.request();
    if (net.off) return r.abort('internetdisconnected');
    try {
      const response = await r.fetch(req.method() === 'GET' ? {} : { headers: { ...(await req.allHeaders()), origin: APP_ORIGIN } });
      await r.fulfill({ response });
    } catch {
      // the page or its context closed while the call was in flight
    }
  });
}
let browserOf: import('playwright').Browser | undefined;
const phone = async (net: Net, lang: 'en' | 'es' = 'en'): Promise<GuardedContext> => {
  const g = await guardedContext(browserOf!, [origin], { ...PHONE, serviceWorkers: 'block' });
  await wire(g.context, net, lang);
  return g;
};
async function openDirections(context: BrowserContext, job: number, from: number | null, wait: string): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${origin}/tech/jobs/${job}/directions${from === null ? '' : `?from=${from}`}`, { waitUntil: 'load' });
  await page.waitForSelector(`.r1-screen[data-screen="SCR-TEC-08"] ${wait}`, { timeout: 60_000 });
  await page.waitForFunction(() => Boolean(document.querySelector('.dest .addr')?.textContent), undefined, { timeout: 30_000 });
  return page;
}
/** The real rows of the Steps list: the Loading skeleton's rows sit in a list with no control id. */
const STEPS_LI = '.steps[data-ctl="CTL-TEC-08-06"] li';
const text = async (page: Page, sel: string) => ((await page.locator(sel).first().innerText()) ?? '').trim();
/** The text as the markup holds it (a heading the sheet sets in capitals reads in capitals through innerText). */
const raw = async (page: Page, sel: string) => ((await page.locator(sel).first().textContent()) ?? '').trim();
const mapAttr = (page: Page, name: string) => page.$eval('.tmap .r1-map', (e: Json, n: string) => e.getAttribute(n), name) as Promise<string | null>;
/** Another read round, as a focus of the page (GAP-7: on open, on focus, after a send, every 60 s). */
const focusPage = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));
const centerOf = async (page: Page): Promise<[number, number]> => (await mapAttr(page, 'data-map-center'))!.split(',').map(Number) as [number, number];

interface Step { kind: string; direction: string | null; heading: string | null; road: string | null; exit: number | null; side: string | null; at: [number, number]; distanceMeters: number }
const readRoute = async (to: number, from: number | null) => {
  const r = await api('maria', 'GET', `/tech/route?${from === null ? '' : `fromJob=${from}&`}toJob=${to}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return techRoute.response.parse(r.body.data);
};
/** What the list shows, row by row: the words, the distance, whether the row is marked Now. */
const rowsOf = (page: Page) => page.$$eval('.steps[data-ctl="CTL-TEC-08-06"] li', (lis: Json[]) => lis.map((li) => ({
  words: li.querySelector('.tx > span:last-child')?.textContent ?? '', distance: li.querySelector('.w')?.textContent ?? null, now: li.classList.contains('now'), nowText: li.querySelector('.now-t')?.textContent ?? null,
})));
const streetOfPage = async (page: Page) => (await text(page, '.dest .addr')).split(' - ')[0]!.split(',')[0]!.trim();

beforeAll(async () => {
  await routingReady();
  // mapme.stack.ts leaves the clock at 10:26 AM, paused: a jump to where it already is is refused (not_forward)
  if (ms((await api('dana', 'GET', '/clock')).body.data.demoNow) < ms(TEN_TWENTY_SIX) - 1_000) await jumpTo(TEN_TWENTY_SIX);
  await pauseClock();
  serviceId = psql(`SELECT id FROM world.service_type WHERE bookable_online ORDER BY (id = 'furnace_tune_up') DESC, id LIMIT 1`);
  expect(serviceId).not.toBe('');
}, 600_000);
afterAll(() => {
  // a stopped routing service never outlives the suite
  compose(['start', 'routing']);
});

describe.each(engines)('P6-WEB-STEPS on %s', (engine, type) => {
  beforeAll(async () => {
    browserOf = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browserOf?.close();
  });

  // why: FR-TECH-5 1 tap on Directions from Harold's job shows the route to Linda Miller's job and its steps in driving order, from Harold's address to hers, with the Next turn card, step distances adding up to the route's, a picked step centering the map and Show the whole route framing it again
  it('lists the steps from Harold Jenkins\'s address to Linda Miller\'s, in driving order', async () => {
    const day = mariaDay(DATE);
    const at = day.findIndex((s) => s.customer === 'Harold Jenkins');
    const [harold, linda] = [day[at]!, day[at + 1]!];
    expect(linda.customer).toBe('Linda Miller');
    const route = await readRoute(linda.job, harold.job);
    const en = formatterFor('en');
    const g = await phone({ off: false });
    try {
      const page = await openDirections(g.context, linda.job, harold.job, STEPS_LI);
      await page.waitForSelector('.tmap .r1-map[data-map-state="ready"]', { timeout: 60_000 });
      // from Harold's address to Linda Miller's: the leg and the first and last steps
      const point = (job: number) => json<{ lon: number; lat: number }>(`SELECT json_build_object('lon', c.lon, 'lat', c.lat) FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.job_number = ${job}`);
      const [from, to] = [point(harold.job), point(linda.job)];
      expect([route.leg.from.lon, route.leg.from.lat]).toEqual([from.lon, from.lat]);
      expect([route.leg.to.lon, route.leg.to.lat]).toEqual([to.lon, to.lat]);
      const steps = route.steps as Step[];
      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect([steps[0]!.kind, steps.at(-1)!.kind]).toEqual(['depart', 'arrive']);
      expect(Math.abs(steps[0]!.at[0] - from.lon) + Math.abs(steps[0]!.at[1] - from.lat)).toBeLessThan(0.003);
      expect(Math.abs(steps.at(-1)!.at[0] - to.lon) + Math.abs(steps.at(-1)!.at[1] - to.lat)).toBeLessThan(0.003);
      // the step distances add up to the route's (SD-49), and the list says each as the shared function does
      expect(steps.reduce((n, s) => n + s.distanceMeters, 0)).toBe(route.leg.distanceMeters);
      expect(await text(page, '.dest h2')).toBe('Linda Miller');
      const street = await streetOfPage(page);
      const rows = await rowsOf(page);
      expect(rows.map((r) => r.words)).toEqual(steps.map((s) => stepText(s, en, street)));
      expect(rows.map((r) => r.distance)).toEqual(steps.map((s) => (s.kind === 'arrive' ? null : stepDistanceText(s.distanceMeters, en))));
      expect(rows.map((r) => r.now)).toEqual(steps.map((_, i) => i === 0));
      expect(rows[0]!.nowText).toBe('Now');
      expect(await page.locator('.steps .now-t').count()).toBe(1);
      expect(await page.getAttribute('.steps', 'aria-label')).toBe('Steps');
      // the Next turn card: the first step's distance, the second step's words, in a polite live region
      expect(await text(page, '.nturn')).toBe(`${en('tech.dir.nextTurnIn', { distance: stepDistanceText(steps[0]!.distanceMeters, en) })}\n${stepText(steps[1]!, en, street)}`);
      expect(await page.getAttribute('.nturn', 'aria-live')).toBe('polite');
      expect(await text(page, '.dest .dt')).toBe(`About ${route.leg.minutes} minutes`);
      expect(await mapAttr(page, 'data-map-routes')).toBe('baked');
      // a picked step centers the map on its turn, and Show the whole route frames the route again
      const whole = await centerOf(page);
      const pick = steps.findIndex((s, i) => i > 0 && Math.abs(s.at[0] - whole[0]) + Math.abs(s.at[1] - whole[1]) > 0.004);
      expect(pick, 'a step away from the middle of the route').toBeGreaterThan(0);
      await page.locator('.steps li .sb').nth(pick).click();
      await until('the map to center on the picked step', () => centerOf(page), (c) => Math.abs(c[0] - steps[pick]!.at[0]) < 0.0005 && Math.abs(c[1] - steps[pick]!.at[1]) < 0.0005, 40);
      await page.click('.tmap [data-ctl="CTL-TEC-08-07"]');
      await until('the map to frame the whole route', () => centerOf(page), (c) => Math.abs(c[0] - whole[0]) < 0.001 && Math.abs(c[1] - whole[1]) < 0.001, 40);
      g.assertNoOutsideRequests();
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TECH-5 the same leg in Spanish for a Spanish-speaking technician: the steps, their distances and the Now mark in the app's language, a road name as the map holds it
  it('words the steps in Spanish', async () => {
    const day = mariaDay(DATE);
    const at = day.findIndex((s) => s.customer === 'Harold Jenkins');
    const [harold, linda] = [day[at]!, day[at + 1]!];
    const route = await readRoute(linda.job, harold.job);
    const es = formatterFor('es');
    const g = await phone({ off: false }, 'es');
    try {
      const page = await openDirections(g.context, linda.job, harold.job, STEPS_LI);
      const street = await streetOfPage(page);
      const rows = await rowsOf(page);
      const steps = route.steps as Step[];
      expect(rows.map((r) => r.words)).toEqual(steps.map((s) => stepText(s, es, street)));
      expect(rows.map((r) => r.distance)).toEqual(steps.map((s) => (s.kind === 'arrive' ? null : stepDistanceText(s.distanceMeters, es))));
      expect(rows[0]!.nowText).toBe(es('tech.dir.now'));
      expect(rows[0]!.words).not.toBe(stepText(steps[0]!, formatterFor('en'), street));
      expect(await raw(page, '.below h3')).toBe(es('tech.dir.steps'));
      g.assertNoOutsideRequests();
    } finally {
      await g.context.close();
    }
  });

  // why: FR-MAP-3, FR-TECH-5 a new online booking's leg (outside the baked set, routed live at its assignment) shows a routed line and its steps
  it('shows a routed line and steps for a new online booking', async () => {
    const { job, date } = await bookOnline(`Lena Whitaker ${engine}`);
    expect(Number(psql(`SELECT count(*) FROM world.van_track WHERE from_ref = '${job}' OR to_ref = '${job}'`)), 'a new job has no baked track').toBe(0);
    await assignToMaria(job);
    if (date !== DATE) bringToToday(job);
    try {
    const prev = stopBefore(DATE, job);
    const route = await readRoute(job, prev);
    expect(route.leg.track, 'routed live').not.toBeNull();
    expect(Number(psql(`SELECT count(*) FROM world.van_track WHERE to_ref = '${job}' AND build_id = 'live'`)), 'routed live').toBeGreaterThan(0);
    expect(psql(`SELECT count(*) FROM world.van_track WHERE to_ref = '${job}' AND build_id <> 'live'`), 'no baked row').toBe('0');
    const g = await phone({ off: false });
    try {
      const page = await openDirections(g.context, job, prev, STEPS_LI);
      await page.waitForSelector('.tmap .r1-map[data-map-state="ready"]', { timeout: 60_000 });
      expect(await mapAttr(page, 'data-map-routes')).toBe('baked');
      expect(await page.locator(STEPS_LI).count()).toBe(route.steps.length);
      expect(route.steps.length).toBeGreaterThanOrEqual(2);
      expect(await page.locator('.tmap .bw-aprx').count()).toBe(0);
      g.assertNoOutsideRequests();
    } finally {
      await g.context.close();
    }
    } finally {
      release(job);
    }
  });

  // why: FR-MAP-3, FR-TECH-5 with the routing service stopped a leg no baked track covers shows the Approximate route label and the not-available sentence in the page's language, and after a restart the next read redraws it with Route updated
  it('shows Approximate route while routing is stopped and Route updated after it runs again', async () => {
    expect(compose(['stop', 'routing']).status).toBe(0);
    let g: GuardedContext | null = null;
    let booked = 0;
    try {
      const { job, date } = await bookOnline(`Ruth Abernathy ${engine}`);
      booked = job;
      await assignToMaria(job);
      if (date !== DATE) bringToToday(job);
      const prev = stopBefore(DATE, job);
      expect(psql(`SELECT count(*) FROM world.van_track WHERE to_ref = '${job}'`), 'the assignment stored nothing').toBe('0');
      const approx = await readRoute(job, prev);
      expect([approx.leg.track, approx.steps]).toEqual([null, []]);
      g = await phone({ off: false });
      const page = await openDirections(g.context, job, prev, '.noturn');
      await page.waitForSelector('.tmap .r1-map[data-map-state="ready"]', { timeout: 60_000 });
      const address = (await text(page, '.dest .addr')).split(' - ')[0]!;
      expect(await mapAttr(page, 'data-map-routes')).toBe('approximate');
      expect(await text(page, '.tmap .bw-aprx')).toBe(formatterFor('en')('map.approx'));
      expect(await text(page, '.noturn')).toBe(formatterFor('en')('tech.dir.approximate', { address }));
      expect([await page.locator('.steps').count(), await page.locator('.nturn').count(), await page.locator('.dest .dt').count()]).toEqual([0, 0, 0]);
      // in Spanish the label and the sentence are Spanish
      const es = await phone({ off: false }, 'es');
      try {
        const p2 = await openDirections(es.context, job, prev, '.noturn');
        await p2.waitForSelector('.tmap .bw-aprx', { timeout: 60_000 });
        expect(await text(p2, '.tmap .bw-aprx')).toBe(formatterFor('es')('map.approx'));
        expect(await text(p2, '.noturn')).toBe(formatterFor('es')('tech.dir.approximate', { address }));
      } finally {
        await es.context.close();
      }
      // the routing service runs again: the next read answers the live route and the screen redraws with Route updated
      expect(compose(['start', 'routing']).status).toBe(0);
      await routingReady();
      expect(await page.locator('[data-ctl="CTL-TEC-08-08"]').count()).toBe(0);
      await until('the page to redraw with the route', async () => {
        await focusPage(page);
        return page.locator(STEPS_LI).count();
      }, (n) => n > 0, 60);
      expect(await text(page, '[data-ctl="CTL-TEC-08-08"]')).toBe('Route updated.');
      expect(await page.getAttribute('.bw-tech-upd', 'aria-live')).toBe('polite');
      expect(await mapAttr(page, 'data-map-routes')).toBe('baked');
      expect(await page.locator('.noturn').count()).toBe(0);
      g.assertNoOutsideRequests();
    } finally {
      compose(['start', 'routing']);
      await g?.context.close();
      if (booked > 0) release(booked);
    }
  });

  // why: FR-TECH-5 with the network off after a read, Offline, steps saved shows the kept steps under the time of that read, with no step marked Now and no Next turn card
  it('keeps the steps of the last read for no signal', async () => {
    await routingReady();
    const day = mariaDay(DATE);
    const at = day.findIndex((s) => s.customer === 'Harold Jenkins');
    const [harold, linda] = [day[at]!, day[at + 1]!];
    const route = await readRoute(linda.job, harold.job);
    const net: Net = { off: false };
    const g = await phone(net);
    try {
      const page = await openDirections(g.context, linda.job, harold.job, STEPS_LI);
      const street = await streetOfPage(page);
      await page.waitForFunction(() => window.localStorage.getItem('bw.tech.routes') !== null, undefined, { timeout: 30_000 });
      net.off = true;
      await g.context.setOffline(true);
      await page.waitForSelector('.r1p-nosig', { timeout: 30_000 });
      const rows = await rowsOf(page);
      expect(rows.map((r) => r.words)).toEqual((route.steps as Step[]).map((s) => stepText(s, formatterFor('en'), street)));
      expect(rows.some((r) => r.now)).toBe(false);
      expect(await page.locator('.nturn').count()).toBe(0);
      expect(await page.locator('.steps .now-t').count()).toBe(0);
      expect(await raw(page, '.below h3')).toMatch(/^Steps from \d{1,2}:\d{2} (AM|PM)$/);
      expect(await text(page, '.tmap .need')).toBe('The map needs signal.');
      expect(await text(page, '.dest .dt')).toBe(`About ${route.leg.minutes} minutes`);
      g.assertNoOutsideRequests();
    } finally {
      await g.context.close();
    }
  });
});
