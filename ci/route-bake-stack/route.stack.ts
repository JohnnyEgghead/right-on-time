// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-5, FR-MAP-3, FR-MAP-5, NFR-12 (P6-ROUTE-BAKE Acceptance: integration tests against the Compose stack, real PostgreSQL 18, real handlers)
// The turn-by-turn steps of the bake, API-104's steps and the routing service (SPECIFICATIONS v0.13 SD-49, section 6.3 Directions, section 6.10;
// UI-SPECIFICATION v0.15 API-104) against the Compose stack at its default settings, set up by the setup service (the seeded world from the
// real map folder `pnpm run setup:maps` filled, the clock at Tue, Sep 15, 7:00 AM), through its proxy, signed in as Maria Santos and Dana Ruiz
// (ci/route-bake-stack/fixture.sql):
//   1. setup loaded every track of the real tracks file with its steps, as the file holds them, and each keeps SD-49's guarantees;
//   2. API-104 from Harold Jenkins's job to Linda Miller's answers the ordered steps with the 8 fields, the stored ones, while the routing
//      service is stopped;
//   3. from the van's position on the way, the list starts at the van's step with that step's length left;
//   4. an approximate leg answers an empty list;
//   5. the routing service with its files absent waits and the stack answers; with its files it answers on the Compose network only, the
//      same route and steps the bake stored (1 OSRM run, 1 vocabulary), and nginx has no route to it;
//   6. a world reset keeps the baked steps.
// Run by ci/route-bake-stack.sh, which exports the stack's Compose settings so this file can start and stop the routing service.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { techRoute } from '../../packages/api/src/contracts/tech-route.ts';
import { loadMapManifest } from '../../packages/maps/src/manifest.ts';
import { haversineMeters } from '../../packages/maps/src/position.ts';
import { stepsFromOsrm, stepVertexIndexes, type TrackStep } from '../../packages/maps/src/steps.ts';
import { decodePolyline, parseTracks } from '../../packages/maps/src/tracks.ts';

const base = process.env.BW_ROUTE_STACK_URL;
const db = process.env.BW_ROUTE_DB_CONTAINER;
const project = process.env.BW_ROUTE_PROJECT;
const mapsDir = process.env.BW_MAPS_DIR;
const people = { maria: process.env.BW_ROUTE_MARIA, dana: process.env.BW_ROUTE_DANA };
if (!base || !db || !project || !mapsDir || Object.values(people).some((v) => !v)) throw new Error('BW_ROUTE_STACK_URL, _DB_CONTAINER, _PROJECT, BW_MAPS_DIR and the session tokens are not set: run ci/route-bake-stack.sh');
const origin = new URL(base).origin;
const APP_ORIGIN = 'http://localhost:8080';
const DATE = '2026-09-15';
const TEN_TWENTY_SIX = '2026-09-15T10:26:00-04:00[America/New_York]';
type Who = keyof typeof people;
/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

