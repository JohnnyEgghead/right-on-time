// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DISP-3, FR-DISP-18, FR-DISP-19, FR-DISP-21, FR-DISP-22, FR-MAP-1, SD-15, SD-21, FR-DISP-1, FR-DISP-2, FR-DISP-4, FR-DISP-6, FR-DISP-9, FR-DISP-10, FR-DISP-11, FR-DISP-13, FR-DISP-14, FR-DISP-15, FR-DISP-16, FR-DISP-17, FR-DISP-34, FR-DEMO-1, UC-02 (P4-BOARD Acceptance: Playwright on the Compose stack)
// The day board against the Compose stack at its default settings (real PostgreSQL 18, real handlers, pbs running), set
// up by the setup service (the seeded world, the clock at Tue, Sep 15, 7:00 AM), through its proxy, every page opened
// through the outside-origin guard. The people are ci/board-stack/fixture.sql's sessions. Run by ci/board-stack.sh.
// The suite shares 1 world and 1 clock: each engine picks its own jobs and makes its own blocks, and the clock only moves
// forward: 7:00 AM for the board on both engines, then 9:45 AM and 10:30 AM for the map panel (P4-BOARD-MAP), then 2:00 PM
// for the late and at-risk words and the drop preview of a late job, then 5:45 PM and 6:05 PM for the vans past the shift end.
// F-1745: the checks that need a moving van run first at 9:45 AM, each engine's right after its own jump there, so the second
// engine's start is late only by the first engine's moving-van checks, never by its whole 9:45 AM block.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Browser, BrowserContextOptions, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { planDay, trackedDriveMinutes } from '../../packages/domain/src/planner.ts';
import { decodePolyline, encodePolyline } from '../../packages/maps/src/tracks.ts';
import { chainCensusSql } from '../../packages/setup/src/testing/census.ts';
import { guardedContext, type GuardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';
import { movingVanWithin } from './moving-van.ts';

const base = process.env.BW_BOARD_STACK_URL;
const db = process.env.BW_BOARD_DB_CONTAINER;
const people = { keisha: process.env.BW_BOARD_KEISHA, ana: process.env.BW_BOARD_ANA, dana: process.env.BW_BOARD_DANA, tech: process.env.BW_BOARD_TECH };
if (!base || !db || Object.values(people).some((v) => !v)) throw new Error('BW_BOARD_STACK_URL, _DB_CONTAINER and the session tokens are not set: run ci/board-stack.sh');
const origin = new URL(base).origin;
// APP_ORIGIN's default (SPECIFICATIONS 11.1): the suite's proxy listens on a free port, so writes carry the default origin.
const APP_ORIGIN = 'http://localhost:8080';
// Tall enough that every Columbus row is on screen (a pointer drag works in the viewport).
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 1700 } };
type Who = keyof typeof people;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** SQL in the stack's database as its owner (reads, and the fixture rows a phone or another page would write). */
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
const board = async (who: Who = 'keisha') => (await api(who, 'GET', '/board?branch=columbus&date=today')).body.data as Json;
const allJobs = (b: Json): Json[] => [...b.unassigned, ...b.technicians.flatMap((t: Json) => t.jobs)];
const minutes = (wire: string) => Date.parse(wire.replace(/\[.*\]$/, ''));
/** "10:40 AM" of a wire time, as the board writes it. */
const timeText = (wire: string) => {
  const m = /T(\d\d):(\d\d)/.exec(wire)!;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
};
/** "1:00-1:30 PM" or "11:30 AM-12:00 PM": a block's span as the board writes it. */
const spanOf = (start: string, end: string) => {
  const a = timeText(start).split(' ');
  const b = timeText(end).split(' ');
  return a[1] === b[1] ? `${a[0]}-${b[0]} ${b[1]}` : `${a.join(' ')}-${b.join(' ')}`;
};
const shortName = (name: string) => { const w = name.split(' '); return `${w[0]} ${w[w.length - 1]!.charAt(0)}.`; };

/** Jump the shared clock forward to a demo time (API-12, the manager) unless it is already past it, then wait for the replay. */
async function clockAt(to: string): Promise<void> {
  const now = (await api('dana', 'GET', '/clock')).body.data;
  if (minutes(now.demoNow) < minutes(to)) {
    const r = await api('dana', 'POST', '/clock/jumps', { to });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
  }
  const deadline = performance.now() + 150_000;
  for (;;) {
    const reply = (await api('dana', 'GET', '/clock')).body;
    if (!reply.data.replay?.running && Math.abs(minutes(reply.meta.demoNow) - minutes(reply.data.demoNow)) < 1_000) return;
    if (performance.now() > deadline) throw new Error('the clock replay did not finish in 150 s');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Writes this suite's resend could not deliver, kept so a red names them: 1 of them would read as a slow page (F-810, F-856). */
export const lostWrites: string[] = [];
/** The page's API writes carry the default origin: Playwright resends them itself (a browser will not let a route set Origin). */
async function writeOrigin(p: Page): Promise<void> {
  await p.route(`${origin}/api/v1/**`, async (r) => {
    if (r.request().method() === 'GET') return r.continue();
    try {
      const response = await r.fetch({ headers: { ...(await r.request().allHeaders()), origin: APP_ORIGIN } });
      await r.fulfill({ response });
    } catch (e) {
      // F-856 (the F-810 fix): the page may be gone, or the resend failed. Either way the request gets an answer, so it can never hang with no trace.
      if (!p.isClosed()) lostWrites.push(`${new URL(r.request().url()).pathname}: ${(e as Error).message.slice(0, 160)}`);
      await r.abort('failed').catch(() => undefined);
    }
  });
}

interface Open { page: Page; g: GuardedContext }
async function open(browser: Browser, who: Who, lang: 'en' | 'es' = 'en', path = '/office/board?branch=columbus&date=today', first?: (p: Page) => Promise<unknown>): Promise<Open> {
  const g = await guardedContext(browser, [origin], DESKTOP);
  await g.context.addCookies([{ name: 'bw_session', value: people[who]!, url: origin, httpOnly: true }, { name: 'bw_lang', value: lang, url: origin }]);
  const page = await g.context.newPage();
  await writeOrigin(page);
  await first?.(page);
  await page.goto(origin + path, { waitUntil: 'load' });
  return { page, g };
}
const ready = (p: Page) => p.waitForSelector('[data-screen="SCR-OFC-02"] .tl-row button.job', { timeout: 60_000 });
const close = async (o: Open) => o.g.context.close();

const hourOf = (wire: string) => { const m = /T(\d\d):(\d\d)/.exec(wire)!; return Number(m[1]) + Number(m[2]) / 60; };
const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
/**
 * A half hour on a technician's row that no job's planned time touches, with another free half hour 1 hour later (the
 * block's move), from 1:00 PM on in half hours, else before the first window (a block may sit outside working hours).
 * The seeded day is full, so the block goes where the day leaves room: a job may not overlap a block (FR-DISP-34).
 */
const SLOT_STARTS = [13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5];
/** Every drawn job counts, ended ones too: the block must be pressable, not under another block. */
function isFreeAt(t: Json, s: number): boolean {
  const busy = t.jobs.map((j: Json) => {
    const from = hourOf(j.status === 'scheduled' ? j.plannedArrival ?? j.window.start : j.eta ?? j.window.start);
    return [from, from + j.expectedMinutes / 60] as const;
  });
  const blocks = t.blocks.map((b: Json) => [hourOf(b.start), hourOf(b.end)] as const);
  return [...busy, ...blocks].every(([a, b]) => s + 0.5 <= a || s >= b);
}
function freeSlot(t: Json, after = 0): number | null {
  for (const s of SLOT_STARTS) {
    if (s >= after && isFreeAt(t, s) && isFreeAt(t, s + 1)) return s;
  }
  return null;
}
/** Kevin Doyle's row (the acceptance's) when it has room for the block and its move, else the first row that has. */
function blockRow(b: Json): { tech: Json; h: number } {
  const rows = [b.technicians.find((t: Json) => t.name === 'Kevin Doyle'), ...b.technicians.filter((t: Json) => t.name !== 'Kevin Doyle')];
  for (const tech of rows) {
    const h = freeSlot(tech);
    if (h !== null) return { tech, h };
  }
  throw new Error('no row has a free half hour and another an hour later');
}

/** Press on an element's center and move over a point in steps (a pointer drag), without releasing. */
async function dragOver(p: Page, from: string, to: { x: number; y: number }): Promise<void> {
  const b = (await p.locator(from).first().boundingBox())!;
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await p.mouse.down();
  await p.mouse.move(b.x + b.width / 2 + 8, b.y + b.height / 2 + 8, { steps: 3 });
  await p.mouse.move(to.x, to.y, { steps: 8 });
}
/** The point at an hour in a technician's lane (DK-74's 7 AM to 6 PM span). */
async function laneAt(p: Page, technicianId: string, hour: number): Promise<{ x: number; y: number }> {
  const l = (await p.locator(`[data-row="${technicianId}"] .lane`).boundingBox())!;
  // The row shows 7 AM to the later of 6 PM and its day's last job end: 1 grid line for each hour between.
  const hours = (await p.locator(`[data-row="${technicianId}"] .lane .tl-grid`).count()) + 1;
  return { x: l.x + ((hour - 7) / hours) * l.width, y: l.y + l.height / 2 };
}

/**
 * A scheduled job, a row with room for it (API-30) and the 5-minute mark at or before its arrival there (API-131), where the row
 * has a half hour free for a block, Kevin Doyle's row (the acceptance's) first. The 2 engines share this world and the drag tests
 * move jobs (which technician wins is a race), so all of this is read from the server now, never assumed from the seed (F-792).
 */
async function jobLandingOnFreeTime(b: Json): Promise<{ job: Json; tech: Json; at: number } | undefined> {
  const now = minutes((await api('keisha', 'GET', '/clock')).body.data.demoNow);
  const rows = [...b.technicians].sort((x: Json, y: Json) => Number(y.name === 'Kevin Doyle') - Number(x.name === 'Kevin Doyle'));
  for (const job of allJobs(b).filter((j) => j.status === 'scheduled' && j.technicianId && minutes(j.window.start) > now)) {
    const q = new URLSearchParams({ branch: 'columbus', date: b.date, windowId: job.windowId, serviceId: job.serviceId, jobNumber: String(job.jobNumber) });
    const room = (await api('keisha', 'GET', `/technicians/room?${q}`)).body.data.technicians as Json[];
    for (const tech of rows) {
      if (tech.id === job.technicianId || !room.find((t) => t.id === tech.id)?.room) continue;
      const arrives = (await api('keisha', 'POST', `/jobs/${job.jobNumber}/assignment-preview`, { technicianId: tech.id })).body.data.arrivesAbout;
      const at = Math.floor(hourOf(arrives) * 12) / 12;
      if (isFreeAt(tech, at)) return { job, tech, at };
    }
  }
  return undefined;
}

/**
 * Drags to a point, waits for that drag to be drawn, then runs the last move and the release in 1 task on the pressed element, so
 * the release always beats the page's next draw (a real WebKit release came 2 to 5 ms after the last move, F-792). The page's move
 * is read and aborted at the door: the proof is what the page asked for, and the shared world stays as it was.
 */
async function droppedWrite(browser: Browser, pressed: string, path: (p: Page) => Promise<{ crossed: { x: number; y: number }; released: { x: number; y: number }; drawn: string }>): Promise<Json> {
  const o = await open(browser, 'keisha');
  try {
    const asked: Json[] = [];
    await o.page.route(`${origin}/api/v1/**`, async (r) => {
      if (!/\/(assignment|move)$/.test(new URL(r.request().url()).pathname)) return r.fallback();
      asked.push(r.request().postDataJSON());
      return r.abort('connectionfailed');
    });
    await ready(o.page);
    await o.page.waitForSelector(pressed);
    const { crossed, released, drawn } = await path(o.page);
    await dragOver(o.page, pressed, crossed);
    await o.page.waitForSelector(drawn, { timeout: 15_000 });
    await o.page.locator(pressed).first().evaluate((el, at) => {
      const event = (type: string) => new (globalThis as Json).PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, clientX: at.x, clientY: at.y });
      (el as Json).dispatchEvent(event('pointermove'));
      (el as Json).dispatchEvent(event('pointerup'));
    }, { x: Math.round(released.x), y: Math.round(released.y) });
    await o.page.mouse.up();
    await expect.poll(() => asked.length, { timeout: 15_000 }).toBe(1);
    return asked[0];
  } finally {
    await close(o);
  }
}

/**
 * The map panel's first time: 2 vans on the way and moving (Marcus Bell to 24791 until about 9:51, Jamal Carter to 24814 until about
 * 9:58). Since the Jobs page story (dcc50303, F-1651) the only van out at 10:00 AM is Jamal's, parked at his track's end until his late
 * arrival at 10:18, so no van moves then (F-1733).
 */
const NINE_45 = '2026-09-15T09:45:00-04:00[America/New_York]';
/**
 * F-1745: an engine's moving-van check starts by this demo time, so Marcus's van still moves for about a minute and Jamal's for
 * about 8: a check that starts later found its van only by the other engine's luck.
 */
