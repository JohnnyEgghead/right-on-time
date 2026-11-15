// SPDX-License-Identifier: AGPL-3.0-or-later
// The load script's numbers (P4-LOAD; REQUIREMENTS section 5.2, NFR-01): nearest-rank percentiles and the pooled verdict.
// Nothing here touches the network, so a unit test can hold the p95 and the counting to known answers.

/** NFR-01: the dispatch board shows any change within 5 seconds, p95 on the load day. */
export const NFR_01_P95_LIMIT_S = 5;
/** REQUIREMENTS section 5.2: the load day's figures are p95 over 20 runs. */
export const LOAD_DAY_RUNS = 20;

/** The q-th percentile by nearest rank (the same rule G-S1-SSE used): the value at rank ceil(q/100 x n), 1-based. */
export function nearestRank(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (!(q > 0 && q <= 100)) throw new RangeError(`percentile ${q} is outside (0, 100]`);
  return sorted[Math.max(1, Math.ceil((q / 100) * sorted.length)) - 1] as number;
}

export interface Spread { count: number; p50: number; p95: number; p99: number; max: number }

export function spread(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    p99: nearestRank(sorted, 99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

/** What 1 run of the load day counted (the driver fills it; the numbers below read only these fields). */
export interface RunCounts {
  /** Every delay in ms: 1 per change per open board of the change's branch. */
  delaysMs: readonly number[];
  /** Change-board pairs never shown before the run's settle time. */
  lost: number;
  /** Writes planned for the run, and how each ended. */
  writesPlanned: number;
  writesApplied: number;
  /** A write the server answered with a refusal the day allows for (no room on the target technician, say). */
  writesRefused: number;
  /** A write that failed: a 5xx, a dropped connection or an unexpected item result. */
  writesFailed: number;
  /** Failed reads of the board. */
  boardReadErrors: number;
}

export interface Pooled {
  runs: number;
  samples: number;
  lost: number;
  writesPlanned: number;
  writesApplied: number;
  writesRefused: number;
  writesFailed: number;
  boardReadErrors: number;
  /** Over every sample of every run. A lost sample counts as slower than anything measured, so losses can only raise the p95. */
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  p95S: number;
  /** Each run's own p95, in run order. */
  runP95Ms: number[];
  worstRunP95Ms: number;
  bestRunP95Ms: number;
}

/** A run's p95 with its lost samples counted as slower than anything measured. */
export function p95WithLost(delaysMs: readonly number[], lost: number): number {
  const sorted = [...delaysMs].sort((a, b) => a - b);
  const n = sorted.length + lost;
  if (n === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil(0.95 * n));
  return rank > sorted.length ? Number.POSITIVE_INFINITY : (sorted[rank - 1] as number);
}

export function pool(runs: readonly RunCounts[]): Pooled {
  const all = runs.flatMap((r) => [...r.delaysMs]).sort((a, b) => a - b);
  const lost = runs.reduce((n, r) => n + r.lost, 0);
  const add = (f: (r: RunCounts) => number): number => runs.reduce((n, r) => n + f(r), 0);
  const runP95Ms = runs.map((r) => p95WithLost(r.delaysMs, r.lost));
  const p95Ms = p95WithLost(all, lost);
  return {
    runs: runs.length,
    samples: all.length,
    lost,
    writesPlanned: add((r) => r.writesPlanned),
    writesApplied: add((r) => r.writesApplied),
    writesRefused: add((r) => r.writesRefused),
    writesFailed: add((r) => r.writesFailed),
    boardReadErrors: add((r) => r.boardReadErrors),
    p50Ms: nearestRank(all, 50),
    p95Ms,
    p99Ms: nearestRank(all, 99),
    maxMs: all[all.length - 1] ?? Number.NaN,
    p95S: p95Ms / 1000,
    runP95Ms,
    worstRunP95Ms: runP95Ms.length ? Math.max(...runP95Ms) : Number.NaN,
    bestRunP95Ms: runP95Ms.length ? Math.min(...runP95Ms) : Number.NaN,
  };
}

/**
 * NFR-01's verdict on a pooled result: the full count of runs, nothing lost, and the p95 under the limit. The count is section
 * 5.2's 20 unless an owner ruling sets another (P4-LOAD: 5, ruling b6666cfd); the output file records which count it used.
 */
export function nfr01Passes(p: Pooled, runsRequired: number = LOAD_DAY_RUNS): boolean {
  return p.runs >= runsRequired && p.samples > 0 && p.lost === 0 && p.p95S < NFR_01_P95_LIMIT_S;
}

/** How 1 run file was made: the summary pools only runs made the same way. */
export interface RunShape { run: number; runSeconds: number; vans: boolean; reassignShare: number; restSeconds: number; /** P7-LOAD: office pages probed (NFR-02). */ pages?: boolean; /** F-1498: the routing arm (a run file before it has none). */ routing?: 'on' | 'off' }

/**
 * The runs of 1 label may come from several invocations (chunks of 4 or 5 runs, so a stopped job loses only its own runs). The
 * pooled figure is honest only if the files are runs 1 to N, none missing or repeated, all of 1 shape: this names what is wrong, or null.
 */
export function runSetProblem(shapes: readonly RunShape[]): string | null {
  const sorted = [...shapes].sort((a, b) => a.run - b.run);
  for (const [i, s] of sorted.entries()) if (s.run !== i + 1) return `run ${i + 1} is missing or repeated (found run ${s.run})`;
  const first = sorted[0];
  if (!first) return null;
  for (const s of sorted) {
    for (const k of ['runSeconds', 'vans', 'reassignShare', 'restSeconds', 'pages', 'routing'] as const) {
      if (s[k] !== first[k]) return `run ${s.run} has ${k} ${String(s[k])}, run 1 has ${String(first[k])}`;
    }
  }
  return null;
}

// P7-LOAD: NFR-02 (page loads) and NFR-03 (no error, 0 lost updates) over the same runs.

/** NFR-02: pages load in under 2 seconds, p95 on the load day, on the office network profile. */
export const NFR_02_P95_LIMIT_S = 2;
/** NFR-02's office network profile (a team assumption): 50 Mbps each way, a 20 ms round trip. */
export const OFFICE_PROFILE = { mbps: 50, rttMs: 20 } as const;

/**
 * 1 run's office page loads: each sample is a page's load event (navigation start to loadEventEnd) in a fresh browser context
 * (cold: nothing cached), then the same page again in that context (warm). A load that did not answer 200 or timed out is an error.
 */
export interface PageCounts {
  coldMs: readonly number[];
  warmMs: readonly number[];
  /** Every failed load, cold and warm: NFR-03's page errors. */
  errors: number;
  /**
   * F-1494: the failed cold loads, the only failures NFR-02's cold p95 ranks (a failed warm load is not a cold load). A run file made
   * before F-1494 has no split: all its failures are ranked as cold, as they were measured.
   */
  coldErrors?: number;
  warmErrors?: number;
  errorsBy: Record<string, number>;
}

export interface PooledPages {
  runs: number;
  /** Cold loads measured, and warm ones. */
  samples: number;
  warmSamples: number;
  /** Every failed load (NFR-03), and the failed cold loads NFR-02's p95 ranks (F-1494). */
  errors: number;
  coldErrors: number;
  /** Cold loads tried: measured plus failed. */
  coldAttempts: number;
  /** Cold loads over every run, a failed load counted as slower than anything measured: the NFR-02 line. */
  p50Ms: number;
  p95Ms: number;
  p95S: number;
  maxMs: number;
  /** Warm loads, recorded beside it. */
  warmP95Ms: number;
  runP95Ms: number[];
}

export function poolPages(runs: readonly PageCounts[]): PooledPages {
  const cold = runs.flatMap((r) => [...r.coldMs]).sort((a, b) => a - b);
  const warm = runs.flatMap((r) => [...r.warmMs]).sort((a, b) => a - b);
  const errors = runs.reduce((n, r) => n + r.errors, 0);
  const coldErrorsOf = (r: PageCounts): number => r.coldErrors ?? r.errors;
  const coldErrors = runs.reduce((n, r) => n + coldErrorsOf(r), 0);
  const p95Ms = p95WithLost(cold, coldErrors);
  return {
    runs: runs.length,
    samples: cold.length,
    warmSamples: warm.length,
    errors,
    coldErrors,
    coldAttempts: cold.length + coldErrors,
    p50Ms: nearestRank(cold, 50),
    p95Ms,
    p95S: p95Ms / 1000,
    maxMs: cold[cold.length - 1] ?? Number.NaN,
    warmP95Ms: nearestRank(warm, 95),
    runP95Ms: runs.map((r) => p95WithLost(r.coldMs, coldErrorsOf(r))),
  };
}

/** NFR-02's verdict: the required runs, no failed load, and the cold p95 under 2 s (the stricter of the 2; warm is recorded beside it). */
export function nfr02Passes(p: PooledPages, runsRequired: number = LOAD_DAY_RUNS): boolean {
  return p.runs >= runsRequired && p.samples > 0 && p.errors === 0 && p.p95S < NFR_02_P95_LIMIT_S;
}

/**
 * A run's end checked against the server (NFR-03's lost updates): each job's version on the board after the run against the version
 * the script's applied writes gave it. Behind: an applied write the server does not hold (lost). Ahead: a write the script counted as
 * failed that the server holds. Missing: a job of the world the board no longer lists.
 */
export interface EndState { jobs: number; matched: number; behind: number; ahead: number; missing: number }

export function endStateOf(expected: ReadonlyMap<number, number>, seen: ReadonlyMap<number, number>): EndState {
  const s: EndState = { jobs: expected.size, matched: 0, behind: 0, ahead: 0, missing: 0 };
  for (const [job, version] of expected) {
    const v = seen.get(job);
    if (v === undefined) s.missing += 1;
    else if (v === version) s.matched += 1;
    else if (v < version) s.behind += 1;
    else s.ahead += 1;
  }
  return s;
}

/** What NFR-03 reads from 1 run beside the delay counts. */
export interface Nfr03Run extends RunCounts { vanReadErrors: number; pageErrors: number; endState: EndState; endStateErrors: number }

export interface Nfr03 {
  errors: number;
  errorsBy: { writesFailed: number; boardReadErrors: number; vanReadErrors: number; pageErrors: number; endStateAhead: number; endStateReadErrors: number };
  lostUpdates: number;
  lostBy: { neverShown: number; serverBehind: number; jobMissing: number };
  runs: number;
  passes: boolean;
}

/**
 * NFR-03: the load day completes with no error and 0 lost updates. An error is a failed write, a failed board, map or page read, or a
 * job the server holds ahead of the script or a failed end-state read; a refusal the day allows for (no room on the target) is not one. A lost update is a change
 * no board showed by the settle time, an applied write the server does not hold at the end, or a job gone from the board.
 */
export function nfr03Of(runs: readonly Nfr03Run[], runsRequired: number = LOAD_DAY_RUNS): Nfr03 {
  const add = (f: (r: Nfr03Run) => number): number => runs.reduce((n, r) => n + f(r), 0);
  const errorsBy = {
    writesFailed: add((r) => r.writesFailed), boardReadErrors: add((r) => r.boardReadErrors), vanReadErrors: add((r) => r.vanReadErrors),
    pageErrors: add((r) => r.pageErrors), endStateAhead: add((r) => r.endState.ahead), endStateReadErrors: add((r) => r.endStateErrors),
  };
  const lostBy = { neverShown: add((r) => r.lost), serverBehind: add((r) => r.endState.behind), jobMissing: add((r) => r.endState.missing) };
  const errors = Object.values(errorsBy).reduce((n, v) => n + v, 0);
  const lostUpdates = Object.values(lostBy).reduce((n, v) => n + v, 0);
  const checked = add((r) => r.endState.jobs);
  return { errors, errorsBy, lostUpdates, lostBy, runs: runs.length, passes: runs.length >= runsRequired && checked > 0 && errors === 0 && lostUpdates === 0 };
}
