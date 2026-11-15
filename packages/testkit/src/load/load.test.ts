// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: NFR-01
// The load script's p95 and counting logic, held to known answers (P4-LOAD), and the record's figures against the output file.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTimeline, checkLoadDay, LOAD_DAY, seeded, squeeze, type LoadWorld, type Step } from './plan.ts';
import { BOARD_EVENTS, REREAD_WAIT_MS, VAN_READ_MS } from './run.ts';
import { LOAD_DAY_RUNS, nearestRank, nfr01Passes, NFR_01_P95_LIMIT_S, p95WithLost, pool, runSetProblem, spread, type RunCounts, type RunShape } from './stats.ts';
import { boardVersions, DelayTracker } from './tracker.ts';

const run = (delaysMs: number[], over: Partial<RunCounts> = {}): RunCounts => ({
  delaysMs, lost: 0, writesPlanned: delaysMs.length, writesApplied: delaysMs.length, writesRefused: 0, writesFailed: 0, boardReadErrors: 0, ...over,
});
const oneTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

describe('p95 by nearest rank', () => {
  // why: NFR-01
  it('takes the value at rank ceil(0.95 n)', () => {
    expect(nearestRank(oneTo(100), 95)).toBe(95);
    expect(nearestRank(oneTo(20), 95)).toBe(19);
    expect(nearestRank(oneTo(21), 95)).toBe(20);
    expect(nearestRank(oneTo(1), 95)).toBe(1);
    expect(nearestRank([], 95)).toBeNaN();
    expect(() => nearestRank([1], 0)).toThrow(RangeError);
  });

  // why: NFR-01
  it('sorts before it ranks and leaves its input alone', () => {
    const input = [5, 1, 4, 2, 3];
    expect(spread(input)).toEqual({ count: 5, p50: 3, p95: 5, p99: 5, max: 5 });
    expect(input).toEqual([5, 1, 4, 2, 3]);
  });

  // why: NFR-01
  it('counts a lost change as slower than anything measured, so losses only raise the p95', () => {
    expect(p95WithLost(oneTo(100), 0)).toBe(95);
    expect(p95WithLost(oneTo(100), 1)).toBe(96);
    expect(p95WithLost(oneTo(95), 5)).toBe(95);
    expect(p95WithLost(oneTo(95), 6)).toBe(Number.POSITIVE_INFINITY);
    expect(p95WithLost([], 0)).toBeNaN();
  });
});

describe('pooling the runs', () => {
  // why: NFR-01
  it('pools every sample of every run, not an average of the run p95s', () => {
    const p = pool([run(oneTo(100)), run(oneTo(100).map((n) => n * 10))]);
    expect(p.runs).toBe(2);
    expect(p.samples).toBe(200);
    // Rank 190 of 200: 110 samples are at most 100, then 110, 120 and on; the 80th of those is 900.
    expect(p.p95Ms).toBe(900);
    expect(p.p95S).toBe(0.9);
    expect(p.runP95Ms).toEqual([95, 950]);
    expect(p.worstRunP95Ms).toBe(950);
    expect(p.bestRunP95Ms).toBe(95);
    expect(p.maxMs).toBe(1000);
  });

  // why: NFR-01
  it('adds up the writes, the lost pairs and the read errors', () => {
    const p = pool([run([1], { writesPlanned: 10, writesApplied: 7, writesRefused: 2, writesFailed: 1, lost: 3, boardReadErrors: 4 }), run([2], { writesPlanned: 5, writesApplied: 5 })]);
    expect(p).toMatchObject({ writesPlanned: 15, writesApplied: 12, writesRefused: 2, writesFailed: 1, lost: 3, boardReadErrors: 4 });
  });

  // why: NFR-01
  it('passes NFR-01 only with 20 runs, nothing lost and a p95 under 5 s', () => {
    const fast = Array.from({ length: LOAD_DAY_RUNS }, () => run([100, 200, 300]));
    expect(nfr01Passes(pool(fast))).toBe(true);
    expect(nfr01Passes(pool(fast.slice(1)))).toBe(false);
    expect(nfr01Passes(pool([...fast.slice(1), run([100], { lost: 1 })]))).toBe(false);
    expect(nfr01Passes(pool(Array.from({ length: LOAD_DAY_RUNS }, () => run([NFR_01_P95_LIMIT_S * 1000]))))).toBe(false);
    expect(nfr01Passes(pool(Array.from({ length: LOAD_DAY_RUNS }, () => run([]))))).toBe(false);
  });

  // why: NFR-01, F-901: the verdict used runsRequired 5 (owner ruling b6666cfd), so that path has its own case
  it('passes NFR-01 with 5 runs only when 5 are required, nothing lost and the p95 under 5 s', () => {
    const five = Array.from({ length: 5 }, () => run([100, 200, 300]));
    expect(nfr01Passes(pool(five), 5)).toBe(true);
    expect(nfr01Passes(pool(five))).toBe(false);
    expect(nfr01Passes(pool(five.slice(1)), 5)).toBe(false);
    expect(nfr01Passes(pool([...five.slice(1), run([100], { lost: 1 })]), 5)).toBe(false);
    expect(nfr01Passes(pool(Array.from({ length: 5 }, () => run([NFR_01_P95_LIMIT_S * 1000]))), 5)).toBe(false);
  });
});

