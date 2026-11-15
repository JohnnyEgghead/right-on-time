// SPDX-License-Identifier: AGPL-3.0-or-later
// Selects the page-inventory rows the walkers check: target phase at or before the current phase (D-9) and building task merged (F-154), every row,
// whatever its type (SPECIFICATIONS section 14: the walkers cover every inventory row). Each row is then routed by
// type to the walk that covers it, and nothing is dropped silently (F-38).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mergedTasks, repoRoot, resolveMainRef } from '../gates-lib.ts';

export type ScreenRow = { screen: string; name: string; type: string; route: string; phase: number; task: string };

export function loadInventory(path: string): ScreenRow[] {
  const j = JSON.parse(readFileSync(path, 'utf8')) as { screens: ScreenRow[] };
  return j.screens;
}

/** Every row at or before the current phase, of any type. */
export function selectRows(rows: ScreenRow[], currentPhase: number): ScreenRow[] {
  return rows.filter((r) => r.phase <= currentPhase);
}

/**
 * page: a web page with a route; the walkers load it. A "page / native screen" row is a web page too.
 * host-page: a dialog, sheet, popover or panel; the walkers open it on its host page.
 * native: a native-only screen; handed to the native audit, listed, never dropped.
 */
export type WalkClass = 'page' | 'host-page' | 'native';

const CLASS_BY_TYPE: Record<string, WalkClass> = {
  page: 'page',
  'page / native screen': 'page',
  dialog: 'host-page',
  sheet: 'host-page',
  popover: 'host-page',
  panel: 'host-page',
  'native screen': 'native',
};

/** An inventory type the walkers do not know fails closed: a new type must be routed on purpose. */
export function walkClass(type: string): WalkClass {
  const c = CLASS_BY_TYPE[type];
  if (!c) throw new Error(`page-walkers: inventory type "${type}" has no walk; route it in ci/page-walkers/inventory.ts`);
  return c;
}

export type WalkPlan = {
  walked: ScreenRow[];
  hostOpened: ScreenRow[];
  handedOff: ScreenRow[];
  selected: ScreenRow[];
  /** Rows at or before the phase whose task is not merged yet; printed, not walked (F-154). */
  waiting: ScreenRow[];
  /** Rows that must turn the gate red, each with the reason (F-154 safeguards a and b). */
  problems: string[];
};

