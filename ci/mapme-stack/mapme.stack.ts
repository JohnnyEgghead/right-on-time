// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-5, FR-TECH-10, FR-TECH-11, FR-TECH-13, FR-TECH-15, FR-MAP-1, F-937, NFR-09 (P5-TWA-MAP-ME Acceptance: Playwright on Chromium and WebKit at 520 x 980 against the Compose stack)
// The web technician app's Map tab, Directions, Parts, Me and install page (SCR-TEC-15, -08, -16, -10, -11) against the Compose stack at its default
// settings (real PostgreSQL 18, real handlers, pbs and the worker running), set up by the setup service (the seeded world, the clock at Tue, Sep 15,
// 7:00 AM), through its proxy, every page opened through the outside-origin guard, signed in as Maria Santos (ci/mapme-stack/fixture.sql):
//   1. the Map tab at Sep 15, 10:26 AM numbers Maria's stops in the day's order, marks her finished jobs Done and Harold Jenkins's job Next, shows his
//      window, customer, address and drive time, and draws the map with 0 requests outside the app's own origin (FR-TECH-11, FR-MAP-1);
//   2. Directions: 1 tap on the Next stop card's button opens the route to that job on the app's own map, with the same minutes the button shows, and
//      those are the baked track's drive minutes (FR-TECH-5, FR-TECH-13);
//   3. the tabs Today, Map, Parts and Me each open their screen, and the Parts search finds a part by name or code with the network off, with
//      no edit control (FR-TECH-10);
//   4. Me: the van with no stock-checked line, the start time of the first sign-in of the day, hours on the clock, jobs done, Call dispatch, the version;
//      Text size Large enlarges the text and stays after the app closes; Notifications off stops the in-app notices and no push service is contacted
//      (FR-TECH-15);
//   5. a job moved by the office raises 1 day-changed notice with Notifications on and none with it off (FR-TECH-15, UD-43);
//   6. Sign out is refused while an item waits, then signs out and the service worker drops the kept /tech pages (F-937);
//   7. the install page shows the steps of the visitor's browser and Continue in the browser stops it showing (NFR-09).
// Run by ci/mapme-stack.sh. The suite shares 1 world and 1 clock; every move of Maria's jobs is put back.
import { hashPassword } from '../../packages/db/src/passwords.ts';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, BrowserType, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedContext, guardedPersistentContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_MAPME_STACK_URL;
const db = process.env.BW_MAPME_DB_CONTAINER;
const people = {
  maria: process.env.BW_MAPME_MARIA, mariaout1: process.env.BW_MAPME_MARIAOUT1, mariaout2: process.env.BW_MAPME_MARIAOUT2,
  mariaout3: process.env.BW_MAPME_MARIAOUT3, mariaout4: process.env.BW_MAPME_MARIAOUT4,
  keisha: process.env.BW_MAPME_KEISHA, dana: process.env.BW_MAPME_DANA,
};
if (!base || !db || Object.values(people).some((v) => !v)) throw new Error('BW_MAPME_STACK_URL, _DB_CONTAINER and the session tokens are not set: run ci/mapme-stack.sh');
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the suite's proxy listens on a free port, so writes carry the default origin.
const APP_ORIGIN = 'http://localhost:8080';
const PHONE = { viewport: { width: 520, height: 980 }, colorScheme: 'light' as const };
const DATE = '2026-09-15';
const TEN_TWENTY_SIX = '2026-09-15T10:26:00-04:00[America/New_York]';
type Who = keyof typeof people;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
// The page-side functions run in the browser; the suite's own typings carry no DOM.
declare const document: Json;
declare const window: Json;
declare const MutationObserver: Json;
/** The page's Cache Storage, as the service worker test reads it (the suite's own typings carry no DOM). */
interface Caches { keys(): Promise<string[]>; open(name: string): Promise<{ keys(): Promise<{ url: string }[]> }> }

/** SQL in the stack's database as its owner (reads, and the rows the suite sets up). */
function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}

/** A call as a person, with the default origin on writes (the kernel's Origin check, SD-8). */
async function api(who: Who, method: string, p: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${origin}/api/v1${p}`, {
    method,
    headers: { cookie: `bw_session=${people[who]}`, ...(method === 'GET' || method === 'DELETE' ? {} : { origin: APP_ORIGIN, 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const ms = (wire: string) => Date.parse(wire.replace(/\[.*\]$/, ''));
const sleep = (t: number) => new Promise((r) => setTimeout(r, t));

async function until<T>(what: string, read: () => Promise<T> | T, cond: (v: T) => boolean, tries = 120): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i += 1) {
    last = await read();
    if (cond(last)) return last;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}; last read: ${JSON.stringify(last).slice(0, 600)}`);
}

/** Move the shared clock to a wire time (API-12, the manager; a replay still running refuses with 409) and wait until it has caught up. */
async function jumpTo(to: string): Promise<void> {
  for (let i = 0; ; i += 1) {
    const r = await api('dana', 'POST', '/clock/jumps', { to });
    if (r.status === 202) break;
    // an earlier attempt's jump landed while this one waited: the clock is already at the target
    if (r.status === 409 && r.body?.code === 'not_forward') break;
    if (r.status !== 409 || i > 240) expect(r.status, JSON.stringify(r.body)).toBe(202);
    await sleep(500);
  }
  await until('the clock to reach the target', async () => (await api('dana', 'GET', '/clock')).body, (b) => !b.data.replay?.running && ms(b.data.demoNow) >= ms(to) - 1_000);
}

