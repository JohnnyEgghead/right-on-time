// SPDX-License-Identifier: AGPL-3.0-or-later
// The gate runner behind ci/ci.sh (jl-dev playbooks/build-setup.md "Local CI gate map").
//   ci/ci.sh             the merge set: gates tagged when: merge
//   ci/ci.sh --all       the push set (the wave run): every active gate except the when: nightly ones, with onlyWhenChanged
//                        gates scoped; then ci-time-check.py (row scope: push)
//   ci/ci.sh --nightly   the nightly set: every active gate unscoped, the when: nightly gates included, the when: checkpoint ones not;
//                        then ci-time-check.py (row scope: nightly). Owner ruling Nov 2, 2026 "Daily + phase close" (P3-CI-CADENCE).
//   ci/ci.sh --checkpoint   the checkpoint set: the nightly set plus the when: checkpoint gates (look-values-comparator-nightly, the WebKit
//                        look check: 0 app bugs in 8 runs, about 11 minutes a night). Owner answer 24ad46b5 (Nov 11, 2026) "Run at
//                        checkpoints only" (F-1410). Recorded like a nightly run (verdict mode and scope nightly, with checkpoint: true).
//   ci/ci.sh --gates <ids>   only the named gates (comma list, or --gates=a,b), unscoped, nightly and checkpoint ones too; an unknown id exits 2
//   ci/ci.sh --records   only the gates that declare reads: globs (record-only commits)
//   --list               print the gates the mode would run and the sum of their timeoutS, run nothing (exit 0)
//   --serial             gates run one after another, in map order, output streamed (the pre-F-410 runner)
//   --jobs=<n>           at most n gates at once (also CI_MAX_PARALLEL=<n>; default ci/gates-lib.ts defaultCap: 2 on 8 CPUs)
// F-410: a gate that declares parallel in the map runs beside other declared gates, up to the cap, never beside a gate
// that shares one of its exclusive groups; a gate with no parallel field runs alone. Longest recorded gate first
// (.build/ci-time.jsonl). Above cap 1 each gate's output is held and printed as 1 block when it ends.
// Every selected gate runs to the end; a red gate never stops the run. A gate is active when its
// marker ci/active/<id> exists, else it prints its activating task and is recorded as inactive.
// A gate map entry with no valid when stops the run at start-up (exit 2).
// An active gate runs its cmd, or when cmd is null the convention script ci/gates/<id>.sh; a missing
// script fails the gate and names the file. A gate over its time limit (timeoutS, else the map's
// defaultTimeoutS) is killed with its whole process group and recorded red with a timeout reason.
// Writes ci-verdict.json (.build/ci/ci-verdict.json): result, sha, per-gate status and durationS (map order),
// totalDurationS (wall time), gateDurationSumS (the sum of the gates' times), maxParallel, engines (run, dropped, why).
// A gate's process group is killed when the gate ends (any process it left behind), on its timeout, and, for every
// running gate, when the runner gets SIGINT or SIGTERM (F-466: the output each running gate held is printed first, and with
// gates side by side every gate's output is also appended as it arrives to .build/ci/gate-logs/<id>.log). A timed-out
// engine-net gate keeps its slot until the Compose projects it started are gone (F-467, capped by CI_SETTLE_CAP_S, default 90).
// Exit 0 = green, 1 = a gate red, 2 = start-up error.
// Also writes the flat verdict the dashboard reads (jl-dev contracts/ci-verdict, BM-100): a full run (--all) writes
// .build/ci-verdict.json, a partial run (merge set, --records) writes .build/ci-only-verdict.json so a quick run never
// overwrites the full verdict. The gate map declares no by-design or hygiene category, so those two lists are [].
// Env (for tests): CI_ROOT, CI_GATES_FILE, CI_VERDICT_OUT, CI_FLAT_VERDICT_OUT, CI_ONLY_VERDICT_OUT,
// CI_TIME_CHECK_CMD ("" turns it off), CI_GATE_HISTORY (the scope base history, default .build/ci-time.jsonl).
// A gate with onlyWhenChanged globs (F-408; the push set --all only) runs when a matching file differs from the sha of the last
// recorded run (push, nightly or full) that ran it green, else it is recorded unchanged (neither pass nor fail). Doubt runs it.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALL_ENGINE_NAMES, resolveEngines } from './pw-engine-names.ts';
import {
  canStart, decideScope, defaultCap, inSet, isActive, lastDurations, loadMap, repoRoot, resolveCap, resolveGateCmd, runnerOf, startOrder, timeoutFor, validateMap, type Gate,
} from './gates-lib.ts';