describe('the delay tracker', () => {
  const twoBoards = (): DelayTracker => new DelayTracker(new Map([['columbus', ['a', 'b']], ['dayton', ['c']]]));

  // why: NFR-01
  it('counts 1 delay per change per open board of the branch, from the send to the read that shows it', () => {
    const t = twoBoards();
    t.expect('columbus', 10, 2, 1000);
    expect(t.owed).toBe(2);
    t.seen('a', new Map([[10, 2]]), 1400);
    t.seen('b', new Map([[10, 2]]), 1900);
    t.seen('c', new Map([[10, 2]]), 1950);
    expect(t.delaysMs).toEqual([400, 900]);
    expect(t.owed).toBe(0);
  });

  // why: NFR-01
  it('never counts a read that holds the older version: the event alone does not show the change', () => {
    const t = twoBoards();
    t.expect('dayton', 10, 3, 0);
    t.seen('c', new Map([[10, 2]]), 100);
    t.seen('c', new Map(), 150);
    expect(t.delaysMs).toEqual([]);
    expect(t.owed).toBe(1);
    t.seen('c', new Map([[10, 4]]), 200);
    expect(t.delaysMs).toEqual([200]);
  });

  // why: NFR-01
  it('resolves every change a later version covers, each from its own send', () => {
    const t = twoBoards();
    t.expect('dayton', 10, 2, 0);
    t.expect('dayton', 10, 3, 50);
    t.seen('c', new Map([[10, 3]]), 300);
    expect(t.delaysMs).toEqual([300, 250]);
  });

  // why: NFR-01
  it('owes nothing for a refused write', () => {
    const t = twoBoards();
    const refused = t.expect('columbus', 10, 2, 0);
    t.expect('columbus', 11, 2, 0);
    t.cancel(refused);
    expect(t.owed).toBe(2);
    t.seen('a', new Map([[10, 2], [11, 2]]), 10);
    expect(t.delaysMs).toEqual([10]);
  });

  // why: NFR-01
  it('leaves an unshown change owed: that is a lost update, never a fast one', () => {
    const t = twoBoards();
    t.expect('columbus', 10, 2, 0);
    t.seen('a', new Map([[10, 2]]), 20);
    expect(t.owed).toBe(1);
    expect(pool([run([...t.delaysMs], { lost: t.owed })]).lost).toBe(1);
  });

  // why: NFR-01
  it('reads every job of an API-20 answer, the Unassigned row too', () => {
    const v = boardVersions({ unassigned: [{ jobNumber: 1, version: 3 }], technicians: [{ jobs: [{ jobNumber: 2, version: 1 }] }, { jobs: [{ jobNumber: 3, version: 2 }] }] });
    expect([...v.entries()].sort()).toEqual([[1, 3], [2, 1], [3, 2]]);
  });
});

/** A small world of the load day's exact counts. */
function dayWorld(): LoadWorld {
  const branches = ['columbus', 'dayton', 'springfield'];
  const technicians = Array.from({ length: LOAD_DAY.technicians }, (_, i) => ({ id: `t${i}`, branch: branches[i % 3] as string, token: `tt${i}` }));
  const dispatchers = Array.from({ length: LOAD_DAY.dispatchers }, (_, i) => ({ id: `d${i}`, branch: branches[i % 3] as string, token: `dt${i}` }));
  const day = Date.parse('2026-09-15T12:00:00Z');
  const jobs = Array.from({ length: LOAD_DAY.jobs }, (_, i) => {
    const t = technicians[i % technicians.length]!;
    return { jobNumber: 1000 + i, branch: t.branch, technicianId: t.id, version: 1, plannedMs: day + (i % 8) * 75 * 60_000, expectedMinutes: 60 };
  });
  return { managerToken: 'm', jobs, technicians, dispatchers };
}

