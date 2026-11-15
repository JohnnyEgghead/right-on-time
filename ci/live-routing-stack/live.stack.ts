// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-MAP-3, FR-TECH-5, FR-TECH-11, FR-TECH-13, FR-DEMO-8, NFR-12 (P6-LIVE-ROUTING Acceptance: integration tests against the Compose stack with routing up)
// SD-49's route source (SPECIFICATIONS v0.13 SD-49, SD-15, SD-22, SD-12; owner ruling a923acaa, Nov 9, 2026, "Add live routing"; F-1255) against
// the Compose stack at its default settings, the routing service up (osrm-routed over the release routing files), set up by the setup service (the
// seeded world from the real map folder, the clock at Tue, Sep 15, 7:00 AM), through its proxy, as the office, the manager and the technicians
// (ci/live-routing-stack/fixture.sql). Every answer is read through the real kernel and handlers; psql only reads rows, holds the clock, and stages
// a condition (a deleted baked row, an On my way time in the past) that the path under test then meets:
//   1. the live client is the bake: a baked pair routed live is stored as the row the bake wrote (1 OSRM run, 1 mapping);
//   2. a new online booking (API-113) whose legs are outside the baked set: API-104's routed line and steps, and the planned arrival of its
//      assignment, from 1 stored live row; at the end, API-163 on its day answers the same minutes and line from it;
//   3. with routing stopped the leg answers approximate with no steps and nothing is stored, and once it runs the next read routes it;
//   4. 2 concurrent readers of 1 new pair store exactly 1 row;
//   5. a stalled service answers approximate within the 3 s budget plus the read's own time, and a write that needs a live leg holds its
//      locks that long at most (measured);
//   6. changing a job's customer point deletes that job's rows; on its live leg a van on the way has the same position on the board (API-21)
//      and on the live map (API-116), the point along the live track, and no position table exists (FR-DEMO-8); the live map page draws with
//      the outside-origin guard recording no outside request, on both engines;
//   7. nginx has no route to the routing service and it has no published port;
//   8. a world reset drops every live row and keeps every baked row.
// Run by ci/live-routing-stack.sh, which exports the stack's Compose settings so this file can stop, pause and start the routing service.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { techRoute } from '../../packages/api/src/contracts/tech-route.ts';
import { pointAlongTrack } from '../../packages/maps/src/position.ts';
import { osrmRouteUrl } from '../../packages/maps/src/route-source.ts';
import type { TrackStep } from '../../packages/maps/src/steps.ts';
import { decodePolyline } from '../../packages/maps/src/tracks.ts';
import { Temporal, toWire } from '../../packages/time/src/index.ts';
import { guardedContext } from '../page-walkers/origin-guard.ts';
import { engines } from '../pw-engines.ts';