// all = the push set (the wave run), nightly = every gate unscoped but the checkpoint ones, checkpoint = nightly plus the checkpoint
// gates (F-1410), gates = the named ones (P3-CI-CADENCE).
type Mode = 'merge' | 'all' | 'nightly' | 'checkpoint' | 'records' | 'gates';
// unchanged (F-408): a gate scoped by onlyWhenChanged whose files did not change since its last green full run.
// Neither pass nor fail; named in the verdict (reason, base) and listed in suitesSkipped, counted as pending in the flat verdict.
type Status = 'pass' | 'fail' | 'inactive' | 'skipped' | 'unchanged';

interface GateResult {
  id: string;
  status: Status;
  when: Gate['when'];
  critical: boolean;
  durationS: number;
  activates?: string;
  reason?: string;
  base?: string;
  onlyWhenChanged?: string[];
}

const rawArgs = process.argv.slice(2);
// --gates <ids> | --gates=<ids>: the ids are a comma list; a following word that is not a flag is part of the list.
const gatesAsked: string[] = [];
let gatesFlag = false;
const args: string[] = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i] as string;
  if (a === '--gates' || a.startsWith('--gates=')) {
    gatesFlag = true;
    const list = a === '--gates' ? [] : [a.slice('--gates='.length)];
    while (a === '--gates' && i + 1 < rawArgs.length && !(rawArgs[i + 1] as string).startsWith('--')) list.push(rawArgs[++i] as string);
    gatesAsked.push(...list.flatMap((l) => l.split(',')).map((x) => x.trim()).filter((x) => x !== ''));
  } else args.push(a);
}
const known = new Set(['--all', '--nightly', '--checkpoint', '--records', '--serial', '--list']);
const bad = args.filter((a) => !known.has(a) && !/^--jobs=/.test(a));
const capChoice = resolveCap(args, process.env.CI_MAX_PARALLEL, defaultCap(os.availableParallelism(), os.totalmem()));
// One set per run: --all, --nightly, --checkpoint, --records and --gates exclude each other.
const sets = [args.includes('--all'), args.includes('--nightly'), args.includes('--checkpoint'), args.includes('--records'), gatesFlag].filter(Boolean).length;
const usageError = bad.length > 0 || sets > 1 || (gatesFlag && gatesAsked.length === 0) || 'error' in capChoice;
const listOnly = args.includes('--list');
const mode: Mode = gatesFlag ? 'gates' : args.includes('--all') ? 'all' : args.includes('--nightly') ? 'nightly' : args.includes('--checkpoint') ? 'checkpoint' : args.includes('--records') ? 'records' : 'merge';
// The scope a run is recorded under in the verdict and in ci-time.jsonl.
// A checkpoint run is the nightly set plus gates, so its verdict, row and wave-run judging are the nightly's (F-1410).
const scope = mode === 'all' ? 'push' : mode === 'checkpoint' ? 'nightly' : mode;