/** The task IDs the plan declares as `#### <ID> \u2014` headings. */
export function planTaskIds(planText: string): Set<string> {
  const out = new Set<string>();
  for (const line of planText.split('\n')) {
    const m = /^#### ([A-Za-z0-9][A-Za-z0-9-]*) [\u2014-]/.exec(line.slice(0, 200));
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

/** BW_MERGED_TASKS (comma-separated IDs) replaces the merged set. Tests only; documented in ci/gates/page-walkers.sh. */
export function mergedFromEnv(env: string | undefined, readMerged: () => Iterable<string>): () => Iterable<string> {
  if (env === undefined || env.trim() === '') return readMerged;
  return () => env.split(',').map((t) => t.trim()).filter(Boolean);
}

/**
 * F-154 selection. A row is walked from the moment its task (row.task) is merged, in its phase:
 *   selected = phase at or before the current phase AND task merged. Same merged set that gives the phase.
 * Nothing is dropped silently:
 *   waiting  = phase at or before the current phase, task not merged yet; the caller prints these.
 *   problems = (a) the row's phase is BEFORE the current phase and its task is still not merged: that phase
 *              should not have closed without it; (b) the task id is not a task heading in the plan: a typo
 *              must not hide a row forever (checked for every row, any phase).
 * (c) A merged task whose page has no wiring stays red; that check is in run-inventory.ts, as before.
 */
export function selectMerged(rows: ScreenRow[], currentPhase: number, merged: ReadonlySet<string>, knownTasks: ReadonlySet<string>) {
  const selected: ScreenRow[] = [];
  const waiting: ScreenRow[] = [];
  const problems: string[] = [];
  for (const r of rows) {
    if (!knownTasks.has(r.task)) problems.push(`${r.screen}: task "${r.task}" is not a task heading in docs/BUILD_PLAN.md`);
    if (r.phase > currentPhase) continue;
    if (merged.has(r.task)) selected.push(r);
    else {
      waiting.push(r);
      if (r.phase < currentPhase) problems.push(`${r.screen}: phase ${r.phase} is before phase ${currentPhase} but its task ${r.task} is not merged`);
    }
  }
  return { selected, waiting, problems };
}

/**
 * F-834: why a walk selected nothing, for a lane that named its own task. A row names the 1 task that built its page, so a task
 * that only changed a built page holds no row (P4-BOARD-MAP's map panel sits on SCR-OFC-02, task P4-BOARD), and BW_MERGED_TASKS
 * replaces the whole merged set, so a set with no CP<n> is phase 1.
 */
export function emptyWalkWhy(rows: ScreenRow[], phase: number, merged: ReadonlySet<string>): string {
  const tasks = [...merged].filter((t) => !/^CP\d/.test(t));
  const parts = tasks.map((t) => {
    const own = rows.filter((r) => r.task === t);
    if (own.length === 0) return `${t} holds no inventory row (a row names the task that built its page)`;
    const early = Math.min(...own.map((r) => r.phase));
    return `${t}'s ${own.length} row(s) start at phase ${early}, after this phase`;
  });
  const said = parts.length > 0 ? parts.join('; ') : 'the merged set names no task';
  return `page-walkers: 0 screens to walk at phase ${phase}: ${said}. Name the task on the page's row and the checkpoint before it, for example BW_MERGED_TASKS=CP3,P4-BOARD for SCR-OFC-02.`;
}

/** With `gate` absent, every row at or before the phase is selected (the pre-F-154 rule, kept for callers that only classify). */
export function planWalk(rows: ScreenRow[], currentPhase: number, gate?: { merged: ReadonlySet<string>; knownTasks: ReadonlySet<string> }): WalkPlan {
  const g = gate ? selectMerged(rows, currentPhase, gate.merged, gate.knownTasks) : { selected: selectRows(rows, currentPhase), waiting: [], problems: [] };
  const by = (c: WalkClass) => g.selected.filter((r) => walkClass(r.type) === c);
  return { selected: g.selected, waiting: g.waiting, problems: g.problems, walked: by('page'), hostOpened: by('host-page'), handedOff: by('native') };
}

export function countByType(rows: ScreenRow[]): string {
  const n = new Map<string, number>();
  for (const r of rows) n.set(r.type, (n.get(r.type) ?? 0) + 1);
  return [...n].map(([t, c]) => `${t} ${c}`).join(', ') || 'none';
}

/**
 * The phase a set of merged task IDs puts the build in: 1 plus the highest merged phase checkpoint CP<n> (n 1 to 9),
 * so phase 1 until CP1 merges (F-47). CP8A is not a phase number and is ignored. Capped at 9.
 */
export function phaseFromMergedTasks(merged: Iterable<string>): number {
  let top = 0;
  for (const id of merged) {
    const m = /^CP([1-9])$/.exec(id);
    if (m) top = Math.max(top, Number(m[1]));
  }
  return Math.min(top + 1, 9);
}

/**
 * The current phase (D-9, F-39, F-47). BW_PHASE wins when set, and must be a whole number 1 to 9. Otherwise it is
 * derived from the merged Task trailers on the integration branch (the durable source gate-activation-check already
 * reads), never from a prose heading in the manager's working state. There is no default: merged tasks that cannot be
 * read are an error, never phase 1.
 */
export function currentPhase(env: string | undefined, readMerged: () => Iterable<string>): number {
  if (env !== undefined && env.trim() !== '') {
    const v = env.trim();
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 9) throw new Error(`page-walkers: current phase from BW_PHASE is "${v}", not a whole number 1 to 9`);
    return n;
  }
  let merged: Iterable<string>;
  try {
    merged = readMerged();
  } catch (e) {
    throw new Error(`page-walkers: BW_PHASE is not set and the merged tasks cannot be read (${(e as Error).message}); the current phase is unknown`);
  }
  return phaseFromMergedTasks(merged);
}

/**
 * The phase checkpoints the plan marks done: CP<n> blocks (n 1 to 9) with a `Status: DONE` line (F-74). A checkpoint
 * is an Iso: none task, so it never leaves a Task trailer on a merge commit; its plan status is its durable record.
 */
export function doneCheckpoints(planText: string): string[] {
  const out: string[] = [];
  for (const block of planText.split(/^#### /m).slice(1)) {
    const m = /^(CP[1-9]) [\u2014-]/.exec(block);
    if (m?.[1] && /^Status: DONE\s*$/m.test(block)) out.push(m[1]);
  }
  return out;
}

/** The merged task IDs on the integration branch (GATE_MAIN_REF, origin/main, main), plus its done checkpoints. */
export function readMergedTasks(): Iterable<string> {
  const root = repoRoot();
  const ref = resolveMainRef(root);
  if (!ref) throw new Error('no integration branch to read (tried GATE_MAIN_REF, origin/main, main)');
  const plan = execFileSync('git', ['show', `${ref}:docs/BUILD_PLAN.md`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return new Set([...mergedTasks(root, ref), ...doneCheckpoints(plan)]);
}
