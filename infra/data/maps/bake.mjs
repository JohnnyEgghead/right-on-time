// SPDX-License-Identifier: AGPL-3.0-or-later
// P3-MAPS-BAKE track bake (FR-MAP-5, SPECIFICATIONS section 6.10). Runs inside the repo's pinned node container, next to an
// osrm-routed container (OSRM v26.10.0, car profile, MLD) on the same Docker network. Input: /d/legs.json, written by
//   node packages/maps/src/cli.ts legs --out <file>
// (the legs of the seeded schedule: each technician's depot and job-to-job legs for the demo week and the preset days with
// jobs, and every Sep 15 same-branch job pair; no model, no assumed counts: F-18). Output: /d/out/tracks.ndjson, 1 line
// per leg in legs.json's order: { branch_id, from_ref, to_ref, polyline, seconds, distance_m, build_id, steps }.
// The polyline is precision-5 encoded; `seconds` is the cumulative drive seconds per vertex. Any leg OSRM cannot route
// fails the whole bake (exit 1): a silently dropped leg would leave a hole the coverage check then finds too late.
// P6-ROUTE-BAKE (SPECIFICATIONS v0.13 SD-49, section 6.10; FR-TECH-5): each request also asks for the route steps (steps=true),
// and `steps` is SD-49's step objects made by packages/maps/src/steps.ts, the same code the live routing client runs. run.sh
// ships that file and tracks.ts (the polyline decoder) into /d/lib; node strips their types. A step the mapping refuses (an
// OSRM maneuver type outside SD-49's table, a turn point off the polyline, lengths that do not add up) fails the whole bake,
// naming the leg and the cause.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { decodePolyline } from '/d/lib/tracks.ts';
import { stepsFromOsrm } from '/d/lib/steps.ts';

const OSRM = process.env.OSRM_URL ?? 'http://osrm:5000';
const BUILD_ID = process.env.BUILD_ID ?? 'ohio-261001+osrm-v26.10.0';
const READY_TRIES = 120; // 1 s apart: osrm-routed answers within seconds once the data loads (F-17: poll, no fixed sleep)

const enc1 = (n) => {
  let v = n < 0 ? ~(n << 1) : n << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return out + String.fromCharCode(v + 63);
};
const encode = (coords) => {
  let plat = 0;
  let plon = 0;
  let out = '';
  for (const [lon, lat] of coords) {
    const la = Math.round(lat * 1e5);
    const lo = Math.round(lon * 1e5);
    out += enc1(la - plat) + enc1(lo - plon);
    plat = la;
    plon = lo;
  }
  return out;
};

async function waitReady() {
  for (let i = 0; i < READY_TRIES; i++) {
    try {
      const r = await fetch(`${OSRM}/route/v1/driving/-83.0,39.96;-83.01,39.97?overview=false`);
      if (r.ok && (await r.json()).code === 'Ok') return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`osrm-routed at ${OSRM} did not answer a route in ${READY_TRIES} s`);
}

async function route(a, b) {
  const url = `${OSRM}/route/v1/driving/${a[0]},${a[1]};${b[0]},${b[1]}?overview=full&geometries=geojson&annotations=duration&steps=true`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.code !== 'Ok') return null;
  const rt = d.routes[0];
  const coords = rt.geometry.coordinates;
  const durs = rt.legs[0].annotation.duration;
  let cum = [0];
  for (const x of durs) cum.push(cum[cum.length - 1] + x);
  if (cum.length !== coords.length) {
    const n = coords.length;
    cum = n > 1 ? coords.map((_, i) => (rt.duration * i) / (n - 1)) : [0];
  }
  const polyline = encode(coords);
  const distance_m = Math.round(rt.distance);
  const steps = stepsFromOsrm(rt.legs[0].steps, decodePolyline(polyline), distance_m);
  return { polyline, seconds: cum.map((c) => Math.round(c)), distance_m, steps };
}

const { legs } = JSON.parse(readFileSync('/d/legs.json', 'utf8'));
await waitReady();
mkdirSync('/d/out', { recursive: true });
const lines = [];
const failed = [];
const unmapped = [];
for (const l of legs) {
  let r;
  try {
    r = await route(l.from, l.to);
  } catch (e) {
    unmapped.push(`${l.branch_id}|${l.from_ref}|${l.to_ref}: ${e.name}: ${e.message}`);
    continue;
  }
  if (!r) {
    failed.push(`${l.branch_id}|${l.from_ref}|${l.to_ref}`);
    continue;
  }
  const { steps, ...track } = r;
  lines.push(JSON.stringify({ branch_id: l.branch_id, from_ref: l.from_ref, to_ref: l.to_ref, ...track, build_id: BUILD_ID, steps }));
}
console.log(`bake: ${legs.length} legs, ${lines.length} routed, ${failed.length} failed, ${unmapped.length} refused by the step mapping`);
if (unmapped.length > 0) {
  console.error(`bake: FAIL step mapping (SD-49), first: ${unmapped.slice(0, 5).join('; ')}`);
  process.exit(1);
}
if (failed.length > 0) {
  console.error(`bake: FAIL unrouted legs, first: ${failed.slice(0, 5).join('; ')}`);
  process.exit(1);
}
writeFileSync('/d/out/tracks.ndjson', `${lines.join('\n')}\n`);