const root = process.env.CI_ROOT ? path.resolve(process.env.CI_ROOT) : repoRoot();
const gatesFile = process.env.CI_GATES_FILE ?? path.join(root, 'ci', 'gates.json');
const verdictOut = process.env.CI_VERDICT_OUT ?? path.join(root, '.build', 'ci', 'ci-verdict.json');
const wavePath = process.env.CI_FLAT_VERDICT_OUT ?? path.join(root, '.build', 'ci-verdict.json');
const onlyPath = process.env.CI_ONLY_VERDICT_OUT ?? path.join(root, '.build', 'ci-only-verdict.json');
const flatOut = mode === 'all' || mode === 'nightly' || mode === 'checkpoint' ? wavePath : onlyPath;
// F-408: the committed history of recorded runs (push, nightly or full) (ci-time-check rows: sha + per-gate status) a scoped gate takes its base from.
const historyFile = process.env.CI_GATE_HISTORY ?? path.join(root, '.build', 'ci-time.jsonl');

// F-22 c, F-108: a start-up error (exit 2) must not leave the previous run's verdict in place as a pass. A usage
// error comes first, before the mode is known, so it removes every verdict path; any other run removes its own two.
if (usageError) {
  rmSync(verdictOut, { force: true });
  rmSync(wavePath, { force: true });
  rmSync(onlyPath, { force: true });
  if ('error' in capChoice) console.error(`ci.sh: ${capChoice.error}`);
  if (gatesFlag && gatesAsked.length === 0) console.error('ci.sh: --gates needs at least 1 gate id');
  console.error('usage: ci/ci.sh [--all | --nightly | --checkpoint | --records | --gates <ids>] [--list] [--serial | --jobs=<n>]');
  process.exit(2);
}
const cap = 'cap' in capChoice ? capChoice.cap : 1;
const capSource = 'cap' in capChoice ? capChoice.source : '';
if (!listOnly) {
  rmSync(verdictOut, { force: true });
  rmSync(flatOut, { force: true });
}

let map;
try {
  map = loadMap(gatesFile);
} catch (e) {
  console.error(`ci.sh: cannot read ${gatesFile}: ${(e as Error).message}`);
  process.exit(2);
}
const errors = validateMap(map);
if (errors.length > 0) {
  for (const e of errors) console.error(`ci.sh: start-up error: ${e}`);
  process.exit(2);
}

// P3-CI-CADENCE: an engines list names only the known engines (ci/pw-engine-names.ts), or the verdict record would be false.
for (const g of map.gates) {
  const bad = (g.engines ?? []).filter((n) => !(ALL_ENGINE_NAMES as readonly string[]).includes(n));
  if (bad.length > 0) {
    console.error(`ci.sh: start-up error: gate ${g.id}: engines names ${bad.join(', ')}, which is not one of ${ALL_ENGINE_NAMES.join(', ')}`);
    process.exit(2);
  }
}

// A named id that is not in the map stops the run at start-up (exit 2), before any gate runs.
if (mode === 'gates') {
  const known = new Set(map.gates.map((g) => g.id));
  const unknown = gatesAsked.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    console.error(`ci.sh: start-up error: --gates names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not in ci/gates.json (known: ${[...known].join(', ')})`);
    process.exit(2);
  }
  // A named gate that is in the map but inactive would run nothing and read green (F-580): that is a start-up error too.
  const inactive = map.gates.filter((g) => gatesAsked.includes(g.id) && !isActive(root, g.id)).map((g) => g.id);
  if (inactive.length > 0) {
    console.error(`ci.sh: start-up error: --gates names ${inactive.join(', ')}, which ${inactive.length === 1 ? 'is' : 'are'} inactive (no marker ci/active/<id>), so the run would run nothing`);
    process.exit(2);
  }
}

// F-1201: a runner mac gate needs this Mac (Xcode, the simulator); the map's sets never select it here, the mac half of ci/wave-run.sh
// runs it (ci/mac-half.ts). Named with --gates it runs wherever ci.sh runs, except in the wave container (F-1430): that is the Spectre half of
// a wave run, whose mac half runs the named mac gate and gives the verdict its row, as in a nightly run.
const waveContainer = process.env.BW_WAVE_CONTAINER === '1';
function selected(g: Gate): boolean {
  if (runnerOf(g) === 'mac' && (mode !== 'gates' || waveContainer)) return false;
  return inSet(mode, g, gatesAsked);
}

