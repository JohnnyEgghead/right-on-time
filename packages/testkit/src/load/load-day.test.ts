// SPDX-License-Identifier: AGPL-3.0-or-later
// P7-LOAD: the load day's NFR-02 and NFR-03 counting held to known answers, and the record's figures against the script's output files
// (docs/build/spikes/P7-LOAD.summary.json from the load script, P7-LOAD.memory.json from infra/load/load-day-memory.ts).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addedLatencyMs, OFFICE_PAGES, spkiHash } from './pages.ts';
import { causeOf, READ_ERRORS_KEPT, Reads, vanRoutesOf } from './run.ts';
import { endStateOf, nfr02Passes, nfr03Of, NFR_02_P95_LIMIT_S, OFFICE_PROFILE, poolPages, runSetProblem, type Nfr03Run, type PageCounts } from './stats.ts';

const pages = (coldMs: number[], over: Partial<PageCounts> = {}): PageCounts => ({ coldMs, warmMs: coldMs.map((m) => m / 2), errors: 0, errorsBy: {}, ...over });
const oneTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
const clean = (over: Partial<Nfr03Run> = {}): Nfr03Run => ({
  delaysMs: [1], lost: 0, writesPlanned: 1, writesApplied: 1, writesRefused: 0, writesFailed: 0, boardReadErrors: 0, vanReadErrors: 0, pageErrors: 0,
  endState: { jobs: 600, matched: 600, behind: 0, ahead: 0, missing: 0 }, endStateErrors: 0, ...over,
});

