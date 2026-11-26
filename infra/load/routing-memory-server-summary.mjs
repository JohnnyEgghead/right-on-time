// SPDX-License-Identifier: AGPL-3.0-or-later
// P6-ROUTING-MEMORY (OQ-42): the temporary server's figures, made from infra/load/routing-memory-server.sh's raw files only.
//   node infra/load/routing-memory-server-summary.mjs <state folder> <tag> <plan> <head> > <summary.json>
// Per run: from collect-<tag>-<n>/server-cgroup.log (every 2 s), the max of each service's memory.current, anon and file, the max of
// the services' sum at 1 instant (the stack), and the max of the host's used memory (MemTotal - MemAvailable); from server-memory.txt,
// each service's memory.peak, memory.events and state (lifetime counters: the last run's are the setting's); the routing files' disk use;
// the burst file; the load script's run file. MiB = 1048576 bytes. The plan's memory is the host's MemTotal.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, tag, plan, head] = process.argv.slice(2);
if (!dir || !tag || !plan || !head) throw new Error('usage: routing-memory-server-summary.mjs <dir> <tag> <plan> <head>');
const mib = (b) => Math.round((Number(b) / 1048576) * 10) / 10;
const SERVICES = ['proxy', 'web', 'worker', 'pbs', 'db', 'routing'];

