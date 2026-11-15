// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared code for the gate map (BUILD_PLAN section 7, D-15): ci/run-gates.ts and
// ci/gate-activation-check.ts both read ci/gates.json through this file.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// nightly (P3-CI-CADENCE, D-15): a gate that runs only in `ci.sh --nightly` (or by name with --gates), never in the push set.
// checkpoint (owner answer 24ad46b5, F-1410): a gate that runs only in `ci.sh --checkpoint` (the nightly set plus these gates) or by name with --gates;
// a plain --nightly run skips it.
export const WHEN_VALUES = ['merge', 'wave', 'signoff', 'nightly', 'checkpoint'] as const;
export type When = (typeof WHEN_VALUES)[number];

export interface Gate {
  id: string;
  title: string;
  when: When;
  critical: boolean;
  reads?: string[];
  builders: string[];
  /** The 1 task whose merge makes the marker ci/active/<id> owed (D-15). */
  activates: string;
  activeFromPhase: number;
  /** Shell command of an active gate; null means the convention script ci/gates/<id>.sh (README). */
  cmd: string | null;
  /** Per-gate time limit in seconds; overrides the map's defaultTimeoutS. */
  timeoutS?: number;
  covers?: string[];
  /**
   * F-408: globs (repo-relative, `*` within a directory, `**` across directories). In a push run (--all) a gate with this
   * field runs only when a file matching one of them changed since the last recorded run (push, nightly or full) that ran this gate green;
   * otherwise it is recorded as unchanged, naming that base sha. Any doubt about the base runs the gate.
   */
  onlyWhenChanged?: string[];
  /**
   * F-410: present means this gate may run beside other declared gates (up to the run's cap); absent means it runs
   * alone, with nothing else running. exclusive names groups from the map's exclusiveGroups: two gates that share a
   * group never run at the same time. An empty list states that the gate shares no mutable resource with any gate.
   */
  parallel?: { exclusive: string[] };
  /**
   * P3-CI-CADENCE: the Playwright engines this gate's script runs its browsers on (a subset of the names in ci/pw-engine-names.ts, checked by ci/run-gates.ts). The runner
   * writes the verdict's engines from the gates that ran, so a push verdict cannot say WebKit ran when page-walkers and
   * look-values-comparator ran Chromium only. A gate with no browser leaves it out.
   */
  engines?: string[];
  /**
   * F-1201: the runner whose machine this gate needs (SPECIFICATIONS SD-38's 2 runners). Absent means linux: the gate runs in ci.sh on
   * the linux side (the GitHub push run, the Spectre wave and nightly container). mac means the gate needs this Mac (Xcode, the iOS
   * simulator): ci.sh's merge, push, nightly and records sets never select it, and the mac half of ci/wave-run.sh runs it (ci/mac-half.ts).
   */
  runner?: Runner;
  note?: string;
}

export const RUNNER_VALUES = ['linux', 'mac'] as const;
export type Runner = (typeof RUNNER_VALUES)[number];

/** ci.sh's modes that select gates by the map (F-1201: shared with the mac half, ci/mac-half.ts). */
export type SetMode = 'merge' | 'all' | 'nightly' | 'checkpoint' | 'records' | 'gates';

/** The when rule of each mode, before the runner: which gates a mode's set holds (asked: the --gates ids). */
export function inSet(mode: SetMode, g: Pick<Gate, 'id' | 'when' | 'reads'>, asked: readonly string[] = []): boolean {
  if (mode === 'checkpoint') return true;
  if (mode === 'nightly') return g.when !== 'checkpoint';
  if (mode === 'gates') return asked.includes(g.id);
  if (mode === 'all') return g.when !== 'nightly' && g.when !== 'checkpoint';
  if (mode === 'records') return g.when !== 'nightly' && g.when !== 'checkpoint' && (g.reads ?? []).length > 0;
  return g.when === 'merge';
}