const base = process.env.BW_LR_STACK_URL;
const db = process.env.BW_LR_DB_CONTAINER;
const project = process.env.BW_LR_PROJECT;
const techSeed = process.env.BW_LR_TECHSEED;
const people = { keisha: process.env.BW_LR_KEISHA, dana: process.env.BW_LR_DANA };
if (!base || !db || !project || !techSeed || Object.values(people).some((v) => !v)) {
  throw new Error('BW_LR_STACK_URL, _DB_CONTAINER, _PROJECT, _TECHSEED and the session tokens are not set: run ci/live-routing-stack.sh');
}
const origin = new URL(base).origin;
const APP_ORIGIN = 'http://localhost:8080';
const ZONE = 'America/New_York';
const TODAY = '2026-09-15';
const BOOK_DAY = '2026-09-16';
const TEN_TWENTY_SIX = '2026-09-15T10:26:00-04:00[America/New_York]';
/** SD-49: the live budget (LIVE_ROUTE_BUDGET_MS). */
const BUDGET_MS = 3_000;
/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}
const json = <T = Json>(sql: string): T => JSON.parse(psql(sql) || 'null') as T;
/** docker compose on the suite's own project, with the stack's settings the script exported. */
function compose(args: string[]): { status: number | null; out: string } {
  const r = spawnSync('docker', ['compose', '-p', project!, '-f', 'infra/compose.yaml', ...args], { encoding: 'utf8', env: process.env, timeout: 180_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const routingContainer = (): string => compose(['ps', '-aq', 'routing']).out.trim();

const techToken = (userId: string) => createHash('sha256').update(`${techSeed}${userId}`).digest('base64url');
async function call(token: string | null, method: string, p: string, body?: unknown): Promise<{ status: number; body: Json; ms: number }> {
  const t0 = performance.now();
  const r = await fetch(`${origin}/api/v1${p}`, {
    method,
    headers: { ...(token ? { cookie: `bw_session=${token}` } : {}), ...(method === 'GET' ? {} : { origin: APP_ORIGIN, 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, ms: performance.now() - t0 };
}
const api = (who: keyof typeof people, method: string, p: string, body?: unknown) => call(people[who]!, method, p, body);
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
const measured = (line: string): void => {
  if (process.env.BW_LR_MEASURE_FILE) appendFileSync(process.env.BW_LR_MEASURE_FILE, `live-routing-stack: ${line}\n`);
};

async function jumpTo(to: string): Promise<void> {
  for (let i = 0; ; i += 1) {
    const r = await api('dana', 'POST', '/clock/jumps', { to });
    if (r.status === 202) break;
    if (r.status !== 409 || i > 240) expect(r.status, JSON.stringify(r.body)).toBe(202);
    await sleep(500);
  }
  await until('the clock to reach the target', async () => (await api('dana', 'GET', '/clock')).body, (b) => !b.data.replay?.running && ms(b.data.demoNow) >= ms(to) - 1_000);
}
async function pauseClock(): Promise<string> {
  const r = await api('dana', 'PUT', '/clock/paused', { paused: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (await until('the clock to be paused', async () => (await api('dana', 'GET', '/clock')).body, (b) => b.data.paused === true)).data.demoNow;
}
/** Hold the demo clock at `iso`, paused (ci/newjob-stack's holdClockAt): the day's reads then answer for that day. */
async function holdClockAt(iso: string): Promise<void> {
  psql(`UPDATE system.demo_clock SET demo_anchor = '${iso}', real_anchor = now(), paused = true WHERE id = 1`);
  await until(`the clock to read ${iso}`, async () => (await api('dana', 'GET', '/clock')).body.data, (d) => Math.abs(ms(d.demoNow) - Date.parse(iso)) < 1_000, 100);
}

interface Row { build_id: string; polyline: string; seconds: number[]; distance_m: number; steps: TrackStep[] }
const ref = (job: number | null) => (job === null ? 'depot' : String(job));
const pairRows = (from: number | null, to: number): Row[] => json<Row[]>(`SELECT coalesce(json_agg(row_to_json(x)), '[]') FROM (
    SELECT build_id, polyline, seconds, distance_m, steps FROM world.van_track WHERE branch_id = 'columbus' AND from_ref = '${ref(from)}' AND to_ref = '${ref(to)}') x`);
const naming = (job: number): number => Number(psql(`SELECT count(*) FROM world.van_track WHERE from_ref = '${job}' OR to_ref = '${job}'`));
const liveCount = (): number => Number(psql(`SELECT count(*) FROM world.van_track WHERE build_id = 'live'`));
const bakedDigest = (): string => psql(`SELECT md5(string_agg(branch_id || '|' || from_ref || '|' || to_ref || '|' || polyline || '|' || steps::text, E'\\n' ORDER BY branch_id, from_ref, to_ref)) || ' ' || count(*) FROM world.van_track WHERE build_id <> 'live'`);
const minutesOf = (r: Row) => Math.ceil(r.seconds[r.seconds.length - 1]! / 60);

/** The routing service's answer, asked from inside the web container (it has no published port). */
function routeFromWeb(a: { lon: number; lat: number }, b: { lon: number; lat: number }): Json | null {
  const url = osrmRouteUrl('http://routing:5000', a, b);
  const r = compose(['exec', '-T', 'web', 'node', '-e', `fetch(${JSON.stringify(url)}).then((r) => r.text()).then((t) => console.log(t), () => process.exit(7))`]);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.out.trim().split('\n').pop()!);
  } catch {
    return null;
  }
}
const DEPOT = (): { lon: number; lat: number } => json(`SELECT json_build_object('lon', depot_lon, 'lat', depot_lat) FROM world.branch WHERE id = 'columbus'`);
async function routingReady(): Promise<void> {
  const d = DEPOT();
  await until('the routing service to answer a route', () => routeFromWeb(d, { lon: d.lon + 0.01, lat: d.lat + 0.01 }), (j) => j?.code === 'Ok', 240);
}

interface Tech { id: string; userId: string; name: string }
const columbusTechs = (): Tech[] => json<Tech[]>(`SELECT json_agg(json_build_object('id', id, 'userId', user_id, 'name', name) ORDER BY name) FROM world.technician
  WHERE branch_id = 'columbus' AND user_id IS NOT NULL AND NOT installer`);
interface DayJob { job: number; planned: string | null; expected: number; windowStart: string; customer: string }
/** A technician's live jobs of a day in the planner's order (SD-15: window start, booked at, job number). */
const dayOf = (techId: string, date: string): DayJob[] => json<DayJob[]>(`SELECT coalesce(json_agg(json_build_object('job', job_number, 'planned', planned_arrival,
    'expected', expected_minutes, 'windowStart', window_start, 'customer', customer_id) ORDER BY window_start, booked_at, job_number), '[]')
    FROM world.job WHERE technician_id = '${techId}' AND date = '${date}' AND status <> 'canceled'`);

let serviceId = '';
let streetOffset = 0;
/** API-112 then API-113 for the next street no customer lives on, on BOOK_DAY: the job number. */
async function bookOnline(name: string): Promise<number> {
  for (; streetOffset < 400; streetOffset += 1) {
    const street = psql(`SELECT s.id FROM world.street s WHERE s.branch_id = 'columbus' AND jsonb_array_length(s.points) >= 2
        AND NOT EXISTS (SELECT 1 FROM world.customer c WHERE c.street_id = s.id) ORDER BY s.name, s.id LIMIT 1 OFFSET ${streetOffset}`);
    const a = await call(null, 'POST', '/public/availability', { streetId: street, serviceId, from: BOOK_DAY, to: BOOK_DAY });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    if (a.body.data.branch !== 'columbus') continue;
    const day = (a.body.data.days as Json[]).find((d) => d.date === BOOK_DAY);
    const win = (day?.windows as Json[] | undefined)?.find((x) => x.state === 'open');
    if (!win) continue;
    const b = await call(null, 'POST', '/public/bookings', {
      serviceId, streetId: street, houseNumber: 1, date: BOOK_DAY, windowId: win.windowId, name, mobile: null, textsOn: false, textLanguage: 'en', timeZone: ZONE,
    });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    streetOffset += 1;
    return b.body.data.visit.jobNumber as number;
  }
  throw new Error('no Columbus street with an open window on Sep 16');
}
/** API-22 as the office: the job to the first Columbus technician with room for it (a refusal writes nothing). `prefer` is tried first. */
async function assign(job: number, prefer?: Tech): Promise<{ tech: Tech; ms: number }> {
  const all = columbusTechs();
  for (const t of prefer ? [prefer, ...all.filter((x) => x.id !== prefer.id)] : all) {
    const version = Number(psql(`SELECT version FROM world.job WHERE job_number = ${job}`));
    const r = await api('keisha', 'POST', `/jobs/${job}/assignment`, { technicianId: t.id, baseVersion: version });
    if (r.status === 200) return { tech: t, ms: r.ms };
  }
  throw new Error(`no Columbus technician took job ${job}`);
}
/** The stop before `job` in its technician-day's plan order: a job number, or null for the depot. */
function prevOf(techId: string, date: string, job: number): DayJob | null {
  const d = dayOf(techId, date);
  const i = d.findIndex((x) => x.job === job);
  expect(i).toBeGreaterThanOrEqual(0);
  return i === 0 ? null : d[i - 1]!;
}
const route = async (t: Tech, toJob: number, fromJob?: number | null) =>
  call(techToken(t.userId), 'GET', `/tech/route?${fromJob ? `fromJob=${fromJob}&` : ''}toJob=${toJob}`);

/** The technician's On my way as the phone sends it (API-102, section 5.1 step 1): the offset saved now, the item entered now. */
async function onMyWay(t: Tech, job: number): Promise<void> {
  const clock = (await api('dana', 'GET', '/clock')).body.data;
  const real = toWire(Temporal.Now.instant(), ZONE);
  const version = Number(psql(`SELECT version FROM world.job WHERE job_number = ${job}`));
  const item = { key: randomUUID(), kind: 'on_my_way', jobNumber: job, baseVersion: version, worldEpoch: clock.worldEpoch, deviceTime: real, offsetSavedReal: real, sinceSaveMs: 0, demoTime: clock.demoNow };
  const r = await call(techToken(t.userId), 'POST', '/tech/items', { items: [item] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.data.items[0], JSON.stringify(r.body)).toMatchObject({ result: 'applied' });
}

let bakedBefore = '';
/** The booking of clause 2: its job, technician and the stop before it. */
let booked: { job: number; tech: Tech; prev: number | null };

beforeAll(async () => {
  await routingReady();
  await jumpTo(TEN_TWENTY_SIX);
  await pauseClock();
  bakedBefore = bakedDigest();
  expect(liveCount(), 'setup routes nothing live').toBe(0);
  serviceId = psql(`SELECT id FROM world.service_type WHERE bookable_online ORDER BY (id = 'furnace_tune_up') DESC, id LIMIT 1`);
  expect(serviceId).not.toBe('');
});
afterAll(() => {
  spawnSync('docker', ['unpause', routingContainer()], { encoding: 'utf8' });
});

describe('the live client is the bake (SD-49 step 2)', () => {
  // why: FR-MAP-3, FR-TECH-5 a baked pair routed live through API-104 stores the row the bake wrote: 1 OSRM run, 1 mapping
  it('stores a baked pair, routed live, as the row the bake wrote', async () => {
    const maria = columbusTechs().find((t) => t.name === 'Maria Santos')!;
    const day = dayOf(maria.id, TODAY).filter((j) => psql(`SELECT status FROM world.job WHERE job_number = ${j.job}`) === 'scheduled');
    expect(day.length).toBeGreaterThanOrEqual(2);
    const [a, b] = [day[0]!.job, day[1]!.job];
    const [baked] = pairRows(a, b);
    expect(baked?.build_id).not.toBe('live');
    psql(`DELETE FROM world.van_track WHERE branch_id = 'columbus' AND from_ref = '${a}' AND to_ref = '${b}'`);
    const t0 = performance.now();
    const r = await route(maria, b, a);
    measured(`API-104 with 1 live route and its write: ${Math.round(performance.now() - t0)} ms`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const live = pairRows(a, b);
    expect(live.map((x) => x.build_id)).toEqual(['live']);
    expect({ ...live[0], build_id: 'x' }).toEqual({ ...baked, build_id: 'x' });
    expect(techRoute.response.parse(r.body.data).steps).toEqual(baked!.steps);
  });
});

describe('a new online booking (API-113) outside the baked set', () => {
  // why: FR-MAP-3, FR-TECH-5, FR-TECH-13 its leg answers API-104's routed line with steps, and its assignment's planned arrival, from 1 stored live row
  it('answers API-104 and its planned arrival from 1 stored live row', async () => {
    const job = await bookOnline('Lena Whitaker');
    expect(naming(job), 'a new job has no baked track').toBe(0);
    const maria = columbusTechs().find((t) => t.name === 'Maria Santos')!;
    const { tech } = await assign(job, maria);
    const prev = prevOf(tech.id, BOOK_DAY, job);
    const rows = pairRows(prev?.job ?? null, job);
    expect(rows.map((x) => x.build_id), 'the assignment routed the leg into the job and stored it').toEqual(['live']);
    const row = rows[0]!;
    // API-104 (from the stop before it, or from the depot with no fromJob): the stored row's line, length, minutes and steps
    const r = await route(tech, job, prev?.job ?? null);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const data = techRoute.response.parse(r.body.data);
    expect(data.leg.track).toEqual(decodePolyline(row.polyline));
    expect(data.leg.distanceMeters).toBe(row.distance_m);
    expect(data.leg.minutes).toBe(minutesOf(row));
    expect(data.steps).toEqual(row.steps);
    expect([data.steps[0]!.kind, data.steps.at(-1)!.kind]).toEqual(['depart', 'arrive']);
    // SD-15: the planned arrival the assignment wrote = max(window start, the stop before's planned end, or the shift start, + the row's minutes)
    const j = json<{ planned: string; windowStart: string }>(`SELECT json_build_object('planned', planned_arrival, 'windowStart', window_start) FROM world.job WHERE job_number = ${job}`);
    const ready = prev ? Date.parse(prev.planned!) + prev.expected * 60_000
      : Number(psql(`SELECT extract(epoch FROM ('${BOOK_DAY}'::date + t.shift_start) AT TIME ZONE '${ZONE}') * 1000 FROM world.technician t WHERE t.id = '${tech.id}'`));
    expect(Date.parse(j.planned)).toBe(Math.max(Date.parse(j.windowStart), ready + minutesOf(row) * 60_000));
    expect(pairRows(prev?.job ?? null, job)).toHaveLength(1);
    booked = { job, tech, prev: prev?.job ?? null };
  });
});

describe('while the routing service gives no route', () => {
  // why: FR-MAP-3 stopped: the leg answers approximate with no steps and nothing is stored; once it runs, the next read routes and stores it
  it('answers approximate and stores nothing while stopped, and routes the next read once it runs', async () => {
    expect(compose(['stop', 'routing']).status).toBe(0);
    const job = await bookOnline('Ruth Abernathy');
    const { tech } = await assign(job, booked.tech);
    const prev = prevOf(tech.id, BOOK_DAY, job)?.job ?? null;
    expect(pairRows(prev, job), 'the assignment stored nothing').toEqual([]);
    const r = await route(tech, job, prev);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([r.body.data.leg.track, r.body.data.leg.distanceMeters, r.body.data.steps]).toEqual([null, null, []]);
    expect(pairRows(prev, job)).toEqual([]);
    // F-1306: the failures since the first one are 1 warn line of class unresolved (Docker's DNS drops the stopped service's name), no more
    // than 1 a minute, and it holds no point, address, phone or job number.
    const signal = compose(['logs', 'web', '--no-log-prefix', '--since', '10m']).out.split('\n').filter((l) => l.includes('live route failed'));
    expect(signal, 'the web log holds 1 warn line of the live route failure').toHaveLength(1);
    expect(JSON.parse(signal[0]!)).toMatchObject({ level: 'warn', process: 'web', status: 'live route failed', errorCode: 'unresolved' });
    expect(Object.keys(JSON.parse(signal[0]!)).sort()).toEqual(['errorCode', 'failures', 'level', 'process', 'realTime', 'status']);
    expect(compose(['start', 'routing']).status).toBe(0);
    await routingReady();
    const again = await route(tech, job, prev);
    expect(again.status).toBe(200);
    const rows = pairRows(prev, job);
    expect(rows.map((x) => x.build_id)).toEqual(['live']);
    expect(again.body.data.leg.track).toEqual(decodePolyline(rows[0]!.polyline));
    expect(again.body.data.steps).toEqual(rows[0]!.steps);
  });
});

describe('2 concurrent readers of 1 new pair', () => {
  // why: FR-MAP-3 2 API-104 reads of a pair no row covers, at once: both answer the route, and exactly 1 row is stored
  it('store exactly 1 row', async () => {
    const day = dayOf(booked.tech.id, BOOK_DAY).map((d) => d.job);
    const first = day[0]!;
    const last = day[day.length - 1]!;
    expect(first).not.toBe(last);
    expect(pairRows(last, first), 'no track runs back from the last stop to the first').toEqual([]);
    const [a, b] = await Promise.all([route(booked.tech, first, last), route(booked.tech, first, last)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data.leg.track).not.toBeNull();
    expect(a.body.data).toEqual(b.body.data);
    expect(pairRows(last, first)).toHaveLength(1);
  });
});

describe('a stalled routing service', () => {
  // why: FR-MAP-3 paused (it takes the connection and never answers): approximate within the 3 s budget plus the read's own time, nothing stored; a write needing a live leg holds its locks no longer
  it('answers approximate within the budget, and an assignment waits no longer', async () => {
    const day = dayOf(booked.tech.id, BOOK_DAY).map((d) => d.job);
    const open = day.flatMap((a) => day.filter((b) => b !== a && pairRows(a, b).length === 0).map((b) => [a, b] as const))[0];
    expect(open, 'a pair of the day with no row').toBeDefined();
    const [x, y] = open!;
    // the read's own time: the same read of a stored pair (the booking's leg), 3 times, the slowest
    let own = 0;
    for (let i = 0; i < 3; i++) own = Math.max(own, (await route(booked.tech, booked.job, booked.prev)).ms);
    expect(spawnSync('docker', ['pause', routingContainer()], { encoding: 'utf8' }).status).toBe(0);
    try {
      const r = await route(booked.tech, y, x);
      measured(`API-104 with the routing service paused: ${Math.round(r.ms)} ms (budget ${BUDGET_MS} ms; the same read of a stored pair, slowest of 3: ${Math.round(own)} ms)`);
      expect(r.status).toBe(200);
      expect([r.body.data.leg.track, r.body.data.steps]).toEqual([null, []]);
      expect(r.ms).toBeGreaterThanOrEqual(BUDGET_MS - 100);
      expect(r.ms).toBeLessThanOrEqual(BUDGET_MS + own + 500);
      expect(pairRows(x, y)).toEqual([]);
      // a write on the timeout path: the assignment's settle asks the paused service for the new job's legs under the technician-day lock
      const job = await bookOnline('Victor Lindqvist');
      const a = await assign(job, booked.tech);
      measured(`API-22 assignment with the routing service paused (the technician-day lock is held for the write's whole transaction): ${Math.round(a.ms)} ms`);
      expect(a.ms).toBeLessThanOrEqual(BUDGET_MS + 3_000);
      expect(pairRows(prevOf(a.tech.id, BOOK_DAY, job)?.job ?? null, job)).toEqual([]);
    } finally {
      spawnSync('docker', ['unpause', routingContainer()], { encoding: 'utf8' });
    }
    await routingReady();
  });
});

describe('a job\'s customer point changed, and a van on its live leg (FR-DEMO-8)', () => {
  let tech: Tech;
  let job = 0;
  let prev: number | null = null;
  let token = '';
  const ELAPSED_S = 300;

  // why: FR-MAP-3 an address edit (API-36) deletes every row naming the customer's job, baked or live; On my way then routes the new point live
  it('deletes the job\'s rows when its customer point changes, and the next read routes the new point', async () => {
    const board = (await api('keisha', 'GET', `/board?branch=columbus&date=${TODAY}`)).body.data;
    for (const t of board.technicians as Json[]) {
      if (t.jobs.some((j: Json) => j.status === 'on_the_way' || j.status === 'on_site')) continue;
      const pick = (t.jobs as Json[]).find((j) => j.status === 'scheduled' && naming(j.jobNumber) > 0
        && Number(psql(`SELECT jsonb_array_length(s.points) FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.street s ON s.id = c.street_id WHERE j.job_number = ${j.jobNumber}`)) >= 2);
      if (!pick) continue;
      tech = columbusTechs().find((x) => x.id === t.id)!;
      job = pick.jobNumber;
      break;
    }
    expect(job, 'a free Columbus technician with a scheduled job today').toBeGreaterThan(0);
    const c = json<{ id: string; house: number; lon: number; lat: number }>(`SELECT json_build_object('id', c.id, 'house', c.house_number, 'lon', c.lon, 'lat', c.lat)
        FROM world.job j JOIN world.customer c ON c.id = j.customer_id WHERE j.job_number = ${job}`);
    expect(naming(job)).toBeGreaterThan(0);
    const e = await api('keisha', 'PATCH', `/customers/${c.id}`, { houseNumber: c.house + 1 });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    const moved = json<{ lon: number; lat: number }>(`SELECT json_build_object('lon', lon, 'lat', lat) FROM world.customer WHERE id = '${c.id}'`);
    expect(moved).not.toEqual({ lon: c.lon, lat: c.lat });
    expect(naming(job), 'every row naming the job is gone').toBe(0);
    // The customer gets a mobile and texts on, so the On my way sends its text with the live map link (FR-TEXT-3).
    psql(`UPDATE world.customer SET mobile = '+16145550142', texts_on = true WHERE id = '${c.id}'`);
    await onMyWay(tech, job);
    prev = Number(psql(`SELECT coalesce((SELECT job_number FROM world.job WHERE technician_id = '${tech.id}' AND date = '${TODAY}' AND status IN ('done', 'no_one_home')
        ORDER BY ended_at DESC NULLS LAST, job_number DESC LIMIT 1), 0)`)) || null;
    const rows = pairRows(prev, job);
    expect(rows.map((x) => x.build_id), 'On my way routed the leg to the new point and stored it').toEqual(['live']);
    const end = decodePolyline(rows[0]!.polyline).at(-1)!;
    expect(Math.abs(end[0] - moved.lon) + Math.abs(end[1] - moved.lat)).toBeLessThan(0.01);
    token = psql(`SELECT token FROM world.link_token WHERE job_number = ${job} AND kind = 'live_map' AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1`);
    expect(token).not.toBe('');
  });

  // why: FR-DEMO-8, FR-MAP-3 on the live leg the van has 1 position on the board and the live map, the point along the live track, and no position table exists
  it('has the same position on the board and the live map, computed on read from the live track', async () => {
    expect(job).toBeGreaterThan(0);
    const now = (await api('dana', 'GET', '/clock')).body.data.demoNow as string;
    // the van left ELAPSED_S seconds of demo time ago (the clock is paused, so every read below sees the same instant)
    psql(`UPDATE world.job SET on_the_way_at = '${new Date(ms(now) - ELAPSED_S * 1000).toISOString()}'::timestamptz WHERE job_number = ${job}`);
    const [row] = pairRows(prev, job);
    expect(row!.build_id).toBe('live');
    const want = pointAlongTrack(row!, ELAPSED_S);
    const vans = await api('keisha', 'GET', '/vans?branch=columbus');
    expect(vans.status, JSON.stringify(vans.body)).toBe(200);
    const van = (vans.body.data.vans as Json[]).find((v) => v.technicianId === tech.id);
    expect(van.status).toBe('on_the_way');
    expect(van.route.track).toEqual(decodePolyline(row!.polyline));
    const live = await fetch(`${origin}/m/${token}/data`, { headers: { accept: 'application/json' } });
    expect(live.status).toBe(200);
    const data = ((await live.json()) as Json).data;
    expect(data.van.source).toBe('track');
    expect(data.van).toEqual({ lon: van.position.lon, lat: van.position.lat, source: 'track' });
    expect(van.position).toEqual(want);
    expect(data.route.track).toEqual(van.route.track);
    // FR-DEMO-8: no table holds a position, and the van and technician rows carry no coordinate
    expect(psql(`SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_name ILIKE '%position%'`)).toBe('0');
    expect(psql(`SELECT count(*) FROM information_schema.columns WHERE table_schema IN ('world', 'world_snapshot') AND table_name IN ('van', 'technician', 'job')
        AND column_name ~ '(^|_)(lon|lat|longitude|latitude|position)($|_)'`)).toBe('0');
  });

  describe.each(engines)('the live map page on the live leg (%s)', (_name, type) => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await type.launch({ headless: true });
    });
    afterAll(async () => {
      await browser?.close();
    });

    // why: FR-MAP-3, NFR-12 the customer's page draws the van on the live leg from the stack's own origin: the outside-origin guard records no outside request
    it('draws with no outside request', async () => {
      expect(token).not.toBe('');
      const g = await guardedContext(browser, [origin], { viewport: { width: 390, height: 844 } });
      try {
        const page = await g.context.newPage();
        expect((await page.goto(`${origin}/m/${token}`, { waitUntil: 'load' }))?.status()).toBe(200);
        await page.locator('.r1-screen[data-screen="SCR-CUS-04"] .r1-map[data-map-state="ready"]').waitFor({ timeout: 90_000 });
        expect(g.outside).toEqual([]);
      } finally {
        await g.context.close();
      }
    });
  });
});

describe('the routing service on the Compose network only (SD-3, NFR-12)', () => {
  // why: NFR-12, FR-MAP-3 it has no published port and nginx has no route to it
  it('has no published port and no route through nginx', async () => {
    expect(spawnSync('docker', ['port', routingContainer()], { encoding: 'utf8' }).stdout.trim()).toBe('');
    const d = DEPOT();
    const via = await fetch(`${origin}/route/v1/driving/${d.lon},${d.lat};${d.lon + 0.01},${d.lat + 0.01}`);
    expect(await via.text()).not.toContain('"code":"Ok"');
    expect(via.status).not.toBe(200);
  });
});

describe('API-163 on the booking\'s day', () => {
  // why: FR-TECH-11, FR-TECH-13, FR-MAP-3 the Map tab's leg into the booked job answers the same minutes, line and length as its 1 stored row
  it('answers the same drive minutes from the stored row', async () => {
    await holdClockAt('2026-09-16T07:00:00-04:00');
    const r = await call(techToken(booked.tech.userId), 'GET', '/tech/day-route');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.date).toBe(BOOK_DAY);
    const stops = r.body.data.stops as Json[];
    const i = stops.findIndex((s) => s.jobNumber === booked.job);
    expect(i).toBeGreaterThanOrEqual(0);
    // API-163's leg into a stop runs from the stop before it in its own order (the next stop's from the van, at the depot at 7:00 AM)
    const from = i === 0 ? null : stops[i - 1].jobNumber as number;
    const rows = pairRows(from, booked.job);
    expect(rows).toHaveLength(1);
    const leg = (r.body.data.legs as Json[]).find((l) => l.toJob === booked.job);
    expect([leg.minutes, leg.distanceMeters, leg.track]).toEqual([minutesOf(rows[0]!), rows[0]!.distance_m, decodePolyline(rows[0]!.polyline)]);
    if (from === booked.prev) expect(rows[0]!.build_id).toBe('live');
  });
});

describe('the world reset (SD-12)', () => {
  // why: FR-MAP-3, FR-DEMO-6 a reset drops every live row and keeps every baked row
  it('drops every live row and keeps every baked row', async () => {
    expect(liveCount()).toBeGreaterThan(0);
    const epoch = (await api('dana', 'GET', '/clock')).body.data.worldEpoch as number;
    for (let i = 0; ; i += 1) {
      const r = await api('dana', 'POST', '/clock/resets', {});
      if (r.status === 202) break;
      if (r.status !== 429 || r.body?.code !== 'cooldown' || i > 5) expect(r.status, JSON.stringify(r.body)).toBe(202);
      await sleep((Number(r.body.availableInSeconds) + 1) * 1000);
    }
    await until('the reset to finish', async () => (await api('dana', 'GET', '/clock')).body, (b) => b.data.worldEpoch > epoch && b.data.paused === false);
    // every baked row is back as setup loaded it (the one clause 1 deleted included), and no live row is left (the reset world's legs are baked)
    expect(bakedDigest()).toBe(bakedBefore);
    expect(liveCount()).toBe(0);
    expect(Number(psql(`SELECT count(*) FROM world_snapshot.van_track WHERE build_id = 'live'`))).toBe(0);
  }, 600_000);
});