const runs = [];
let planMiB = null;
for (let n = 1; existsSync(join(dir, `collect-${tag}-${n}`)); n++) {
  const c = join(dir, `collect-${tag}-${n}`);
  const ids = Object.fromEntries(readFileSync(join(c, 'server-ids.txt'), 'utf8').trim().split('\n').map((l) => l.split(' '))
    .map(([id, name]) => [id, name.replace(/^bw-p4-load-/, '').replace(/-1$/, '')]));
  const max = {};
  const at = {};
  let host = 0;
  for (const line of readFileSync(join(c, 'server-cgroup.log'), 'utf8').trim().split('\n')) {
    const [t, id, current, ...kv] = line.split(/\s+/);
    const stat = Object.fromEntries(kv.filter(Boolean).map((x) => x.split('=')));
    if (id === 'host') {
      host = Math.max(host, mib(current));
      planMiB = mib(stat.total);
      continue;
    }
    const s = ids[id];
    if (!SERVICES.includes(s)) continue;
    const m = (max[s] ??= { currentMiB: 0, anonMiB: 0, fileMiB: 0 });
    m.currentMiB = Math.max(m.currentMiB, mib(current));
    m.anonMiB = Math.max(m.anonMiB, mib(stat.anon ?? 0));
    m.fileMiB = Math.max(m.fileMiB, mib(stat.file ?? 0));
    const a = (at[t] ??= { current: 0, anon: 0, file: 0, nonRouting: 0 });
    a.current += Number(current);
    if (s !== 'routing') a.nonRouting += Number(current);
    a.anon += Number(stat.anon ?? 0);
    a.file += Number(stat.file ?? 0);
  }
  const instants = Object.values(at);
  max.stack = {
    currentMiB: mib(Math.max(...instants.map((x) => x.current))), anonMiB: mib(Math.max(...instants.map((x) => x.anon))), fileMiB: mib(Math.max(...instants.map((x) => x.file))),
  };
  // W36-ROUTING-CAP: the services other than routing, summed at 1 instant: their max, and their sum at the stack's peak instant.
  const peakInstant = instants.reduce((p, x) => (x.current > p.current ? x : p));
  max.nonRouting = { maxMiB: mib(Math.max(...instants.map((x) => x.nonRouting))), atStackPeakMiB: mib(peakInstant.nonRouting) };
  max.samples = { count: instants.length, overNfr13: planMiB === null ? null : instants.filter((x) => mib(x.current) > Math.round(planMiB * 0.6 * 10) / 10).length };
  const peaks = {};
  const events = {};
  const state = {};
  const endStat = {};
  for (const line of readFileSync(join(c, 'server-memory.txt'), 'utf8').trim().split('\n')) {
    const w = line.trim().split(/\s+/);
    if (!SERVICES.includes(w[0])) continue;
    if (w[1] === 'memory.peak') (peaks[w[0]] ??= {}).peakMiB = mib(w[2]);
    else if (w[1] === 'memory.max') (peaks[w[0]] ??= {}).max = w[2] === 'max' ? 'max' : mib(w[2]);
    else if (w[1] === 'memory.events') events[w[0]] = Object.fromEntries(w.slice(2).reduce((acc, x, i, all) => (i % 2 ? acc : [...acc, [x, Number(all[i + 1])]]), []));
    else if (w[1] === 'state') state[w[0]] = w.slice(2).join(' ');
    else if (w[1] === 'memory.stat') endStat[w[0]] = Object.fromEntries(w.slice(2).map((x) => x.split('=')).map(([k, v]) => [k, mib(v)]));
  }
  // The load day's memory measure: docker stats' MemUsage (memory.current less inactive file cache), every 15 s; the max of the services' sum.
  const unit = { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024 };
  const statsAt = {};
  const statsMax = {};
  for (const line of readFileSync(join(c, 'server-stats.log'), 'utf8').split('\n')) {
    const m = /^(\S+) bw-p4-load-(\w+)-1 [\d.]+% ([\d.]+)(B|KiB|MiB|GiB) \//.exec(line);
    if (!m || !SERVICES.includes(m[2])) continue;
    const v = Number(m[3]) * unit[m[4]];
    statsAt[m[1]] = (statsAt[m[1]] ?? 0) + v;
    statsMax[m[2]] = Math.max(statsMax[m[2]] ?? 0, Math.round(v * 10) / 10);
  }
  const dockerStats = { stackMaxMiB: Math.round(Math.max(...Object.values(statsAt)) * 10) / 10, serviceMaxMiB: statsMax };
  const disk = readFileSync(join(c, 'server-disk.txt'), 'utf8').trim().split('\n');
  const burst = JSON.parse(readFileSync(join(dir, `burst-${tag}-${n}.json`), 'utf8'));
  const runFile = join(dir, 'out', `${tag}-run-${String(n).padStart(2, '0')}.json`);
  let load = null;
  if (existsSync(runFile)) {
    const r = JSON.parse(readFileSync(runFile, 'utf8'));
    const d = [...r.delaysMs].sort((x, y) => x - y);
    load = { startedAt: r.startedAt, endedAt: r.endedAt, samples: d.length, p95Ms: d.length ? Math.round(d[Math.ceil(0.95 * d.length) - 1]) : null, lost: r.lost };
  }
  // W36-ROUTING-CAP: the instance's CPU and burst capacity (Lightsail 5-minute averages) in the periods that overlap the load-day run.
  const metric = (m) => {
    const f = join(c, `aws-metric-${m}.txt`);
    if (!load || !existsSync(f)) return null;
    const [from, to] = [Date.parse(load.startedAt) - 300000, Date.parse(load.endedAt)];
    const v = readFileSync(f, 'utf8').trim().split('\n').map((l) => l.split('\t')).filter(([t]) => Date.parse(t) > from && Date.parse(t) <= to)
      .map(([, x]) => Math.round(Number(x) * 10) / 10);
    return v.length ? { min: Math.min(...v), max: Math.max(...v), periods: v.length } : null;
  };
  const cpu = { cpuPercent: metric('CPUUtilization'), burstCapacityPercent: metric('BurstCapacityPercentage') };
  runs.push({
    run: n, sampledMax: max, dockerStats, hostUsedMaxMiB: host, peaks, events, state, endStat,
    disk: { routingFilesBytes: Number(disk[0]), mapsFolderKiB: Number(disk[1]), df: disk[2] },
    burst: { startedAt: burst.startedAt, firstRouteMs: burst.firstRouteMs, legs: burst.legs, routed: burst.routed, failed: burst.failed, overSd49: burst.overSd49, ms: burst.ms },
    load, cpu,
  });
}
const loadSummaryFile = join(dir, 'out', `${tag}-summary.json`);
const squeezeFactor = existsSync(loadSummaryFile) ? JSON.parse(readFileSync(loadSummaryFile, 'utf8')).squeezeFactor : null;
if (runs.length === 0) throw new Error(`no collect-${tag}-<n> folders in ${dir}`);
const last = runs[runs.length - 1];
const spread = (pick) => {
  const v = runs.map(pick).filter((x) => typeof x === 'number');
  return { min: Math.min(...v), max: Math.max(...v) };
};
const nfr13LimitMiB = Math.round(planMiB * 0.6 * 10) / 10;
console.log(JSON.stringify({
  task: 'P6-ROUTING-MEMORY', question: 'OQ-42', rig: 'temporary Lightsail copy', instancePlan: plan, head, tag, madeAt: new Date().toISOString(),
  stopped: existsSync(join(dir, `stopped-${tag}.txt`)) ? readFileSync(join(dir, `stopped-${tag}.txt`), 'utf8').trim() : null,
  planMiB, nfr13LimitMiB, sd49LimitMs: 3000, runs: runs.length,
  stackSampledMaxMiB: spread((r) => r.sampledMax.stack.currentMiB), stackAnonMaxMiB: spread((r) => r.sampledMax.stack.anonMiB),
  stackPercentOfPlan: Math.round((Math.max(...runs.map((r) => r.sampledMax.stack.currentMiB)) / planMiB) * 1000) / 10,
  hostUsedMaxMiB: spread((r) => r.hostUsedMaxMiB),
  dockerStatsStackMaxMiB: spread((r) => r.dockerStats.stackMaxMiB),
  dockerStatsPercentOfPlan: Math.round((Math.max(...runs.map((r) => r.dockerStats.stackMaxMiB)) / planMiB) * 1000) / 10,
  hostUsedPercentOfPlan: Math.round((Math.max(...runs.map((r) => r.hostUsedMaxMiB)) / planMiB) * 1000) / 10,
  routingSampledMaxMiB: spread((r) => r.sampledMax.routing?.currentMiB), routingAnonMaxMiB: spread((r) => r.sampledMax.routing?.anonMiB),
  peaks: last.peaks, events: last.events, state: last.state, disk: last.disk,
  burstP95Ms: spread((r) => r.burst.ms.p95), burstRouted: runs.map((r) => `${r.burst.routed}/${r.burst.legs}`), burstOverSd49: runs.reduce((a, r) => a + r.burst.overSd49, 0),
  loadP95Ms: runs.map((r) => r.load?.p95Ms ?? null),
  squeezeFactor, routingCap: last.peaks.routing?.max ?? null,
  nonRoutingMaxMiB: spread((r) => r.sampledMax.nonRouting.maxMiB), nonRoutingAtStackPeakMiB: spread((r) => r.sampledMax.nonRouting.atStackPeakMiB),
  stackPerSampleOverLimit: runs.some((r) => r.sampledMax.stack.currentMiB > nfr13LimitMiB),
  stackSamples: runs.reduce((a, r) => a + r.sampledMax.samples.count, 0), stackSamplesOverLimit: runs.map((r) => r.sampledMax.samples.overNfr13),
  loadCpu: runs.map((r) => r.cpu),
  perRun: runs,
}, null, 1));