// --list: what this mode would run, and the sum of their time limits. Runs nothing, writes no verdict.
if (listOnly) {
  let sumS = 0;
  const ids: string[] = [];
  for (const g of map.gates) {
    if (!selected(g)) continue;
    const active = isActive(root, g.id);
    const limitS = timeoutFor(map, g);
    if (active) {
      sumS += limitS;
      ids.push(g.id);
    }
    console.log(`LIST ${g.id} ${g.when} ${active ? 'active' : 'inactive'} timeoutS=${limitS}${g.onlyWhenChanged && mode === 'all' ? ' scoped(onlyWhenChanged)' : ''}`);
  }
  console.log(`LIST ${mode}: ${ids.length} active gates, timeoutS sum ${sumS}: ${ids.join(' ')}`);
  process.exit(0);
}

function sha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// F-410: the process groups of the gates running now. SIGINT or SIGTERM to the runner kills every one of them.
const runningGroups = new Set<number>();
// F-466: what each running gate has printed so far (held output, side-by-side runs only), by process group.
const heldOutput = new Map<number, { id: string; chunks: Buffer[] }>();
function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // group already gone
  }
}
const onSignal = (sig: NodeJS.Signals): void => {
  // F-466: the gates that hung are the ones to debug, so print what each held before the groups are killed.
  for (const [, h] of heldOutput) {
    const text = Buffer.concat(h.chunks).toString('utf8');
    process.stdout.write(`\n=== ${h.id}: stopped by ${sig} while running; its output so far:\n${text}${text === '' || text.endsWith('\n') ? '' : '\n'}`);
  }
  for (const pgid of runningGroups) killGroup(pgid);
  process.exit(sig === 'SIGINT' ? 130 : 143);
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

const gateLogDir = path.join(path.dirname(verdictOut), 'gate-logs');
// F-974: per-test times. Each gate gets BW_JUNIT_DIR=<root>/.build/junit/<id>; the vitest configs write a junit file there and
// ci/test-times.sh records it with test-cost.py after the run (ci/wave-run.sh does the same on the host for a container run).
const junitRoot = path.join(root, '.build', 'junit');
if (!listOnly) rmSync(junitRoot, { recursive: true, force: true });

/**
 * F-997 a: a gate's environment. The junit folder is made here, before the gate starts; when it cannot be made, BW_JUNIT_DIR is left
 * unset (and the reason printed), so the gate runs with no junit reporter and a write failure can never fail it.
 */
function gateEnv(id: string): NodeJS.ProcessEnv {
  const dir = path.join(junitRoot, id);
  try {
    mkdirSync(dir, { recursive: true });
    return { ...process.env, BW_JUNIT_DIR: dir };
  } catch (e) {
    console.log(`ci.sh: cannot make ${dir} (${(e as Error).message}); ${id} runs without per-test times`);
    const env = { ...process.env };
    delete env.BW_JUNIT_DIR;
    return env;
  }
}
if (!listOnly && cap > 1) {
  rmSync(gateLogDir, { recursive: true, force: true });
  mkdirSync(gateLogDir, { recursive: true });
}

/** F-467: the Compose projects the engine knows now (any state), or null when there is no usable docker here. */
function composeProjects(): Set<string> | null {
  const r = spawnSync('docker', ['compose', 'ls', '--all', '--format', 'json'], { encoding: 'utf8', timeout: 8_000 });
  if (r.error || r.status !== 0) return null;
  try {
    const rows = JSON.parse(r.stdout.trim() === '' ? '[]' : r.stdout) as { Name?: string }[];
    return new Set(rows.map((x) => String(x.Name)));
  } catch {
    return null;
  }
}

// The projects that were up before the first watched gate started, read once per run (a run that has no usable docker reads null).
let baseline: Set<string> | null | undefined;
function stackBaseline(): Set<string> | null {
  if (baseline === undefined) baseline = composeProjects();
  return baseline;
}

/**
 * F-467: a gate killed on its timeout never runs its EXIT trap; its reaper (its own group, by design) tears the stack down
 * about 1 s later. Until that is done the engine's network namespace is still changing, so the slot is held until the
 * projects started since the run began are gone, at most CI_SETTLE_CAP_S seconds (default 90).
 */
async function settleStacks(id: string, before: Set<string>): Promise<void> {
  const capS = Number(process.env.CI_SETTLE_CAP_S ?? '90');
  const t0 = Date.now();
  for (;;) {
    const now = composeProjects();
    if (now === null) return;
    const left = [...now].filter((n) => !before.has(n));
    if (left.length === 0) {
      console.log(`ci.sh: gate ${id} timed out; its Compose projects are gone after ${Math.round((Date.now() - t0) / 100) / 10}s, the slot is released`);
      return;
    }
    if (Date.now() - t0 >= capS * 1000) {
      console.log(`ci.sh: gate ${id} timed out and its Compose projects (${left.join(', ')}) are still up after ${capS}s; the slot is released anyway`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Grace for a gate's output pipes to drain after its shell exits, before they are closed (a holder outside the group). */
const PIPE_GRACE_MS = 2000;

/**
 * Run a shell command in its own process group; past limitS the whole group is killed, and when the shell ends the
 * group is killed too, so nothing the gate started outlives it (W-47). hold: collect its output (stdout and stderr in
 * arrival order) instead of streaming it, for a run with gates side by side.
 */
function runLimited(id: string, cmd: string, limitS: number, hold: boolean): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd: root,
      stdio: hold ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      detached: true,
      env: gateEnv(id),
    });
    const chunks: Buffer[] = [];
    // F-466: a held gate's output is also appended to .build/ci/gate-logs/<id>.log as it arrives, so a run stopped by its cap leaves it.
    const logFile = hold ? path.join(gateLogDir, `${id}.log`) : null;
    const keep = (d: Buffer): void => {
      chunks.push(d);
      if (logFile !== null) {
        try {
          appendFileSync(logFile, d);
        } catch {
          // the log is a diagnostic; a write failure never fails the gate
        }
      }
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const pgid = child.pid;
    if (pgid !== undefined) {
      runningGroups.add(pgid);
      if (hold) heldOutput.set(pgid, { id, chunks });
    }
    let timedOut = false;
    let exitCode: number | null = null;
    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (pgid !== undefined) {
        killGroup(pgid);
        runningGroups.delete(pgid);
        heldOutput.delete(pgid);
      }
      resolve({ code, timedOut, output: Buffer.concat(chunks).toString('utf8') });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (pgid !== undefined) killGroup(pgid);
    }, limitS * 1000);
    let grace: NodeJS.Timeout | undefined;
    child.on('exit', (code) => {
      exitCode = code;
      // The shell is gone: end whatever it left in its group, then let the pipes drain (a process outside the group
      // that still holds them is cut off after the grace).
      if (pgid !== undefined) killGroup(pgid);
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(exitCode);
      }, PIPE_GRACE_MS);
    });
    child.on('close', (code) => finish(code ?? exitCode));
    child.on('error', () => finish(1));
  });
}

