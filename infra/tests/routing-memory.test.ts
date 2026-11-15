// SPDX-License-Identifier: AGPL-3.0-or-later
// P6-ROUTING-MEMORY (OQ-42): the record's verdict and figures follow from the instrument's output file, and the routing cap follows the
// verdict. docs/build/spikes/P6-ROUTING-MEMORY.summary.json is made by infra/load/routing-memory-summary.mjs (the Mac-shaped rig) and
// infra/load/routing-memory-server-summary.mjs (the temporary small_3_0 copy) from the raw files only.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');
type Spread = { min: number; max: number };
type Mode = { tag: string; mode: string; runs: number; peakMiB: Record<string, { peakMiB: number }>; stackPeakPercentOfPlan: number; burstP95Ms: Spread; disk: { bytes: number } };
type Server = {
  instancePlan: string; head: string; planMiB: number; nfr13LimitMiB: number; sd49LimitMs: number; runs: number; stopped: string | null;
  stackSampledMaxMiB: Spread; hostUsedMaxMiB: Spread; stackPercentOfPlan: number; dockerStatsPercentOfPlan: number; hostUsedPercentOfPlan: number;
  routingSampledMaxMiB: Spread; peaks: Record<string, { peakMiB: number }>; burstP95Ms: Spread; burstRouted: string[]; burstOverSd49: number;
  state: Record<string, string>; disk: { routingFilesBytes: number }; perRun: { burst: { startedAt: string } }[];
};
type Capped = Server & {
  routingCap: number; squeezeFactor: number; loadP95Ms: number[]; stackSamples: number; stackSamplesOverLimit: number[];
  events: Record<string, { oom_kill: number }>; nonRoutingMaxMiB: Spread;
  loadCpu: { burstCapacityPercent: Spread | null }[];
};
type CapBasis = {
  nfr13LimitMiB: number; nonRoutingMaxMiB: number; nonRoutingAtStackPeakMaxMiB: number; nonRoutingOwnPeaksSumMiB: number;
  roomAtMaxMiB: number; roomAtOwnPeaksMiB: number; capMiB: number; marginMiB: number;
  uncapped: { squeezeFactor: number; loadP95Ms: number[]; loadCpu: { burstCapacityPercent: Spread | null }[] };
};
type Burst = { legs: number; routed: number; legsSha256: string | null; firstRouteMs: number | null; ms: { p95: number | null; max: number | null } };
type CloseMode = {
  tag: string; setting: string; passes: boolean; runs: number; peakMiB: Record<string, { peakMiB: number }>; events: Record<string, { max: number; oom_kill: number }>;
  state: Record<string, string>; perRun: { burst: Burst; load: { p95Ms: number } | null; otherProjects: string[] | null }[];
};
type LegsCheck = { ok: boolean; listSha256: string; listFileSha256: string | null; listKeys: number; bursts: { file: string; routed: number; setEqual: boolean; legsSha256: string | null; shaMatches: boolean | null }[] };
const summary = JSON.parse(read('docs/build/spikes/P6-ROUTING-MEMORY.summary.json')) as {
  head: string; mac: { modes: Mode[] }; server: Server & { perRun: { dockerStats: { stackMaxMiB: number } }[]; vmstat: { idleAvg: Spread; stealAvg: Spread } };
  serverCap: Capped; capBasis: CapBasis;
  macClose: { head: string; appHead: string; passLine: string; modes: CloseMode[]; localCap: { uncappedPeakMiB: number; capMiB: number; marginMiB: number };
    unroutedReads: { pass: boolean; reads: number; unroutedMs: number[]; bakedMs: number[]; ownTimeMs: number; limitMs: number; pair: { fromJob: number; toJob: number } } };
  legsCheck: { server: LegsCheck; mac: LegsCheck };
};
const record = read('docs/build/spikes/P6-ROUTING-MEMORY.md');
const s = summary.server;
const c = summary.serverCap;
const basis = summary.capBasis;
const capSection = record.slice(record.indexOf('## Capped routing'), record.indexOf('## Teardown'));
const uncappedPart = record.replace(capSection, '');
const SERVICES = ['proxy', 'web', 'worker', 'pbs', 'db', 'routing'];
const routes = (r: string): boolean => { const [a, b] = r.split('/').map(Number); return a! * 10 >= b! * 9; };
const allRouted = (r: string): boolean => { const [a, b] = r.split('/').map(Number); return a === b; };
// NFR-13's count is host used memory (BUILD_PLAN section 3 D-21; owner answer 8936427c); the cgroup sum and docker stats sit beside it.
const fits = s.stopped === null && s.burstRouted.every(routes) && s.burstP95Ms.max <= s.sd49LimitMs && s.hostUsedPercentOfPlan <= 60;
// The capped verdict (W36-ROUTING-CAP): all 5 runs, every leg routed, route p95 within SD-49, 0 kills or restarts, host used within 60%.
const capFits = c.stopped === null && c.runs === 5 && c.burstRouted.every(allRouted) && c.burstP95Ms.max <= c.sd49LimitMs
  && SERVICES.every((svc) => c.events[svc]?.oom_kill === 0 && / restarts=0 /.test(c.state[svc] ?? ''))
  && c.hostUsedPercentOfPlan <= 60;
