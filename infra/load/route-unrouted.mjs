// SPDX-License-Identifier: AGPL-3.0-or-later
// P6-ROUTING-MEMORY (OQ-42; F-1305; SPECIFICATIONS v0.13 SD-49 step 3): the time of API-104 reads of 1 pair no row covers while the routing
// service is stopped (infra/load/routing-memory.sh unrouted stops it first). Each read must answer the approximate line (track null, length
// null, no steps) within SD-49's 3 s plus the read's own time. The read's own time is measured on the same stack, same technician, at the
// same moment: the same number of API-104 reads of a pair a baked row covers (answered from the row, so no routing call is made).
//   node infra/load/route-unrouted.mjs <origin> <token file> <fromJob> <toJob> <baked fromJob> <baked toJob> <reads> > <out.json>
// The token file holds 1 technician's session token (it stays in the state folder, outside the repo; it is never printed).
import { readFileSync } from 'node:fs';

const [origin, tokenFile, fromJob, toJob, bakedFrom, bakedTo, readsArg] = process.argv.slice(2);
if (!readsArg) throw new Error('usage: route-unrouted.mjs <origin> <token file> <fromJob> <toJob> <baked fromJob> <baked toJob> <reads>');
const SD49_LIMIT_MS = 3000;
const reads = Number(readsArg);
const cookie = `bw_session=${readFileSync(tokenFile, 'utf8').trim()}`;

async function read(from, to) {
  const s = performance.now();
  const r = await fetch(`${origin}/api/v1/tech/route?fromJob=${from}&toJob=${to}`, { headers: { cookie }, signal: AbortSignal.timeout(30000) });
  const body = await r.json();
  const ms = Math.round((performance.now() - s) * 10) / 10;
  const leg = body?.data?.leg;
  const steps = body?.data?.steps;
  const approximate = r.status === 200 && leg?.track === null && leg?.distanceMeters === null && Array.isArray(steps) && steps.length === 0;
  const routed = r.status === 200 && Array.isArray(leg?.track) && leg.track.length > 1;
  return { at: new Date().toISOString(), status: r.status, ms, approximate, routed, minutes: leg?.minutes ?? null };
}

const baked = [];
const unrouted = [];
for (let i = 0; i < reads; i++) {
  baked.push(await read(bakedFrom, bakedTo));
  unrouted.push(await read(fromJob, toJob));
}
const ownMs = Math.max(...baked.map((b) => b.ms));
const limitMs = SD49_LIMIT_MS + ownMs;
const pass = baked.every((b) => b.routed) && unrouted.every((u) => u.approximate && u.ms <= limitMs);
console.log(JSON.stringify({
  task: 'P6-ROUTING-MEMORY', finding: 'F-1305', api: 'API-104', routing: 'stopped', pair: { fromJob: Number(fromJob), toJob: Number(toJob) },
  bakedPair: { fromJob: Number(bakedFrom), toJob: Number(bakedTo) }, reads, ownTimeMs: ownMs, limitMs, pass,
  unroutedMs: unrouted.map((u) => u.ms), bakedMs: baked.map((b) => b.ms), unrouted, baked,
}, null, 1));
process.exit(pass ? 0 : 1);