const startedAt = Date.now();
// Results by map index, so the verdict lists them in map order whatever order the gates end in.
const slots: (GateResult | undefined)[] = new Array<GateResult | undefined>(map.gates.length);
const header = (g: Gate, shown: string): string => `\n=== ${g.id} (${g.when}${g.critical ? ', critical' : ''}): ${shown}`;
interface Planned {
  g: Gate;
  index: number;
  cmd: string;
  limitS: number;
}
const planned: Planned[] = [];

// Pass 1, in map order and before any gate runs: what is skipped, inactive, unchanged (F-408) or missing its script.
map.gates.forEach((g, index) => {
  if (!selected(g)) {
    if (runnerOf(g) === 'mac' && inSet(mode, g, gatesAsked)) console.log(`MAC ${g.id}: runner mac, not run here (the mac half of ci/wave-run.sh runs it)`);
    slots[index] = { id: g.id, status: 'skipped', when: g.when, critical: g.critical, durationS: 0 };
    return;
  }
  if (!isActive(root, g.id)) {
    console.log(`INACTIVE ${g.id}: activates when ${g.activates} merges (marker ci/active/${g.id})`);
    slots[index] = { id: g.id, status: 'inactive', when: g.when, critical: g.critical, durationS: 0, activates: g.activates };
    return;
  }
  // F-408: a scoped gate in a push run skips only when git proves no scoped file changed since its last green run.
  // A nightly run and a named gate (--gates) run unscoped.
  if (mode === 'all' && g.onlyWhenChanged !== undefined) {
    const d = decideScope(root, g, historyFile);
    if (!d.run) {
      const reason = `no change in ${d.globs.join(', ')} since ${d.base}`;
      console.log(`${header(g, `skipped (${reason})`)}`);
      slots[index] = { id: g.id, status: 'unchanged', when: g.when, critical: g.critical, durationS: 0, reason, base: d.base, onlyWhenChanged: d.globs };
      return;
    }
    console.log(`\nscope ${g.id}: runs (${d.why})`);
  }
  const resolved = resolveGateCmd(root, g);
  if ('missing' in resolved) {
    const reason = `active (marker present) but ${resolved.missing} is missing: the activating lane (${g.activates}) must add it`;
    console.log(header(g, '(no script)'));
    console.error(`ci.sh: gate ${g.id} ${reason}`);
    console.log(`=== ${g.id}: FAIL in 0s`);
    slots[index] = { id: g.id, status: 'fail', when: g.when, critical: g.critical, durationS: 0, reason };
    return;
  }
  planned.push({ g, index, cmd: resolved.cmd, limitS: timeoutFor(map, g) });
});