describe('the load day and its timeline', () => {
  // why: NFR-01
  it('accepts only the load day of REQUIREMENTS section 5.2', () => {
    const w = dayWorld();
    expect(() => checkLoadDay(w)).not.toThrow();
    expect(() => checkLoadDay({ ...w, jobs: w.jobs.slice(1) })).toThrow('599 jobs');
    expect(() => checkLoadDay({ ...w, dispatchers: w.dispatchers.slice(1) })).toThrow('13 dispatcher');
    expect(() => checkLoadDay({ ...w, technicians: w.technicians.slice(1) })).toThrow('84 technician');
    expect(() => checkLoadDay({ ...w, jobs: w.jobs.map((j) => ({ ...j, branch: 'columbus' })) })).toThrow('1 branches');
  });

  // why: NFR-01
  it('sends all 3 steps of all 600 jobs in order, inside the run, plus the moves', () => {
    const w = dayWorld();
    const steps = buildTimeline(w, { durationMs: 600_000, reassignShare: 0.05, seed: 1 });
    expect(steps.filter((s) => s.kind === 'item')).toHaveLength(1800);
    expect(steps.filter((s) => s.kind === 'assign')).toHaveLength(30);
    expect(steps.every((s) => s.at >= 0 && s.at <= 600_000)).toBe(true);
    expect([...steps].sort((a, b) => a.at - b.at).map((s) => s.at)).toEqual(steps.map((s) => s.at));
    const stepsOf = (n: number): Step[] => steps.filter((s) => s.jobNumber === n);
    for (const j of w.jobs.slice(0, 50)) {
      const mine = stepsOf(j.jobNumber).filter((s) => s.kind === 'item');
      expect(mine.map((s) => s.kind === 'item' && s.item)).toEqual(['on_my_way', 'arrived', 'finished']);
    }
  });

  // why: NFR-01
  it('moves a job only inside its branch, to another technician, before its On my way', () => {
    const w = dayWorld();
    const techs = new Map(w.technicians.map((t) => [t.id, t.branch]));
    const steps = buildTimeline(w, { durationMs: 600_000, reassignShare: 0.05, seed: 2 });
    for (const s of steps) {
      if (s.kind !== 'assign') continue;
      const job = w.jobs.find((j) => j.jobNumber === s.jobNumber)!;
      expect(techs.get(s.toTechnicianId)).toBe(job.branch);
      expect(s.toTechnicianId).not.toBe(job.technicianId);
      const first = steps.find((x) => x.kind === 'item' && x.jobNumber === s.jobNumber)!;
      expect(s.at).toBeLessThanOrEqual(first.at);
    }
  });

  // why: NFR-01
  it('repeats exactly for a seed and states how much it squeezes the day', () => {
    const w = dayWorld();
    expect(buildTimeline(w, { durationMs: 1000, reassignShare: 0.1, seed: 7 })).toEqual(buildTimeline(w, { durationMs: 1000, reassignShare: 0.1, seed: 7 }));
    expect(seeded(3)()).toBe(seeded(3)());
    // The first arrival less the 20 minute drive, to the last arrival (525 minutes later) plus its 60 minute visit: 605 minutes.
    expect(squeeze(w, 605_000)).toBeCloseTo(60, 5);
  });

  // why: NFR-01
  it('re-reads on the same events and at the same pace as the board page', () => {
    const page = readFileSync(new URL('../../../../apps/web/src/board/BoardScreen.tsx', import.meta.url), 'utf8');
    const events = /BOARD_EVENTS = new Set\(\[([^\]]+)\]\)/.exec(page)?.[1]?.split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(new Set(events)).toEqual(BOARD_EVENTS);
    expect(page).toContain(`window.setTimeout(() => void flush(), ${REREAD_WAIT_MS})`);
    expect(VAN_READ_MS).toBe(10_000);
  });
});