/** The runner a gate runs on: its runner field, else linux. */
export function runnerOf(g: Pick<Gate, 'runner'>): Runner {
  return g.runner ?? 'linux';
}

export interface GateMap {
  /** Time limit in seconds for a gate with no timeoutS of its own. */
  defaultTimeoutS?: number;
  /** F-410: each exclusive group a gate's parallel.exclusive may name, with the shared resource it guards. */
  exclusiveGroups?: Record<string, string>;
  gates: Gate[];
}

export const FALLBACK_TIMEOUT_S = 300;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..');
}

export function loadMap(file: string): GateMap {
  return JSON.parse(readFileSync(file, 'utf8')) as GateMap;
}

/** Every start-up error in the map; an empty list means the map is well formed. */
export function validateMap(map: unknown): string[] {
  const errors: string[] = [];
  const m = map as Partial<GateMap> | null;
  if (!m || !Array.isArray(m.gates) || m.gates.length === 0) return ['gates: missing or empty'];
  if (m.defaultTimeoutS !== undefined && !(typeof m.defaultTimeoutS === 'number' && m.defaultTimeoutS > 0)) {
    errors.push('defaultTimeoutS must be a positive number of seconds');
  }
  const groups = m.exclusiveGroups ?? {};
  if (m.exclusiveGroups !== undefined && (typeof m.exclusiveGroups !== 'object' || m.exclusiveGroups === null || Array.isArray(m.exclusiveGroups))) {
    errors.push('exclusiveGroups must be an object of group name to the resource it guards');
  } else {
    for (const [k, v] of Object.entries(groups)) {
      if (!ID_RE.test(k)) errors.push(`exclusiveGroups: ${k} is not a plain name`);
      if (typeof v !== 'string' || v.trim() === '') errors.push(`exclusiveGroups: ${k} must name the resource it guards`);
    }
  }
  const seen = new Set<string>();
  m.gates.forEach((raw, i) => {
    const g = raw as Partial<Gate>;
    const label = typeof g?.id === 'string' ? g.id : `gates[${i}]`;
    if (typeof g?.id !== 'string' || !ID_RE.test(g.id)) errors.push(`${label}: id missing or not a plain name`);
    else if (seen.has(g.id)) errors.push(`${label}: duplicate id`);
    else seen.add(g.id);
    if (!(WHEN_VALUES as readonly string[]).includes(g?.when as string)) {
      errors.push(`${label}: when missing or not one of ${WHEN_VALUES.join(' | ')}`);
    }
    if (typeof g?.critical !== 'boolean') errors.push(`${label}: critical must be true or false`);
    if (!Array.isArray(g?.builders) || g.builders.length === 0) errors.push(`${label}: builders missing`);
    if (typeof g?.activates !== 'string' || !TASK_RE.test(g.activates)) errors.push(`${label}: activates (task ID) missing`);
    if (g?.cmd !== null && typeof g?.cmd !== 'string') errors.push(`${label}: cmd must be a string or null`);
    if (g?.timeoutS !== undefined && !(typeof g.timeoutS === 'number' && g.timeoutS > 0)) {
      errors.push(`${label}: timeoutS must be a positive number of seconds`);
    }
    if (g?.onlyWhenChanged !== undefined) {
      if (!Array.isArray(g.onlyWhenChanged) || g.onlyWhenChanged.length === 0 || g.onlyWhenChanged.some((r) => typeof r !== 'string' || r === '')) {
        errors.push(`${label}: onlyWhenChanged must be a non-empty list of globs`);
      } else if (g.when === 'merge' || g.when === 'nightly' || g.when === 'checkpoint') {
        errors.push(`${label}: onlyWhenChanged is for wave and signoff gates; a ${g.when} gate always runs`);
      }
    }
    if (g?.engines !== undefined) {
      if (!Array.isArray(g.engines) || g.engines.length === 0 || g.engines.some((e) => typeof e !== 'string')) {
        errors.push(`${label}: engines must be a non-empty list of engine names`);
      }
    }
    if (g?.parallel !== undefined) {
      const p = g.parallel as unknown as { exclusive?: unknown } | null;
      if (typeof p !== 'object' || p === null || !Array.isArray(p.exclusive) || p.exclusive.some((x) => typeof x !== 'string')) {
        errors.push(`${label}: parallel must be { "exclusive": [group names] } (an empty list shares nothing)`);
      } else {
        for (const x of p.exclusive as string[]) {
          if (!Object.hasOwn(groups, x)) errors.push(`${label}: parallel.exclusive names ${x}, which is not in exclusiveGroups`);
        }
      }
    }
    if (g?.runner !== undefined && !(RUNNER_VALUES as readonly string[]).includes(g.runner as string)) {
      errors.push(`${label}: runner must be one of ${RUNNER_VALUES.join(' | ')} (absent means linux)`);
    }
    if (g?.reads !== undefined && (!Array.isArray(g.reads) || g.reads.some((r) => typeof r !== 'string'))) {
      errors.push(`${label}: reads must be a list of globs`);
    }
  });
  return errors;
}