// Pass 2: run the planned gates. Cap 1 keeps the map order and streams; above it, longest recorded gate first.
const hold = cap > 1;
const queue = hold ? startOrder(planned, lastDurations(historyFile)) : [...planned];
if (hold && planned.length > 1) {
  const alone = planned.filter((p) => p.g.parallel === undefined).map((p) => p.g.id);
  console.log(`\nci.sh: up to ${cap} gates side by side (${capSource})${alone.length ? `; alone (no parallel field): ${alone.join(', ')}` : ''}`);
}
const running = new Map<number, Gate>();

async function runOne(p: Planned): Promise<void> {
  const { g } = p;
  if (hold) console.log(`--> ${g.id} started (${running.size} running)`);
  else console.log(header(g, p.cmd));
  const t0 = Date.now();
  // F-467: a gate that may share the engine with others (no parallel field, or a non-empty exclusive list) is watched for stacks it leaves.
  const watchStacks = g.parallel === undefined || g.parallel.exclusive.length > 0;
  const before = watchStacks ? stackBaseline() : null;
  const r = await runLimited(g.id, p.cmd, p.limitS, hold);
  if (r.timedOut && before !== null) await settleStacks(g.id, before);
  const ok = r.code === 0 && !r.timedOut;
  const reason = r.timedOut ? `timeout: exceeded ${p.limitS}s and was killed` : undefined;
  const durationS = Math.round(((Date.now() - t0) / 1000) * 100) / 100;
  const tail = `${reason ? `ci.sh: gate ${g.id} ${reason}\n` : ''}=== ${g.id}: ${ok ? 'pass' : 'FAIL'} in ${durationS}s\n`;
  if (hold) {
    const body = r.output === '' || r.output.endsWith('\n') ? r.output : `${r.output}\n`;
    process.stdout.write(`${header(g, p.cmd)}\n${body}${tail}`);
  } else {
    if (reason) console.error(`ci.sh: gate ${g.id} ${reason}`);
    console.log(`=== ${g.id}: ${ok ? 'pass' : 'FAIL'} in ${durationS}s`);
  }
  slots[p.index] = { id: g.id, status: ok ? 'pass' : 'fail', when: g.when, critical: g.critical, durationS, ...(reason ? { reason } : {}) };
}

