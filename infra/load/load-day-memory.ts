// SPDX-License-Identifier: AGPL-3.0-or-later
// P7-LOAD (NFR-13, BUILD_PLAN section 3 D-21): the load day's memory, from 1 collect folder of infra/load/temp-server.sh and the load
// script's output file only.
//   node infra/load/load-day-memory.ts <collect folder> <load summary.json> > <memory.json>
// The window is the summary's firstRunStart to lastRunEnd (the server's own clock, as the samplers'). Over it:
//   host       NFR-13's 1 count (D-21): the cgroup sampler's host line, /proc/meminfo MemTotal - MemAvailable every 2 s; its peak as a
//              percent of MemTotal is the pass line (at most 60%), compared unrounded (F-1494: 60.045% fails; the file's peakPct is
//              rounded to 0.1 for the record, peakPctExact is the compared value).
//   hostSplit  F-1498: /proc/meminfo's parts at the host peak instant (AnonPages, Shmem, SUnreclaim, PageTables, ...), from the
//              sampler's host line; a log made before F-1498 has none (null).
//   cgroupSum  beside it, never the pass line: the containers' memory.current summed at each 2 s instant (counts reclaimable page cache).
//   services   each service's peak memory.current and anon over the window, and its cap from server-memory.txt (memory.max).
//   dockerStats beside it: each container's max of docker stats' MemUsage (every 15 s), their sum, and the max of the sum at 1 instant.
// MiB = 1048576 bytes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from '../../ci/is-main.ts';

export const NFR13_LIMIT_PCT = 60;
const MiB = 1048576;
const r1 = (n: number): number => Math.round(n * 10) / 10;
const serviceOf = (name: string): string => name.replace(/^bw-p4-load-/, '').replace(/-\d+$/, '');

/** docker stats' MemUsage left side ("200.5MiB", "1.2GiB", "512KiB", "0B") in bytes. */
export function bytesOf(s: string): number {
  const m = /^([\d.]+)\s*(B|KiB|MiB|GiB|kB|MB|GB)$/.exec(s.trim());
  if (!m) throw new Error(`load-day-memory: unreadable size '${s}'`);
  const unit = ({ B: 1, KiB: 1024, MiB, GiB: 1024 * MiB, kB: 1e3, MB: 1e6, GB: 1e9 } as Record<string, number>)[m[2]!]!;
  return Number(m[1]) * unit;
}

/** The meminfo parts of a host line (every key but total, in bytes, as the sampler writes them), or null when it has none. */
export const MEMINFO_PARTS = ['MemFree', 'Buffers', 'Cached', 'SwapCached', 'AnonPages', 'Mapped', 'Shmem', 'KReclaimable', 'SReclaimable', 'SUnreclaim', 'KernelStack', 'PageTables'] as const;
function meminfoSplit(stat: Record<string, string>): Record<string, number> | null {
  const parts = MEMINFO_PARTS.filter((k) => stat[k] !== undefined);
  return parts.length === 0 ? null : Object.fromEntries(parts.map((k) => [k, Number(stat[k])]));
}

/** The cgroup sampler's lines in [start, end] (epoch s): the host's used memory and the containers' sum at each instant. */
export interface ServicePeak { peakCurrentMiB: number; peakAnonMiB: number }
export function fromCgroupLog(text: string, ids: Record<string, string>, start: number, end: number) {
  const at = new Map<number, number>();
  const services: Record<string, ServicePeak> = {};
  let host: { usedBytes: number; totalBytes: number; t: number | null; split: Record<string, number> | null } = { usedBytes: 0, totalBytes: 0, t: null, split: null };
  let samples = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [ts, id = '', current, ...kv] = line.trim().split(/\s+/);
    const t = Number(ts);
    if (t < start || t > end) continue;
    const stat = Object.fromEntries(kv.map((x) => x.split('='))) as Record<string, string>;
    if (id === 'host') {
      samples += 1;
      if (Number(current) > host.usedBytes) host = { usedBytes: Number(current), totalBytes: Number(stat.total), t, split: meminfoSplit(stat) };
      else host.totalBytes ||= Number(stat.total);
      continue;
    }
    const name = ids[id];
    if (!name) continue;
    at.set(t, (at.get(t) ?? 0) + Number(current));
    const s = (services[name] ??= { peakCurrentMiB: 0, peakAnonMiB: 0 });
    s.peakCurrentMiB = Math.max(s.peakCurrentMiB, r1(Number(current) / MiB));
    s.peakAnonMiB = Math.max(s.peakAnonMiB, r1(Number(stat.anon ?? 0) / MiB));
  }
  let sum: { bytes: number; t: number | null } = { bytes: 0, t: null };
  for (const [t, b] of at) if (b > sum.bytes) sum = { bytes: b, t };
  return { samples, host, sum, services };
}

/**
 * docker stats lines ("HH:MM:SS <name> <cpu%> <used> / <limit>", UTC time of day, no date) in [start, end]: the date is the window's
 * first day, moved on a day each time the time of day goes back.
 */