/** Names of the marker files in ci/active (a dot file such as .gitkeep is not a marker). */
export function listMarkers(root: string): string[] {
  const dir = path.join(root, 'ci', 'active');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
}

export function isActive(root: string, id: string): boolean {
  return existsSync(path.join(root, 'ci', 'active', id));
}

/**
 * The task IDs that have merged: a `Task: <ID>` trailer line in the message of a merge commit
 * reachable from `ref` (the integration branch). Records-only commits never carry it.
 */
export function parseMergedTasks(logText: string): Set<string> {
  const out = new Set<string>();
  for (const line of logText.split('\n')) {
    const m = /^Task:[ \t]*([A-Za-z0-9][A-Za-z0-9-]*)[ \t]*$/.exec(line);
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

/**
 * The first of GATE_MAIN_REF, origin/main, main that resolves; null when none does. A GATE_MAIN_REF that
 * is set and does not resolve gives null: it is never replaced silently by origin/main (F-22 b).
 */
export function resolveMainRef(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = env.GATE_MAIN_REF ? [env.GATE_MAIN_REF] : ['origin/main', 'main'];
  for (const ref of candidates) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' });
      return ref;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** True when the clone is shallow: its merge history is cut, so merged tasks cannot be read (F-22 a). */
export function isShallow(root: string): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' }).trim() === 'true';
  } catch {
    return true; // a failed read is not a clean history
  }
}

export function mergedTasks(root: string, ref: string): Set<string> {
  const log = execFileSync('git', ['log', '--merges', '--format=%B', ref], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return parseMergedTasks(log);
}

/**
 * The D-15 rule. A problem is listed when a gate's activating task has merged and its
 * marker is absent, or when a marker file names no gate.
 */
export function findActivationProblems(map: GateMap, markers: string[], merged: Set<string>): string[] {
  const problems: string[] = [];
  const have = new Set(markers);
  const rows: { id: string; kind: string; activates: string }[] = [
    ...map.gates.map((g) => ({ id: g.id, kind: 'gate', activates: g.activates })),
  ];
  for (const r of rows) {
    if (merged.has(r.activates) && !have.has(r.id)) {
      problems.push(`${r.kind} ${r.id}: activating task ${r.activates} has merged but ci/active/${r.id} is absent`);
    }
  }
  const known = new Set(rows.map((r) => r.id));
  for (const mk of markers) {
    if (!known.has(mk)) problems.push(`marker ci/active/${mk} names no gate`);
  }
  return problems;
}

/** The convention path (relative to the repo root) of a gate's script: ci/gates/<id>.sh. */
export function gateScript(id: string): string {
  return `ci/gates/${id}.sh`;
}

/**
 * What an active gate runs. A gate with a cmd runs it. A gate with cmd null runs the convention
 * script; when that file is absent the result names it, so the activating lane knows what to add.
 */
export function resolveGateCmd(root: string, g: Gate): { cmd: string } | { missing: string } {
  if (g.cmd !== null) return { cmd: g.cmd };
  const script = gateScript(g.id);
  return existsSync(path.join(root, script)) ? { cmd: `bash ${script}` } : { missing: script };
}

/** The time limit in seconds for a gate: its own timeoutS, else the map default, else the fallback. */
export function timeoutFor(map: GateMap, g: Gate): number {
  return g.timeoutS ?? map.defaultTimeoutS ?? FALLBACK_TIMEOUT_S;
}

/** A repo-relative glob as a RegExp: `**` crosses directories, `*` and `?` stay inside one. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === '*' && glob.charAt(i + 1) === '*') {
      i++;
      if (glob.charAt(i + 1) === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The scope values of the recorded runs that ran gates: a push run, a nightly run, and the pre-cadence full run (P3-CI-CADENCE). */
export const RUN_SCOPES: readonly string[] = ['full', 'push', 'nightly'];

export type ScopeDecision = { run: true; why: string } | { run: false; base: string; globs: string[] };

/**
 * The sha of the last recorded run that ran gate `id` green: the newest row of the committed history (.build/ci-time.jsonl,
 * one row per recorded run (push, nightly or pre-cadence full), with the run's sha and per-gate gateStatus) whose gateStatus for `id` is pass, and only
 * when no newer row shows the gate ran red (F-413). A skipped row is passed over; a red row is never a base. Null when there is no such row or it carries no full 40-hex sha.
 */
export function lastGreenSha(historyFile: string, id: string): string | null {
  let text: string;
  try {
    text = readFileSync(historyFile, 'utf8');
  } catch {
    return null;
  }
  let found: unknown = null;
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line) as { scope?: string; sha?: unknown; gateStatus?: Record<string, string> };
      // F-413: the newest row where the gate RAN decides. A red run after a green one leaves no base (the gate runs again);
      // a skipped or unchanged row ran nothing and is passed over.
      const ran = typeof r.scope === 'string' && RUN_SCOPES.includes(r.scope);
      if (ran && r.gateStatus?.[id] === 'pass') found = r.sha;
      else if (ran && r.gateStatus?.[id] === 'fail') found = null;
    } catch {
      // a blank or torn line is not a record
    }
  }
  return typeof found === 'string' && /^[0-9a-f]{40}$/.test(found) ? found : null;
}