await new Promise<void>((resolveAll) => {
  const pump = (): void => {
    for (let i = 0; i < queue.length; ) {
      const p = queue[i] as Planned;
      if (!canStart(p.g, [...running.values()], cap)) {
        i++;
        continue;
      }
      queue.splice(i, 1);
      running.set(p.index, p.g);
      void runOne(p).then(() => {
        running.delete(p.index);
        pump();
      });
    }
    if (queue.length === 0 && running.size === 0) resolveAll();
  };
  pump();
});
const results: GateResult[] = slots.map((s) => s as GateResult);
const gateDurationSumS = Math.round(results.reduce((a, r) => a + r.durationS, 0) * 100) / 100;

// The Playwright engines the browser gates ran on (F-47): the same env the gates inherit. A narrowed run records the
// dropped engines and why, so a copied verdict cannot pass for a full-engine run.
let engines: { run: string[]; dropped: string[]; why: string | null };
try {
  const e = resolveEngines(process.env.BW_PW_ENGINES, process.env.BW_PW_ENGINES_WHY);
  engines = {
    run: e.names,
    dropped: ALL_ENGINE_NAMES.filter((n) => !e.names.includes(n)),
    why: e.notice ? (process.env.BW_PW_ENGINES_WHY ?? '').trim() : null,
  };
  // P3-CI-CADENCE: the record follows the gates that ran. A gate that declares `engines` in ci/gates.json narrows its own
  // browsers in its script (the push halves run Chromium only), so the run's engines are what those gates ran on, not the
  // runner's env. With no browser gate in the set, the env record above stands.
  const declared = new Map(map.gates.filter((g) => g.engines !== undefined).map((g) => [g.id, g.engines as string[]]));
  const browserGates = results.filter((r) => (r.status === 'pass' || r.status === 'fail') && declared.has(r.id));
  if (browserGates.length > 0) {
    const ran = new Set(browserGates.flatMap((r) => declared.get(r.id) as string[]));
    const names = e.names.filter((n) => ran.has(n));
    const dropped = ALL_ENGINE_NAMES.filter((n) => !names.includes(n));
    engines = {
      run: names,
      dropped,
      why: dropped.length === 0 ? null : (process.env.BW_PW_ENGINES_WHY ?? '').trim() || `${scope} set: the browser gates that ran (${browserGates.map((r) => r.id).join(', ')}) use ${names.join(', ')} only; ${dropped.join(', ')} runs in the nightly set`,
    };
  }
} catch (e) {
  console.error(`ci.sh: start-up error: ${(e as Error).message}`);
  process.exit(2);
}