/** Hold the demo clock where it is (API-13, the manager), so a time on a screen does not move under the test. */
async function pauseClock(): Promise<void> {
  const r = await api('dana', 'PUT', '/clock/paused', { paused: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await until('the clock to be paused', async () => (await api('dana', 'GET', '/clock')).body, (b) => b.data.paused === true);
}

/** Maria's day as the database holds it, in the day's order (window, planned arrival, job number), and the facts the screens derive from it. */
interface DbStop { job: number; status: string; customer: string; area: string; sh: number; eh: number; version: number }
function mariaDay(): DbStop[] {
  return JSON.parse(psql(`SELECT coalesce(json_agg(x ORDER BY ord), '[]'::json) FROM (
      SELECT row_number() OVER (ORDER BY j.window_start, j.planned_arrival NULLS LAST, j.job_number) AS ord, j.job_number AS job, j.status, c.name AS customer, s.city AS area,
             extract(hour FROM j.window_start AT TIME ZONE 'America/New_York')::int AS sh, extract(hour FROM j.window_end AT TIME ZONE 'America/New_York')::int AS eh, j.version
        FROM world.job j JOIN world.technician t ON t.id = j.technician_id JOIN world.customer c ON c.id = j.customer_id JOIN world.street s ON s.id = c.street_id
       WHERE t.name = 'Maria Santos' AND j.date = '${DATE}' AND j.status <> 'canceled') x`));
}
const ENDED = ['done', 'no_one_home'];
const h12 = (h: number) => ((h + 11) % 12) + 1;
const mer = (h: number) => (h < 12 ? 'AM' : 'PM');
/** "10 AM-12 PM", "8-10 AM": the window as the pages print it. */
const windowText = (s: number, e: number) => (mer(s) === mer(e) ? `${h12(s)}-${h12(e)} ${mer(e)}` : `${h12(s)} ${mer(s)}-${h12(e)} ${mer(e)}`);
/** The drive minutes of the baked track from the last finished stop (else the depot) to a job, or null where the database holds no track for the pair. */
function trackMinutes(toJob: number): number | null {
  const prev = psql(`SELECT j.job_number FROM world.job j JOIN world.technician t ON t.id = j.technician_id
      WHERE t.name = 'Maria Santos' AND j.date = '${DATE}' AND j.status IN ('done', 'no_one_home') AND j.job_number <> ${toJob}
      ORDER BY j.ended_at DESC NULLS LAST, j.job_number DESC LIMIT 1`);
  const secs = psql(`SELECT seconds[array_upper(seconds, 1)] FROM world.van_track WHERE branch_id = 'columbus' AND from_ref = '${prev || 'depot'}' AND to_ref = '${toJob}' LIMIT 1`);
  return secs === '' ? null : Math.ceil(Number(secs) / 60);
}

/** The network as the phone sees it: off makes every API call fail as a dropped connection. */
interface Net { off: boolean; calls: string[] }

/** The page's writes carry the default origin (Playwright resends them; a browser will not let a route set Origin), the session cookie and the network switch. */
async function wire(context: BrowserContext, net: Net, who: Who = 'maria', lang: 'en' | 'es' = 'en'): Promise<void> {
  await context.addCookies([{ name: 'bw_session', value: people[who]!, url: origin, httpOnly: true }, { name: 'bw_lang', value: lang, url: origin }]);
  await context.route(`${origin}/api/v1/**`, async (r) => {
    const req = r.request();
    net.calls.push(`${req.method()} ${new URL(req.url()).pathname}`);
    if (net.off) return r.abort('internetdisconnected');
    try {
      const response = await r.fetch(req.method() === 'GET' ? {} : { headers: { ...(await req.allHeaders()), origin: APP_ORIGIN } });
      await r.fulfill({ response });
    } catch {
      // the page or its context closed while the call was in flight: nothing to hand back
    }
  });
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const profile = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'bw-mapme-profile-'));
  dirs.push(d);
  return d;
};
const phone = async (net: Net, who: Who = 'maria', serviceWorkers: 'allow' | 'block' = 'block', lang: 'en' | 'es' = 'en'): Promise<GuardedContext> => {
  const g = await guardedContext(browserOf!, [origin], { ...PHONE, serviceWorkers });
  await wire(g.context, net, who, lang);
  return g;
};
const persistent = async (type: BrowserType, dir: string, net: Net): Promise<GuardedContext> => {
  const g = await guardedPersistentContext(type, dir, [origin], { ...PHONE, serviceWorkers: 'block' });
  await wire(g.context, net);
  return g;
};
let browserOf: import('playwright').Browser | undefined;