/**
 * F-408. Does a scoped gate run? It SKIPS only when the base is proven (a recorded green sha present in a full-history
 * clone) and git proves no file matching a glob differs between that sha and the working tree (committed, uncommitted
 * or untracked). No record, a shallow clone, an unknown sha or any git failure runs the gate: never a skip on doubt.
 */
export function decideScope(root: string, g: Gate, historyFile: string): ScopeDecision {
  const globs = g.onlyWhenChanged ?? [];
  if (globs.length === 0) return { run: true, why: 'not scoped' };
  const base = lastGreenSha(historyFile, g.id);
  if (base === null) return { run: true, why: `no recorded green run of ${g.id} in ${path.basename(historyFile)}` };
  if (isShallow(root)) return { run: true, why: 'shallow clone, history cannot prove the base' };
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  let files: string[];
  try {
    git(['cat-file', '-e', `${base}^{commit}`]);
    files = [...git(['diff', '--name-only', '--no-renames', '-z', base]).split('\0'), ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter((f) => f !== '');
  } catch {
    return { run: true, why: `base ${base} is not in this clone's history` };
  }
  const res = globs.map(globToRegExp);
  const hit = files.find((f) => res.some((re) => re.test(f)));
  if (hit !== undefined) return { run: true, why: `${hit} changed since ${base}` };
  return { run: false, base, globs };
}

// ---- F-410: running gates side by side ----

/** The cap when neither --jobs, --serial nor CI_MAX_PARALLEL sets one. */
export const DEFAULT_MAX_PARALLEL = 2;

/**
 * F-410. The default number of gates that run at once: DEFAULT_MAX_PARALLEL, sized for the wave rig (8 CPUs, 16.6 GB):
 * the engine-net chain (page-walkers, import-target-counts, look-values-comparator, contract-gates, restore-test,
 * map-manifest, unit-tests, 1 at a time) is longer than all the other gates in 1 lane beside it, so a 3rd slot buys no wall time and only adds CPU
 * contention against fixed timeouts (ci/README.md). Lowered on a smaller host to 1 per 2 CPUs and 1 per 4 GiB, never
 * below 1.
 */
export function defaultCap(cpus: number, memBytes: number): number {
  return Math.max(1, Math.min(DEFAULT_MAX_PARALLEL, Math.floor(cpus / 2), Math.floor(memBytes / 2 ** 32)));
}

/** The run's cap from --serial, --jobs=<n> and CI_MAX_PARALLEL, in that order; an error string for a bad value. */
export function resolveCap(args: readonly string[], env: string | undefined, fallback: number): { cap: number; source: string } | { error: string } {
  const parse = (v: string, from: string): { cap: number; source: string } | { error: string } =>
    /^[1-9][0-9]*$/.test(v.trim()) ? { cap: Number(v.trim()), source: from } : { error: `${from} must be a whole number of gates, 1 or more (got '${v}')` };
  if (args.includes('--serial')) return { cap: 1, source: '--serial' };
  const jobs = args.find((a) => a.startsWith('--jobs='));
  if (jobs !== undefined) return parse(jobs.slice('--jobs='.length), '--jobs');
  if (env !== undefined && env !== '') return parse(env, 'CI_MAX_PARALLEL');
  return { cap: fallback, source: 'default' };
}

/**
 * F-410. May gate g start now, beside the gates already running, under cap? Nothing running: yes. Otherwise both it
 * and every running gate must declare parallel, the run must be under its cap, and no running gate may share one of
 * its exclusive groups. A gate with no parallel field therefore always runs alone (the safe default).
 */
export function canStart(g: Gate, running: readonly Gate[], cap: number): boolean {
  if (running.length === 0) return true;
  if (running.length >= cap || g.parallel === undefined) return false;
  const mine = new Set(g.parallel.exclusive);
  return running.every((r) => r.parallel !== undefined && !r.parallel.exclusive.some((x) => mine.has(x)));
}

/** Per gate, its newest non-zero durationS in the recorded runs (a skipped run records 0, which says nothing). */
export function lastDurations(historyFile: string): Map<string, number> {
  const out = new Map<string, number>();
  let text: string;
  try {
    text = readFileSync(historyFile, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line) as { scope?: string; gates?: Record<string, unknown> };
      if (typeof r.scope !== 'string' || !RUN_SCOPES.includes(r.scope) || typeof r.gates !== 'object' || r.gates === null) continue;
      for (const [id, s] of Object.entries(r.gates)) if (typeof s === 'number' && s > 0) out.set(id, s);
    } catch {
      // a blank or torn line is not a record
    }
  }
  return out;
}

/**
 * F-410. The order gates are offered a slot in: longest recorded duration first (so the long chains start at once),
 * a gate with no record before all of them (it may be long), ties in map order. Only the start order; results are
 * always reported in map order.
 */
export function startOrder<T extends { g: Gate; index: number }>(items: readonly T[], durations: ReadonlyMap<string, number>): T[] {
  const key = (t: T): number => durations.get(t.g.id) ?? Number.POSITIVE_INFINITY;
  return [...items].sort((a, b) => key(b) - key(a) || a.index - b.index);
}