describe('page loads on the office profile', () => {
  // why: NFR-02
  it('pools every cold load of every run, and counts a failed load as slower than anything measured', () => {
    const p = poolPages([pages(oneTo(50)), pages(oneTo(50).map((n) => n + 50))]);
    expect(p.samples).toBe(100);
    expect(p.p95Ms).toBe(95);
    expect(p.warmP95Ms).toBe(47.5);
    // 6 failed loads in 100 attempts push the rank-95 value past every measured load
    expect(poolPages([pages(oneTo(94), { errors: 6 })]).p95Ms).toBe(Number.POSITIVE_INFINITY);
  });

  // why: NFR-02
  it('passes NFR-02 only with the required runs, no failed load and a cold p95 under 2 s', () => {
    const fast = Array.from({ length: 5 }, () => pages(oneTo(100).map((n) => n * 10)));
    expect(NFR_02_P95_LIMIT_S).toBe(2);
    expect(nfr02Passes(poolPages(fast), 5)).toBe(true);
    expect(nfr02Passes(poolPages(fast.slice(0, 4)), 5)).toBe(false);
    expect(nfr02Passes(poolPages([...fast.slice(1), pages(oneTo(100), { errors: 1 })]), 5)).toBe(false);
    expect(nfr02Passes(poolPages(Array.from({ length: 5 }, () => pages(oneTo(100).map((n) => n * 22)))), 5)).toBe(false);
    expect(nfr02Passes(poolPages(Array.from({ length: 5 }, () => pages([]))), 5)).toBe(false);
  });

  // why: NFR-02 the profile is 50 Mbps and a 20 ms round trip; the real round trip counts toward it and is never made faster
  it('adds only the latency the real round trip lacks', () => {
    expect(OFFICE_PROFILE).toEqual({ mbps: 50, rttMs: 20 });
    expect(addedLatencyMs(4.4)).toBe(16);
    expect(addedLatencyMs(20)).toBe(0);
    expect(addedLatencyMs(31.2)).toBe(0);
  });

  // why: NFR-02 the probe trusts the server's own certificate by its key, so Chromium caches and a warm load is a warm load
  it('names the certificate by the SHA-256 of its public key, as Chromium\'s SPKI list wants', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bw-spki-'));
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=t', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
      const want = execFileSync('sh', ['-c', `openssl x509 -in "${join(dir, 'c.pem')}" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`], { encoding: 'utf8' }).trim();
      expect(spkiHash(readFileSync(join(dir, 'c.pem'), 'utf8'))).toBe(want);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // why: NFR-02 the probe opens every office page a dispatcher's day uses, each a real route of the web app
  it('probes office pages that exist', () => {
    for (const p of OFFICE_PAGES) {
      const route = p.split('?')[0]!.replace('{job}', '[jobNumber]');
      expect(existsSync(new URL(`../../../../apps/web/app${route}/page.tsx`, import.meta.url)), route).toBe(true);
    }
  });

  // why: F-1494 NFR-02's p95 is over cold loads: a failed warm load is an error (NFR-03) but is never ranked as a cold load
  it('ranks only the failed cold loads into the cold p95, and counts every failure as an error', () => {
    // 94 measured, 3 cold and 6 warm failures: 97 cold attempts, rank 93 is a measured load
    const p = poolPages([pages(oneTo(94), { errors: 9, coldErrors: 3, warmErrors: 6 })]);
    expect(p).toMatchObject({ samples: 94, errors: 9, coldErrors: 3, coldAttempts: 97, p95Ms: 93 });
    expect(p.runP95Ms).toEqual([93]);
    expect(nfr02Passes(p, 1)).toBe(false); // any failed load still fails NFR-02
    // 6 cold failures in 100 cold attempts: past every measured load
    expect(poolPages([pages(oneTo(94), { errors: 6, coldErrors: 6, warmErrors: 0 })]).p95Ms).toBe(Number.POSITIVE_INFINITY);
    // a run file made before the split ranks all its failures as cold, as measured
    expect(poolPages([pages(oneTo(94), { errors: 9 })])).toMatchObject({ coldErrors: 9, p95Ms: Number.POSITIVE_INFINITY });
  });

  // why: NFR-02 runs with the probe and runs without it are 2 shapes, never pooled
  it('refuses to pool runs with and without the page probe', () => {
    const shape = { runSeconds: 2824, vans: true, reassignShare: 0.05, restSeconds: 0 };
    expect(runSetProblem([{ run: 1, ...shape, pages: true }, { run: 2, ...shape }])).toMatch(/pages/);
    expect(runSetProblem([{ run: 1, ...shape, pages: true }, { run: 2, ...shape, pages: true }])).toBeNull();
  });

  // why: F-1498 the routing arm is part of a run's shape: 1 label never pools runs with routing up and runs with it stopped
  it('refuses to pool the 2 routing arms', () => {
    const shape = { runSeconds: 5648, vans: true, reassignShare: 0.05, restSeconds: 0, pages: true };
    expect(runSetProblem([{ run: 1, ...shape, routing: 'on' }, { run: 2, ...shape, routing: 'off' }])).toMatch(/routing/);
    expect(runSetProblem([{ run: 1, ...shape, routing: 'off' }, { run: 2, ...shape, routing: 'off' }])).toBeNull();
  });
});

describe('a failed read keeps its cause (F-1495)', () => {
  // why: F-1495 a failed board or van read is counted with its status or thrown cause and its time after the run's start, as writes keep failedBy
  it('counts each failure by cause and keeps the first ones with their time', () => {
    const r = new Reads(1000);
    r.fail('status 500', 3500);
    r.fail('status 500', 4000);
    r.fail(causeOf(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), 12_345);
    const s = r.stats();
    expect(s.errors).toBe(3);
    expect(s.errorsBy).toEqual({ 'status 500': 2, 'TypeError ECONNRESET: fetch failed': 1 });
    expect(s.errorsAt).toEqual([{ atS: 2.5, why: 'status 500' }, { atS: 3, why: 'status 500' }, { atS: 11.3, why: 'TypeError ECONNRESET: fetch failed' }]);
    expect(causeOf(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toBe('TimeoutError: The operation was aborted due to timeout');
    // the times kept are bounded, the counts never are
    const many = new Reads(0);
    for (let i = 0; i < READ_ERRORS_KEPT + 50; i++) many.fail('status 429', i);
    expect(many.stats()).toMatchObject({ errors: READ_ERRORS_KEPT + 50, errorsBy: { 'status 429': READ_ERRORS_KEPT + 50 } });
    expect(many.stats().errorsAt).toHaveLength(READ_ERRORS_KEPT);
  });

  // why: F-1498 each API-21 answer's on-the-way vans are counted as tracked (a stored or live track) or approximate (no track)
  it('counts the route members of a van read', () => {
    const body = JSON.stringify({ data: { vans: [{ route: null }, { route: { track: [[1, 2]] } }, { route: { track: null } }, { route: { track: [[3, 4]] } }] } });
    expect(vanRoutesOf(body)).toEqual({ tracked: 2, approximate: 1 });
    expect(vanRoutesOf(JSON.stringify({ data: { vans: [] } }))).toEqual({ tracked: 0, approximate: 0 });
  });
});

describe('the end of a run against the server', () => {
  // why: NFR-03
  it('sorts each job into matched, behind (a lost update), ahead or missing', () => {
    const want = new Map([[1, 3], [2, 3], [3, 3], [4, 3]]);
    const seen = new Map([[1, 3], [2, 2], [3, 4]]);
    expect(endStateOf(want, seen)).toEqual({ jobs: 4, matched: 1, behind: 1, ahead: 1, missing: 1 });
  });

  // why: NFR-03
  it('passes NFR-03 only with the required runs, no error and 0 lost updates', () => {
    const five = Array.from({ length: 5 }, () => clean());
    expect(nfr03Of(five, 5)).toMatchObject({ errors: 0, lostUpdates: 0, passes: true });
    expect(nfr03Of(five.slice(1), 5).passes).toBe(false);
    for (const bad of [{ writesFailed: 1 }, { boardReadErrors: 1 }, { vanReadErrors: 1 }, { pageErrors: 1 }, { endStateErrors: 1 }]) {
      const r = nfr03Of([...five.slice(1), clean(bad)], 5);
      expect(r, JSON.stringify(bad)).toMatchObject({ errors: 1, passes: false });
    }
    for (const [over, key] of [[{ lost: 2 }, 'neverShown'], [{ endState: { jobs: 600, matched: 598, behind: 2, ahead: 0, missing: 0 } }, 'serverBehind'], [{ endState: { jobs: 600, matched: 598, behind: 0, ahead: 0, missing: 2 } }, 'jobMissing']] as const) {
      const r = nfr03Of([...five.slice(1), clean(over)], 5);
      expect(r.lostBy[key]).toBe(2);
      expect(r).toMatchObject({ lostUpdates: 2, passes: false });
    }
    // a refusal the day allows for is neither an error nor a lost update
    expect(nfr03Of([...five.slice(1), clean({ writesRefused: 40 })], 5).passes).toBe(true);
    // a run whose end state checked nothing proves nothing
    expect(nfr03Of(Array.from({ length: 5 }, () => clean({ endState: { jobs: 0, matched: 0, behind: 0, ahead: 0, missing: 0 } })), 5).passes).toBe(false);
  });
});

const SPIKES = new URL('../../../../docs/build/spikes/', import.meta.url);
const RECORD = new URL('P7-LOAD.md', SPIKES);
type Out = {
  task: string; instancePlan: string; runSet: string; runsRequired: number; shape: Record<string, number>; totals: { runs: number }; routing?: string;
  firstRunStart: string; lastRunEnd: string;
  nfr02: { p95S: number | null; samples: number; errors: number; passes: boolean }; nfr03: { errors: number; lostUpdates: number; passes: boolean };
};
type Mem = {
  window: { start: string; end: string }; host: { peakPct: number; peakPctExact?: number; peakMiB: number }; cgroupSum: { peakPct: number };
  dockerStats: { sumOfMaxPct: number }; nfr13: { passes: boolean; limitPct: number }; services: Record<string, unknown>;
};
/** 1 measured set: its load summary and its memory file, by the name part between P7-LOAD and .summary.json (none: the first day). */
const setOf = (part: string): { out: Out; mem: Mem } | null => {
  const out = new URL(`P7-LOAD${part}.summary.json`, SPIKES);
  const mem = new URL(`P7-LOAD${part}.memory.json`, SPIKES);
  if (!existsSync(out) && !existsSync(mem)) return null;
  expect(existsSync(out), `docs/build/spikes/P7-LOAD${part}.summary.json is missing beside its memory file`).toBe(true);
  expect(existsSync(mem), `docs/build/spikes/P7-LOAD${part}.memory.json is missing beside its summary`).toBe(true);
  return { out: JSON.parse(readFileSync(out, 'utf8')) as Out, mem: JSON.parse(readFileSync(mem, 'utf8')) as Mem };
};
const lineOf = (record: string, name: string): string => {
  const m = new RegExp(`^${name}: (.*)$`, 'm').exec(record);
  expect(m, `the record has no "${name}:" line`).not.toBeNull();
  return m![1]!;
};
/** F-1494: NFR-13 is the unrounded peak against 60% (a file made before it carries only the rounded one). */
const nfr13Passes = (mem: Mem): boolean => (mem.host.peakPctExact ?? mem.host.peakPct) <= 60;

/** The 3 NFR lines of 1 set, each against its files; prefix '' for the lines the verdict reads, 'Day 1 ' for the first day kept beside a rerun. */
function checkSet(record: string, prefix: string, { out, mem }: { out: Out; mem: Mem }): boolean {
  expect(out.task).toBe('P7-LOAD');
  expect(out.instancePlan).toBe('small_3_0');
  expect(out.shape).toEqual({ jobs: 600, dispatchers: 14, technicians: 85, branches: 3 });
  expect(out.runSet).toBe('runs 1 to N, 1 shape');
  expect(out.totals.runs).toBe(out.runsRequired);
  // D-21: the NFR lines are measured with routing in the stack (a summary made before F-1498 names no arm: it ran with routing).
  expect(out.routing ?? 'on').toBe('on');
  // the memory file covers the same window as the load summary
  expect(mem.window).toEqual({ start: out.firstRunStart, end: out.lastRunEnd });
  expect(mem.nfr13.limitPct).toBe(60);
  expect(mem.nfr13.passes).toBe(nfr13Passes(mem));
  const line = (name: string): string => lineOf(record, `${prefix}${name}`);
  // A failed load ranks above every measured one, so more than 5% failed makes the p95 infinite, which JSON writes as null.
  const p95 = out.nfr02.p95S;
  expect(line('NFR-02')).toContain(p95 === null ? 'p95 infinite' : `p95 ${(Math.round(p95 * 1000) / 1000).toFixed(3)} s`);
  if (p95 === null) expect(out.nfr02.passes).toBe(false);
  expect(line('NFR-02')).toMatch(new RegExp(`^${out.nfr02.passes ? 'PASS' : 'FAIL'}\\b`));
  expect(line('NFR-03')).toContain(`${out.nfr03.errors} errors, ${out.nfr03.lostUpdates} lost updates`);
  expect(line('NFR-03')).toMatch(new RegExp(`^${out.nfr03.passes ? 'PASS' : 'FAIL'}\\b`));
  expect(line('NFR-13')).toContain(`${mem.host.peakPct}% of MemTotal`);
  expect(line('NFR-13')).toMatch(new RegExp(`^${mem.nfr13.passes ? 'PASS' : 'FAIL'}\\b`));
  expect(line('NFR-13')).toContain(`cgroup sum ${mem.cgroupSum.peakPct}%`);
  expect(line('NFR-13')).toContain(`docker stats ${mem.dockerStats.sumOfMaxPct}%`);
  return out.nfr02.passes && out.nfr03.passes && mem.nfr13.passes;
}

describe('the P7-LOAD record', () => {
  // why: NFR-02, NFR-03, NFR-13 the record's figures are the output files' own, whatever the verdict; a record without its files fails
  // why: F-1863 a public copy skips this with a note naming docs/build/spikes/P7-LOAD.md, never passes it green with no proof run
  it('holds the page p95, the error and lost-update counts and the peak host memory of the output files', (ctx) => {
    if (!existsSync(RECORD)) ctx.skip('docs/build/spikes/P7-LOAD.md is not in this copy (a private path the public export leaves out)');
    const record = readFileSync(RECORD, 'utf8');
    const day1 = setOf('');
    expect(day1, 'the record exists but docs/build/spikes/P7-LOAD.summary.json and .memory.json are missing').not.toBeNull();
    const rerun = setOf('.rerun');
    const hosted = setOf('.hosted');
    // The verdict's lines are the latest measured set's: the real-speed day on the hosted server (owner answer f3d84787), else the
    // rerun, else the first day. Each earlier set stays beside it under its own prefix ("Rerun ", "Day 1 "), and the first day's
    // NFR-13 miss is recorded for the owner, never replaced by a later figure (BUILD_PLAN P7-LOAD Acceptance).
    const passes = checkSet(record, '', hosted ?? rerun ?? day1!);
    if (hosted && rerun) checkSet(record, 'Rerun ', rerun);
    if (hosted || rerun) {
      checkSet(record, 'Day 1 ', day1!);
      expect(lineOf(record, 'Day 1 NFR-13')).toMatch(/^FAIL\b/);
    }
    // why: F-1496 the Verdict line (the row ci/spikes-index.sh copies into SPIKES.md, the index the owner reads) says PASS only when
    // all 3 lines pass, and FAIL otherwise
    expect(lineOf(record, 'Verdict')).toMatch(new RegExp(`^${passes ? 'PASS' : 'FAIL'}\\b`));
  });

  // why: F-1498 the routing-stopped arm is its own set beside the verdict's, never its pass line: its summary names the arm and its memory file holds no routing service
  // why: F-1863 the same skip note when the record is absent
  it('keeps the routing-stopped arm beside the verdict, with its own host peak', (ctx) => {
    if (!existsSync(RECORD)) ctx.skip('docs/build/spikes/P7-LOAD.md is not in this copy (a private path the public export leaves out)');
    const arm = setOf('.norouting');
    if (!arm) return; // the arm is measured by the rerun
    const record = readFileSync(RECORD, 'utf8');
    expect(arm.out.routing).toBe('off');
    expect(Object.keys(arm.mem.services)).not.toContain('routing');
    expect(arm.mem.window).toEqual({ start: arm.out.firstRunStart, end: arm.out.lastRunEnd });
    expect(lineOf(record, 'Routing stopped')).toContain(`${arm.mem.host.peakPct}% of MemTotal`);
  });
});