const failed = results.filter((r) => r.status === 'fail');
const verdict: Record<string, unknown> = {
  result: failed.length === 0 ? 'pass' : 'fail',
  mode: scope === 'nightly' ? 'nightly' : mode,
  ...(mode === 'checkpoint' ? { checkpoint: true } : {}),
  scope,
  sha: sha(),
  generatedAt: new Date().toISOString(),
  suitesRun: results.filter((r) => r.status === 'pass' || r.status === 'fail').map((r) => r.id),
  engines,
  suitesSkipped: results.filter((r) => r.status === 'skipped' || r.status === 'inactive' || r.status === 'unchanged').map((r) => r.id),
  totalDurationS: Math.round(((Date.now() - startedAt) / 1000) * 100) / 100,
  // F-410: beside the wall time, the sum of the gates' own times and the cap they ran under.
  gateDurationSumS,
  maxParallel: cap,
  gates: results,
};
/** The flat shape-2 verdict. pending = gates not run (inactive or outside this mode), so pass + pending + fail = total. */
function flatVerdict(): Record<string, unknown> {
  const count = (s: Status): number => results.filter((r) => r.status === s).length;
  return {
    ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    sha: verdict.sha ?? 'unknown',
    verdict: verdict.result,
    pass: count('pass'),
    pending: count('inactive') + count('skipped') + count('unchanged'),
    fail: count('fail'),
    total: results.length,
    failing: failed.map((f) => f.id),
    byDesignFailing: [],
    hygieneFailing: [],
    gates: results.map((r) => ({ id: r.id, status: r.status, durationS: r.durationS })),
    mode: scope === 'nightly' ? 'nightly' : mode,
    scope,
    totalDurationS: verdict.totalDurationS,
  };
}
function write(): void {
  mkdirSync(path.dirname(verdictOut), { recursive: true });
  writeFileSync(verdictOut, JSON.stringify(verdict, null, 2) + '\n');
  mkdirSync(path.dirname(flatOut), { recursive: true });
  writeFileSync(flatOut, JSON.stringify(flatVerdict()) + '\n');
}
write();

// F-974: record the per-test times (never a gate: a failure here is printed, the verdict stands). The wave container has no
// test-cost.py; ci/wave-run.sh copies .build/junit out and records on the host.
if (process.env.BW_WAVE_CONTAINER !== '1') {
  const r = spawnSync('bash', [path.join(import.meta.dirname, 'test-times.sh'), junitRoot, sha() ?? '', path.join(root, '.build', 'test-history.jsonl')], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) console.log(`ci.sh: test-times.sh exit ${String(r.status)} (advisory: per-test times not recorded)`);
}

// ci-time-check.py after each full run (playbook): a smoke alarm, never a gate. Exit 3 = budget
// breach (printed; the manager files it), 4 = lap stop (printed). Any other non-zero is recorded. In the wave container the row is
// not appended (--no-append): its history dies with the container, and the row of record is the host's (ci/wave-run.sh time_check, F-691, F-694).
if (mode === 'all' || mode === 'nightly' || mode === 'checkpoint') {
  // F-1571: ci/vendor (the owner's private jl-dev copy) is not in the public repo; without it the alarm is skipped with a message.
  const vendored = existsSync(path.join(root, 'ci', 'vendor', 'jl-dev', 'ci-time-check.py'));
  if (process.env.CI_TIME_CHECK_CMD === undefined && !vendored) console.log('\n=== ci-time-check skipped: ci/vendor is not in this tree');
  const cmd =
    process.env.CI_TIME_CHECK_CMD ??
    (!vendored ? '' : `python3 ci/vendor/jl-dev/ci-time-check.py --scope ${scope} --verdict "${verdictOut}" --history .build/ci/ci-time.jsonl --plan docs/BUILD_PLAN.md${process.env.BW_WAVE_CONTAINER === '1' ? ' --no-append' : ''}`);
  if (cmd !== '') {
    console.log('\n=== ci-time-check');
    const r = spawnSync('bash', ['-c', cmd], { cwd: root, stdio: 'inherit' });
    verdict.timeCheck = { exit: r.status, note: r.status === 0 ? 'within budget' : r.status === 3 ? 'budget breach (advisory)' : r.status === 4 ? 'lap stop (advisory)' : 'tool problem (advisory)' };
    write();
  }
}

console.log(`\nci.sh ${mode}: ${verdict.result} in ${String(verdict.totalDurationS)}s wall, ${gateDurationSumS}s of gate time, up to ${cap} at once (${failed.length} red${failed.length ? ': ' + failed.map((f) => f.id).join(', ') : ''}); verdict ${path.relative(root, verdictOut)}`);
process.exit(failed.length === 0 ? 0 : 1);
