// SPDX-License-Identifier: AGPL-3.0-or-later
// P6-ROUTING-MEMORY (OQ-42): the instrument's output file, made from infra/load/routing-memory.sh's raw files only (no figure typed in).
//   node infra/load/routing-memory-summary.mjs <state out folder> <head sha> <tag:mode> [<tag:mode> ...] > <summary.json>
// Per tag (1 osrm-routed mode, N runs): per run, from that run's sampler file, the max of memory.current, anon and file for the parent cgroup
// (the whole stack) and each service; from its collect file, every cgroup's memory.peak and memory.events since the mode started (the
// counters are lifetime counters, so the last run's figures are the mode's), the container states and the routing files' disk use; from its
// burst file, the first route, the answer times and the leg list's SHA-256; from the load script's run file, the run's p95. MiB = 1048576 bytes.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [out, head, ...tags] = process.argv.slice(2);
if (!out || !head || tags.length === 0) throw new Error('usage: routing-memory-summary.mjs <out> <head> <tag:mode>...');
const PLAN_MIB = 1936;
const NFR13_MIB = Math.round(PLAN_MIB * 0.6);
const mib = (b) => Math.round((Number(b) / 1048576) * 10) / 10;
const read = (f) => readFileSync(join(out, f), 'utf8');

const idsOf = (mode) => Object.fromEntries(read(`ids-${mode}.txt`).trim().split('\n').map((l) => l.split(' ')).map(([id, s]) => [id, s]));

function sampled(file, ids) {
  const max = {};
  for (const line of read(file).trim().split('\n')) {
    const [, d, current, ...kv] = line.trim().split(/\s+/);
    const name = d === '.' ? 'stack' : ids[d];
    if (!name) continue;
    const stat = Object.fromEntries(kv.map((x) => x.split('=')));
    const m = (max[name] ??= { currentMiB: 0, anonMiB: 0, fileMiB: 0, samples: 0 });
    m.currentMiB = Math.max(m.currentMiB, mib(current));
    m.anonMiB = Math.max(m.anonMiB, mib(stat.anon ?? 0));
    m.fileMiB = Math.max(m.fileMiB, mib(stat.file ?? 0));
    m.samples++;
  }
  return max;
}

function collected(file, ids) {
  const peaks = {};
  const events = {};
  const stat = {};
  const state = {};
  let disk = null;
  let header = '';
  for (const line of read(file).trim().split('\n')) {
    const w = line.split(/\s+/);
    if (w[0] === 'collected') header = line;
    else if (w[1] === 'memory.peak') peaks[w[0] === 'parent' ? 'stack' : ids[w[0]] ?? w[0]] = { peakMiB: mib(w[2]), max: w[4] === 'max' ? 'max' : mib(w[4]) };
    else if (w[1] === 'memory.events') events[w[0] === 'parent' ? 'stack' : ids[w[0]] ?? w[0]] = Object.fromEntries(w.slice(2).reduce((a, x, i, all) => (i % 2 ? a : [...a, [x, Number(all[i + 1])]]), []));
    else if (w[1] === 'memory.stat') stat[ids[w[0]] ?? w[0]] = Object.fromEntries(w.slice(2).map((x) => x.split('=')).map(([k, v]) => [k, mib(v)]));
    else if (w[1] === 'state') state[w[0]] = w.slice(2).filter((x) => !x.startsWith('id=')).join(' ');
    else if (line.startsWith('routing files disk use')) disk = { bytes: Number(w[4]), allocatedKiB: Number(w[5]) };
  }
  return { header, peaks, events, stat, state, disk };
}