const verdictLine = /^Verdict: .*$/m.exec(record)?.[0] ?? '';
const closeSection = record.slice(record.indexOf('## Local copies'), record.indexOf('## Teardown'));
const one = (n: number): string => n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

describe('P6-ROUTING-MEMORY record (OQ-42)', () => {
  // why: OQ-42 the hosted plan's answer is measured on a copy of small_3_0 with every service and both osrm-routed modes, never assumed
  it('holds, for both osrm-routed modes, each service peak, the stack against the plan, the files disk use and the route p95', () => {
    expect(s.instancePlan).toBe('small_3_0');
    expect(s.head).toBe(summary.head);
    expect(s.runs).toBeGreaterThanOrEqual(1);
    expect(s.planMiB).toBeGreaterThan(1900);
    expect(s.nfr13LimitMiB).toBeCloseTo(s.planMiB * 0.6, 0);
    for (const svc of SERVICES) expect(s.peaks[svc]?.peakMiB, `server ${svc}`).toBeGreaterThan(0);
    expect(s.disk.routingFilesBytes).toBe(2693340724);
    const modes = new Set(summary.mac.modes.map((m) => m.mode));
    expect([...modes].sort()).toEqual(['load', 'mmap']);
    for (const m of summary.mac.modes) {
      for (const svc of SERVICES) expect(m.peakMiB[svc]?.peakMiB, `${m.tag} ${svc}`).toBeGreaterThan(0);
      expect(m.disk.bytes).toBe(2693340724);
      expect(m.stackPeakPercentOfPlan).toBeGreaterThan(0);
    }
  });

  // why: F-1320 the verdict states D-21's NFR-13 count and all 3 counts beside the fact that routing works, for both settings
  it('states the verdict by host used memory, and gives all 3 counts of both settings from the instrument file', () => {
    expect(verdictLine).toMatch(capFits ? /^Verdict: YES, capped/ : /^Verdict: NO/);
    expect(verdictLine).toContain('host used memory');
    for (const x of [c, s]) {
      for (const pct of [x.hostUsedPercentOfPlan, x.dockerStatsPercentOfPlan, x.stackPercentOfPlan]) expect(verdictLine).toContain(`${pct}%`);
      expect(verdictLine).toContain(`route p95 ${one(x.burstP95Ms.min)} to ${one(x.burstP95Ms.max)} ms`);
    }
    expect(verdictLine).toContain('515 of 515');
    expect(uncappedPart).toContain(`By D-21's count (host used) the uncapped stack is ${fits ? 'within' : 'over'} 60%`);
    expect(verdictLine).toContain(one(c.hostUsedMaxMiB.max));
    expect(record).toContain(Math.round(s.stackSampledMaxMiB.max).toLocaleString('en-US'));
    expect(record).toContain(`head ${s.head}`);
    // F-1325: no line pre-empts the owner's choice of count
    expect(record).not.toMatch(/final no/i);
  });

  // why: F-1320 the record quotes the owner's answer with its option text and gives the cap this cycle set
  it("quotes owner answer 8936427c and names the cap set for each kind of copy", () => {
    expect(record).toContain('owner answer 8936427c (Nov 10, 2026, 12:15 PM EST), option "Keep it, capped (Recommended)": "Routing works and nothing crashed');
    const compose = read('infra/compose.yaml');
    const set = /^ {4}mem_limit: (\$\{ROUTING_MEM_LIMIT:-[0-9]+m\})$/m.exec(compose.slice(compose.indexOf('\n  routing:\n')))?.[1];
    expect(set).toBeDefined();
    const capParagraph = record.slice(record.indexOf('## The routing service'), record.indexOf('## Capped routing'));
    for (const text of [record.slice(record.indexOf('Owner rulings:'), record.indexOf('## What was measured')), capParagraph]) {
      expect(text).toContain(`mem_limit: ${set}`);
      expect(text).toContain('320m');
    }
  });

  // why: OQ-42 a record that says 515 of 515 is held to every burst routing every leg, not only the stop rule's 90% floor (F-1323)
  it('fails on any unrouted leg where the record claims every leg routed', () => {
    for (const [text, runs] of [[uncappedPart, s], [capSection, c]] as const) {
      if (/515 of 515/.test(text)) for (const r of runs.burstRouted) expect(r, 'burst claimed 515 of 515').toBe('515/515');
    }
  });

  // why: OQ-42 the capped run's cap follows from row 545's largest other-services sum over every sample, with its margin (F-1321)
  it('derives the tested cap from the largest other-services sum, states the bounds, and ran at that cap', () => {
    expect(basis.roomAtMaxMiB).toBeCloseTo(basis.nfr13LimitMiB - basis.nonRoutingMaxMiB, 1);
    expect(basis.roomAtOwnPeaksMiB).toBeCloseTo(basis.nfr13LimitMiB - basis.nonRoutingOwnPeaksSumMiB, 1);
    expect(basis.capMiB + basis.nonRoutingMaxMiB + basis.marginMiB).toBeCloseTo(basis.nfr13LimitMiB, 1);
    expect(basis.marginMiB).toBeGreaterThanOrEqual(0);
    expect(basis.nonRoutingMaxMiB).toBeGreaterThanOrEqual(basis.nonRoutingAtStackPeakMaxMiB);
    expect(c.routingCap).toBe(basis.capMiB);
    expect(c.peaks.routing!.peakMiB).toBeLessThanOrEqual(basis.capMiB);
    for (const n of [basis.nonRoutingMaxMiB, basis.roomAtMaxMiB, basis.nonRoutingOwnPeaksSumMiB, basis.roomAtOwnPeaksMiB]) expect(capSection).toContain(one(n));
    expect(capSection).toContain(`${basis.capMiB} MiB with a margin of ${one(basis.marginMiB)} MiB`);
  });

  // why: OQ-42 the capped verdict the owner acts on follows from the capped run's figures, quoted from the instrument file
  it('states the capped verdict the figures give, and quotes them', () => {
    expect(c.instancePlan).toBe('small_3_0');
    expect(capSection).toMatch(capFits ? /^Capped-run verdict: YES by D-21's count/m : /^Capped-run verdict: NO/m);
    expect(capSection).toContain(`head ${c.head}`);
    expect(capSection).toContain(`${c.stackPercentOfPlan}%`);
    expect(capSection).toContain(one(c.stackSampledMaxMiB.max));
    expect(capSection).toContain(`route p95 ${one(c.burstP95Ms.min)} to ${one(c.burstP95Ms.max)} ms`);
    const over = c.stackSamplesOverLimit.reduce((a, b) => a + b, 0);
    expect(capSection).toContain(`${over} of ${c.stackSamples.toLocaleString('en-US')} samples`);
    expect(capSection).toContain(`${c.dockerStatsPercentOfPlan}%`);
    expect(capSection).toContain(`${c.hostUsedPercentOfPlan}%`);
  });

  // why: OQ-42 the record says whether capping changes the load day, beside the uncapped runs, at the same squeeze and burst capacity
  it('quotes each run load-day p95, the squeeze and the burst capacity of both settings', () => {
    expect(c.squeezeFactor).toBe(basis.uncapped.squeezeFactor);
    expect(capSection).toContain(`squeeze ${c.squeezeFactor}`);
    for (const p of [...c.loadP95Ms, ...basis.uncapped.loadP95Ms]) expect(capSection).toContain(p.toLocaleString('en-US'));
    const burst = [...c.loadCpu, ...basis.uncapped.loadCpu].map((x) => x.burstCapacityPercent);
    if (burst.every((b) => b?.max === 0)) expect(capSection).toContain('Burst capacity read 0% in every 5-minute period of both sets');
  });

  // why: F-1324 the record's cells and scope lines say what the instrument file says
  it('gives the docker stats cells, the files-loaded service peaks, the squeeze reason and the Mac-rig scope as the file does', () => {
    const rows = uncappedPart.split('\n').filter((l) => /^\| [1-5] \| 515\/515 \|/.test(l)).slice(0, 5);
    expect(rows).toHaveLength(5);
    rows.forEach((row, i) => expect(row.split('|').map((x) => x.trim())[8], `run ${i + 1} docker stats`).toBe(s.perRun[i]!.dockerStats.stackMaxMiB.toFixed(1)));
    const load = summary.mac.modes.find((m) => m.tag === 'load')!;
    expect(record).toContain(`web ${one(load.peakMiB.web!.peakMiB)}, db ${one(load.peakMiB.db!.peakMiB)}, worker ${one(load.peakMiB.worker!.peakMiB)}, pbs ${one(load.peakMiB.pbs!.peakMiB)}, proxy ${one(load.peakMiB.proxy!.peakMiB)}`);
    expect(record).toMatch(/600 s at squeeze 70\.6 so that/);
    expect(record).toContain('below the routing service\'s working set is a Mac-rig result');
  });

  // why: F-1326 the load-day text quotes the vmstat averages by column name and claims no CPU cause
  it("quotes the uncapped runs' idle and steal averages and claims no CPU cause", () => {
    const v = summary.server.vmstat;
    expect(capSection).toContain(`idle ${one(v.idleAvg.min)} to ${one(v.idleAvg.max)}% and steal ${one(v.stealAvg.min)} to ${one(v.stealAvg.max)}%`);
    expect(v.idleAvg.min).toBeGreaterThan(50);
    expect(capSection).toContain('no CPU cause is claimed');
  });

  // why: F-1327 the leg list both small_3_0 runs were judged against is committed, named by its hash, and the set check re-runs from it
  it('names the committed leg list and its SHA-256, and every burst routed exactly its keys', () => {
    const { server, mac } = summary.legsCheck;
    expect(server.ok).toBe(true);
    expect(server.listKeys).toBe(515);
    expect(server.bursts).toHaveLength(10);
    for (const b of server.bursts) expect([b.file, b.setEqual, b.routed]).toEqual([b.file, true, 515]);
    expect(record).toContain('`.build/evidence/W36-ROUTING-LEGS/legs.json.gz` (commit 74c32cb5)');
    expect(record).toContain(server.listSha256);
    expect(mac.listSha256).toBe(server.listSha256);
    for (const b of mac.bursts) expect([b.setEqual, b.legsSha256, b.shaMatches]).toEqual([true, server.listSha256, true]);
    for (const m of summary.macClose.modes) for (const r of m.perRun) expect(r.burst.legsSha256).toBe(server.listSha256);
  });

  // why: F-1322 the Mac local-copy run is recorded with its pass line, and the local cap follows from it
  it('records the Mac run at 320m and at the measured local cap, each against the pass line, with the other projects', () => {
    const mc = summary.macClose;
    const pass = (m: CloseMode): boolean => m.perRun.every((r) => r.burst.routed === r.burst.legs && r.burst.ms.p95 !== null && r.burst.ms.p95 <= 3000)
      && m.events.routing!.oom_kill === 0 && / restarts=0 /.test(`${m.state.routing} `);
    const c320 = mc.modes.find((m) => / cap=320m /.test(m.setting))!;
    const local = mc.modes.find((m) => new RegExp(` cap=${mc.localCap.capMiB}m `).test(m.setting))!;
    for (const m of [c320, local]) {
      expect(m.passes).toBe(pass(m));
      expect(m.setting).toContain('plan=none');
      for (const r of m.perRun) expect(r.otherProjects, 'the other projects are listed').not.toBeNull();
    }
    expect(closeSection).toMatch(pass(c320) ? /320 MiB passes/ : /^Local-copy verdict: 320 MiB fails on this Mac's rig; the measured local cap, \d+m, passes/m);
    if (!pass(c320)) {
      expect(c320.runs, 'a failing run 1 is not repeated').toBe(1);
      expect(pass(local)).toBe(true);
      expect(local.runs).toBe(1);
      expect(mc.localCap.capMiB).toBeCloseTo(mc.localCap.uncappedPeakMiB + mc.localCap.marginMiB, 1);
      expect(closeSection).toContain(`${one(mc.localCap.uncappedPeakMiB).replace(/^(\d)(\d{3})/, '$1,$2')} MiB`);
      expect(closeSection).toContain(`margin of ${one(mc.localCap.marginMiB)} MiB`);
    }
    for (const m of [c320, local]) {
      const b = m.perRun[0]!.burst;
      expect(closeSection).toContain(`${b.routed} of ${b.legs}`);
      expect(closeSection).toContain(b.ms.p95!.toLocaleString('en-US', { minimumFractionDigits: 1 }));
    }
    expect(closeSection).toContain(`head ${mc.head}`);
    expect(closeSection).toContain(`app code ${mc.appHead}`);
  });

  // why: F-1305 with routing stopped, API-104 reads of an unrouted pair answer approximate within SD-49's 3 s plus the read's own time
  it('times 5 API-104 reads of 1 unrouted pair with routing stopped', () => {
    const u = summary.macClose.unroutedReads;
    expect(u.reads).toBe(5);
    expect(u.pass).toBe(true);
    expect(u.limitMs).toBeCloseTo(3000 + u.ownTimeMs, 1);
    for (const ms of u.unroutedMs) expect(ms).toBeLessThanOrEqual(u.limitMs);
    const list = (xs: number[]): string => `${xs.slice(0, -1).map(one).join(', ')} and ${one(xs.at(-1)!)} ms`;
    expect(closeSection).toContain(list(u.unroutedMs));
    expect(closeSection).toContain(list(u.bakedMs));
    expect(closeSection).toContain(`job ${u.pair.fromJob} back to job ${u.pair.toJob}`);
  });
});
