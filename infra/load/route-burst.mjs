// SPDX-License-Identifier: AGPL-3.0-or-later
// P6-ROUTING-MEMORY (OQ-42; SPECIFICATIONS v0.13 SD-49): the route burst. Runs in a container on the measured stack's Compose network
// (infra/load/routing-memory.sh burst), asks the `routing` service for every leg of /burst/legs.json (infra/load/routing-memory-legs.sql:
// the load day's legs the bake does not cover) with the bake's request options (infra/data/maps/bake.mjs: the full geometry, the
// duration annotation and the steps), BURST_CONCURRENCY at a time, and writes 1 JSON file: the time to the first route from the
// probe's start (polled every 0.1 s, so a service still loading its files is measured, never assumed ready), and each leg's answer time.
// SD-49's 3 s is the live client's limit; here a leg is timed to its answer (cut at 30 s), so a slow answer is counted, not hidden.
// The file carries the SHA-256 of the legs file's bytes (F-1327), so a burst names the leg list it was judged against.
//   docker run ... node /burst/route-burst.mjs <out file>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const OSRM = process.env.OSRM_URL ?? 'http://routing:5000';
const CONCURRENCY = Number(process.env.BURST_CONCURRENCY ?? '8');
const READY_LIMIT_MS = Number(process.env.BURST_READY_LIMIT_MS ?? '600000');
const LEG_LIMIT_MS = 30000;
const SD49_LIMIT_MS = 3000;
const out = process.argv[2];
if (!out) throw new Error('route-burst: an output file is required');
const legsBytes = readFileSync('/burst/legs.json');
const legsSha256 = createHash('sha256').update(legsBytes).digest('hex');
const legs = JSON.parse(legsBytes.toString('utf8'));
const options = 'overview=full&geometries=geojson&annotations=duration&steps=true';
const now = () => performance.now();
const startedAt = new Date().toISOString();
const t0 = now();

let firstRouteMs = null;
let readyTries = 0;
while (firstRouteMs === null) {
  readyTries++;
  try {
    const r = await fetch(`${OSRM}/route/v1/driving/-83.0,39.96;-83.01,39.97?overview=false`, { signal: AbortSignal.timeout(2000) });
    if (r.ok && (await r.json()).code === 'Ok') firstRouteMs = now() - t0;
  } catch {
    /* not up yet */
  }
  if (firstRouteMs === null) {
    if (now() - t0 > READY_LIMIT_MS) break;
    await new Promise((res) => setTimeout(res, 100));
  }
}

const results = [];
if (firstRouteMs !== null) {
  let next = 0;
  const worker = async () => {
    while (next < legs.length) {
      const leg = legs[next++];
      const url = `${OSRM}/route/v1/driving/${leg.from[0]},${leg.from[1]};${leg.to[0]},${leg.to[1]}?${options}`;
      const s = now();
      let ok = false;
      let error = null;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(LEG_LIMIT_MS) });
        const d = await r.json();
        ok = d.code === 'Ok' && Array.isArray(d.routes?.[0]?.legs?.[0]?.steps);
        if (!ok) error = d.code ?? `http ${r.status}`;
      } catch (e) {
        error = e.name === 'TimeoutError' ? 'timeout' : String(e.message ?? e);
      }
      results.push({ branch: leg.branch, fromRef: leg.fromRef, toRef: leg.toRef, ms: Math.round((now() - s) * 10) / 10, ok, error });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

const ms = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)] : null);
const summary = {
  task: 'P6-ROUTING-MEMORY', startedAt, endedAt: new Date().toISOString(), osrm: OSRM, options, concurrency: CONCURRENCY,
  firstRouteMs: firstRouteMs === null ? null : Math.round(firstRouteMs), readyTries,
  legsSha256, legs: legs.length, routed: ms.length, failed: results.filter((r) => !r.ok).length,
  overSd49: ms.filter((x) => x > SD49_LIMIT_MS).length,
  ms: { p50: pct(0.5), p95: pct(0.95), max: ms.length ? ms[ms.length - 1] : null },
  results,
};
writeFileSync(out, `${JSON.stringify(summary)}\n`);
console.log(`route-burst: first route ${summary.firstRouteMs} ms; ${summary.routed}/${summary.legs} routed, ${summary.failed} failed, p50 ${summary.ms.p50} p95 ${summary.ms.p95} max ${summary.ms.max} ms, ${summary.overSd49} over 3 s`);
process.exit(firstRouteMs === null || summary.failed > 0 ? 1 : 0);