const MOVING_BY = '2026-09-15T09:50:00-04:00[America/New_York]';
const demoNow = async (): Promise<string> => (await api('dana', 'GET', '/clock')).body.data.demoNow as string;
/** F-1745: how many of the other 9:45 AM tests (either engine's) have run; a moving-van check runs before all of them. */
let otherNineFortyFiveRan = 0;
/** F-817: a route line's key, as SPECIFICATIONS 7.4 API-21 defines it. */
const lineKey = (polyline: string) => createHash('sha256').update(polyline).digest('hex').slice(0, 16);
const TEN_THIRTY ='2026-09-15T10:30:00-04:00[America/New_York]';
const vans = async (): Promise<Json[]> => (await api('keisha', 'GET', '/vans?branch=columbus')).body.data.vans;
/** The board, with its map's first frame and its van read in. */
const mapReady = async (p: Page) => {
  await ready(p);
  await p.waitForSelector('[data-cmp="CMP-05"][data-map-state="ready"]', { state: 'attached', timeout: 60_000 });
  await p.waitForSelector('[data-marker-kind="van"]', { state: 'attached', timeout: 30_000 });
};
const tabCount = async (p: Page, n: number) => Number(await p.locator(`[data-ctl="CTL-OFC-02-28"] [role="tab"]:nth-child(${n}) b`).textContent());
const liveCount = (p: Page) => p.locator('.mapp [data-ctl="CTL-OFC-02-23"]');
const vansButton = (p: Page) => p.locator('.mapp button[data-ctl="CTL-OFC-02-31"]');
const tabWords = (p: Page) => p.locator('.mapp [data-ctl="CTL-OFC-02-28"] [role="tab"]').allTextContents();
const vanMarkers = (p: Page) => p.locator('[data-marker-kind="van"]').count();
const FAILURES = ['the server answers 404', 'the connection drops'] as const;
type Failure = (typeof FAILURES)[number];
/**
 * API-20 or API-21 fails on this page, for real: the read goes to the real server for a branch it does not have, so the
 * refusal is the real handler's 404, or the connection drops (the client's own failed fetch). Nothing stands in for an answer.
 */
const failRead = (read: 'board' | 'vans', how: Failure) => (p: Page) => p.route(`${origin}/api/v1/${read}?*`, async (r) => {
  if (how === 'the connection drops') return r.abort('connectionfailed');
  return r.continue({ url: r.request().url().replace('branch=columbus', 'branch=nowhere') });
});
/** The focused element: a marker's id, else its tag name. */
const focusedId = (p: Page): Promise<string> => p.evaluate(() => {
  const el = (globalThis as Json).document.activeElement;
  return el?.dataset?.markerId ?? el?.tagName ?? 'none';
});
const stamp = (p: Page, id: string) => p.locator(`[data-marker-id="${id}"]`).evaluate((el) => { (el as unknown as { dataset: Record<string, string> }).dataset.kept = 'yes'; });
const stamped = (p: Page, id: string) => p.locator(`[data-marker-id="${id}"]`).getAttribute('data-kept');
/** A van whose position moves right now: 2 reads of API-21 apart, so a test that needs a moving van cannot pass on a parked one. */
async function movingVan(): Promise<Json> {
  // F-974: the 2nd read repeats every 250 ms until a van has moved (the fixed 2.5 s wait it replaces is now the longest it waits).
  return movingVanWithin(vans, { withinMs: 2_500, everyMs: 250 });
}
/** Sees 2 of the panel's reads move the van while focus sits on a marker: focus and the marker's element survive each. */
async function holdsFocusAcrossReads(p: Page, focused: string, van: Json): Promise<void> {
  let reads = 0;
  p.on('response', (r) => {
    if (/\/api\/v1\/vans\?/.test(r.url())) reads++;
  });
  await p.locator(`[data-marker-id="${focused}"]`).focus();
  expect(await focusedId(p)).toBe(focused);
  await stamp(p, focused);
  const at = () => p.locator(`[data-marker-id="van-${van.technicianId}"]`).getAttribute('data-marker-at');
  for (let n = 1; n <= 2; n++) {
    const before = await at();
    await expect.poll(at, { timeout: 25_000 }).not.toBe(before);
    expect(await focusedId(p), `after read ${n}`).toBe(focused);
    expect(await stamped(p, focused), `the element after read ${n}`).toBe('yes');
  }
  expect(reads).toBeGreaterThanOrEqual(2);
}