describe('runs made in chunks (F-883)', () => {
  const shape = (run: number, over: Partial<RunShape> = {}): RunShape => ({ run, runSeconds: 1700, vans: true, reassignShare: 0.05, restSeconds: 0, ...over });

  // why: NFR-01
  it('pools 20 runs from 4 chunks of 5 as 1 set, in any file order', () => {
    expect(runSetProblem(oneTo(20).reverse().map((n) => shape(n)))).toBeNull();
    expect(runSetProblem([])).toBeNull();
  });

  // why: NFR-01
  it('refuses a set with a run missing or repeated, so a lost chunk is never silently left out of the p95', () => {
    expect(runSetProblem([1, 2, 4].map((n) => shape(n)))).toMatch(/run 3 is missing/);
    expect(runSetProblem([2, 3].map((n) => shape(n)))).toMatch(/run 1 is missing/);
    expect(runSetProblem([1, 2, 2].map((n) => shape(n)))).toMatch(/run 3 is missing or repeated/);
  });

  // why: NFR-01
  it('refuses runs of 2 shapes: another squeeze, rest, map setting or reassign share', () => {
    expect(runSetProblem([shape(1), shape(2, { runSeconds: 600 })])).toMatch(/run 2 has runSeconds 600/);
    expect(runSetProblem([shape(1), shape(2, { restSeconds: 300 })])).toMatch(/restSeconds/);
    expect(runSetProblem([shape(1), shape(2, { vans: false })])).toMatch(/vans/);
    expect(runSetProblem([shape(1), shape(2, { reassignShare: 0.1 })])).toMatch(/reassignShare/);
  });
});

const RECORD = new URL('../../../../docs/build/spikes/P4-LOAD.md', import.meta.url);
const OUTPUT = new URL('../../../../docs/build/spikes/P4-LOAD.summary.json', import.meta.url);

describe('the record', () => {
  // why: NFR-01
  it('holds the p95 of the script output file: under 5 s over the required runs, on the hosted plan, with its run date', () => {
    // F-901: a record that claims a measurement while its output file is gone fails; it never passes by skipping
    if (!existsSync(OUTPUT)) {
      expect(readFileSync(RECORD, 'utf8'), 'the record has a Measured line but docs/build/spikes/P4-LOAD.summary.json is missing').not.toMatch(/^Measured: p95/m);
      return;
    }
    const out = JSON.parse(readFileSync(OUTPUT, 'utf8')) as {
      instancePlan: string; firstRunStart: string; lastRunEnd: string; nfr01: { p95S: number; passes: boolean }; runsRequired: number; runSet: string;
      totals: { runs: number; lost: number; samples: number }; shape: Record<string, number>; perRun: { p95Ms: number; samples: number; lost: number }[];
    };
    const record = readFileSync(RECORD, 'utf8');
    expect(out.instancePlan).toBe('small_3_0');
    expect(out.shape).toEqual({ jobs: 600, dispatchers: 14, technicians: 85, branches: 3 });
    expect(out.runSet).toBe('runs 1 to N, 1 shape');
    // Section 5.2's 20 runs, or fewer only by the owner ruling the record cites (b6666cfd, Nov 7, 2026: "5 runs").
    if (out.runsRequired !== LOAD_DAY_RUNS) {
      expect(out.runsRequired).toBe(5);
      expect(record).toContain('b6666cfd');
    }
    expect(out.totals.runs).toBe(out.runsRequired);
    expect(out.perRun).toHaveLength(out.runsRequired);
    expect(out.perRun.reduce((n, r) => n + r.samples, 0)).toBe(out.totals.samples);
    expect(out.totals.lost).toBe(0);
    expect(out.nfr01.p95S).toBeLessThan(NFR_01_P95_LIMIT_S);
    expect(out.nfr01.passes).toBe(true);
    const measured = /^Measured: p95 ([\d.]+) s over (\d+) runs/m.exec(record);
    expect(measured, 'the record has no Measured line in the expected shape').not.toBeNull();
    expect(Number(measured![1])).toBe(Math.round(out.nfr01.p95S * 1000) / 1000);
    expect(Number(measured![2])).toBe(out.totals.runs);
    expect(record).toContain('small_3_0');
    // F-901: the record's Date measured line holds the output file's first run start and last run end, as New York time
    const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' }).replace(/\u202f/g, ' ');
    const day = new Date(out.firstRunStart).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
    const dateLine = /^Date measured: (.*)$/m.exec(record);
    expect(dateLine, 'the record has no Date measured line').not.toBeNull();
    expect(dateLine![1]).toContain(`${day}, ${clock(out.firstRunStart)} to ${clock(out.lastRunEnd)}`);
  });
});