export function fromStatsLog(text: string, start: number, end: number) {
  const d0 = new Date(start * 1000);
  let day = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()) / 1000;
  let last = -1;
  const max: Record<string, number> = {};
  const at = new Map<number, number>();
  for (const line of text.split('\n')) {
    const m = /^(\d\d):(\d\d):(\d\d) (\S+) \S+ (\S+) \/ /.exec(line);
    if (!m) continue;
    const tod = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (last >= 0 && tod < last - 60) day += 86400;
    last = tod;
    const t = day + tod;
    if (t < start || t > end) continue;
    const name = serviceOf(m[4]!);
    const b = bytesOf(m[5]!);
    max[name] = Math.max(max[name] ?? 0, r1(b / MiB));
    // 1 docker stats call lists every container within a second or 2: group by the 15 s round.
    const round = Math.floor(t / 15);
    at.set(round, (at.get(round) ?? 0) + b);
  }
  const sumOfMax = r1(Object.values(max).reduce((n, v) => n + v, 0));
  return { perContainerMaxMiB: max, sumOfMaxMiB: sumOfMax, peakInstantSumMiB: r1(Math.max(0, ...at.values()) / MiB) };
}

/** Each service's memory.max from server-memory.txt ("<svc> memory.max <bytes|max>"), in MiB. */
export function capsOf(text: string): Record<string, number | null> {
  const caps: Record<string, number | null> = {};
  for (const m of text.matchAll(/^(\S+) memory\.max (\d+|max)$/gm)) caps[m[1]!] = m[2] === 'max' ? null : r1(Number(m[2]) / MiB);
  return caps;
}

export function loadDayMemory(collect: string, summary: { firstRunStart: string; lastRunEnd: string }) {
  const start = Math.floor(Date.parse(summary.firstRunStart) / 1000);
  const end = Math.ceil(Date.parse(summary.lastRunEnd) / 1000);
  if (!(start > 0 && end > start)) throw new Error('load-day-memory: the summary has no run window');
  const ids: Record<string, string> = Object.fromEntries(readFileSync(join(collect, 'server-ids.txt'), 'utf8').trim().split('\n').map((l) => l.split(' '))
    .map(([id, name]) => [id, serviceOf(name ?? '')]));
  const c = fromCgroupLog(readFileSync(join(collect, 'server-cgroup.log'), 'utf8'), ids, start, end);
  if (c.samples === 0 || !c.host.totalBytes) throw new Error('load-day-memory: no host sample inside the run window');
  const caps = capsOf(readFileSync(join(collect, 'server-memory.txt'), 'utf8'));
  const total = c.host.totalBytes;
  const pct = (b: number): number => r1((b / total) * 100);
  const iso = (t: number | null): string | null => (t === null ? null : new Date(t * 1000).toISOString());
  const services = Object.fromEntries(Object.entries(c.services).sort().map(([k, v]) => [k, { ...v, capMiB: caps[k] ?? null }]));
  const docker = fromStatsLog(readFileSync(join(collect, 'server-stats.log'), 'utf8'), start, end);
  const hostPct = pct(c.host.usedBytes);
  const hostPctExact = (c.host.usedBytes / total) * 100;
  const hostSplit = c.host.split === null ? null : Object.fromEntries(Object.entries(c.host.split).map(([k, b]) => [k, r1(b / MiB)]));
  return {
    task: 'P7-LOAD', window: { start: summary.firstRunStart, end: summary.lastRunEnd }, hostSamples: c.samples, memTotalMiB: r1(total / MiB),
    host: { peakMiB: r1(c.host.usedBytes / MiB), peakPct: hostPct, peakPctExact: hostPctExact, at: iso(c.host.t) },
    hostSplitMiB: hostSplit,
    cgroupSum: { peakMiB: r1(c.sum.bytes / MiB), peakPct: pct(c.sum.bytes), at: iso(c.sum.t) },
    services,
    capsSumMiB: r1(Object.values(services).reduce((n, s) => n + (s.capMiB ?? 0), 0)),
    dockerStats: { ...docker, sumOfMaxPct: pct(docker.sumOfMaxMiB * MiB), peakInstantSumPct: pct(docker.peakInstantSumMiB * MiB) },
    nfr13: { count: 'host used memory, MemTotal - MemAvailable, peak over the run window (D-21)', limitPct: NFR13_LIMIT_PCT, peakPct: hostPct, passes: hostPctExact <= NFR13_LIMIT_PCT },
  };
}

if (isMain(import.meta.url)) {
  const [collect, summaryPath] = process.argv.slice(2);
  if (!collect || !summaryPath) throw new Error('usage: load-day-memory.ts <collect folder> <load summary.json>');
  console.log(JSON.stringify(loadDayMemory(collect, JSON.parse(readFileSync(summaryPath, 'utf8'))), null, 1));
}