// The seeded world as setup wrote it, on the real baked tracks: nothing has moved yet (the suite's first tests).
describe('the chained sample week on the baked tracks (owner answer 36d87aec)', () => {
  // why: SD-21, FR-DEMO-8 F-513: 0 pairs out of order in the world setup wrote (139 and 67 of 332 before; F-292 dcc50303: 329 with the 3 unassigned Jobs page jobs)
  it('has every technician leave after the visit before ends, and never be on site at 2 jobs', () => {
    expect(psql(`SELECT row_to_json(c) FROM (${chainCensusSql()}) c`)).toBe('{"pairs":329,"left_during_visit":0,"on_site_at_two":0}');
  });

  // why: SD-15 F-356: SD-15's day plan recomputed for each seeded technician-day leaves every seeded planned arrival unchanged
  it('leaves every seeded planned arrival unchanged when SD-15 is recomputed on the real tracks', () => {
    const ms = (c: string) => `(extract(epoch FROM ${c}) * 1000)::bigint`;
    const days: Json[] = JSON.parse(psql(`
      SELECT json_agg(d) FROM (
        SELECT j.technician_id, j.date,
               ${ms("(j.date + t.shift_start) AT TIME ZONE j.zone")} AS shift_start, b.depot_lon, b.depot_lat,
               json_agg(json_build_object('n', j.job_number, 'w', ${ms('j.window_start')}, 'b', ${ms('j.booked_at')}, 'm', j.expected_minutes, 'p', ${ms('j.planned_arrival')}, 'lon', c.lon, 'lat', c.lat)) AS jobs
          FROM world.job j JOIN world.technician t ON t.id = j.technician_id JOIN world.branch b ON b.id = j.branch_id JOIN world.customer c ON c.id = j.customer_id
         WHERE NOT j.pilot GROUP BY j.technician_id, j.date, j.zone, t.shift_start, b.depot_lon, b.depot_lat) d`));
    const seconds = new Map<string, number>(JSON.parse(psql(`SELECT json_agg(json_build_array(from_ref || '|' || to_ref, seconds[cardinality(seconds)])) FROM world.van_track`)));
    expect(seconds.size).toBeGreaterThan(1000);
    let compared = 0;
    for (const d of days) {
      const plan = planDay({
        shiftStart: d.shift_start, depot: { lon: d.depot_lon, lat: d.depot_lat }, drive: trackedDriveMinutes(seconds),
        stops: d.jobs.map((j: Json) => ({ jobNumber: j.n, windowStart: j.w, bookedAt: j.b, expectedMinutes: j.m, point: { lon: j.lon, lat: j.lat } })),
      });
      for (const p of plan) {
        expect(p.plannedArrival, `job ${p.jobNumber}`).toBe(d.jobs.find((j: Json) => j.n === p.jobNumber).p);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(400);
  });
});

describe.each(engines)('the day board on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-DISP-1, FR-DISP-15, FR-DEMO-1
  it('shows 1 row per technician working the day with van and skill, each job on its row, and the demo time in the header', async () => {
    const b = await board();
    const o = await open(browser, 'keisha');
    try {
      await ready(o.page);
      const rows = await o.page.locator('.tl-row[data-row]:not([data-row="unassigned"])').evaluateAll((els) => els.map((e) => e.getAttribute('data-row')));
      expect(rows).toEqual(b.technicians.map((t: Json) => t.id));
      for (const t of b.technicians) {
        const shown = await o.page.locator(`[data-row="${t.id}"] button[data-job]`).evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-job'))).sort());
        expect(shown, t.name).toEqual(t.jobs.map((j: Json) => j.jobNumber).sort());
        if (t.van) await expect(o.page.locator(`[data-row="${t.id}"] .who .sub`).textContent()).resolves.toContain(`Van ${t.van}`);
      }
      const maria = b.technicians.find((t: Json) => t.name === 'Maria Santos');
      const sub = await o.page.locator(`[data-row="${maria.id}"] .who .sub`).textContent();
      expect(sub).toBe(`Van ${maria.van} - Heating & cooling`);
      // FR-DEMO-1: the header's Demo clock shows the demo time API-10 answers.
      const clock = (await api('keisha', 'GET', '/clock')).body.data;
      const strip = await o.page.locator('.r1-demobar').textContent();
      expect(strip).toContain('Demo clock');
      const shown = /Tue, Sep 15, (\d{1,2}):(\d\d) ([AP])M EDT/.exec(strip ?? '');
      expect(shown, strip ?? '').not.toBeNull();
      const shownMin = (Number(shown![1]) % 12 + (shown![3] === 'P' ? 12 : 0)) * 60 + Number(shown![2]);
      const apiMin = Number(/T(\d\d):(\d\d)/.exec(clock.demoNow)![1]) * 60 + Number(/T(\d\d):(\d\d)/.exec(clock.demoNow)![2]);
      expect(Math.abs(shownMin - apiMin)).toBeLessThanOrEqual(2);
    } finally {
      await close(o);
    }
    // A van change (the Technicians page's write, FR-DISP-33) shows on the row at the next read.
    const maria = b.technicians.find((t: Json) => t.name === 'Maria Santos');
    const was = psql(`SELECT van_id FROM world.technician WHERE id = '${maria.id}'`);
    // The seeded Columbus vans are all driven, so the case plants a free one and takes it away after (F-607: the case no longer skips when none is free).
    const other = psql(`INSERT INTO world.van (branch_id, number, vehicle) VALUES ('columbus', 'F607', 'Planted free van') RETURNING id || '|' || number`).split('\n')[0]!;
    expect(other, 'the planted free van').toContain('|F607');
    {
      const [vanId, number] = other.split('|');
      psql(`UPDATE world.technician SET van_id = '${vanId}' WHERE id = '${maria.id}'`);
      const o2 = await open(browser, 'keisha');
      try {
        await ready(o2.page);
        await expect(o2.page.locator(`[data-row="${maria.id}"] .who .sub`).textContent()).resolves.toBe(`Van ${number} - Heating & cooling`);
      } finally {
        await close(o2);
        psql(`UPDATE world.technician SET van_id = ${was ? `'${was}'` : 'NULL'} WHERE id = '${maria.id}'`);
        psql(`DELETE FROM world.van WHERE id = '${vanId}'`);
      }
    }
  });

  // why: FR-DISP-1, FR-DISP-15
  it('F-1539: the van and skill line of every technician row stays inside the technician column', async () => {
    const o = await open(browser, 'keisha');
    try {
      await ready(o.page);
      // A line may be wider than the column (the frame's is); then the column must cut it at its edge, so nothing is drawn over the grid.
      const off = await o.page.locator('.tl-row[data-row] .who').evaluateAll((whos) => whos.flatMap((w) => {
        const col = w.getBoundingClientRect();
        const cut = ['hidden', 'clip'].includes(w.ownerDocument.defaultView!.getComputedStyle(w).overflowX);
        return Array.from(w.querySelectorAll('.nm, .sub, .sub2'), (e: Json) => ({ text: e.textContent, over: e.getBoundingClientRect().right - col.right })).filter((x) => x.over > 0.5 && !cut);
      }));
      expect(off, 'lines that run past the column edge').toEqual([]);
      // A technician with 2 skills keeps the row's 50 px: the second skill is a line of its own, not a third wrapped line.
      const tall = await o.page.locator('.tl-row[data-row]').evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height).filter((h) => h > 51));
      expect(tall, 'rows taller than 50 px').toEqual([]);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-1, FR-DISP-9
  it('F-1540: a job that ends after 6 PM can be scrolled into view and opened', async () => {
    const b = await board();
    const late = allJobs(b).filter((j) => j.technicianId !== null).map((j) => ({ j, end: hourOf(j.status !== 'scheduled' && j.eta ? j.eta : j.plannedArrival ?? j.window.start) + j.expectedMinutes / 60 })).filter((x) => x.end > 18).sort((x, y) => y.end - x.end);
    expect(late.length, 'a seeded job ending after 6 PM').toBeGreaterThan(0);
    const o = await open(browser, 'keisha');
    try {
      await ready(o.page);
      const btn = o.page.locator(`button[data-job="${late[0]!.j.jobNumber}"]`);
      // The dispatcher scrolls the timeline to its right end (nothing to scroll before the fix: the grid stopped at 6 PM).
      await o.page.locator('#tl').evaluate((e) => { e.scrollLeft = e.scrollWidth; });
      const fit = await btn.evaluate((e) => {
        const r = e.getBoundingClientRect();
        const t = e.ownerDocument.querySelector('#tl')!.getBoundingClientRect();
        const hit = e.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { inside: r.right <= t.right + 1 && r.left < t.right, seen: hit === e || e.contains(hit), width: r.width, r: [r.left, r.right], t: [t.left, t.right] };
      });
      expect(fit, `the job is inside the timeline and not under the technician column: ${JSON.stringify(fit)}`).toMatchObject({ inside: true, seen: true });
      expect(fit.width, 'the block is not a sliver').toBeGreaterThan(40);
      await btn.click();
      await expect.poll(() => o.page.locator('.r1-pop').textContent()).toContain(String(late[0]!.j.jobNumber));
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-13
  it('shows the technicians on shift and the 7-day on-time rate against 90% with its label, equal to an independent count', async () => {
    const b = await board();
    const rate = Number(psql(`SELECT round(100.0 * count(*) FILTER (WHERE on_time) / count(*)) FROM world.report_visit
      WHERE branch_id = 'columbus' AND date BETWEEN '2026-09-08' AND '2026-09-14' AND on_time IS NOT NULL AND NOT no_one_home_only`));
    const shift = Number(psql(`SELECT count(*) FROM world.technician t WHERE t.branch_id = 'columbus' AND 2 = ANY(t.working_days)
      AND NOT EXISTS (SELECT 1 FROM world.time_off o WHERE o.technician_id = t.id AND DATE '2026-09-15' BETWEEN o.from_date AND o.to_date)`));
    expect(b.onShift).toBe(shift);
    for (const lang of ['en', 'es'] as const) {
      const o = await open(browser, 'keisha', lang);
      try {
        await ready(o.page);
        await expect(o.page.locator('[data-ctl="CTL-OFC-02-19"]').textContent()).resolves.toBe(lang === 'en' ? `${shift} on shift` : `${shift} en turno`);
        const tile = (await o.page.locator('[data-ctl="CTL-OFC-02-18"]').textContent()) ?? '';
        expect(tile).toContain(lang === 'en' ? `${rate}%` : `${rate} %`);
        expect(tile).toContain(lang === 'en' ? 'goal 90%' : 'meta 90 %');
        expect(tile).toContain(lang === 'en' ? 'Simulated pilot data' : 'Datos simulados del piloto');
      } finally {
        await close(o);
      }
    }
  });

  // why: FR-DISP-10, FR-DISP-11
  it('opens the board from the top bar for the office and a manager, refuses a technician, and "/" focuses the search only while the shortcut is on', async () => {
    for (const who of ['keisha', 'dana'] as const) {
      const o = await open(browser, who);
      try {
        await ready(o.page);
        await o.page.locator('.topbar nav a', { hasText: 'Board' }).first().click();
        await o.page.waitForURL(/\/office\/board/);
        await o.page.waitForSelector('[data-screen="SCR-OFC-02"]');
      } finally {
        await close(o);
      }
    }
    const t = await open(browser, 'tech');
    try {
      await t.page.waitForSelector('[data-screen="SCR-SHR-01"]');
    } finally {
      await close(t);
    }
    // The "/" shortcut (CTL-CMP-07-10): on for Keisha (the default), off for Dana (her saved setting, API-08).
    expect((await api('dana', 'PATCH', '/me', { slashShortcut: 'off' })).status).toBeLessThan(300);
    try {
      for (const [who, on] of [['keisha', true], ['dana', false]] as const) {
        const o = await open(browser, who);
        try {
          await ready(o.page);
          await o.page.locator('[data-ctl="CTL-OFC-02-17"]').click();
          await o.page.keyboard.press('/');
          const focused = await o.page.evaluate(() => (globalThis as unknown as { document: { activeElement: { className?: string } | null } }).document.activeElement?.className ?? '');
          if (on) expect(focused).toContain('bw-search-input');
          else expect(focused).not.toContain('bw-search-input');
        } finally {
          await close(o);
        }
      }
    } finally {
      await api('dana', 'PATCH', '/me', { slashShortcut: 'on' });
    }
  });

  // why: FR-DISP-2, FR-DISP-6, UC-02
  it('2 dispatchers drag the same job at once: it ends with 1 technician, the second sees who moved it, to whom and when in her language, and other boards update', async () => {
    const b = await board();
    const kevin = b.technicians.find((t: Json) => t.name === 'Kevin Doyle');
    const now = minutes((await api('keisha', 'GET', '/clock')).body.data.demoNow);
    // Job 24825 for the first engine (the acceptance's job), else a scheduled job of a later window of the day.
    const candidates = allJobs(b).filter((j) => j.status === 'scheduled' && j.technicianId && j.technicianId !== kevin.id && minutes(j.window.start) > now);
    const job = candidates.find((j) => j.jobNumber === 24825) ?? candidates[candidates.length - 1];
    expect(job, 'a scheduled job to move').toBeDefined();
    // The 2 targets need room that day (SD-27): Kevin Doyle (the acceptance's) and the least loaded other technician.
    const others = b.technicians.filter((t: Json) => t.id !== kevin.id && t.id !== job.technicianId && t.capacity > t.jobs.length + 1)
      .sort((x: Json, y: Json) => x.jobs.length - y.jobs.length);
    const second = others[0];
    expect(kevin.jobs.length, 'Kevin Doyle has room').toBeLessThan(kevin.capacity);
    const a = await open(browser, 'keisha', 'en');
    const c = await open(browser, 'ana', 'es');
    const watch = await open(browser, 'dana', 'en');
    try {
      await Promise.all([ready(a.page), ready(c.page), ready(watch.page)]);
      const sample = watch.page.waitForRequest((r) => r.url().endsWith('/api/v1/board-delay-samples') && r.method() === 'POST', { timeout: 30_000 });
      await dragOver(a.page, `button[data-job="${job.jobNumber}"]`, await laneAt(a.page, kevin.id, 15));
      await dragOver(c.page, `button[data-job="${job.jobNumber}"]`, await laneAt(c.page, second.id, 15));
      await Promise.all([a.page.mouse.up(), c.page.mouse.up()]);
      const dialog = '[data-screen="SCR-OFC-19"]';
      await Promise.race([a.page.waitForSelector(dialog, { timeout: 20_000 }), c.page.waitForSelector(dialog, { timeout: 20_000 })]);
      const after = allJobs(await board()).find((j) => j.jobNumber === job.jobNumber);
      const aLost = await a.page.locator(dialog).count();
      const cLost = await c.page.locator(dialog).count();
      expect(aLost + cLost, 'exactly 1 of the 2 moves is refused').toBe(1);
      const [winner, loser, lang] = aLost ? ['Ana Gutierrez', a, 'en'] : ['Keisha Thompson', c, 'es'];
      // The job has exactly 1 technician, one of the 2 targets (the server's record decides whose move came first).
      expect([kevin.id, second.id]).toContain(after.technicianId);
      const winnerTech = after.technicianId === kevin.id ? kevin : second;
      expect(after.version).toBe(job.version + 1);
      const message = (await loser.page.locator(`${dialog} [data-ctl="CTL-OFC-19-01"]`).textContent()) ?? '';
      expect(message).toContain(shortName(winner));
      expect(message).toContain(winnerTech.name);
      expect(message).toMatch(lang === 'en' ? /moved this job to .* at \d{1,2}:\d\d [AP]M/ : /movió este trabajo a .* a las \d{1,2}:\d\d [AP]M/);
      await expect(loser.page.locator(`${dialog} [data-ctl="CTL-OFC-19-02"]`).textContent()).resolves.toBe(lang === 'en' ? 'Move it anyway' : 'Moverlo de todos modos');
      // Every open board shows the job on the winner's row, the onlooker's by the live update alone (NFR-01), and it posts
      // the re-read's delay sample (API-172, SD-43).
      await expect.poll(async () => watch.page.locator(`[data-row="${winnerTech.id}"] button[data-job="${job.jobNumber}"]`).count(), {
        timeout: 15_000, message: `the onlooker's board, live state ${await watch.page.locator('.r1-live').textContent()}`,
      }).toBe(1);
      // F-885: the board posts its held samples as 1 batch, each with its seq and held time
      const posted = JSON.parse((await sample).postData() ?? '{}') as { samples?: { seq: number; heldMs: number }[] };
      expect(posted.samples?.[0]?.seq).toBeGreaterThan(0);
      expect(posted.samples?.[0]?.heldMs).toBeGreaterThanOrEqual(0);
      await loser.page.locator(`${dialog} [data-ctl="CTL-OFC-19-03"]`).first().click();
      await loser.page.waitForSelector(`[data-row="${winnerTech.id}"] button[data-job="${job.jobNumber}"]`, { timeout: 15_000 });
    } finally {
      await Promise.all([close(a), close(c), close(watch)]);
    }
  });

  // why: FR-DISP-16, FR-DISP-34
  it('adds a Supply run for Kevin Doyle, drags it to 2:00 PM on every open board, and Delete asks first; a block is no job', async () => {
    const before = await board();
    // Kevin Doyle's row when the seeded day leaves it room (blockRow); the name `kevin` is that row.
    const { tech: kevin, h: startH } = blockRow(before);
    const seeded = before.technicians.flatMap((t: Json) => t.blocks).find((x: Json) => x.label === 'Pickup');
    const a = await open(browser, 'keisha');
    const c = await open(browser, 'ana');
    try {
      await Promise.all([ready(a.page), ready(c.page)]);
      // The seeded Pickup block must exist, and shows its place and its times (FR-DISP-16).
      expect(seeded, 'the seeded Pickup block').toBeDefined();
      await expect(a.page.locator(`button[data-block="${seeded.blockId}"]`).textContent()).resolves.toContain('Supply house');
      await expect(a.page.locator(`#bd${seeded.blockId}`).textContent()).resolves.toBe(spanOf(seeded.start, seeded.end));
      const jobsTile = async () => (await a.page.locator('[data-ctl="CTL-OFC-02-06"] .tile .num').first().textContent())?.trim();
      const jobsBefore = await jobsTile();
      await a.page.locator('[data-ctl="CTL-OFC-02-32"]').click();
      const dlg = a.page.locator('[data-screen="SCR-OFC-31"]');
      await dlg.locator('#blk-tech').selectOption(kevin.id);
      await dlg.locator('#blk-label').fill('Supply run');
      await dlg.locator('#blk-place').fill('Supply house');
      await dlg.locator('#blk-start').fill(hhmm(startH));
      await dlg.locator('#blk-end').fill(hhmm(startH + 0.5));
      await dlg.locator('[data-ctl="CTL-OFC-31-05"]').click();
      await a.page.waitForSelector('[data-screen="SCR-OFC-31"]', { state: 'detached' });
      const made = (await board()).technicians.find((t: Json) => t.id === kevin.id).blocks.find((x: Json) => x.label === 'Supply run' && x.version === 1);
      expect(made).toBeDefined();
      await c.page.waitForSelector(`button[data-block="${made.blockId}"]`, { timeout: 15_000 });
      // FR-DISP-13, FR-DISP-34: the block is counted neither as a job nor in Kevin's capacity.
      expect(await jobsTile()).toBe(jobsBefore);
      expect((await board()).counts.jobs).toBe(before.counts.jobs);
      // Drag it along the row an hour later: every open board shows it there.
      const box = (await a.page.locator(`button[data-block="${made.blockId}"]`).boundingBox())!;
      const target = await laneAt(a.page, kevin.id, startH + 1);
      await dragOver(a.page, `button[data-block="${made.blockId}"]`, { x: target.x + box.width / 2 + 0.5, y: target.y });
      await a.page.mouse.up();
      const moved = async () => (await board()).technicians.find((t: Json) => t.id === kevin.id).blocks.find((x: Json) => x.blockId === made.blockId);
      await expect.poll(async () => (await moved()).version, { timeout: 15_000 }).toBe(2);
      const m = await moved();
      expect(hhmm(hourOf(m.start))).toBe(hhmm(startH + 1));
      const span = spanOf(m.start, m.end);
      await expect.poll(async () => c.page.locator(`#bd${made.blockId}`).textContent(), { timeout: 15_000 }).toBe(span);
      // Delete asks first: Cancel keeps it; confirming removes it from every open board.
      await a.page.locator(`button[data-block="${made.blockId}"]`).click();
      await a.page.locator('[data-ctl="CTL-OFC-32-03"]').click();
      const del = a.page.locator('[data-screen="SCR-OFC-33"]');
      await expect(del.locator('[data-ctl="CTL-OFC-33-01"]').textContent()).resolves.toContain(span);
      await del.locator('[data-ctl="CTL-OFC-33-03"]').first().click();
      expect(await moved()).toBeDefined();
      await a.page.locator(`button[data-block="${made.blockId}"]`).click();
      await a.page.locator('[data-ctl="CTL-OFC-32-03"]').click();
      await a.page.locator('[data-screen="SCR-OFC-33"] [data-ctl="CTL-OFC-33-02"]').click();
      await c.page.waitForSelector(`button[data-block="${made.blockId}"]`, { state: 'detached', timeout: 15_000 });
      expect(await moved()).toBeUndefined();
    } finally {
      await Promise.all([close(a), close(c)]);
    }
  });

  // why: FR-DISP-16, FR-DISP-34 (F-1787) a block's popover and its Delete dialog, opened while the block's own move still reads the board, stay open when that read lands (SCR-OFC-32 closes only by Close or Escape)
  it('keeps a block popover and its Delete dialog open when the block\'s own move reads the board after they open', async () => {
    const { tech, h } = blockRow(await board());
    const created = await api('keisha', 'POST', '/time-blocks', { technicianId: tech.id, date: '2026-09-15', label: 'Supply run', place: 'Supply house', start: hhmm(h), end: hhmm(h + 0.5) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const made = created.body.data.block;
    const o = await open(browser, 'keisha', 'en');
    // The page's board reads (API-20) wait while `held` is set, so the move's own read lands after the popover and the dialog open:
    // the order a loaded host gave the Supply run case above by chance (its click beat the dropping page's read).
    let held: Promise<void> | null = null;
    let release: () => void = () => undefined;
    try {
      await ready(o.page);
      await o.page.route((u) => u.pathname === '/api/v1/board', async (r) => {
        if (held) await held;
        return r.fallback();
      });
      const block = o.page.locator(`button[data-block="${made.blockId}"]`);
      const box = (await block.boundingBox())!;
      const target = await laneAt(o.page, tech.id, h + 1);
      await dragOver(o.page, `button[data-block="${made.blockId}"]`, { x: target.x + box.width / 2 + 0.5, y: target.y });
      held = new Promise((r) => { release = r; });
      await o.page.mouse.up();
      const moved = async () => (await board()).technicians.find((t: Json) => t.id === tech.id).blocks.find((x: Json) => x.blockId === made.blockId);
      await expect.poll(async () => (await moved()).version, { timeout: 15_000 }).toBe(2);
      const m = await moved();
      const span = spanOf(m.start, m.end);
      // The move is written and its read is held: the block still says Moving..., opens its popover, and Delete opens its dialog.
      await expect(block.getAttribute('aria-busy')).resolves.toBe('true');
      await block.click();
      await o.page.locator('[data-ctl="CTL-OFC-32-03"]').click();
      const del = o.page.locator('[data-screen="SCR-OFC-33"]');
      await del.waitFor({ timeout: 15_000 });
      held = null;
      release();
      // The read lands (the board says the block moved, in the same draw), and what the person opened is still open.
      await o.page.waitForSelector('[data-ctl="CTL-CMP-11-01"]:has-text("Supply run moved to")', { timeout: 15_000 });
      expect(await o.page.locator('.r1-pop [data-ctl="CTL-OFC-32-01"]').count(), 'the block popover').toBe(1);
      expect(await del.count(), 'the Delete dialog').toBe(1);
      await expect(del.locator('[data-ctl="CTL-OFC-33-01"]').textContent()).resolves.toContain(span);
      await del.locator('[data-ctl="CTL-OFC-33-02"]').click();
      await expect.poll(moved, { timeout: 15_000 }).toBeUndefined();
    } finally {
      release();
      await close(o);
      await api('keisha', 'DELETE', `/time-blocks/${made.blockId}`);
    }
  });

  // why: FR-DISP-12 the bell and the page share the tab's 1 event connection, so a local copy's 6 connections per host reach 4 Board tabs and more (F-662, F-710: the 4th tab hung)
  it('holds 1 event connection in each of 4 Board tabs, and the 4th loads', async () => {
    const o = await open(browser, 'keisha');
    const streams: string[] = [];
    o.g.context.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname === '/api/v1/events') streams.push(u.search);
    });
    await ready(o.page);
    for (let tab = 2; tab <= 4; tab += 1) {
      const p = await o.g.context.newPage();
      await writeOrigin(p);
      await p.goto(`${origin}/office/board?branch=columbus&date=today`, { waitUntil: 'load', timeout: 30_000 });
      await ready(p);
    }
    // The first tab's connection can open before the watch starts or just after it: 3 or 4 in all, never 2 a tab, none naming a branch.
    expect(streams.length).toBeGreaterThanOrEqual(3);
    expect(streams.length).toBeLessThanOrEqual(4);
    expect(new Set(streams)).toEqual(new Set(['']));
    await close(o);
  }, 180_000);

  // why: FR-DISP-34 (owner ruling 8ef38e83, F-354) 2 dispatchers move the same block at once
  it('2 dispatchers drag the same block at once: it ends in 1 place, the second sees who moved it and when, and API-137 names the block change log row', async () => {
    const { tech: kevin, h } = blockRow(await board());
    // The 2 movers get different free half hours (not the block's own), so the loser's message can name only the winner's target (F-607).
    const targets = SLOT_STARTS.filter((x) => x !== h && isFreeAt(kevin, x));
    expect(targets.length, 'Kevin has 2 free half hours besides the block\'s own').toBeGreaterThanOrEqual(2);
    const [targetA, targetC] = targets as [number, number];
    const created = await api('keisha', 'POST', '/time-blocks', { technicianId: kevin.id, date: '2026-09-15', label: 'Supply run', place: 'Supply house', start: hhmm(h), end: hhmm(h + 0.5) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const made = created.body.data.block;
    const a = await open(browser, 'keisha', 'en');
    const c = await open(browser, 'ana', 'en');
    try {
      await Promise.all([ready(a.page), ready(c.page)]);
      await Promise.all([a.page.waitForSelector(`button[data-block="${made.blockId}"]`), c.page.waitForSelector(`button[data-block="${made.blockId}"]`)]);
      const refused = Promise.race([a.page, c.page].map((p) => p.waitForResponse((r) => r.url().includes(`/time-blocks/${made.blockId}/move`) && r.status() === 409, { timeout: 20_000 })));
      const box = (await a.page.locator(`button[data-block="${made.blockId}"]`).boundingBox())!;
      // Each moves it to its own free half hour, against the version its board read: 1 of them is refused.
      const ta = await laneAt(a.page, kevin.id, targetA);
      const tc = await laneAt(c.page, kevin.id, targetC);
      await dragOver(a.page, `button[data-block="${made.blockId}"]`, { x: ta.x + box.width / 2 + 0.5, y: ta.y });
      await dragOver(c.page, `button[data-block="${made.blockId}"]`, { x: tc.x + box.width / 2 + 0.5, y: tc.y });
      await Promise.all([a.page.mouse.up(), c.page.mouse.up()]);
      const answer = (await (await refused).json()) as Json;
      expect(answer.code).toBe('version_conflict');
      const row = psql(`SELECT u.name || '|' || c.actor_kind || '|' || c.kind || '|' || (extract(epoch FROM c.at) * 1000)::bigint || '|' || b.start::text
        FROM world.time_block_change c JOIN world."user" u ON u.id = c.actor_user_id JOIN world.time_block b ON b.id = c.block_id
        WHERE c.block_id = '${made.blockId}' ORDER BY c.to_version DESC LIMIT 1`).split('|');
      expect([answer.by, answer.byKind, answer.change]).toEqual([row[0], row[1], row[2]]);
      expect(answer.by && answer.byKind && answer.change && answer.at).toBeTruthy();
      expect(minutes(answer.at)).toBe(Number(row[3]));
      // The block is in 1 place: version 2, the winner's time; the loser's dialog names who and when.
      const now = (await board()).technicians.find((t: Json) => t.id === kevin.id).blocks.find((x: Json) => x.blockId === made.blockId);
      expect(now.version).toBe(2);
      const dialog = '[data-screen="SCR-OFC-19"]';
      const loser = await Promise.race([a, c].map((o) => o.page.waitForSelector(`${dialog} [data-ctl="CTL-OFC-19-01"]`, { timeout: 20_000 }).then(() => o)));
      const message = (await loser.page.locator(`${dialog} [data-ctl="CTL-OFC-19-01"]`).textContent()) ?? '';
      expect(message).toContain(shortName(answer.by));
      expect(message).toContain(`moved this block to ${timeText(now.start)} at ${timeText(answer.at)}`);
      // The winner's target is named, never the loser's own.
      const loserTarget = loser === a ? targetA : targetC;
      const winnerTarget = loser === a ? targetC : targetA;
      expect(hhmm(hourOf(now.start))).toBe(hhmm(winnerTarget));
      expect(message).not.toContain(`moved this block to ${timeText(`T${hhmm(loserTarget)}`)}`);
    } finally {
      await Promise.all([close(a), close(c)]);
      await api('keisha', 'DELETE', `/time-blocks/${made.blockId}`);
    }
  });

  // why: FR-DISP-34, OI-41 a job dropped on a row where its planned time overlaps a block is refused with the message that names the block (the UI half; the server half is P3-OFFICE-WRITES's DB test)
  it('refuses a job dropped on a row where it would overlap a block, names the block in the toast and moves nothing', async () => {
    const found = await jobLandingOnFreeTime(await board());
    expect(found, 'a scheduled job, a row with room for it, and a free half hour where it would land there').toBeDefined();
    const { job, tech, at } = found!;
    const created = await api('keisha', 'POST', '/time-blocks', { technicianId: tech.id, date: '2026-09-15', label: 'Supply run', place: 'Supply house', start: hhmm(at), end: hhmm(at + 0.5) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const made = created.body.data.block;
    const o = await open(browser, 'keisha', 'en');
    try {
      await ready(o.page);
      await o.page.waitForSelector(`button[data-job="${job.jobNumber}"]`);
      await dragOver(o.page, `button[data-job="${job.jobNumber}"]`, await laneAt(o.page, tech.id, at));
      await o.page.mouse.up();
      const toast = o.page.locator('[data-ctl="CTL-CMP-11-01"]');
      await toast.waitFor({ timeout: 20_000 });
      const text = (await toast.textContent()) ?? '';
      expect(text).toMatch(/^That would overlap .+'s Supply run, /);
      expect(text).toContain(spanOf(made.start, made.end));
      expect(allJobs(await board()).find((j) => j.jobNumber === job.jobNumber).technicianId, 'the refused job stays on its row').toBe(job.technicianId);
    } finally {
      await close(o);
      await api('keisha', 'DELETE', `/time-blocks/${made.blockId}`);
    }
  });

  // why: FR-DISP-2, FR-DISP-34 (F-792) a drop lands where the pointer is released even when the release beats the page's next draw, on the row under it and at the time under it
  it('lands a job on the row and a block at the time under the release when the release beats the next draw', async () => {
    const b = await board();
    const { tech, h } = blockRow(b);
    const now = minutes((await api('keisha', 'GET', '/clock')).body.data.demoNow);
    const job = allJobs(b).find((j) => j.status === 'scheduled' && j.technicianId && j.technicianId !== tech.id && minutes(j.window.start) > now);
    expect(job, 'a scheduled job to drag').toBeDefined();
    const [crossed, released] = b.technicians.filter((t: Json) => t.id !== job.technicianId) as [Json, Json];
    // Both times stay on the lane: the block's own hour plus 1, then 2 hours from it on the side the day has left.
    const last = h + 2 <= 17 ? h + 2 : h - 2;
    const created = await api('keisha', 'POST', '/time-blocks', { technicianId: tech.id, date: '2026-09-15', label: 'Supply run', place: 'Supply house', start: hhmm(h), end: hhmm(h + 0.5) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const made = created.body.data.block;
    try {
      const ofJob = await droppedWrite(browser, `button[data-job="${job.jobNumber}"]`, async (p) => ({
        crossed: await laneAt(p, crossed.id, 15), released: await laneAt(p, released.id, 15), drawn: `[data-row="${crossed.id}"] .dragging`,
      }));
      expect(ofJob.technicianId, 'the row under the release, not the row it crossed').toBe(released.id);
      const ofBlock = await droppedWrite(browser, `button[data-block="${made.blockId}"]`, async (p) => {
        const half = (await p.locator(`button[data-block="${made.blockId}"]`).boundingBox())!.width / 2;
        const at = async (hour: number) => { const l = await laneAt(p, tech.id, hour); return { x: l.x + half + 0.5, y: l.y }; };
        return { crossed: await at(h + 1), released: await at(last), drawn: `[data-row="${tech.id}"] .dragging` };
      });
      expect(ofBlock.start, 'the time under the release, not the time it crossed').toBe(hhmm(last));
    } finally {
      await api('keisha', 'DELETE', `/time-blocks/${made.blockId}`);
    }
  });

  // why: FR-DISP-2, FR-DISP-17 (F-792) a drag's tooltip sits over the row above its target: a release there lands on the row under the pointer, never on the row the tooltip names
  it('lands a job on the row under the pointer when the drag\'s own tooltip covers it', async () => {
    const b = await board();
    const now = minutes((await api('keisha', 'GET', '/clock')).body.data.demoNow);
    const job = allJobs(b).find((j) => j.status === 'scheduled' && j.technicianId && minutes(j.window.start) > now);
    expect(job, 'a scheduled job to drag').toBeDefined();
    // Under: a row whose row above (over) is another technician's, neither the job's own.
    const k = b.technicians.findIndex((t: Json, i: number) => i > 0 && t.id !== job.technicianId && b.technicians[i - 1].id !== job.technicianId);
    const [over, under] = [b.technicians[k - 1], b.technicians[k]] as [Json, Json];
    const o = await open(browser, 'keisha');
    try {
      const asked: Json[] = [];
      await o.page.route(`${origin}/api/v1/**`, async (r) => {
        if (!/\/assignment$/.test(new URL(r.request().url()).pathname)) return r.fallback();
        asked.push(r.request().postDataJSON());
        return r.abort('connectionfailed');
      });
      await ready(o.page);
      const pressed = `button[data-job="${job.jobNumber}"]`;
      await o.page.waitForSelector(pressed);
      await dragOver(o.page, pressed, await laneAt(o.page, under.id, 15));
      // The tooltip stands still once the preview has answered (it moves to the arrival the preview names).
      const tip = o.page.locator(`[data-row="${under.id}"] .dragtip`);
      await o.page.waitForSelector(`[data-row="${under.id}"] .dragtip .ok`, { timeout: 15_000 });
      const t = (await tip.boundingBox())!;
      const lane = (await o.page.locator(`[data-row="${over.id}"] .lane`).boundingBox())!;
      const top = Math.max(t.y, lane.y);
      const bottom = Math.min(t.y + t.height, lane.y + lane.height);
      expect(bottom - top, 'the tooltip covers part of the row above').toBeGreaterThan(4);
      await o.page.mouse.move(t.x + Math.min(20, t.width / 2), (top + bottom) / 2, { steps: 2 });
      await o.page.mouse.up();
      await expect.poll(() => asked.length, { timeout: 15_000 }).toBe(1);
      expect(asked[0].technicianId, 'the row under the pointer, not the row the tooltip names').toBe(over.id);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-34, UD-6 (F-792) the block a dispatcher is dragging can move to another row under her and take its button with it: her release still goes out, she sees who moved it, and no drag stays on screen
  it('answers a release with who moved the block when someone else put it on another row during the drag', async () => {
    const b = await board();
    const { tech, h } = blockRow(b);
    const other = b.technicians.find((t: Json) => t.id !== tech.id && isFreeAt(t, h));
    expect(other, 'another row with the same half hour free').toBeDefined();
    const created = await api('keisha', 'POST', '/time-blocks', { technicianId: tech.id, date: '2026-09-15', label: 'Supply run', place: 'Supply house', start: hhmm(h), end: hhmm(h + 0.5) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const made = created.body.data.block;
    const held = `button[data-block="${made.blockId}"]`;
    const o = await open(browser, 'ana', 'en');
    try {
      await ready(o.page);
      await o.page.waitForSelector(held);
      await dragOver(o.page, held, await laneAt(o.page, tech.id, h + 1));
      await o.page.waitForSelector(`[data-row="${tech.id}"] .dragging`, { timeout: 15_000 });
      const moved = await api('keisha', 'POST', `/time-blocks/${made.blockId}/move`, { technicianId: other.id, start: hhmm(h), end: hhmm(h + 0.5), baseVersion: made.version });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      await o.page.waitForSelector(`[data-row="${other.id}"] ${held}`, { timeout: 15_000 });
      await o.page.mouse.up();
      const dialog = '[data-screen="SCR-OFC-19"]';
      await o.page.waitForSelector(`${dialog} [data-ctl="CTL-OFC-19-01"]`, { timeout: 15_000 });
      expect(await o.page.locator(`${dialog} [data-ctl="CTL-OFC-19-01"]`).textContent()).toContain('Keisha T.');
      expect(await o.page.locator('.tl-row .dragging').count(), 'no drag left on screen').toBe(0);
    } finally {
      await close(o);
      await api('keisha', 'DELETE', `/time-blocks/${made.blockId}`);
    }
  });

  // why: FR-DISP-9
  it('lists flagged phone items until a person marks one handled, which the job history records with who and when', async () => {
    const jobs = allJobs(await board()).filter((j) => j.technicianId).slice(0, 2);
    const tech = jobs[0].technicianId;
    const ids = jobs.map((j) => psql(`WITH i AS (INSERT INTO world.tech_item (key, technician_id, job_number, kind, base_version, world_epoch, device_time_real, offset_saved_real,
        demo_time, since_save_ms, received_at, result) VALUES (gen_random_uuid(), '${tech}', ${j.jobNumber}, 'finished', 1,
        (SELECT world_epoch FROM system.demo_clock), now(), now(), now(), 0, now(), 'flagged') RETURNING key)
      INSERT INTO world.offline_conflict (job_number, item_key, branch_id, message_key, message_values, offline_at, sent_at)
      SELECT ${j.jobNumber}, key, 'columbus', 'offline.flag.canceled', '{"tech":"Maria","action":"finished","job":${j.jobNumber},"by":"Keisha T.","at":"10:40 AM"}'::jsonb, now(), now() FROM i RETURNING id`));
    const handledBefore = Number(psql(`SELECT count(*) FROM world.job_change WHERE job_number = ${jobs[0].jobNumber} AND kind = 'flag_handled'`));
    const o = await open(browser, 'keisha');
    try {
      await ready(o.page);
      for (const id of ids) await o.page.waitForSelector(`[data-conflict="${id}"]`);
      const demoBefore = minutes((await api('keisha', 'GET', '/clock')).body.data.demoNow);
      await o.page.locator(`[data-conflict="${ids[0]}"] [data-ctl="CTL-OFC-02-16"]`).click();
      await o.page.waitForSelector(`[data-conflict="${ids[0]}"]`, { state: 'detached', timeout: 15_000 });
      const demoAfter = minutes((await api('keisha', 'GET', '/clock')).body.data.demoNow);
      await o.page.waitForSelector(`[data-conflict="${ids[1]}"]`);
      expect(psql(`SELECT u.name FROM world.offline_conflict c JOIN world."user" u ON u.id = c.handled_by WHERE c.id = '${ids[0]}'`)).toBe('Keisha Thompson');
      expect(psql(`SELECT count(*) FROM world.job_change WHERE job_number = ${jobs[0].jobNumber} AND kind = 'flag_handled'`)).toBe(String(handledBefore + 1));
      // The history row's time is the demo clock's at the click ("at 11:15 AM" in the acceptance), not a real-time stamp (F-607).
      const loggedAt = Number(psql(`SELECT (extract(epoch FROM at) * 1000)::bigint FROM world.job_change WHERE job_number = ${jobs[0].jobNumber} AND kind = 'flag_handled' ORDER BY at DESC LIMIT 1`));
      expect(loggedAt).toBeGreaterThanOrEqual(demoBefore - 1000);
      expect(loggedAt).toBeLessThanOrEqual(demoAfter + 1000);
      expect(psql(`SELECT handled_at IS NULL FROM world.offline_conflict WHERE id = '${ids[1]}'`)).toBe('t');
    } finally {
      await close(o);
      await api('keisha', 'POST', `/offline-conflicts/${ids[1]}/handled`, {});
    }
  });

  // why: F-1743 (F-1734, 1deca594) a second Mark handled press is not dropped while the first press's re-read is still in flight: the board reads after the first press are held (600 ms, then 3 s), the second row is pressed the moment the first leaves, and the press is written
  it('writes a second Mark handled press made while the board re-read of the first press is still held', async () => {
    const jobs = allJobs(await board()).filter((j) => j.technicianId).slice(0, 2);
    const tech = jobs[0].technicianId;
    const ids = jobs.map((j) => psql(`WITH i AS (INSERT INTO world.tech_item (key, technician_id, job_number, kind, base_version, world_epoch, device_time_real, offset_saved_real,
        demo_time, since_save_ms, received_at, result) VALUES (gen_random_uuid(), '${tech}', ${j.jobNumber}, 'finished', 1,
        (SELECT world_epoch FROM system.demo_clock), now(), now(), now(), 0, now(), 'flagged') RETURNING key)
      INSERT INTO world.offline_conflict (job_number, item_key, branch_id, message_key, message_values, offline_at, sent_at)
      SELECT ${j.jobNumber}, key, 'columbus', 'offline.flag.canceled', '{"tech":"Maria","action":"finished","job":${j.jobNumber},"by":"Keisha T.","at":"10:40 AM"}'::jsonb, now(), now() FROM i RETURNING id`));
    const o = await open(browser, 'keisha');
    // Once armed, the page's board reads (API-20) wait: the first 600 ms, every later one 3 s, the rig that proved F-1734 red then green.
    let armed = false;
    let held = 0;
    let inFlight = 0; // F-1806: the held reads that have not ended
    try {
      await ready(o.page);
      for (const id of ids) await o.page.waitForSelector(`[data-conflict="${id}"]`);
      await o.page.route((u) => u.pathname === '/api/v1/board', async (r) => {
        if (armed) {
          const wait = held === 0 ? 600 : 3_000;
          held += 1;
          inFlight += 1;
          await new Promise((done) => setTimeout(done, wait));
          inFlight -= 1;
        }
        return r.fallback();
      });
      armed = true;
      await o.page.locator(`[data-conflict="${ids[0]}"] [data-ctl="CTL-OFC-02-16"]`).click();
      // The first row leaves when the event's re-read (600 ms) draws the board; the press's own read (3 s) is still in flight.
      await o.page.waitForSelector(`[data-conflict="${ids[0]}"]`, { state: 'detached', timeout: 15_000 });
      // F-1806: the case is red on the old code only while the press's own read is still held here, so the overlap is asserted, not assumed.
      expect(inFlight, 'the press read is still in flight at the second click').toBeGreaterThanOrEqual(1);
      await o.page.locator(`[data-conflict="${ids[1]}"] [data-ctl="CTL-OFC-02-16"]`).click();
      // The second press is written, not dropped: its row is handled in the database well before the 3 s read ends and the page shows the board again.
      await expect.poll(() => psql(`SELECT handled_at IS NOT NULL FROM world.offline_conflict WHERE id = '${ids[1]}'`), { timeout: 8_000, interval: 250 }).toBe('t');
      await o.page.waitForSelector(`[data-conflict="${ids[1]}"]`, { state: 'detached', timeout: 15_000 });
      expect(held, 'the held reads ran: at least the first press read and the event read').toBeGreaterThanOrEqual(2);
    } finally {
      armed = false;
      await close(o);
      for (const id of ids) await api('keisha', 'POST', `/offline-conflicts/${id}/handled`, {});
    }
  });

  // why: F-1168 (owner ruling 21ce2f73, "Keep them too"): a refused photo or signature kept by the server shows in the dispatcher's flagged row as a link to the image (API-175)
  it('shows a kept refused photo and signature under their flagged rows as links to the image', async () => {
    const j = allJobs(await board()).filter((x) => x.technicianId)[0];
    const kept = ['photo', 'signature'].map((kind) => psql(`WITH i AS (INSERT INTO world.tech_item (key, technician_id, job_number, kind, world_epoch, device_time_real, offset_saved_real,
        demo_time, since_save_ms, received_at, result, payload) VALUES (gen_random_uuid(), '${j.technicianId}', ${j.jobNumber}, '${kind}',
        (SELECT world_epoch FROM system.demo_clock), now(), now(), now(), 0, now(), 'flagged', '{"file":"2026-09/${kind}-kept"}'::jsonb) RETURNING key)
      INSERT INTO world.offline_conflict (job_number, item_key, branch_id, message_key, message_values, offline_at, sent_at)
      SELECT ${j.jobNumber}, key, 'columbus', 'offline.flag.not_found', '{"tech":"Maria","action":"${kind}","job":${j.jobNumber}}'::jsonb, now(), now() FROM i RETURNING id || '|' || item_key`));
    const o = await open(browser, 'keisha');
    try {
      await ready(o.page);
      for (const [i, kind] of ['photo', 'signature'].entries()) {
        const [id, key] = kept[i]!.split('|');
        const link = o.page.locator(`[data-conflict="${id}"] a[data-entry-file="${kind}"]`);
        await link.waitFor();
        expect(await link.getAttribute('href')).toBe(`/api/v1/files/${key}`);
      }
    } finally {
      await close(o);
      for (const k of kept) await api('keisha', 'POST', `/offline-conflicts/${k.split('|')[0]}/handled`, {});
    }
  });
});

// The clock's first move: every test above ran at 7:00 AM on both engines. F-1745: the 2 checks that need a moving van run here,
// each engine's right after its own jump to 9:45 AM, before either engine's other 9:45 AM tests.
describe.each(engines)('the moving van at 9:45 AM on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
    await clockAt(NINE_45);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  });

  // why: NFR-06, UI-SPECIFICATION 14 item 1, F-813, F-1745 a keyboard user stays on a van marker while the 10 s reads move it, pressing it keeps focus through its change of look, and a marker that leaves hands focus to the map
  it('keeps focus on a van marker across 2 reads, through Enter, and on the map when the marker leaves', async () => {
    const o = await open(browser, 'keisha');
    try {
      await mapReady(o.page);
      expect(otherNineFortyFiveRan, 'no other 9:45 AM test spent demo minutes before this moving-van check').toBe(0);
      expect(minutes(await demoNow()), 'this engine\'s moving-van check starts by 9:50 AM').toBeLessThanOrEqual(minutes(MOVING_BY));
      const van = await movingVan();
      expect(van, 'a van moving at 9:45 AM').toBeDefined();
      const id = `van-${van.technicianId}`;
      await holdsFocusAcrossReads(o.page, id, van);
      await o.page.keyboard.press('Enter');
      await o.page.waitForSelector('[data-ctl="CTL-OFC-02-13"]');
      await o.page.waitForSelector(`[data-marker-id="${id}"] .bw-marker.selected`, { state: 'attached' });
      expect(await focusedId(o.page)).toBe(id);
      expect(await stamped(o.page, id), 'the element after its look changed').toBe('yes');
      await failRead('vans', 'the connection drops')(o.page);
      await o.page.waitForSelector('.bw-van-error .r1-errpanel', { timeout: 15_000 });
      await expect.poll(() => focusedId(o.page)).toBe('CANVAS');
    } finally {
      await close(o);
    }
  });

  // why: NFR-06, UI-SPECIFICATION 14 item 1, F-813, F-1745 the same under Both: a job marker keeps focus while a van's reads redraw the map
  it('keeps focus on a job marker under Both across 2 reads', async () => {
    const o = await open(browser, 'keisha');
    try {
      await mapReady(o.page);
      expect(otherNineFortyFiveRan, 'no other 9:45 AM test spent demo minutes before this moving-van check').toBe(0);
      expect(minutes(await demoNow()), 'this engine\'s moving-van check starts by 9:50 AM').toBeLessThanOrEqual(minutes(MOVING_BY));
      const van = await movingVan();
      expect(van, 'a van moving at 9:45 AM').toBeDefined();
      await o.page.locator('[data-ctl="CTL-OFC-02-24"] [role="radio"]', { hasText: 'Both' }).click();
      await o.page.waitForSelector('[data-marker-kind="job"]', { state: 'attached' });
      const id = (await o.page.locator('[data-marker-kind="job"]').first().getAttribute('data-marker-id'))!;
      await holdsFocusAcrossReads(o.page, id, van);
    } finally {
      await close(o);
    }
  });
});

describe.each(engines)('the map panel at 9:45 AM on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
    await clockAt(NINE_45);
  }, 180_000);
  afterEach(() => {
    otherNineFortyFiveRan += 1;
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: NFR-06, UI-SPECIFICATION 14 item 1, F-813 under Jobs no van moves, so it is a job's own change that redraws: a real reassignment changes the focused marker's look, and focus stays on its id
  it('keeps focus on a job marker under Jobs when its look changes', async () => {
    const o = await open(browser, 'keisha');
    // A midday job: nothing runs it during the test, and its row is back before the afternoon does.
    const job = allJobs(await board()).find((j) => j.status === 'scheduled' && j.technicianId && hourOf(j.window.start) === 12);
    const assign = async (to: string | null) => {
      const now = allJobs(await board()).find((j) => j.jobNumber === job.jobNumber);
      const r = await api('keisha', 'POST', `/jobs/${job.jobNumber}/assignment`, { technicianId: to, baseVersion: now.version });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    try {
      await mapReady(o.page);
      await o.page.locator('[data-ctl="CTL-OFC-02-24"] [role="radio"]', { hasText: 'Jobs' }).click();
      const id = `job-${job.jobNumber}`;
      const marker = o.page.locator(`[data-marker-id="${id}"]`);
      await marker.waitFor({ state: 'attached' });
      await marker.focus();
      await stamp(o.page, id);
      const look = await marker.locator('svg').getAttribute('class');
      await assign(null);
      await expect.poll(() => marker.locator('svg').getAttribute('class'), { timeout: 15_000 }).not.toBe(look);
      expect(await focusedId(o.page)).toBe(id);
      expect(await stamped(o.page, id)).toBe('yes');
    } finally {
      await assign(job.technicianId);
      await close(o);
    }
  });

  // why: FR-MAP-1 F-363: the board map renders from the app's own files with the outside-origin guard on, and 0 outside requests
  it('renders the board map with 0 outside requests', async () => {
    const o = await open(browser, 'keisha');
    try {
      await mapReady(o.page);
      expect(Number(await o.page.locator('[data-cmp="CMP-05"]').getAttribute('data-map-features'))).toBeGreaterThan(0);
      expect(o.g.outside).toEqual([]);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-3, FR-DISP-22 at 9:45 AM the autopilot's van is on the way, and each tab's count equals an API count
  it('shows the autopilot\'s van on the way and the tab counts equal an API count', async () => {
    const o = await open(browser, 'keisha');
    try {
      await mapReady(o.page);
      const way = (await vans()).find((v) => v.status === 'on_the_way');
      expect(way, 'a van on the way at 9:45 AM').toBeDefined();
      await expect.poll(() => o.page.locator(`[data-marker-id="van-${way.technicianId}"]`).getAttribute('aria-label')).toMatch(/^Van, .*(on the way|late) to /);
      const b = await board();
      const jobs = allJobs(b);
      const want = { all: jobs.length, onTheWay: jobs.filter((j) => j.status === 'on_the_way').length, onSite: jobs.filter((j) => j.status === 'on_site').length };
      expect(await tabCount(o.page, 1)).toBe(want.all);
      expect(await tabCount(o.page, 3)).toBe(want.onTheWay);
      expect(await tabCount(o.page, 4)).toBe(want.onSite);
      expect(want.onTheWay).toBeGreaterThan(0);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-18 Hide map gives the timeline the board's full width, the choice stays through a reload, and Show map brings the van positions back
  it('hides the panel so the timeline takes the full width, keeps the choice, and shows it again', async () => {
    const o = await open(browser, 'keisha');
    const hide = () => o.page.click('.mapp [data-ctl="CTL-OFC-02-22"]');
    const widths = () => o.page.evaluate(() => {
      const d = (globalThis as unknown as { document: { querySelector(s: string): { getBoundingClientRect(): { width: number } } | null } }).document;
      return { work: d.querySelector('.work')?.getBoundingClientRect().width ?? 0, board: d.querySelector('.boardp')?.getBoundingClientRect().width ?? 0, timeline: d.querySelector('#tl')?.getBoundingClientRect().width ?? 0 };
    });
    try {
      await mapReady(o.page);
      const before = await widths();
      await hide();
      await o.page.waitForSelector('.mapp', { state: 'detached' });
      const after = await widths();
      expect(after.timeline).toBeGreaterThan(before.timeline + 300);
      expect(after.board).toBeCloseTo(after.work - 24, 0); // the frame's 12 px padding on each side
      await o.page.reload({ waitUntil: 'load' });
      await ready(o.page);
      await o.page.waitForSelector('.boardp [data-ctl="CTL-OFC-02-22"]');
      expect(await o.page.locator('.mapp').count()).toBe(0);
      await o.page.click('.boardp [data-ctl="CTL-OFC-02-22"]');
      await mapReady(o.page);
      const live = (await vans()).filter((v) => v.position !== null).length;
      await expect.poll(() => o.page.locator('[data-marker-kind="van"]').count()).toBe(live);
    } finally {
      await close(o);
    }
  });

  // why: F-817 (SPECIFICATIONS 7.4 API-21) the board sends a van's route line once: its first read names no line and gets the track, the next names the key and gets track null, and a changed line comes back whole under its new key
  it('sends a van\'s route line once, not again while it is unchanged, and again when it changes', async () => {
    const reads: { have: string | null; vans: Json[] }[] = [];
    const o = await open(browser, 'keisha', 'en', '/office/board?branch=columbus&date=today', async (p) => {
      p.on('response', async (r) => {
        if (!/\/api\/v1\/vans\?/.test(r.url()) || r.status() !== 200) return;
        try {
          reads.push({ have: new URL(r.url()).searchParams.get('have'), vans: ((await r.json()) as Json).data.vans });
        } catch {
          // the page closed under the read
        }
      });
    });
    let restore: (() => void) | null = null;
    try {
      await mapReady(o.page);
      await expect.poll(() => reads.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
      expect(reads[0]!.have, 'the first read names no line').toBeNull();
      const van = reads[0]!.vans.find((v) => v.route?.key);
      expect(van, 'a van on the way on a road at 9:45 AM').toBeDefined();
      const key = van.route.key as string;
      expect(van.route.track.length).toBeGreaterThan(1);
      const lineOf = (r: { vans: Json[] }) => r.vans.find((v) => v.technicianId === van.technicianId)?.route;
      // Unchanged: the next read names the key and the answer leaves the track out.
      expect(reads[1]!.have?.split(',')).toContain(key);
      expect(lineOf(reads[1]!)).toEqual({ ...van.route, track: null });
      // Changed: the leg's stored track gets a new first point (1 m north), so its line and its key change.
      const rows: Json[] = JSON.parse(psql(`SELECT json_agg(json_build_object('from', from_ref, 'polyline', polyline)) FROM world.van_track WHERE branch_id = 'columbus' AND to_ref = '${van.jobNumber}'`));
      const row = rows.find((r) => lineKey(r.polyline) === key);
      expect(row, 'the van_track row of the line').toBeDefined();
      const coords = decodePolyline(row.polyline);
      coords[0] = [coords[0]![0], Math.round((coords[0]![1] + 0.00001) * 1e5) / 1e5];
      const moved = encodePolyline(coords);
      expect(lineKey(moved)).not.toBe(key);
      const where = `branch_id = 'columbus' AND from_ref = '${row.from}' AND to_ref = '${van.jobNumber}'`;
      const n = reads.length;
      psql(`UPDATE world.van_track SET polyline = '${moved}' WHERE ${where}`);
      restore = () => psql(`UPDATE world.van_track SET polyline = '${row.polyline}' WHERE ${where}`);
      const changedAt = () => reads.findIndex((r, i) => i >= n && lineOf(r)?.key === lineKey(moved));
      await expect.poll(changedAt, { timeout: 30_000 }).toBeGreaterThanOrEqual(0);
      const m = changedAt();
      expect(reads[m]!.have?.split(','), 'the board still named the old line').toContain(key);
      expect(lineOf(reads[m]!).track).toEqual(decodePolyline(moved));
      // The new line is held in turn: the read after names its key, not the old one, and gets track null.
      await expect.poll(() => reads.length, { timeout: 30_000 }).toBeGreaterThan(m + 1);
      expect(reads[m + 1]!.have?.split(',')).toContain(lineKey(moved));
      expect(reads[m + 1]!.have?.split(',')).not.toContain(key);
      expect(lineOf(reads[m + 1]!)).toEqual({ ...lineOf(reads[m]!), track: null });
    } finally {
      restore?.();
      await close(o);
    }
  });
});

describe.each(engines)('the map panel at 10:30 AM on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
    await clockAt(TEN_THIRTY);
  }, 180_000);
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-DISP-3, FR-DEMO-8 every Columbus van shows a marker where the API computes it, and the job page's panel draws the same point
  it('puts every van with a position at the position API-21 computes, the same the on-the-way panel reads', async () => {
    const o = await open(browser, 'keisha');
    try {
      await mapReady(o.page);
      const list = await vans();
      await expect.poll(() => o.page.locator('[data-marker-kind="van"]').count()).toBe(list.filter((v) => v.position !== null).length);
      const drawn = await o.page.locator('[data-marker-kind="van"]').evaluateAll((els) => els.map((e) => [(e as unknown as { dataset: { markerId: string; markerAt: string } }).dataset.markerId, (e as unknown as { dataset: { markerAt: string } }).dataset.markerAt]));
      const placed = new Map(drawn.map(([id, at]) => [id!.slice(4), (at as string).split(',').map(Number)]));
      for (const v of list.filter((x) => x.position !== null)) {
        const at = placed.get(v.technicianId) as number[];
        expect(at[0], v.name).toBeCloseTo(v.position.lon, 2);
        expect(at[1], v.name).toBeCloseTo(v.position.lat, 2);
      }
      const way = list.find((v) => v.status === 'on_the_way');
      expect(way, 'a van on the way at 10:30 AM').toBeDefined();
      const panel = (await api('keisha', 'GET', `/jobs/${way.jobNumber}/on-the-way`)).body.data;
      const now = (await vans()).find((v) => v.technicianId === way.technicianId);
      expect(panel.van.lon).toBeCloseTo(now.position.lon, 2);
      expect(panel.van.lat).toBeCloseTo(now.position.lat, 2);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-19 the live count is the vans with a position; Jobs is 1 marker per job and no van; Both shows both; the legend names each kind
  it('counts the live vans, switches Vans, Jobs and Both, and the legend names every marker kind', async () => {
    const o = await open(browser, 'keisha');
    const pick = (word: string) => o.page.locator('[data-ctl="CTL-OFC-02-24"] [role="radio"]', { hasText: word }).click();
    const count = (kind: string) => o.page.locator(`[data-marker-kind="${kind}"]`).count();
    try {
      await mapReady(o.page);
      const live = (await vans()).filter((v) => v.position !== null).length;
      const jobs = allJobs(await board()).length;
      expect(await o.page.locator('[data-ctl="CTL-OFC-02-23"]').textContent()).toBe(`${live} vans, live`);
      expect(await o.page.locator('.bw-mkey[data-map-legend="vans"]').textContent()).toBe('On siteOn the wayBetween jobsNext stopLate or at risk'); // F-816
      await pick('Jobs');
      await expect.poll(() => count('job')).toBe(jobs);
      expect(await count('van')).toBe(0);
      expect(await o.page.locator('.bw-mkey[data-map-legend="jobs"]').textContent()).toBe('Scheduled jobOn the way jobOn site jobClosed jobLate jobAt risk jobUnassigned job'); // F-816
      await pick('Both');
      await expect.poll(() => count('van')).toBe(live);
      expect(await count('job')).toBe(jobs);
      expect(await o.page.locator('.bw-mkey').count()).toBe(2);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-21, FR-DISP-22 Maria's van from the vans menu shows her card, with Call Maria and, on a computer, her number; a marker selects a van too
  it('picks Maria in the vans menu: her card, Call Maria and her number from API-21', async () => {
    const o = await open(browser, 'keisha');
    try {
      await mapReady(o.page);
      const maria = (await vans()).find((v) => v.name === 'Maria Santos');
      await o.page.click('[data-ctl="CTL-OFC-02-31"]');
      await o.page.locator('.bw-vans-menu [role="menuitem"]', { hasText: 'Maria Santos' }).click();
      const card = o.page.locator('[data-ctl="CTL-OFC-02-13"]');
      await card.waitFor();
      expect(await card.locator('.top b').textContent()).toBe(`Maria Santos - Van ${maria.van}`);
      expect(await card.locator('.top .s').textContent()).toBe('Heating & cooling');
      const call = card.locator('[data-ctl="CTL-CMP-16-01"]');
      expect((await call.textContent())?.trim()).toBe('Call Maria');
      await call.click();
      await expect.poll(() => card.textContent()).toContain(maria.phone);
      // The marker selects its van, the card follows it, and a van on the way opens its job.
      const way = (await vans()).find((v) => v.status === 'on_the_way' && v.position !== null);
      await o.page.locator(`[data-marker-id="van-${way.technicianId}"]`).dispatchEvent('click');
      await expect.poll(() => card.locator('.top b').textContent()).toContain(way.name);
      expect(await card.locator('.eta').textContent()).toContain('Arriving about');
      expect(await card.locator('[data-ctl="CTL-OFC-02-14"]').getAttribute('href')).toBe(`/office/jobs/${way.jobNumber}`);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-22 each tab's count equals its rows and a count by status; Needs attention keeps the flagged items; a skill leaves only its jobs and vans
  it('lists the jobs under each tab, keeps the flagged items, and the skill filter narrows the list and the map', async () => {
    const o = await open(browser, 'keisha');
    const tab = (n: number) => o.page.locator(`[data-ctl="CTL-OFC-02-28"] [role="tab"]:nth-child(${n})`);
    const rows = () => o.page.locator('[role="tabpanel"] a.jrow').count();
    try {
      await mapReady(o.page);
      const b = await board();
      const flagged = b.needsAttention.flagged.length;
      const att = b.needsAttention.late.length + b.needsAttention.atRisk.length + b.needsAttention.unassigned.length;
      expect(await tabCount(o.page, 2)).toBe(att + flagged);
      expect(await o.page.locator('[role="tabpanel"] [data-ctl="CTL-OFC-02-15"] .row').count()).toBe(att + flagged);
      for (const [n, want] of [[1, allJobs(b).length], [3, allJobs(b).filter((j) => j.status === 'on_the_way').length], [4, allJobs(b).filter((j) => j.status === 'on_site').length]] as const) {
        await tab(n).click();
        await expect.poll(rows).toBe(want);
        expect(await tabCount(o.page, n)).toBe(want);
      }
      await tab(1).click();
      await o.page.selectOption('[data-ctl="CTL-OFC-02-30"] select', 'heating_cooling');
      await o.page.waitForSelector('.bw-skill-note');
      expect(await o.page.locator('.bw-skill-note b').textContent()).toBe('Showing Heating & cooling only');
      const techs = new Set(b.technicians.filter((t: Json) => t.skills.includes('heating_cooling')).map((t: Json) => t.id));
      const jobs = allJobs(b).filter((j) => j.technicianId !== null && techs.has(j.technicianId));
      await expect.poll(rows).toBe(jobs.length);
      const list = (await vans()).filter((v) => v.skills.includes('heating_cooling'));
      await expect.poll(() => o.page.locator('[data-marker-kind="van"]').count()).toBe(list.filter((v) => v.position !== null).length);
      expect(await o.page.locator('[data-ctl="CTL-OFC-02-31"]').textContent()).toBe(`${list.length} vans`);
      await o.page.locator('.bw-skill-note .btn').click();
      await expect.poll(rows).toBe(allJobs(b).length);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-19 a job marker opens the job's popover, as its block does (CTL-OFC-02-26)
  it('opens SCR-OFC-29 from a job marker', async () => {
    const o = await open(browser, 'keisha');
    try {
      await mapReady(o.page);
      await o.page.locator('[data-ctl="CTL-OFC-02-24"] [role="radio"]', { hasText: 'Jobs' }).click();
      const job = allJobs(await board()).find((j) => j.status === 'scheduled');
      await o.page.locator(`[data-marker-id="job-${job.jobNumber}"]`).dispatchEvent('click');
      await expect.poll(() => o.page.locator('.r1-pop').textContent()).toContain(String(job.jobNumber));
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-19, F-1544 the larger map fills the board's width and is taller, keeps every marker and the job marker's popover, zooms in, and comes back by its button and by Escape
  it('opens a larger map, keeps its markers, zooms, and returns with the button and with Escape', async () => {
    const o = await open(browser, 'keisha');
    const p = o.page;
    const box = (sel: string) => p.locator(sel).first().evaluate((e) => {
      const r = (e as unknown as { getBoundingClientRect(): { width: number; height: number } }).getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    const markers = () => p.locator('.mapp [data-marker-id]').count();
    const zoomOf = async () => Number(await p.locator('[data-cmp="CMP-05"]').getAttribute('data-map-zoom'));
    try {
      await mapReady(p);
      await p.locator('[data-ctl="CTL-OFC-02-24"] [role="radio"]', { hasText: 'Both' }).click();
      await expect.poll(() => p.locator('[data-marker-kind="job"]').count()).toBeGreaterThan(0);
      const panelMap = await box('.mapp [data-cmp="CMP-05"]');
      const panelMarkers = await markers();
      const panelJobs = await p.locator('[data-marker-kind="job"]').count();
      await p.click('.mapp [data-ctl="CTL-OFC-02-35"]');
      await p.waitForSelector('.work.maplarge');
      const work = await box('.work');
      await expect.poll(async () => (await box('.mapp [data-cmp="CMP-05"]')).width).toBeGreaterThan((work.width - 24) * 0.8);
      expect((await box('.mapp [data-cmp="CMP-05"]')).height).toBeGreaterThan(panelMap.height + 200);
      expect(await p.locator('.boardp').isVisible()).toBe(false);
      expect(await p.locator('.mapp [data-ctl="CTL-OFC-02-36"]').textContent()).toContain('Smaller map');
      expect(await p.evaluate(() => (globalThis as unknown as { document: { activeElement: { dataset: { largeToggle?: string } } } }).document.activeElement.dataset.largeToggle)).toBeDefined();
      // the same markers, the toggle, the legend and the skill filter stay
      await expect.poll(markers).toBe(panelMarkers);
      expect(await p.locator('[data-marker-kind="job"]').count()).toBe(panelJobs);
      expect(await p.locator('[data-marker-kind="van"]').count()).toBeGreaterThan(0);
      expect(await p.locator('.mapp [data-ctl="CTL-OFC-02-24"]').count()).toBe(1);
      expect(await p.locator('.mapp [data-ctl="CTL-OFC-02-25"]').count()).toBeGreaterThan(0);
      expect(await p.locator('.mapp [data-ctl="CTL-OFC-02-30"]').count()).toBeGreaterThan(0);
      // zoom in changes the map's scale
      await expect.poll(zoomOf).toBeGreaterThan(0);
      const before = await zoomOf();
      await p.click('.mapp [data-ctl="CTL-CMP-05-02"]');
      await expect.poll(zoomOf).toBeGreaterThan(before + 0.5);
      // a job marker opens the popover as in the panel
      const job = allJobs(await board()).find((j) => j.status === 'scheduled');
      await p.locator(`[data-marker-id="job-${job.jobNumber}"]`).dispatchEvent('click');
      await expect.poll(() => p.locator('.r1-pop').textContent()).toContain(String(job.jobNumber));
      await p.keyboard.press('Escape'); // closes the popover, and the larger map stays
      await expect.poll(() => p.locator('.r1-pop').count()).toBe(0);
      expect(await p.locator('.work.maplarge').count()).toBe(1);
      // the button returns to the board
      await p.click('.mapp [data-ctl="CTL-OFC-02-36"]');
      await p.waitForSelector('.work.maplarge', { state: 'detached' });
      expect(await p.locator('.boardp').isVisible()).toBe(true);
      expect(await p.locator('#tl').isVisible()).toBe(true);
      await expect.poll(async () => (await box('.mapp [data-cmp="CMP-05"]')).height).toBeCloseTo(panelMap.height, 0);
      await expect.poll(markers).toBe(panelMarkers);
      // and Escape does too
      await p.click('.mapp [data-ctl="CTL-OFC-02-35"]');
      await p.waitForSelector('.work.maplarge');
      await p.keyboard.press('Escape');
      await p.waitForSelector('.work.maplarge', { state: 'detached' });
      expect(await p.locator('#tl').isVisible()).toBe(true);
      expect(await p.locator('.mapp [data-ctl="CTL-OFC-02-35"]').evaluate((e) => e === (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement)).toBe(true);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-3, SD-47 positions are computed on read, so the panel asks again every 10 s, and a failed read leaves the timeline working (Partial)
  it('re-reads the vans every 10 s, and a failed read hides the markers, says so and leaves the timeline', async () => {
    const o = await open(browser, 'keisha');
    let reads = 0;
    o.page.on('request', (r) => {
      if (/\/api\/v1\/vans\?/.test(r.url())) reads++;
    });
    try {
      await mapReady(o.page);
      await expect.poll(() => reads, { timeout: 25_000 }).toBeGreaterThanOrEqual(2);
      await o.page.route('**/api/v1/vans?*', (r) => r.fulfill({ status: 500, contentType: 'application/problem+json', body: '{}' }));
      await o.page.waitForSelector('.r1-errpanel', { timeout: 15_000 });
      expect(await o.page.locator('.r1-errpanel').textContent()).toContain('Van positions could not load.');
      expect(await o.page.locator('[data-marker-kind="van"]').count()).toBe(0);
      expect(await liveCount(o.page).count()).toBe(0);
      expect(await o.page.locator('.tl-row button.job').count()).toBeGreaterThan(0);
      await o.page.unroute('**/api/v1/vans?*');
      await o.page.locator('.r1-errpanel button').click();
      await expect.poll(() => o.page.locator('[data-marker-kind="van"]').count()).toBeGreaterThan(0);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-19, SCR-OFC-02 Partial, F-812 API-20 fails and the van region works: its read runs and its numbers are true, the list region shows CMP-12, and no tab prints a number no read gave
  it.each(FAILURES)('with the board read failed (%s), reads the vans and prints no job count', async (how) => {
    const o = await open(browser, 'keisha', 'en', undefined, failRead('board', how));
    try {
      await o.page.waitForSelector('.mapp [role="tabpanel"] .r1-errpanel', { timeout: 30_000 });
      await o.page.waitForSelector('[data-marker-kind="van"]', { state: 'attached', timeout: 30_000 });
      expect(await o.page.locator('.mapp [role="tabpanel"] .r1-errpanel').textContent()).toContain('The board could not load.');
      const list = await vans();
      const live = list.filter((v) => v.position !== null);
      expect(live.length).toBeGreaterThan(0);
      await expect.poll(() => liveCount(o.page).textContent()).toBe(`${live.length} vans, live`);
      expect(await vansButton(o.page).textContent()).toBe(`${list.length} vans`);
      await expect.poll(() => vanMarkers(o.page)).toBe(live.length);
      const way = list.find((v) => v.status === 'on_the_way');
      if (way) expect(await o.page.locator(`[data-marker-id="van-${way.technicianId}"]`).getAttribute('aria-label')).toBe(`Van, ${way.name}, on the way ${way.initials}`);
      expect((await tabWords(o.page)).join(' ')).not.toMatch(/\d/);
      await o.page.unroute(`${origin}/api/v1/board?*`);
      await o.page.locator('.mapp [role="tabpanel"] .r1-errpanel button').click();
      await ready(o.page);
      await expect.poll(() => tabCount(o.page, 1)).toBe(allJobs(await board()).length);
      expect(await o.page.locator('.mapp .r1-errpanel').count()).toBe(0);
    } finally {
      await close(o);
    }
  });

  // why: F-833, UI-SPECIFICATION Error state (a read fails: CMP-12 in place of the region): a refused re-read never leaves an old board on the page with no sign of it
  it('swaps the old board for the error panel when a re-read is refused, and Try again brings it back', async () => {
    const o = await open(browser, 'keisha');
    let block: string | undefined;
    try {
      await ready(o.page);
      await failRead('board', 'the server answers 404')(o.page);
      // A real block.changed reaches the page and sets off the re-read, which the real server refuses.
      const technician = (await board()).technicians[0].id as string;
      const made = await api('keisha', 'POST', '/time-blocks', { technicianId: technician, date: '2026-09-18', label: 'Supply run', place: 'Supply house', start: hhmm(8), end: hhmm(8.5) });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      block = (made.body.data.block ?? made.body.data).blockId as string;
      await o.page.waitForSelector('[data-screen="SCR-OFC-02"] .r1-errpanel', { timeout: 30_000 });
      expect(await o.page.locator('.tl-row button.job').count()).toBe(0);
      await o.page.unroute(`${origin}/api/v1/board?*`);
      await o.page.locator('[data-screen="SCR-OFC-02"] .r1-errpanel button').first().click();
      await ready(o.page);
    } finally {
      await close(o);
      if (block) await api('keisha', 'DELETE', `/time-blocks/${block}`);
    }
  });

  // why: F-789, NFR-06 (Spanish at 800 px: the top bar's last control stays inside the window and its words inside it)
  it('keeps the user button inside an 800 px window in Spanish', async () => {
    const o = await open(browser, 'keisha', 'es');
    try {
      await ready(o.page);
      await o.page.setViewportSize({ width: 800, height: 900 });
      // F-861: the bar fits itself in script (a ResizeObserver resets the overflow count, a layout effect moves 1 link into More per render),
      // so 1 read right after the resize can see the wide layout. Read the 3 values until they fit, up to 30 s.
      const read = () => o.page.locator('.topbar .user').evaluate((el) => {
        const e = el as unknown as { getBoundingClientRect(): { right: number }; scrollWidth: number; clientWidth: number };
        const w = globalThis as Json;
        return { right: e.getBoundingClientRect().right, inner: e.scrollWidth - e.clientWidth, width: w.innerWidth, page: w.document.documentElement.scrollWidth };
      });
      await expect.poll(async () => { const f = await read(); return f.right <= f.width && f.inner <= 0 && f.page <= f.width; }, { timeout: 30_000 }).toBe(true);
      const fit = await read();
      expect(fit.right).toBeLessThanOrEqual(fit.width);
      expect(fit.inner).toBeLessThanOrEqual(0);
      expect(fit.page).toBeLessThanOrEqual(fit.width);
    } finally {
      await close(o);
    }
  });

  // why: F-839, NFR-06, the F-813 class (a failed 10 s read hands focus on, it does not drop it): an item's focus goes to the menu's own button, and the button keeps it
  it('keeps keyboard focus on the Vans menu button when a van read fails with the menu open', async () => {
    const o = await open(browser, 'keisha');
    try {
      await mapReady(o.page);
      await vansButton(o.page).focus();
      await o.page.keyboard.press('Enter');
      await o.page.locator('.bw-vans-menu button').first().focus();
      await failRead('vans', 'the connection drops')(o.page);
      await o.page.waitForSelector('.mapp .bw-van-error .r1-errpanel', { timeout: 20_000 });
      await expect.poll(() => o.page.locator('.bw-vans-menu').count()).toBe(0);
      expect(await o.page.evaluate(() => (globalThis as Json).document.activeElement?.dataset?.ctl)).toBe('CTL-OFC-02-31');
      expect(await vansButton(o.page).getAttribute('aria-disabled')).toBe('true');
      await o.page.keyboard.press('Enter'); // a button with nothing to list opens nothing
      expect(await o.page.locator('.bw-vans-menu').count()).toBe(0);
    } finally {
      await close(o);
    }
  });

  // why: F-838, CTL-OFC-02-13, CTL-OFC-02-14 (API-21 holds the van's job and arrival: another day's board, which does not hold that job, still prints them)
  it('prints Open job and the arrival on the van card when the shown board does not hold the van\'s job', async () => {
    const list = await vans();
    const way = list.find((v) => v.status === 'on_the_way' && v.jobNumber !== null && v.eta !== null);
    expect(way, 'a van on the way at this time').toBeDefined();
    const o = await open(browser, 'keisha', 'en', '/office/board?branch=columbus&date=2026-09-18');
    try {
      await mapReady(o.page);
      await vansButton(o.page).click();
      await o.page.locator('.bw-vans-menu button', { hasText: way.name }).click();
      const card = o.page.locator('.vancard');
      await expect.poll(() => card.locator('[data-ctl="CTL-OFC-02-14"]').getAttribute('href')).toBe(`/office/jobs/${way.jobNumber}`);
      expect(await card.locator('.eta').textContent()).toMatch(/\d:\d\d [AP]M/);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-19, SCR-OFC-02 Partial, F-812 API-21 fails and the list works: the error region stands alone, with no van count or live word above it, and the job counts stay true
  it.each(FAILURES)('with the van read failed (%s), prints no van count and keeps the job list', async (how) => {
    const o = await open(browser, 'keisha', 'en', undefined, failRead('vans', how));
    try {
      await ready(o.page);
      await o.page.waitForSelector('.mapp .bw-van-error .r1-errpanel', { timeout: 30_000 });
      expect(await liveCount(o.page).count()).toBe(0);
      expect(await vansButton(o.page).textContent()).toBe('Vans');
      expect(await vansButton(o.page).isDisabled()).toBe(true);
      expect(await o.page.locator('.mapp').textContent()).not.toMatch(/, live|\d+ vans?\b/);
      expect(await vanMarkers(o.page)).toBe(0);
      await expect.poll(() => tabCount(o.page, 1)).toBe(allJobs(await board()).length);
      await o.page.unroute(`${origin}/api/v1/vans?*`);
      await o.page.locator('.mapp .bw-van-error .r1-errpanel button').click();
      await expect.poll(() => liveCount(o.page).textContent()).toMatch(/^[1-9]\d* vans?, live$/);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-19, CTL-OFC-02-23, CTL-OFC-02-31, F-812 the count, the menu and the markers are the vans at the demo time, whatever day the board shows, and a 10 s read keeps running
  it.each(['2026-09-16', '2026-09-14'])('on %s counts the vans live at the demo time and lists them in the menu', async (date) => {
    let reads = 0;
    const o = await open(browser, 'keisha', 'en', `/office/board?branch=columbus&date=${date}`, async (p) => {
      p.on('response', (r) => {
        if (/\/api\/v1\/vans\?/.test(r.url()) && r.status() === 200) reads++;
      });
    });
    try {
      await mapReady(o.page);
      const list = await vans();
      const live = list.filter((v) => v.position !== null).length;
      expect(live).toBeGreaterThan(0);
      await expect.poll(() => liveCount(o.page).textContent()).toBe(`${live} vans, live`);
      await expect.poll(() => vanMarkers(o.page)).toBe(live);
      expect(await vansButton(o.page).textContent()).toBe(`${list.length} vans`);
      await vansButton(o.page).click();
      expect(await o.page.locator('.bw-vans-menu [role="menuitem"]').count()).toBe(list.length);
      const shown = (await api('keisha', 'GET', `/board?branch=columbus&date=${date}`)).body.data;
      expect(await tabCount(o.page, 1)).toBe(allJobs(shown).length);
      await expect.poll(() => reads, { timeout: 25_000 }).toBeGreaterThanOrEqual(2);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-3 the panel's words are Spanish on a Spanish page, and the built app's scripts run under the page's policy with no console error (F-437)
  it('reads the panel in Spanish, with no policy error from the built app', async () => {
    const o = await open(browser, 'keisha', 'es');
    const errors: string[] = [];
    // F-437's error is an eval refused to a script. WebKit itself logs a refused stylesheet for each bare select under this policy
    // (measured on a page of 1 select), which no page code causes, and the listeners go on after the first load so no canceled read counts.
    await o.page.goto('about:blank');
    o.page.on('console', (m) => {
      if (m.type() === 'error' && /unsafe-eval|EvalError/i.test(m.text())) errors.push(m.text());
    });
    o.page.on('pageerror', (e) => errors.push(e.message));
    try {
      await o.page.goto(`${origin}/office/board?branch=columbus&date=today`, { waitUntil: 'load' });
      await mapReady(o.page);
      expect(await o.page.locator('.mapp .ph h2').textContent()).toBe('Mapa');
      expect(await o.page.locator('.mapp [data-ctl="CTL-OFC-02-22"]').textContent()).toBe('Ocultar mapa');
      expect(await o.page.locator('[data-ctl="CTL-OFC-02-23"]').textContent()).toMatch(/camionetas, en vivo$/);
      expect(await o.page.locator('canvas.maplibregl-canvas').getAttribute('aria-label')).toBe('Mapa');
      await expect.poll(() => o.page.locator('[data-marker-kind="van"]').first().getAttribute('aria-label')).toMatch(/^Camioneta, /);
      expect(errors).toEqual([]);
    } finally {
      await close(o);
    }
  });
});

// The late and at-risk words of the afternoon.
describe.each(engines)('the day board at 2:00 PM on the Compose stack, %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // why: FR-DISP-4, FR-DISP-14
  it('at 2:00 PM names every late and at-risk job by its word, shows the 6 legend words, and says On site and Done, never Arrived or Finished', async () => {
    await clockAt('2026-09-15T14:00:00-04:00[America/New_York]');
    const b = await board();
    const o = await open(browser, 'keisha');
    try {
      await ready(o.page);
      const legend = (await o.page.locator('[data-ctl="CTL-OFC-02-17"]').textContent()) ?? '';
      for (const w of ['Scheduled', 'On the way', 'On site', 'Done', 'At risk', 'Late']) expect(legend).toContain(w);
      const flagged = allJobs(b).filter((j) => j.timing === 'late' || j.timing === 'atRisk');
      expect(flagged.length).toBeGreaterThan(0);
      for (const j of flagged) {
        const word = j.timing === 'late' ? 'Late' : 'At risk';
        await expect(o.page.locator(`#jd${j.jobNumber}`).textContent()).resolves.toContain(word);
        if (j.status !== 'on_site') await expect(o.page.locator(`button[data-job="${j.jobNumber}"] .tag`).textContent()).resolves.toBe(word);
      }
      const site = allJobs(b).find((j) => j.status === 'on_site');
      expect(site, 'a job On site at 2:00 PM (FR-DISP-14)').toBeDefined();
      await expect(o.page.locator(`button[data-job="${site!.jobNumber}"]`).textContent()).resolves.toContain('On site');
      const done = allJobs(b).find((j) => j.status === 'done');
      expect(done, 'a Done job at 2:00 PM (FR-DISP-14)').toBeDefined();
      await expect(o.page.locator(`button[data-job="${done!.jobNumber}"]`).textContent()).resolves.toContain('Done');
      const text = (await o.page.locator('[data-screen="SCR-OFC-02"] .work').textContent()) ?? '';
      expect(text).not.toMatch(/\bArrived\b|\bFinished\b/);
    } finally {
      await close(o);
    }
  });

  // why: FR-DISP-17
  it('drags a late job over Kevin Doyle without dropping: his row is the drop target, the preview names him and the server\'s estimate, and releasing outside any row moves nothing', async () => {
    await clockAt('2026-09-15T14:00:00-04:00[America/New_York]');
    const b = await board();
    const kevin = b.technicians.find((t: Json) => t.name === 'Kevin Doyle');
    const o = await open(browser, 'keisha');
    let late: Json;
    try {
      await ready(o.page);
      // A late job (else a scheduled one) whose block is the topmost element at its own center, so a press there takes it.
      const onTop = async (j: Json) => o.page.locator(`button[data-job="${j.jobNumber}"]`).evaluate((el) => {
        const r = el.getBoundingClientRect();
        const d = (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { closest(s: string): unknown } | null } }).document;
        return r.width > 8 && d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button[data-job]') === el;
      });
      const pool = [...allJobs(b).filter((j) => j.timing === 'late' && j.status !== 'done'), ...allJobs(b).filter((j) => j.status === 'scheduled')]
        .filter((j) => j.technicianId && j.technicianId !== kevin.id);
      for (const j of pool) if (await onTop(j)) { late = j; break; }
      expect(late, 'a job to drag').toBeDefined();
      const estimate = (await api('keisha', 'POST', `/jobs/${late.jobNumber}/assignment-preview`, { technicianId: kevin.id })).body.data;
      await dragOver(o.page, `button[data-job="${late.jobNumber}"]`, await laneAt(o.page, kevin.id, 12));
      await o.page.waitForSelector(`[data-row="${kevin.id}"] .drop-target`);
      const tip = o.page.locator('[data-ctl="CTL-OFC-02-21"]');
      await expect.poll(async () => tip.textContent(), { timeout: 10_000 }).toContain(`arrives about ${timeText(estimate.arrivesAbout)}`);
      const said = (await tip.textContent()) ?? '';
      expect(said).toContain('Move to Kevin Doyle');
      expect(said).toMatch(estimate.insideWindow ? /On time, inside the .* window/ : /Late, after the .* window/);
      const away = (await o.page.locator('.sumbar').boundingBox())!;
      await o.page.mouse.move(away.x + 40, away.y + 10, { steps: 4 });
      await o.page.mouse.up();
    } finally {
      await close(o);
    }
    const after = allJobs(await board()).find((j) => j.jobNumber === late.jobNumber);
    expect([after.technicianId, after.version]).toEqual([late.technicianId, late.version]);
  });
});

// The clock's last moves: past the shift end (5:30 PM on Columbus, 6:00 PM on the latest), where the chained week still has vans out.
// Since the Jobs page story (dcc50303, F-1733) that is Luis Ortega's last visit, 24839: on the way from 5:40 PM, past Columbus's shift
// end, and on site from 5:55 PM to 7:19 PM, past every shift; the jobs that were out at 5:55 and 6:05 PM before (24840 to 24843) are
// the page's Unassigned jobs or now end before 5:30 PM. So 5:45 PM reads a van on the way and 6:05 PM a van on site.
// The clock only moves forward and 2 engines read 1 clock, so each time is 1 case that opens both engines.
describe('the vans past the shift end on the Compose stack', () => {
  // why: FR-DEMO-8, FR-DISP-3, FR-DISP-19, F-811 at 5:45 PM and 6:05 PM every van at work has a position, API-21 and API-135 answer 1 point, the board draws it, and the panel counts it
  it.each([
    ['5:45 PM', '2026-09-15T17:45:00-04:00[America/New_York]', 'on_the_way', false],
    ['6:05 PM', '2026-09-15T18:05:00-04:00[America/New_York]', 'on_site', true],
  ])('at %s the board and the on-the-way panel read 1 van', async (label, when, outStatus, pastEveryShift) => {
    await clockAt(when);
    const b = await board();
    const atWork = allJobs(b).filter((j) => j.status === 'on_the_way' || j.status === 'on_site');
    expect(atWork.filter((j) => j.status === outStatus).length, `a job ${outStatus}`).toBeGreaterThan(0);
    process.stdout.write(`board-stack: ${label}: on the way ${atWork.filter((j) => j.status === 'on_the_way').map((j) => j.jobNumber).join(' ')}; on site ${atWork.filter((j) => j.status === 'on_site').map((j) => j.jobNumber).join(' ')}; vans with a position ${(await vans()).filter((v) => v.position !== null).length}\n`);
    for (const j of atWork) {
      const v = (await vans()).find((x) => x.jobNumber === j.jobNumber);
      expect(v, `the van of job ${j.jobNumber}`).toBeDefined();
      const answer = await api('keisha', 'GET', `/jobs/${j.jobNumber}/on-the-way`);
      if (j.status === 'on_site') {
        expect(v.position, `on site, job ${j.jobNumber}`).toEqual(j.position);
        // F-868 (UI-SPECIFICATION 12.2 API-135): after arrival the answer is 410 with no coordinates.
        expect(answer.status, 'the on-the-way panel is gone from arrival on').toBe(410);
        expect(JSON.stringify(answer.body), 'no coordinates after arrival').not.toMatch(/"lon"|"lat"/);
        continue;
      }
      const panel = answer.body.data;
      expect(v.position, `on the way, job ${j.jobNumber}`).not.toBeNull();
      expect(panel.van.lon).toBeCloseTo(v.position.lon, 3);
      expect(panel.van.lat).toBeCloseTo(v.position.lat, 3);
    }
    if (pastEveryShift) {
      for (const v of await vans()) {
        const left = allJobs(b).filter((j) => j.technicianId === v.technicianId && ['scheduled', 'on_the_way', 'on_site'].includes(j.status));
        expect(v.position !== null, `${v.name}: drawn only with a job left, ${left.length} left`).toBe(left.length > 0);
      }
    }
    for (const [, type] of engines) {
      const browser = await type.launch({ headless: true });
      const o = await open(browser, 'keisha');
      try {
        await mapReady(o.page);
        const list = await vans();
        const live = list.filter((v) => v.position !== null);
        expect(live.length).toBeGreaterThanOrEqual(atWork.length);
        await expect.poll(() => liveCount(o.page).textContent()).toBe(`${live.length} ${live.length === 1 ? 'van' : 'vans'}, live`);
        await expect.poll(() => vanMarkers(o.page)).toBe(live.length);
        for (const v of live) {
          const at = (await o.page.locator(`[data-marker-id="van-${v.technicianId}"]`).getAttribute('data-marker-at'))!.split(',').map(Number);
          expect(at[0], v.name).toBeCloseTo(v.position.lon, 2);
          expect(at[1], v.name).toBeCloseTo(v.position.lat, 2);
        }
      } finally {
        await close(o);
        await browser.close();
      }
    }
  });
});