function psql(sql: string): string {
  const r = spawnSync('docker', ['exec', db!, 'psql', '-q', '-t', '-A', '-U', 'brightwater', '-d', 'brightwater', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout.trim();
}

/** docker compose on the suite's own project, with the stack's settings the script exported (BW_IMAGE, DB_ENV_FILE, the binds, the folders). */
function compose(args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const r = spawnSync('docker', ['compose', '-p', project!, '-f', 'infra/compose.yaml', ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const routingState = (): string => spawnSync('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=routing', '--format', '{{.State}}'], { encoding: 'utf8' }).stdout.trim();

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
async function pauseClock(): Promise<string> {
  const r = await api('dana', 'PUT', '/clock/paused', { paused: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (await until('the clock to be paused', async () => (await api('dana', 'GET', '/clock')).body, (b) => b.data.paused === true)).data.demoNow;
}

interface Stop { job: number; status: string; customer: string; area: string; lon: number; lat: number }
function mariaDay(date = DATE): Stop[] {
  return JSON.parse(psql(`SELECT coalesce(json_agg(x ORDER BY ord), '[]'::json) FROM (
      SELECT row_number() OVER (ORDER BY j.window_start, j.planned_arrival NULLS LAST, j.job_number) AS ord, j.job_number AS job, j.status, c.name AS customer, s.city AS area, c.lon, c.lat
        FROM world.job j JOIN world.technician t ON t.id = j.technician_id JOIN world.customer c ON c.id = j.customer_id JOIN world.street s ON s.id = c.street_id
       WHERE t.name = 'Maria Santos' AND j.date = '${date}' AND j.status <> 'canceled') x`));
}
interface Row { polyline: string; seconds: number[]; distance_m: number; steps: TrackStep[] }
function trackRow(from: string, to: string): Row | null {
  const r = psql(`SELECT row_to_json(x) FROM (SELECT polyline, seconds, distance_m, steps FROM world.van_track WHERE branch_id = 'columbus' AND from_ref = '${from}' AND to_ref = '${to}' LIMIT 1) x`);
  return r === '' ? null : (JSON.parse(r) as Row);
}
const stepsDigest = (): string => psql(`SELECT md5(string_agg(branch_id || '|' || from_ref || '|' || to_ref || '|' || steps::text, E'\\n' ORDER BY branch_id, from_ref, to_ref)) || ' ' || count(*) FROM world.van_track`);

/** The routing service's answer for 1 pair, asked from inside the web container (the routing service has no published port). */
function routeFromWeb(a: { lon: number; lat: number }, b: { lon: number; lat: number }): Json | null {
  const url = `http://routing:5000/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson&annotations=duration&steps=true`;
  const r = compose(['exec', '-T', 'web', 'node', '-e', `fetch(${JSON.stringify(url)}).then((r) => r.text()).then((t) => console.log(t), () => process.exit(7))`]);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.out.trim().split('\n').pop()!);
  } catch {
    return null;
  }
}

/** The bake's precision-5 polyline encoder (infra/data/maps/bake.mjs), to compare a live route with the stored track. */
function encode(coords: [number, number][]): string {
  const one = (n: number): string => {
    let v = n < 0 ? ~(n << 1) : n << 1;
    let out = '';
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return out + String.fromCharCode(v + 63);
  };
  let plat = 0;
  let plon = 0;
  return coords.map(([lon, lat]) => {
    const la = Math.round(lat * 1e5);
    const lo = Math.round(lon * 1e5);
    const s = one(la - plat) + one(lo - plon);
    plat = la;
    plon = lo;
    return s;
  }).join('');
}

let harold: Stop;
let linda: Stop;
const scratch: string[] = [];
/** A measured figure, kept where the script asks (BW_ROUTE_MEASURE_FILE; vitest keeps a passing test's console to itself). */
const measured = (line: string): void => {
  if (process.env.BW_ROUTE_MEASURE_FILE) appendFileSync(process.env.BW_ROUTE_MEASURE_FILE, `route-bake-stack: ${line}\n`);
};

beforeAll(async () => {
  await jumpTo(TEN_TWENTY_SIX);
  await pauseClock();
  const day = mariaDay();
  const at = day.findIndex((s) => s.customer === 'Harold Jenkins');
  expect(at).toBeGreaterThanOrEqual(0);
  harold = day[at]!;
  linda = day[at + 1]!;
  expect([linda.customer, linda.area]).toEqual(['Linda Miller', 'Westerville']);
});
afterAll(() => {
  scratch.forEach((d) => rmSync(d, { recursive: true, force: true }));
  compose(['stop', 'routing']);
});

describe('the baked steps in the stack', () => {
  // why: FR-TECH-5, FR-MAP-5
  it('setup loaded every track of the real tracks file with its steps as the file holds them, each keeping SD-49\'s guarantees', () => {
    const file = parseTracks(readFileSync(path.join(mapsDir!, 'tracks.ndjson'), 'utf8'));
    const rows = JSON.parse(psql(`SELECT json_agg(json_build_object('k', branch_id || '|' || from_ref || '|' || to_ref, 'p', polyline, 'd', distance_m, 's', steps)) FROM world.van_track`)) as { k: string; p: string; d: number; s: TrackStep[] }[];
    expect(rows.length).toBe(file.length);
    const byKey = new Map(rows.map((r) => [r.k, r]));
    for (const t of file) {
      const k = `${t.branch_id}|${t.from_ref}|${t.to_ref}`;
      const r = byKey.get(k);
      expect(r, k).toBeDefined();
      expect(r!.s, k).toEqual(t.steps);
      const s = r!.s;
      expect([s[0]!.kind, s[s.length - 1]!.kind], k).toEqual(['depart', 'arrive']);
      const vs = decodePolyline(r!.p);
      expect(stepVertexIndexes(s, vs).length, k).toBe(s.length); // each `at` is a vertex of the stored polyline, in order
      expect(s.reduce((a, x) => a + x.distanceMeters, 0), k).toBe(r!.d);
    }
  });

  // why: FR-TECH-5, FR-MAP-3
  it('API-104 from Harold Jenkins\'s job to Linda Miller\'s answers the ordered steps with the 8 fields, the stored ones, with the routing service stopped', async () => {
    expect(['', 'exited'], 'the routing service is not running').toContain(routingState());
    const r = await api('maria', 'GET', `/tech/route?fromJob=${harold.job}&toJob=${linda.job}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const data = techRoute.response.parse(r.body.data);
    const row = trackRow(String(harold.job), String(linda.job));
    expect(row).not.toBeNull();
    expect(data.leg.track).not.toBeNull();
    expect(data.steps.length).toBeGreaterThanOrEqual(3);
    expect(data.steps).toEqual(row!.steps);
    for (const s of r.body.data.steps) expect(Object.keys(s).sort()).toEqual(['at', 'direction', 'distanceMeters', 'exit', 'heading', 'kind', 'road', 'side']);
    expect(data.steps[0]!.kind).toBe('depart');
    expect(data.steps[0]!.heading).not.toBeNull();
    expect(data.steps[data.steps.length - 1]!.kind).toBe('arrive');
    expect(data.steps.reduce((a, s) => a + s.distanceMeters, 0)).toBe(data.leg.distanceMeters);
    // the turn points are vertices of the line API-104 draws, in driving order
    expect(stepVertexIndexes(data.steps, data.leg.track!).length).toBe(data.steps.length);
  });

  // why: FR-TECH-5, FR-TECH-13
  it('from the van\'s position on the way, starts at the van\'s step with that step\'s length left', async () => {
    const now = await pauseClock();
    const prev = psql(`SELECT j.job_number FROM world.job j JOIN world.technician t ON t.id = j.technician_id
        WHERE t.name = 'Maria Santos' AND j.date = '${DATE}' AND j.status IN ('done', 'no_one_home') AND j.job_number <> ${harold.job}
        ORDER BY j.ended_at DESC NULLS LAST, j.job_number DESC LIMIT 1`) || 'depot';
    const row = trackRow(prev, String(harold.job));
    expect(row, `the baked leg ${prev} to ${harold.job}`).not.toBeNull();
    expect(row!.steps.length).toBeGreaterThanOrEqual(3);
    const total = row!.seconds[row!.seconds.length - 1]!;
    const vs = decodePolyline(row!.polyline);
    const idx = stepVertexIndexes(row!.steps, vs);
    // the van 1 s past the second step's turn, by drive time: past the start, short of the end
    const elapsed = row!.seconds[idx[1]!]! + 1;
    expect(elapsed).toBeLessThan(total);
    const before = psql(`SELECT status || '|' || coalesce(on_the_way_at::text, '') FROM world.job WHERE job_number = ${harold.job}`);
    psql(`UPDATE world.job SET status = 'on_the_way', on_the_way_at = '${new Date(ms(now) - elapsed * 1000).toISOString()}'::timestamptz WHERE job_number = ${harold.job}`);
    try {
      const r = await api('maria', 'GET', `/tech/route?toJob=${harold.job}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const data = techRoute.response.parse(r.body.data);
      const track = data.leg.track!;
      // The line left starts at the van's point; the vertices after it are the stored polyline's tail.
      const next = vs.length - (track.length - 1);
      expect(track.slice(1)).toEqual(vs.slice(next));
      let k = 0;
      idx.forEach((v, j) => { if (v <= next - 1) k = j; });
      expect(k, 'the van is past the first turn').toBeGreaterThanOrEqual(1);
      expect(data.steps[0]!.kind).not.toBe('depart');
      expect(data.steps.length).toBe(row!.steps.length - k);
      expect(data.steps.slice(1)).toEqual(row!.steps.slice(k + 1));
      expect({ ...data.steps[0]!, distanceMeters: 0 }).toEqual({ ...row!.steps[k]!, distanceMeters: 0 });
      // that step's length is the length left from the van's point to the next step's turn, along the line
      let left = 0;
      const to = idx[k + 1]!;
      let p = track[0]!;
      for (let j = next; j <= to; j++) {
        left += haversineMeters(p, vs[j]!);
        p = vs[j]!;
      }
      expect(data.steps[0]!.distanceMeters).toBe(Math.round(left));
      expect(data.steps[0]!.distanceMeters).toBeLessThanOrEqual(row!.steps[k]!.distanceMeters + 25);
    } finally {
      const [status, at] = before.split('|');
      psql(`UPDATE world.job SET status = '${status}', on_the_way_at = ${at ? `'${at}'::timestamptz` : 'NULL'} WHERE job_number = ${harold.job}`);
    }
  });

  // why: FR-TECH-5, FR-MAP-3
  it('answers an empty list on an approximate leg', async () => {
    const later = mariaDay('2026-09-16')[0];
    expect(later, 'Maria has a job on Sep 16').toBeDefined();
    expect(trackRow(String(linda.job), String(later!.job)), 'no track is baked across days').toBeNull();
    const r = await api('maria', 'GET', `/tech/route?fromJob=${linda.job}&toJob=${later!.job}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const data = techRoute.response.parse(r.body.data);
    expect(data.leg.track).toBeNull();
    expect(data.leg.distanceMeters).toBeNull();
    expect(data.steps).toEqual([]);
  });
});

describe('the routing service (SD-3, SD-49)', () => {
  // why: FR-MAP-3, NFR-12
  it('with its files absent it waits, and the stack starts and answers the baked leg', async () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'bw-route-nofiles-'));
    scratch.push(bare);
    for (const a of loadMapManifest().assets.filter((x) => x.kind !== 'routing')) symlinkSync(path.join(mapsDir!, a.id), path.join(bare, a.id));
    const up = compose(['up', '-d', '--no-deps', '--force-recreate', 'routing'], { BW_MAPS_DIR: bare });
    expect(up.status, up.out).toBe(0);
    await until('the routing service to say it waits', () => compose(['logs', 'routing']).out, (o) => o.includes('routing: no routing files in /data/maps yet'), 60);
    expect(routingState()).toBe('running');
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    const r = await api('maria', 'GET', `/tech/route?fromJob=${harold.job}&toJob=${linda.job}`);
    expect(r.status).toBe(200);
    expect(r.body.data.steps).toEqual(trackRow(String(harold.job), String(linda.job))!.steps);
  });

  // why: FR-MAP-3, NFR-12, FR-TECH-5
  it('with its files it answers on the Compose network only, the same route and steps the bake stored, and nginx has no route to it', async () => {
    const t0 = Date.now();
    const up = compose(['up', '-d', '--no-deps', '--force-recreate', 'routing']);
    expect(up.status, up.out).toBe(0);
    const live = await until('the routing service to answer a route', () => routeFromWeb(harold, linda), (j) => j?.code === 'Ok', 240);
    measured(`the routing service answered its first route ${((Date.now() - t0) / 1000).toFixed(1)} s after docker compose up started it (asked every 0.5 s through the web container)`);
    const rt = live.routes[0];
    const row = trackRow(String(harold.job), String(linda.job))!;
    const polyline = encode(rt.geometry.coordinates);
    expect(polyline, 'the live route is the baked track: 1 OSRM run').toBe(row.polyline);
    expect(Math.round(rt.distance)).toBe(row.distance_m);
    expect(stepsFromOsrm(rt.legs[0].steps, decodePolyline(polyline), Math.round(rt.distance))).toEqual(row.steps);
    // no published port, and the proxy has no route to it
    expect(spawnSync('docker', ['port', compose(['ps', '-q', 'routing']).out.trim()], { encoding: 'utf8' }).stdout.trim()).toBe('');
    const via = await fetch(`${origin}/route/v1/driving/${harold.lon},${harold.lat};${linda.lon},${linda.lat}`);
    const text = await via.text();
    expect(text).not.toContain('"code":"Ok"');
    expect(via.status).not.toBe(200);
    const mem = spawnSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', compose(['ps', '-q', 'routing']).out.trim()], { encoding: 'utf8' }).stdout.trim();
    measured(`routing memory after its first route: ${mem} (used / the container limit, read from docker)`);
  });
});

describe('the world reset (SD-12)', () => {
  // why: FR-TECH-5, FR-MAP-5
  it('keeps the baked steps', async () => {
    const before = stepsDigest();
    const epoch = (await api('dana', 'GET', '/clock')).body.data.worldEpoch as number;
    // setup's own reset starts the 5 minute cool-down (RESET_COOLDOWN_SECONDS, 300 by default): wait out what API-14 says is left
    for (let i = 0; ; i += 1) {
      const r = await api('dana', 'POST', '/clock/resets', {});
      if (r.status === 202) break;
      if (r.status !== 429 || r.body?.code !== 'cooldown' || i > 5) expect(r.status, JSON.stringify(r.body)).toBe(202);
      await sleep((Number(r.body.availableInSeconds) + 1) * 1000);
    }
    await until('the reset to finish', async () => (await api('dana', 'GET', '/clock')).body, (b) => b.data.worldEpoch > epoch && b.data.paused === false);
    expect(stepsDigest()).toBe(before);
    const r = await api('maria', 'GET', `/tech/route?fromJob=${harold.job}&toJob=${linda.job}`);
    expect(r.status).toBe(200);
    expect(r.body.data.steps).toEqual(trackRow(String(harold.job), String(linda.job))!.steps);
  }, 600_000); // up to the 300 s cool-down that setup's own reset starts, then the reset and its confirmation
});