// The Compose projects on this Docker at a run's start and end (routing-memory.sh day writes them; runs before the closing cycle have none),
// less this rig's own: another lane's stack on the same machine competes for its memory and disk.
function projects(file) {
  if (!existsSync(join(out, file))) return null;
  const names = new Set();
  for (const line of read(file).trim().split('\n')) {
    const w = line.trim().split(/\s+/);
    if (w[0] && !['start', 'end', 'NAME', 'bw-w36mem'].includes(w[0])) names.add(`${w[0]} ${w.slice(1, w.findIndex((x, i) => i > 0 && x.startsWith('/'))).join(' ')}`.trim());
  }
  return [...names];
}

const modes = tags.map((t) => {
  const [tag, mode] = t.split(':');
  const ids = idsOf(existsSync(join(out, `ids-${tag}.txt`)) ? tag : mode);
  const runs = [];
  for (let n = 1; existsSync(join(out, `collect-${tag}-${n}.txt`)); n++) {
    const burst = JSON.parse(read(`burst-${tag}-${n}.json`));
    const runFile = join(out, `load-${tag}`, `${tag}-run-${String(n).padStart(2, '0')}.json`);
    let load = null;
    if (existsSync(runFile)) {
      const r = JSON.parse(readFileSync(runFile, 'utf8'));
      const d = [...r.delaysMs].sort((a, b) => a - b);
      load = { startedAt: r.startedAt, endedAt: r.endedAt, samples: d.length, p95Ms: d.length ? Math.round(d[Math.ceil(0.95 * d.length) - 1]) : null, lost: r.lost, writesApplied: r.writesApplied, writesFailed: r.writesFailed };
    }
    runs.push({
      run: n,
      sampledMax: sampled(`samples-${tag}-${n}.log`, ids),
      burst: { startedAt: burst.startedAt, legsSha256: burst.legsSha256 ?? null, concurrency: burst.concurrency, firstRouteMs: burst.firstRouteMs, legs: burst.legs, routed: burst.routed, failed: burst.failed, overSd49: burst.overSd49, ms: burst.ms },
      load,
      collected: collected(`collect-${tag}-${n}.txt`, ids),
      otherProjects: projects(`projects-${tag}-${n}.txt`),
    });
  }
  const last = runs[runs.length - 1].collected;
  const spread = (pick) => {
    const v = runs.map(pick).filter((x) => typeof x === 'number');
    return { min: Math.min(...v), max: Math.max(...v) };
  };
  const svcNames = Object.keys(runs[0].sampledMax).filter((s) => s !== 'stack');
  return {
    tag, mode, runs: runs.length, setting: last.header,
    peakMiB: last.peaks, events: last.events, endStat: last.stat, state: last.state, disk: last.disk,
    stackPeakPercentOfPlan: Math.round((last.peaks.stack.peakMiB / PLAN_MIB) * 1000) / 10,
    perRunSampledSpread: Object.fromEntries(['stack', ...svcNames].map((s) => [s, {
      currentMiB: spread((r) => r.sampledMax[s]?.currentMiB), anonMiB: spread((r) => r.sampledMax[s]?.anonMiB), fileMiB: spread((r) => r.sampledMax[s]?.fileMiB),
    }])),
    burstP95Ms: spread((r) => r.burst.ms.p95), burstFirstRouteMs: runs.map((r) => r.burst.firstRouteMs), burstFailed: runs.reduce((a, r) => a + r.burst.failed, 0),
    burstOverSd49: runs.reduce((a, r) => a + r.burst.overSd49, 0),
    loadP95Ms: runs.map((r) => r.load?.p95Ms ?? null),
    perRun: runs,
  };
});

console.log(JSON.stringify({
  task: 'P6-ROUTING-MEMORY', question: 'OQ-42', head, madeAt: new Date().toISOString(),
  where: "this Mac's Docker (Docker Desktop VM), the stack inside 1 parent cgroup shaped as Lightsail small_3_0: cpu.max 2 CPUs, and memory.max 1936 MiB (plan=plan) or no memory limit (plan=none), as each mode's setting says",
  planMiB: PLAN_MIB, nfr13LimitMiB: NFR13_MIB, sd49LimitMs: 3000, modes,
}, null, 1));
