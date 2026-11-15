// SPDX-License-Identifier: AGPL-3.0-or-later
// no-hosted-runners (SPECIFICATIONS SD-38, OA-80): CI runs only on the owner's 2 self-hosted runners.
//   node ci/no-hosted-runners.ts [dir]   check every workflow in dir (default .github/workflows)
//   node ci/no-hosted-runners.ts --runners [file]   F-12: the repo's registered runners (gh api, or a saved
//                                        JSON file) are exactly 1 linux and 1 mac; run by ci/wave-run.sh
// Exit 0: every job passes. Exit 1: a violation (each printed as file:job: rule: detail), a
// parse error, or no workflow found (an empty directory is a misconfiguration, never a pass).
//
// A workflow fails in the 2 cases SD-38 names:
//   runs-on            a job whose runs-on is not exactly one of the 2 runner label sets below
//                      (a string, an expression, a group object, a missing runs-on, or a call to
//                      a reusable workflow outside this repo cannot be proven to stay on them)
//   container-off-linux a container: or services: key, or a docker:// step, on a job that is not
//                      on the linux runner (GitHub runs these only on a Linux runner)
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { isMain } from './is-main.ts';

/** The 2 runner label sets of SD-38. Compared as sets, case-insensitively (as GitHub matches labels). */
export const RUNNER_LABELS = {
  linux: ['self-hosted', 'linux'],
  mac: ['self-hosted', 'mac'],
} as const;

export type Runner = keyof typeof RUNNER_LABELS;