/** Open a tech screen and wait for its root and body. */
async function openScreen(context: BrowserContext, p: string, screen: string, wait: string): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${origin}${p}`, { waitUntil: 'load' });
  await page.waitForSelector(`.r1-screen[data-screen="${screen}"] ${wait}`, { timeout: 60_000 });
  return page;
}
const text = async (page: Page, sel: string) => ((await page.locator(sel).first().innerText()) ?? '').trim();
const mapReady = (page: Page, sel: string) => page.waitForSelector(`${sel} .r1-map[data-map-state="ready"]`, { timeout: 60_000 });

interface Hook { enter(i: unknown): Promise<{ key: string }>; sync(): Promise<unknown>; state(): { ready: boolean; waiting: { key: string }[]; online: boolean } }
const enterNote = (page: Page, jobNumber: number, baseVersion: number, noteText: string) => page.evaluate(async (x) => {
  const h = (globalThis as unknown as { __bwTechOutbox: Hook }).__bwTechOutbox;
  return (await h.enter({ jobNumber: x.jobNumber, baseVersion: x.baseVersion, body: { kind: 'note', payload: { text: x.noteText } } })).key;
}, { jobNumber, baseVersion, noteText });
const syncNow = (page: Page) => page.evaluate(async () => {
  await (globalThis as unknown as { __bwTechOutbox: Hook }).__bwTechOutbox.sync();
});
const hookReady = (page: Page) => page.waitForFunction(() => Boolean((globalThis as unknown as { __bwTechOutbox?: Hook }).__bwTechOutbox?.state().ready), undefined, { timeout: 30_000 });

let signedInStart = '';
let mariaTechId = '';

beforeAll(async () => {
  // Sign-in is the day's first action: Maria signs in for real (API-03, by employee number) before the clock moves, so her day starts at 7:00 AM.
  mariaTechId = psql(`SELECT id FROM world.technician WHERE name = 'Maria Santos'`);
  const number = psql(`SELECT u.employee_number FROM world."user" u JOIN world.technician t ON t.user_id = u.id WHERE t.name = 'Maria Santos'`);
  psql(`UPDATE world."user" u SET password_hash = '${await hashPassword('aaaaaaaaaaaa')}' FROM world.technician t WHERE t.user_id = u.id AND t.name = 'Maria Santos'`);
  const r = await fetch(`${origin}/api/v1/sessions`, { method: 'POST', headers: { origin: APP_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ login: number, password: 'aaaaaaaaaaaa', client: 'web' }) });
  expect(r.status, await r.text()).toBe(200);
  signedInStart = psql(`SELECT to_char(started_at AT TIME ZONE 'America/New_York', 'FMHH12:MI AM') FROM world.technician_day d JOIN world.technician t ON t.id = d.technician_id WHERE t.name = 'Maria Santos' AND d.date = '${DATE}'`);
  await jumpTo(TEN_TWENTY_SIX);
  await pauseClock();
}, 600_000);

describe.each(engines)('P5-TWA-MAP-ME on %s', (engine, type) => {
  beforeAll(async () => {
    browserOf = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browserOf?.close();
  });

  // why: FR-TECH-15, F-1550 a technician's first sign-in of the day starts it by the demo clock, and the later ones leave it (the seed's past days are not counted)
  it('starts the day at the first sign-in, in the demo clock\'s time', async () => {
    expect(signedInStart).toMatch(/^7:0\d AM$/);
    const before = psql(`SELECT count(*) FROM world.technician_day d JOIN world.technician t ON t.id = d.technician_id WHERE t.name = 'Maria Santos' AND d.date = '${DATE}'`);
    expect(before).toBe('1');
  });

  // why: FR-TECH-11 the Map tab numbers Maria's stops in the order of her day, marks the finished jobs Done and Harold Jenkins's job Next, and shows his window, customer, address and drive time
  it('numbers the stops, marks done and next, and shows the next stop with its drive time', async () => {
    const day = mariaDay();
    const nextAt = day.findIndex((s) => !ENDED.includes(s.status));
    expect(nextAt, 'Maria has a stop left at 10:26 AM').toBeGreaterThan(0);
    const next = day[nextAt]!;
    expect(next.customer).toBe('Harold Jenkins');
    const g = await phone({ off: false, calls: [] });
    try {
      const page = await openScreen(g.context, '/tech/map', 'SCR-TEC-15', '.stopcard');
      const rows = await page.$$eval('.bw-tech .below .stop', (els) => els.map((e) => ({
        num: e.querySelector('.num')?.textContent ?? '', name: e.querySelector('.tx b')?.textContent ?? '',
        window: e.querySelector('.w')?.firstChild?.textContent ?? '', state: e.querySelector('.w small')?.textContent ?? '',
      })));
      expect(rows.map((r) => [r.num, r.name])).toEqual(day.map((s, i) => [String(i + 1), s.customer]));
      expect(rows.map((r) => r.state)).toEqual(day.map((s, i) => (ENDED.includes(s.status) ? 'Done' : i === nextAt ? 'Next' : 'Later')));
      expect(rows.map((r) => r.window)).toEqual(day.map((s) => windowText(s.sh, s.eh)));
      expect(await text(page, '.bw-tech .apphead .d')).toBe(`Today's route - ${day.length} stops - ${day.filter((s) => ENDED.includes(s.status)).length} done`);
      // the Next stop card
      expect(await text(page, '.stopcard .lab .num')).toBe(String(nextAt + 1));
      expect(await text(page, '.stopcard .win')).toBe(windowText(next.sh, next.eh));
      expect(await text(page, '.stopcard h2')).toBe('Harold Jenkins');
      expect(await text(page, '.stopcard .addr')).toMatch(new RegExp(`, ${next.area}$`));
      const minutes = trackMinutes(next.job);
      const dist = await text(page, '.stopcard .dist');
      const button = await text(page, '.stopcard .dir');
      if (minutes !== null) {
        expect(button.replace(/\s+/g, ' ')).toBe(`Directions ${minutes} min`);
        expect(dist).toMatch(new RegExp(`^${minutes} min, \\d+\\.\\d mi - `));
      } else {
        expect(dist).toMatch(/^\d+ min - /);
      }
      expect(button).toMatch(/Directions\s*\d+ min/);
    } finally {
      await g.context.close();
    }
  });

  // why: FR-MAP-1 the Map tab's technician map renders from the app's own map file with the outside-origin guard on and 0 outside requests (F-363)
  it('draws the technician map with 0 requests outside the app\'s own origin', async () => {
    const day = mariaDay();
    const g = await phone({ off: false, calls: [] });
    try {
      const page = await openScreen(g.context, '/tech/map', 'SCR-TEC-15', '.mapw');
      await mapReady(page, '.mapw');
      const attrs = await page.$eval('.mapw .r1-map', (e) => ({ file: e.getAttribute('data-map-file'), markers: Number(e.getAttribute('data-map-markers')), features: Number(e.getAttribute('data-map-features')), routes: e.getAttribute('data-map-routes') }));
      expect(attrs.file).toBe('columbus.pmtiles');
      expect(attrs.markers).toBe(day.length);
      await page.waitForFunction(() => Number(document.querySelector('.mapw .r1-map')?.getAttribute('data-map-features')) > 0, undefined, { timeout: 60_000 });
      expect(attrs.routes?.split(' ').length, 'a leg into the next stop and each stop after it').toBe(day.filter((s) => !ENDED.includes(s.status)).length);
      // the legend, the buttons and the zoom of the frame
      expect(await page.locator('.mapw .legend span').allInnerTexts()).toEqual(['Done', 'Next', 'Later']);
      await page.click('.mapw [data-ctl="CTL-TEC-15-05"]');
      await page.click('.mapw [data-ctl="CTL-TEC-15-06"]');
      expect(await page.evaluate(() => document.activeElement?.className)).toContain('stop');
      expect(g.outside).toEqual([]);
      g.assertNoOutsideRequests();
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TECH-5 one tap on Directions opens the route to the next job on the app's own map, with no request outside the origin
  it('opens Directions from the Next stop card with the baked route and the minutes the button shows', async () => {
    const day = mariaDay();
    const next = day.find((s) => !ENDED.includes(s.status))!;
    const g = await phone({ off: false, calls: [] });
    try {
      const page = await openScreen(g.context, '/tech/map', 'SCR-TEC-15', '.stopcard');
      const shown = Number(/(\d+) min/.exec(await text(page, '.stopcard .dir'))![1]);
      await page.click('.stopcard [data-ctl="CTL-TEC-15-04"]');
      await page.waitForURL(`**/tech/jobs/${next.job}/directions`);
      await page.waitForSelector('.r1-screen[data-screen="SCR-TEC-08"] .dest');
      await mapReady(page, '.tmap');
      expect(await text(page, '.dest h2')).toBe('Harold Jenkins');
      expect(await text(page, '.dest .addr')).toContain(windowText(next.sh, next.eh));
      const route = await api('maria', 'GET', `/tech/route?toJob=${next.job}`);
      expect(route.status).toBe(200);
      const baked = trackMinutes(next.job);
      expect(baked, 'the seed bakes a track into this stop (24825 to 24830)').not.toBeNull();
      expect(route.body.data.leg.minutes).toBe(baked);
      expect(route.body.data.leg.minutes).toBe(shown);
      if (route.body.data.leg.track) {
        expect(await text(page, '.dest .dt')).toBe(`About ${shown} minutes`);
        expect(await page.$eval('.tmap .r1-map', (e) => e.getAttribute('data-map-routes'))).toBe('baked');
      } else {
        expect(await page.locator('.dest .dt').count()).toBe(0);
        expect(await page.$eval('.tmap .r1-map', (e) => e.getAttribute('data-map-routes'))).toBe('approximate');
      }
      // Back opens Today (OI-56, CTL-TEC-04-01's behavior)
      await page.click('.dh .nav [role="link"]');
      await page.waitForSelector('.r1-screen[data-screen="SCR-TEC-02"]');
      // another technician's job is not found, whatever it is
      const other = Number(psql(`SELECT j.job_number FROM world.job j JOIN world.technician t ON t.id = j.technician_id WHERE t.name <> 'Maria Santos' AND j.date = '${DATE}' LIMIT 1`));
      expect((await api('maria', 'GET', `/tech/route?toJob=${other}`)).status).toBe(404);
    } finally {
      await g.context.close();
    }
  });

  // why: F-1369 FR-TECH-13 Directions on a job screen (the button and More's item) opens the route from the van to THIS job, its last step Arrive at that job's address, with the minutes the button shows (owner answer fa9c9833, "Drive to this job")
  it('opens Directions from a job screen with the route from the van to that job, never to the job after it', async () => {
    const day = mariaDay();
    const at = day.findIndex((s) => s.customer === 'Harold Jenkins');
    expect(at).toBeGreaterThanOrEqual(0);
    const jobs = [day[at]!, day[at + 1]!];
    expect(jobs[1]!.customer).toBe('Linda Miller');
    const g = await phone({ off: false, calls: [] });
    try {
      for (const j of jobs) {
        const route = await api('maria', 'GET', `/tech/route?toJob=${j.job}`);
        expect(route.status).toBe(200);
        const baked = route.body.data.leg.track ? route.body.data.leg.minutes : null;
        // F-1396: Harold's leg is baked by the seed (the stop before his is ended), so his minutes checks always run; a missing track fails here, loudly.
        // Linda's leg is the one the clause allows to be approximate (no baked leg ends at her job), so her minutes check stays conditional.
        if (j === jobs[0]) expect(baked, `the route from the van to Harold's job ${j.job} has no baked track: ${JSON.stringify(route.body.data.leg).slice(0, 300)}`).not.toBeNull();
        const street = psql(`SELECT c.house_number || ' ' || st.name FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.street st ON st.id = c.street_id WHERE j.job_number = ${j.job}`);
        expect(street, `no address for job ${j.job}`).not.toBe('');
        for (const via of ['button', 'more'] as const) {
          const page = await openScreen(g.context, `/tech/jobs/${j.job}`, 'SCR-TEC-04', '[data-ctl="CTL-TEC-04-04"]');
          if (baked !== null) await page.waitForFunction((n: number) => document.querySelector('[data-ctl="CTL-TEC-04-04"]')?.getAttribute('data-minutes') === String(n), baked, { timeout: 30_000 });
          const shown = await page.getAttribute('[data-ctl="CTL-TEC-04-04"]', 'data-minutes');
          expect(shown === '' ? null : Number(shown)).toBe(baked);
          if (via === 'button') {
            await page.click('[data-ctl="CTL-TEC-04-04"]');
          } else {
            await page.click('[data-ctl="CTL-TEC-04-18"][role="button"]');
            await page.click('[role="menu"] [role="menuitem"]:has-text("Directions")');
          }
          // this job's own address, with no job before it: the route's destination is this job
          await page.waitForURL(`**/tech/jobs/${j.job}/directions`);
          await page.waitForSelector('.r1-screen[data-screen="SCR-TEC-08"] .dest');
          await mapReady(page, '.tmap');
          expect(await text(page, '.dest h2')).toBe(j.customer);
          expect(await text(page, '.dest .addr')).toContain(j.area);
          const last = (await page.locator('.steps[data-ctl="CTL-TEC-08-06"] li').last().innerText()).trim();
          expect(last).toContain('Arrive at');
          expect(last, `the last step names this job's address ${street}`).toContain(street);
          if (baked !== null) expect(await text(page, '.dest .dt')).toBe(`About ${baked} minutes`);
        }
      }
      g.assertNoOutsideRequests();
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TECH-10 each of the tabs Today, Map, Parts and Me opens its screen on the web app
  it('opens each tab\'s screen from the tab bar', async () => {
    const g = await phone({ off: false, calls: [] });
    try {
      const page = await openScreen(g.context, '/tech', 'SCR-TEC-02', '.tabbar');
      for (const [ctl, screen] of [['CTL-CMP-09-03', 'SCR-TEC-15'], ['CTL-CMP-09-04', 'SCR-TEC-16'], ['CTL-CMP-09-02', 'SCR-TEC-10'], ['CTL-CMP-09-01', 'SCR-TEC-02']] as const) {
        await page.click(`.tabbar [data-ctl="${ctl}"]`);
        await page.waitForSelector(`.r1-screen[data-screen="${screen}"] .tabbar .on`);
        expect(await page.locator('.tabbar .on').getAttribute('data-ctl')).toBe(ctl);
      }
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TECH-10, F-1232 a tab opens within about 5 s when the origin takes a tab's data request and never answers it (a dropped-packet origin), not at the browser's own timeout
  it('opens the Map tab within 5 s when the origin never answers the tab\'s data request', async () => {
    // The worker is blocked so the browser's route sees the data request on both engines (the worker does not answer it either way, sw.js).
    const g = await phone({ off: false, calls: [] }, 'maria', 'block');
    try {
      const page = await openScreen(g.context, '/tech', 'SCR-TEC-02', '.tabbar');
      // The origin takes the Map screen's data request (the router's RSC fetch) and never answers it. The page itself is not held.
      let held = 0;
      const seen: string[] = [];
      await page.route((u) => u.pathname === '/tech/map', async (r) => {
        const rsc = r.request().headers()['rsc'] !== undefined || new URL(r.request().url()).searchParams.has('_rsc');
        seen.push(`${r.request().resourceType()} ${rsc ? 'rsc' : 'page'}`);
        if (!rsc) return r.continue();
        held += 1;
      });
      await page.click('.tabbar [data-ctl="CTL-CMP-09-03"]');
      const opened = await page.waitForSelector('.r1-screen[data-screen="SCR-TEC-15"] .tabbar .on', { timeout: 8000 }).then(() => true, () => false);
      expect(held, `the held data request was never made, so the check proved nothing (saw: ${seen.join(', ')})`).toBeGreaterThan(0);
      expect(opened, 'the Map tab did not open within 8 s of the tap with its data request held').toBe(true);
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TECH-1, UI-SPECIFICATION 4.5 (F-1021) in the real browser: the kept /tech page holds no customer name (the server-state page is never kept), and an open with no signal shows the saved day with Last updated
  it('keeps no customer in the /tech page the worker holds, and opens the saved day offline with Last updated', async () => {
    const net: Net = { off: false, calls: [] };
    const names = mariaDay().map((s) => s.customer);
    const g = await phone(net, 'maria', 'allow');
    try {
      const page = await openScreen(g.context, '/tech', 'SCR-TEC-02', '.list');
      await page.waitForFunction(() => window.localStorage.getItem('bw.tech.day') !== null, undefined, { timeout: 60_000 });
      await page.waitForFunction(async () => Boolean(await (navigator as Json).serviceWorker?.ready), undefined, { timeout: 30_000 });
      // a second load goes through the worker, which keeps the shell variant of /tech and never the page that carries the day
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('.r1-screen[data-screen="SCR-TEC-02"] .list');
      const kept = await until('the worker to keep /tech', () => page.evaluate(async () => {
        const c = (globalThis as unknown as { caches: Caches }).caches;
        const out: string[] = [];
        for (const n of await c.keys()) {
          const cache = await c.open(n);
          for (const r of await cache.keys()) if (new URL(r.url).pathname === '/tech') out.push(await (await (cache as unknown as { match(r: unknown): Promise<{ text(): Promise<string> } | undefined> }).match(r))!.text());
        }
        return out;
      }), (k) => k.length > 0, 80);
      for (const body of kept) for (const name of names) expect(body, `the kept /tech page holds ${name}`).not.toContain(name);
      // no signal: the open serves the kept shell and Today paints the day saved on the phone, marked Last updated
      net.off = true;
      await g.context.setOffline(true);
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('.r1-screen[data-screen="SCR-TEC-02"] .list');
      // why: F-1435 the kept shell already draws a .sec reading Today before the phone copy is read; wait for the Last updated row, then read once
      await page.locator('.list .sec', { hasText: /last updated/i }).waitFor({ timeout: 30_000 });
      expect((await page.locator('.list').innerText()).toLowerCase()).toContain('last updated');
      expect(await page.locator('.list').innerText()).toContain(names[0]!.split(' ').pop()!);
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TECH-10 offline, the Parts tab finds a part by its name or code and shows its code and price, and offers no edit or stock control
  it('searches the parts list kept on the phone with the network off', async () => {
    const net: Net = { off: false, calls: [] };
    const part = JSON.parse(psql(`SELECT row_to_json(p) FROM (SELECT code, name, price_cents FROM world.part ORDER BY name OFFSET 300 LIMIT 1) p`)) as { code: string; name: string; price_cents: number };
    const total = Number(psql('SELECT count(*) FROM world.part'));
    const g = await phone(net, 'maria', 'allow');
    try {
      const page = await openScreen(g.context, '/tech/parts', 'SCR-TEC-16', '.list16');
      // the copy is read with signal and kept on the phone
      await page.waitForFunction(() => window.localStorage.getItem('bw.tech.parts') !== null, undefined, { timeout: 60_000 });
      await page.waitForFunction(async () => Boolean(await (navigator as Json).serviceWorker?.ready), undefined, { timeout: 30_000 });
      await page.reload({ waitUntil: 'load' });
      // F-1433, F-1434: the server draws the skeleton (it cannot read the phone's copy: data.ts useTechData's unread server snapshot), and the page draws the
      // search field (CTL-TEC-16-01, enabled when a copy is on the phone) once it has read the kept copy, after load: wait for that field
      await page.waitForSelector('.r1-screen[data-screen="SCR-TEC-16"] .list16 input');
      expect(await text(page, '.list16 .emp')).toBe(`Search ${total.toLocaleString('en-US')} parts by name or code.`);
      net.off = true;
      await g.context.setOffline(true);
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('.r1-screen[data-screen="SCR-TEC-16"] .list16 input');
      // by code
      await page.fill('.list16 input', part.code);
      const row = page.locator('.list16 .res .pr', { hasText: part.code });
      await row.first().waitFor();
      expect(await row.first().innerText()).toContain(part.name);
      expect(await row.first().locator('.pz').innerText()).toBe(`$${(part.price_cents / 100).toFixed(2)}`);
      // by name
      await page.fill('.list16 input', part.name.split(' ')[0]!.toLowerCase());
      await page.waitForSelector('.list16 .cnt');
      const expected = Number(psql(`SELECT count(*) FROM world.part WHERE lower(name || ' ' || code) LIKE '%${part.name.split(' ')[0]!.toLowerCase().replace(/'/g, "''")}%'`));
      expect(await text(page, '.list16 .cnt')).toBe(`${Math.min(expected, expected).toLocaleString('en-US')} of ${total.toLocaleString('en-US')} parts match`);
      // nothing to edit: 1 field (the search), no buttons or selects among the results
      expect(await page.locator('.list16 input').count()).toBe(1);
      expect(await page.locator('.list16 .res button, .list16 .res a, .list16 .res input, .list16 .res select').count()).toBe(0);
      expect(await page.locator('.list16 select, .list16 textarea, .list16 [contenteditable]').count()).toBe(0);
      // a word nothing matches, and Clear
      await page.fill('.list16 input', 'zzzzqx');
      expect(await text(page, '.list16 .emp')).toBe('No part matches zzzzqx.');
      await page.click('.list16 .clr');
      expect(await page.inputValue('.list16 input')).toBe('');
      // offline, the No signal card shows and the search still works
      await page.waitForSelector('[data-ctl="CTL-CMP-10-01"]');
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TECH-15 Maria's Me screen shows her van with no stock-checked line, the start of her day and the hours since it by the demo clock, her jobs done, Call dispatch with the Columbus office number and the app version
  it('shows the van, the day\'s start, the hours on the clock, jobs done, Call dispatch and the version', async () => {
    const day = mariaDay();
    const van = JSON.parse(psql(`SELECT row_to_json(v) FROM (SELECT v.number, v.vehicle FROM world.van v JOIN world.technician t ON t.van_id = v.id WHERE t.name = 'Maria Santos') v`)) as { number: string; vehicle: string };
    const office = psql(`SELECT office_phone FROM world.branch WHERE id = 'columbus'`);
    const g = await phone({ off: false, calls: [] });
    try {
      const page = await openScreen(g.context, '/tech/me', 'SCR-TEC-10', '.hours');
      await page.waitForFunction(() => document.querySelectorAll('.bw-tech .hours div').length === 3 && !document.querySelector('.bw-tech .hours b')?.textContent?.includes('Not started')
        && document.querySelectorAll('.bw-tech .hours b')[2]?.textContent !== '0 of 0', undefined, { timeout: 30_000 });
      expect(await text(page, '.prof h1')).toBe('Maria Santos');
      expect(await text(page, '.van b')).toBe(`Van ${van.number}`);
      expect(await text(page, '.van small')).toBe(van.vehicle);
      expect((await page.locator('.bw-tech').innerText()).toLowerCase()).not.toContain('stock');
      const hours = await page.$$eval('.bw-tech .hours div', (els) => els.map((e) => [e.querySelector('b')?.textContent ?? '', e.querySelector('small')?.textContent ?? '']));
      expect(hours[0]).toEqual([signedInStart, 'Started']);
      expect(hours[1]![1]).toBe('On the clock');
      // 7:0x AM to 10:26 AM on the paused clock
      const m = /^(?:(\d+) hr )?(\d+) min$/.exec(hours[1]![0]!)!;
      const shown = Number(m[1] ?? 0) * 60 + Number(m[2]);
      const startMin = Number(/^(\d+):(\d+)/.exec(signedInStart)![1]) * 60 + Number(/^(\d+):(\d+)/.exec(signedInStart)![2]);
      expect(Math.abs(shown - (10 * 60 + 26 - (startMin + 0)))).toBeLessThanOrEqual(2);
      expect(hours[2]).toEqual([`${day.filter((s) => ENDED.includes(s.status)).length} of ${day.length}`, 'Jobs done']);
      expect(await text(page, '.rows .call')).toBe(office);
      expect(await text(page, '[data-ctl="CTL-TEC-10-11"] .v')).toBe('Right On Time 1.0.1');
    } finally {
      await g.context.close();
    }
  });

  // why: F-1775 (F-1740, FR-TECH-15) Me's first paint, before the phone's copy is read, names Maria from API-07 read on the server with her session; the page carries X-Bw-Server-State (F-980) and its shell variant holds no name and no mark
  it('names the person in Me\'s server draw, and keeps the name out of the shell variant', async () => {
    const g = await phone({ off: false, calls: [] });
    try {
      const full = await g.context.request.get(`${origin}/tech/me`);
      expect(full.status()).toBe(200);
      expect(full.headers()['x-bw-server-state']).toBe('1');
      const html = await full.text();
      expect(html).toContain('<span class="av">MS</span>');
      expect(html).toContain('<h1 translate="no">Maria Santos</h1>');
      const shell = await g.context.request.get(`${origin}/tech/me?bw-shell=1`);
      expect(shell.status()).toBe(200);
      expect(shell.headers()['x-bw-server-state']).toBeUndefined();
      expect(await shell.text(), 'the shell holds no name').not.toContain('Maria Santos');
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TECH-15 setting Text size to Large enlarges the app's text and it stays set after the app closes
  it('keeps Text size Large after the app is closed and opened again', async () => {
    const dir = profile();
    const net: Net = { off: false, calls: [] };
    // the van's icon box is 42 css px at Standard; the size follows by zoom, so its drawn width grows with the text
    const width = (page: Page) => page.$eval('.bw-tech .van .ico', (e) => e.getBoundingClientRect().width);
    let g = await persistent(type, dir, net);
    let standard = 0;
    try {
      const page = await openScreen(g.context, '/tech/me', 'SCR-TEC-10', '.hours');
      standard = await width(page);
      await page.click('.sel');
      await page.click('.r1-menu [data-size="large"]');
      await page.waitForFunction(() => document.querySelector('.bw-tech')?.getAttribute('data-text-size') === 'large');
      expect(await width(page)).toBeGreaterThan(standard * 1.05);
      expect(await text(page, '.sel')).toBe('Large');
    } finally {
      await g.context.close();
    }
    g = await persistent(type, dir, net);
    try {
      const page = await openScreen(g.context, '/tech/me', 'SCR-TEC-10', '.hours');
      await page.waitForFunction(() => document.querySelector('.bw-tech')?.getAttribute('data-text-size') === 'large');
      expect(await text(page, '.sel')).toBe('Large');
      expect(await width(page)).toBeGreaterThan(standard * 1.05);
      // put it back so the profile's next open is Standard
      await page.click('.sel');
      await page.click('.r1-menu [data-size="standard"]');
      await page.waitForFunction(() => document.querySelector('.bw-tech')?.getAttribute('data-text-size') === 'standard');
    } finally {
      await g.context.close();
    }
  });

  // why: FR-TECH-15 a job moved by the office raises 1 day-changed notice while Notifications is on and none while it is off, and no push service is contacted
  it('raises 1 day-changed notice with Notifications on and none with it off', async () => {
    const day = mariaDay();
    const open = day.filter((s) => s.status === 'scheduled').slice(-2);
    expect(open.length, 'Maria has a scheduled stop to move').toBeGreaterThan(0);
    const [a, b] = [open.at(-1)!, open.at(-2) ?? open.at(-1)!];
    const move = async (job: number, to: string | null) => {
      const v = Number(psql(`SELECT version FROM world.job WHERE job_number = ${job}`));
      const r = await api('keisha', 'POST', `/jobs/${job}/assignment`, { technicianId: to, baseVersion: v });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    const net: Net = { off: false, calls: [] };
    const g = await phone(net, 'maria');
    // Distinct notices seen (a notice still showing is drawn again when the page changes screen, so nodes are not counted).
    const notices = (page: Page) => page.evaluate(() => (globalThis as unknown as { __notices: string[] }).__notices.length);
    try {
      await g.context.addInitScript(() => {
        const seen: string[] = [];
        (globalThis as unknown as { __notices: string[] }).__notices = seen;
        new MutationObserver(() => {
          for (const el of Array.from(document.querySelectorAll('[data-ctl="CTL-TEC-02-14"]')) as Json[]) {
            const t = el.textContent ?? '';
            if (t !== '' && !seen.includes(t)) seen.push(t);
          }
        }).observe(document, { childList: true, subtree: true, characterData: true });
      });
      const page = await openScreen(g.context, '/tech/map', 'SCR-TEC-15', '.stopcard');
      page.setDefaultTimeout(45_000);
      // the first read is the day the phone starts from: no notice
      await sleep(1_500);
      expect(await notices(page)).toBe(0);
      // the office moves a job away: 1 notice
      await move(a.job, null);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const notice = page.locator('[data-ctl="CTL-TEC-02-14"]');
      await notice.first().waitFor({ timeout: 40_000 });
      expect(await notice.first().innerText()).toBe(`Your day changed: job ${a.job} is no longer on your day.`);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await sleep(2_000);
      expect(await notices(page)).toBe(1);
      // F-1008 c: a second read of the same day raised no second notice on the screen (distinct texts alone would hide a repeat)
      expect(await notice.count()).toBe(1);
      // switch Notifications off on the Me screen (kept on the phone)
      await page.click('.tabbar [data-ctl="CTL-CMP-09-02"]');
      await page.waitForSelector('.r1-screen[data-screen="SCR-TEC-10"] .r1-switch');
      await page.click('.r1-switch .trk');
      expect(await page.getAttribute('.r1-switch .trk', 'aria-checked')).toBe('false');
      // a second job moves away, and the first comes back: no notice
      await move(b.job === a.job ? a.job : b.job, b.job === a.job ? mariaTechId : null);
      if (b.job !== a.job) await move(a.job, mariaTechId);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await sleep(4_000);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await sleep(2_000);
      expect(await notices(page)).toBe(1);
      // F-1008 c: the off half did read after the moves: the phone's snapshot holds the job that came back
      const snap = JSON.parse(await page.evaluate(() => window.localStorage.getItem('bw.tech.snapshot') ?? 'null')) as { jobs: { jobNumber: number }[] } | null;
      expect(snap?.jobs.map((j) => j.jobNumber), 'the snapshot was re-saved after the off half reads').toContain(a.job);
      // no push service: the page has no push subscription and the guard saw nothing leave the origin
      const subscribed = await page.evaluate(async () => (await (await (navigator as Json).serviceWorker?.getRegistration('/tech'))?.pushManager?.getSubscription()) ?? null);
      expect(subscribed).toBeNull();
      expect(g.outside).toEqual([]);
    } finally {
      await g.context.close();
      // put Maria's day back whatever happened
      for (const s of new Set([a.job, b.job])) {
        const row = psql(`SELECT technician_id FROM world.job WHERE job_number = ${s}`);
        if (row !== mariaTechId) await move(s, mariaTechId);
      }
    }
    expect(mariaDay().map((s) => s.job)).toEqual(day.map((s) => s.job));
  });

  // why: F-937 Sign out is refused while an item waits, and once the store is empty signs out, clears the phone's copies and has the service worker drop the kept /tech pages (F-1008 b: the item is cleared from the store here, not sent; sending is G-CI1's case)
  it('refuses Sign out while an item waits, then (the store emptied) signs out and the service worker forgets the kept pages', async () => {
    const who: Who = engine === 'chromium' ? 'mariaout1' : 'mariaout2';
    const job = mariaDay().find((s) => s.status === 'scheduled')!;
    const net: Net = { off: false, calls: [] };
    const g = await phone(net, who, 'allow');
    const cached = (page: Page) => page.evaluate(async () => {
      const c = (globalThis as unknown as { caches: Caches }).caches;
      return (await Promise.all((await c.keys()).map(async (n) => (await (await c.open(n)).keys()).map((r) => new URL(r.url).pathname)))).flat();
    });
    try {
      const page = await openScreen(g.context, '/tech/me', 'SCR-TEC-10', '.hours');
      await hookReady(page);
      await syncNow(page);
      await page.waitForFunction(async () => Boolean(await (navigator as Json).serviceWorker?.ready), undefined, { timeout: 30_000 });
      // visit Parts and Map with signal and again through the worker, so it keeps their pages
      for (const [p, screen] of [['/tech/parts', 'SCR-TEC-16'], ['/tech/map', 'SCR-TEC-15'], ['/tech/me', 'SCR-TEC-10']] as const) {
        await page.goto(`${origin}${p}`, { waitUntil: 'load' });
        await page.waitForSelector(`.r1-screen[data-screen="${screen}"] .tabbar`);
      }
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('.r1-screen[data-screen="SCR-TEC-10"] .hours');
      await until('the worker to keep the pages', () => cached(page), (k) => k.includes('/tech/me') && k.includes('/tech/parts') && k.includes('/tech/map'), 40);
      // an item waits (entered with no signal): Sign out is refused with the message, the session stays, and the item stays
      await hookReady(page);
      await syncNow(page);
      net.off = true;
      const key = await enterNote(page, job.job, job.version, `Left waiting before sign-out (${engine})`);
      await page.click('.out');
      await page.waitForSelector('.refused');
      expect(await text(page, '.refused')).toBe('1 item is still waiting to send. Connect and tap Send now. You can sign out when they are sent.');
      expect(new URL(page.url()).pathname).toBe('/tech/me');
      net.off = false;
      expect((await api(who, 'GET', '/tech/day')).status).toBe(200);
      expect(psql(`SELECT count(*) FROM world.tech_item WHERE key = '${key}'`)).toBe('0');
      // The item is cleared from the phone's store (a page served with the worker allowed is not seen by the suite's network route, which is what
      // gives its writes the default origin, so the suite cannot send it from here; sending is G-CI1's case), then Sign out goes through.
      await page.evaluate(() => new Promise<void>((resolve, reject) => {
        const open = (globalThis as unknown as { indexedDB: { open(n: string): { result: { transaction(s: string, m: string): { objectStore(s: string): { clear(): void }; oncomplete: () => void }; close(): void }; onsuccess: () => void; onerror: () => void } } }).indexedDB.open('bw-tech-items');
        open.onerror = () => reject(new Error('the store did not open'));
        open.onsuccess = () => {
          const tx = open.result.transaction('items', 'readwrite');
          tx.objectStore('items').clear();
          tx.oncomplete = () => { open.result.close(); resolve(); };
        };
      }));
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('.r1-screen[data-screen="SCR-TEC-10"] .hours');
      await hookReady(page);
      await page.waitForFunction(() => (globalThis as unknown as { __bwTechOutbox: Hook }).__bwTechOutbox.state().waiting.length === 0);
      await page.click('.out');
      await page.waitForURL('**/tech/sign-in', { timeout: 30_000 });
      // WebKit serves a page with the worker allowed past the suite's network route, so its DELETE carries the proxy's origin, not the default one
      // the server checks (SD-8), and the session stays; the session's end is proved on Chromium, the phone's side (pages, copies) on both.
      if (engine === 'chromium') expect((await api(who, 'GET', '/tech/day')).status).toBe(401);
      const left = await until('the worker to drop the kept pages', () => cached(page), (k) => !k.includes('/tech/me') && !k.includes('/tech/parts') && !k.includes('/tech/map'), 40);
      expect(left).not.toContain('/tech');
      expect(await page.evaluate(() => Object.keys(window.localStorage).filter((k) => k.startsWith('bw.tech.') && k !== 'bw.tech.notices' && k !== 'bw.tech.textSize'))).toEqual([]);
    } finally {
      await g.context.close();
    }
  });

  // why: F-1004 CTL-TEC-10-04 a Sign out with no signal clears the phone anyway: the next open shows no one, and with signal it ends the session and opens sign-in
  it('signs out with no signal, shows no one at the next open, and ends the session once there is signal', async () => {
    const who: Who = engine === 'chromium' ? 'mariaout3' : 'mariaout4';
    const net: Net = { off: false, calls: [] };
    // the worker is blocked, so the suite's route sees every call on both engines (the DELETE carries the default origin)
    const g = await phone(net, who);
    try {
      const page = await openScreen(g.context, '/tech/me', 'SCR-TEC-10', '.hours');
      await hookReady(page);
      await syncNow(page);
      await page.waitForFunction(() => (globalThis as unknown as { __bwTechOutbox: Hook }).__bwTechOutbox.state().waiting.length === 0);
      await page.waitForFunction(() => document.querySelector('.prof h1')?.textContent === 'Maria Santos', undefined, { timeout: 30_000 });
      net.off = true;
      await page.click('.out');
      await page.waitForURL('**/tech/sign-in', { timeout: 30_000 });
      expect(net.calls).toContain('DELETE /api/v1/sessions/current');
      // F-1027 c: the sign-in page is drawn (never blank) and inert under the owed line while the sign-out is owed
      await page.waitForSelector('[data-bw-sign-out-owed]', { state: 'attached', timeout: 30_000 });
      expect(await page.locator('.r1-screen[data-screen="SCR-TEC-01"]').count()).toBe(1);
      expect(await page.locator('div[inert] .r1-screen[data-screen="SCR-TEC-01"]').count()).toBe(1);
      // API-06 never answered: the server session and the httpOnly cookie are still there
      expect((await api(who, 'GET', '/tech/day')).status).toBe(200);
      // the next open, still with no signal: the Me screen does not mount and nothing of the person shows
      await page.goto(`${origin}/tech/me`, { waitUntil: 'load' });
      await page.waitForSelector('[data-bw-sign-out-owed]', { state: 'attached', timeout: 30_000 });
      expect(await page.locator('.r1-screen[data-screen="SCR-TEC-10"]').count()).toBe(0);
      expect(await page.locator('body').innerText()).not.toContain('Maria');
      // signal comes back: the page ends the session on its own and opens sign-in
      net.off = false;
      await page.waitForURL('**/tech/sign-in', { timeout: 30_000 });
      expect((await api(who, 'GET', '/tech/day')).status).toBe(401);
      expect(await page.evaluate(() => Object.keys(window.localStorage).filter((k) => k.startsWith('bw.tech.') && k !== 'bw.tech.notices' && k !== 'bw.tech.textSize'))).toEqual([]);
      // and the next open is no one's: the page gate sends it to sign in
      await page.goto(`${origin}/tech/me`, { waitUntil: 'load' });
      expect(new URL(page.url()).pathname).toBe('/tech/sign-in');
    } finally {
      await g.context.close();
    }
  });

  // why: NFR-09 the install page shows the steps of the visitor's browser, and Continue in the browser opens the app and stops the page showing
  it('shows the steps for Safari on iPhone and stops showing after Continue in the browser', async () => {
    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    const g = await guardedContext(browserOf!, [origin], { ...PHONE, userAgent: IPHONE });
    await wire(g.context, { off: false, calls: [] });
    try {
      const page = await openScreen(g.context, '/tech/install', 'SCR-TEC-11', '.steps11');
      expect(await page.locator('.steps11 li').count()).toBe(3);
      expect(await text(page, '.steps11 li >> nth=0')).toContain('Share');
      expect(await text(page, '.steps11 li >> nth=1')).toContain('Add to Home Screen');
      expect(await text(page, '.body11 h1')).toBe('Put Right On Time on your home screen');
      await page.click('[data-ctl="CTL-TEC-11-03"]');
      await page.waitForURL((u) => u.pathname === '/tech', { timeout: 30_000 });
      await page.goto(`${origin}/tech/install`, { waitUntil: 'load' });
      await page.waitForURL((u) => u.pathname === '/tech', { timeout: 30_000 });
    } finally {
      await g.context.close();
    }
  });

  // why: NFR-09 a browser that is neither Safari on iPhone nor Chrome on Android is told to open the page in one of those
  it('tells another browser to open the page in Safari on iPhone or Chrome on Android', async () => {
    const g = await guardedContext(browserOf!, [origin], { ...PHONE });
    await wire(g.context, { off: false, calls: [] });
    try {
      const page = await openScreen(g.context, '/tech/install', 'SCR-TEC-11', '.infobox2');
      expect(await text(page, '.infobox2')).toBe('Open this page in Safari on iPhone or Chrome on Android to install it.');
    } finally {
      await g.context.close();
    }
  });
});