export interface Violation {
  file: string;
  job: string;
  rule: 'runs-on' | 'container-off-linux' | 'parse';
  detail: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The runner a runs-on value names, or a reason it names neither. */
export function classifyRunsOn(runsOn: unknown): Runner | { reason: string } {
  if (runsOn === undefined) return { reason: 'no runs-on' };
  if (isObj(runsOn)) return { reason: 'runs-on is an object (group or labels form); use a label list' };
  const labels = typeof runsOn === 'string' ? [runsOn] : runsOn;
  if (!Array.isArray(labels) || !labels.every((l): l is string => typeof l === 'string')) {
    return { reason: `runs-on is not a list of labels: ${JSON.stringify(runsOn)}` };
  }
  if (labels.some((l) => l.includes('${{'))) {
    return { reason: `runs-on uses an expression, which cannot be checked: ${JSON.stringify(runsOn)}` };
  }
  const got = [...new Set(labels.map((l) => l.trim().toLowerCase()))].sort();
  for (const [name, want] of Object.entries(RUNNER_LABELS) as [Runner, readonly string[]][]) {
    const w = [...want].sort();
    if (got.length === w.length && got.every((l, i) => l === w[i])) return name;
  }
  return {
    reason: `runs-on ${JSON.stringify(runsOn)} is not [self-hosted, linux] or [self-hosted, mac]`,
  };
}

function dockerKeys(job: Obj): string[] {
  const found: string[] = [];
  if (job.container !== undefined) found.push('container:');
  if (job.services !== undefined) found.push('services:');
  const steps = Array.isArray(job.steps) ? job.steps : [];
  steps.forEach((s, i) => {
    if (isObj(s) && typeof s.uses === 'string' && s.uses.trim().startsWith('docker://')) {
      found.push(`docker:// action in step ${i + 1}`);
    }
  });
  return found;
}

/** Check 1 workflow's text. `file` is used only to label violations. */
export function checkWorkflow(file: string, text: string): Violation[] {
  let doc: unknown;
  try {
    doc = parse(text, { merge: true });
  } catch (e) {
    return [{ file, job: '-', rule: 'parse', detail: (e as Error).message.split('\n')[0] ?? 'parse error' }];
  }
  if (!isObj(doc) || !isObj(doc.jobs)) {
    return [{ file, job: '-', rule: 'parse', detail: 'no jobs: mapping' }];
  }
  const out: Violation[] = [];
  for (const [id, job] of Object.entries(doc.jobs)) {
    if (!isObj(job)) {
      out.push({ file, job: id, rule: 'parse', detail: 'job is not a mapping' });
      continue;
    }
    if (typeof job.uses === 'string') {
      // A reusable-workflow call has no runs-on; a local one is checked as its own file.
      if (!job.uses.trim().startsWith('./')) {
        out.push({ file, job: id, rule: 'runs-on', detail: `calls a reusable workflow outside this repo: ${job.uses}` });
      }
      continue;
    }
    const runner = classifyRunsOn(job['runs-on']);
    if (typeof runner !== 'string') out.push({ file, job: id, rule: 'runs-on', detail: runner.reason });
    if (runner !== 'linux') {
      for (const key of dockerKeys(job)) {
        out.push({ file, job: id, rule: 'container-off-linux', detail: `${key} on a job not on the linux runner` });
      }
    }
  }
  return out;
}

/** Check every *.yml / *.yaml in dir. Returns the files checked and the violations. */
export function checkDir(dir: string): { files: string[]; violations: Violation[] } {
  if (!existsSync(dir)) {
    return { files: [], violations: [{ file: dir, job: '-', rule: 'parse', detail: 'workflow directory not found' }] };
  }
  const files = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
  const violations = files.flatMap((f) => checkWorkflow(f, readFileSync(path.join(dir, f), 'utf8')));
  if (files.length === 0) violations.push({ file: dir, job: '-', rule: 'parse', detail: 'no workflow files found' });
  return { files, violations };
}

/**
 * F-12: the label check above cannot see the runner set. A self-hosted Linux runner registered later
 * carries the default "Linux" label, so [self-hosted, linux] would match it while the gate stays green.
 * Judge the GET actions/runners list: exactly 2 runners, exactly 1 labeled mac and exactly 1 labeled linux.
 * Returns the problems (empty = the set is exactly the 2 runners of SD-38).
 */
export function checkRunnerList(list: unknown): string[] {
  if (!isObj(list) || !Array.isArray(list.runners)) return ['runner list is not {runners: [...]}'];
  const names = (r: unknown): string[] =>
    isObj(r) && Array.isArray(r.labels)
      ? r.labels.map((l) => (isObj(l) && typeof l.name === 'string' ? l.name.trim().toLowerCase() : ''))
      : [];
  const runners = list.runners;
  const nameOf = (r: unknown) => (isObj(r) && typeof r.name === 'string' ? r.name : '?');
  const problems: string[] = [];
  if (runners.length !== 2) {
    problems.push(`${runners.length} runners registered (${runners.map(nameOf).join(', ')}); SD-38 allows exactly 2`);
  }
  const macs = runners.filter((r) => names(r).includes('mac'));
  const linuxes = runners.filter((r) => names(r).includes('linux'));
  if (macs.length !== 1) problems.push(`${macs.length} runners carry the mac label; want exactly 1`);
  if (linuxes.length !== 1) problems.push(`${linuxes.length} runners carry the linux label; want exactly 1`);
  return problems;
}

/** F-113: the longest the gh read of the runner list may take. A stalled call is killed and is a failed read. */
export const GH_TIMEOUT_MS = 60_000;

export function runnersMain(file: string | undefined, ghTimeoutMs: number = GH_TIMEOUT_MS): number {
  let text: string;
  if (file) {
    text = readFileSync(file, 'utf8');
  } else {
    // SIGKILL, so a gh that ignores SIGTERM cannot outlast the bound. A timeout leaves status null: a failure.
    const r = spawnSync('gh', ['api', 'repos/{owner}/{repo}/actions/runners?per_page=100'], {
      encoding: 'utf8',
      timeout: ghTimeoutMs,
      killSignal: 'SIGKILL',
    });
    if (r.status !== 0) {
      const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      const why = timedOut ? `gh timed out after ${ghTimeoutMs} ms` : `gh exit ${r.status}`;
      console.log(`no-hosted-runners --runners: cannot read the runner list (${why}); a failed read is a failure`);
      return 1;
    }
    text = r.stdout;
  }
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    console.log('no-hosted-runners --runners: runner list is not JSON');
    return 1;
  }
  const problems = checkRunnerList(list);
  for (const p of problems) console.log(`runners: ${p}`);
  console.log(`no-hosted-runners --runners: ${problems.length} problem(s)`);
  return problems.length === 0 ? 0 : 1;
}

function main(argv: string[]): number {
  if (argv[0] === '--runners') return runnersMain(argv[1]);
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const dir = path.resolve(argv[0] ?? path.join(root, '.github', 'workflows'));
  const { files, violations } = checkDir(dir);
  for (const v of violations) console.log(`${v.file}:${v.job}: ${v.rule}: ${v.detail}`);
  console.log(`no-hosted-runners: ${files.length} workflow(s), ${violations.length} violation(s)`);
  return violations.length === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
