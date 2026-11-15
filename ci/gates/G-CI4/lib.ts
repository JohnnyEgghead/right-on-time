// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared parts of gate G-CI4 (inv4-one-clock-zoned-times; SPECIFICATIONS section 14 item 4): the no-system-clock
// run with the repo's own eslint.config.mjs, the committed case files, and the host-zone run reports.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import { ACCEPTED_SKIPS_FILE, ACCEPTED_SKIPS_RULING, ACCEPTED_ZONE_SKIPS, acceptedSkipFile, type AcceptedSkip } from './accepted-skips.ts';

export const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const CASES = path.join(import.meta.dirname, 'cases');
export const RULE = 'bw/no-system-clock';

/** The 3 host zones of NFR-08. */
export const HOST_ZONES = ['UTC', 'America/New_York', 'America/Los_Angeles'] as const;

/**
 * The rule as the repo configures it, with inline config off: an eslint-disable comment can hide a read from the
 * lint gate's report but never from G-CI4.
 */
function clockLinter(): ESLint {
  return new ESLint({ cwd: ROOT, allowInlineConfig: false, ruleFilter: ({ ruleId }) => ruleId === RULE });
}

export interface LintOutcome {
  hits: { line: number; message: string }[];
  fatal: string[];
}

export async function lintClockText(code: string, filePath: string): Promise<LintOutcome> {
  const [res] = await clockLinter().lintText(code, { filePath: path.join(ROOT, filePath) });
  const msgs = res?.messages ?? [];
  return {
    hits: msgs.filter((m) => m.ruleId === RULE).map((m) => ({ line: m.line, message: m.message })),
    fatal: msgs.filter((m) => m.fatal).map((m) => m.message),
  };
}

/** Every no-system-clock read in apps/ and packages/ (the real tree), as file:line messages. */
export async function lintClockTree(): Promise<string[]> {
  const results = await clockLinter().lintFiles(['apps', 'packages']);
  const out: string[] = [];
  for (const r of results) {
    for (const m of r.messages) {
      if (m.ruleId === RULE || m.fatal) out.push(`${path.relative(ROOT, r.filePath)}:${m.line}:${m.column} ${m.message}`);
    }
  }
  return out;
}

export interface Case {
  name: string;
  /** The path the case is checked as (its header line `// case-as: <path>`). */
  as: string;
  expect: 'fail' | 'pass';
  /** The rest of the `// expect:` line: a hit count (no-system-clock) or a reason or tag list (realnow-sites). */
  detail: string;
  body: string;
}

export function loadCases(kind: 'no-system-clock' | 'realnow-sites'): Case[] {
  const dir = path.join(CASES, kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((f) => {
      const text = readFileSync(path.join(dir, f), 'utf8');
      const as = /^\/\/ case-as: (\S+)$/m.exec(text)?.[1];
      const ex = /^\/\/ expect: (fail|pass) ?(.*)$/m.exec(text);
      if (!as || !ex) throw new Error(`${kind}/${f}: missing the case-as or expect header`);
      return { name: f.replace(/\.txt$/, ''), as, expect: ex[1] as 'fail' | 'pass', detail: ex[2] ?? '', body: text };
    });
}

/** The section 11.3 use tags, read from the table in docs/SPECIFICATIONS.md, in table order. */
export function specUseTags(): string[] {
  const spec = readFileSync(path.join(ROOT, 'docs', 'SPECIFICATIONS.md'), 'utf8');
  const start = spec.indexOf('### 11.3 Real-time uses');
  if (start < 0) throw new Error('docs/SPECIFICATIONS.md has no section 11.3 Real-time uses');
  const end = spec.indexOf('\n### ', start + 1);
  const tags: string[] = [];
  for (const line of spec.slice(start, end).split('\n')) {
    const first = /^\| ([^|]+) \|/.exec(line)?.[1];
    if (!first || !first.includes('`')) continue;
    for (const m of first.matchAll(/`([a-z_]+)`/g)) tags.push(m[1]!);
  }
  return tags;
}

/** The RealTimeUse union of section 4.2's code block. */
export function specUnionTags(): string[] {
  const spec = readFileSync(path.join(ROOT, 'docs', 'SPECIFICATIONS.md'), 'utf8');
  const m = /export type RealTimeUse =([^;]+);/.exec(spec);
  if (!m) throw new Error('docs/SPECIFICATIONS.md section 4.2 has no RealTimeUse union');
  return [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
}

/** 1 test of a zone report: its file as the report names it (an absolute path), its id (file basename::full name), its status. */
export interface ZoneTest {
  file: string;
  id: string;
  status: string;
}

export interface ZoneReport {
  zone: string;
  passed: number;
  failed: number;
  probePassed: boolean;
  /** Tests that were skipped, pending or todo (F-178): a zone run must have none but the accepted ones (F-1422). */
  skipped: number;
  /** Those tests by id with their status (F-1422), so a red zone run names them in the log. */
  skippedIds: string[];
  /** F-1422: the run's test files as the report names them, and every test, so the accepted-skip list is judged by file and id. */
  files: string[];
  tests: ZoneTest[];
  /** The id (file and full name) of every passed test, sorted; the 3 zones must hold the same list. */
  passedIds: string[];
  /** The failed tests with their assertion text (F-246), so a red zone run can be read from the log alone. */
  failures: string[];
}

/** The test that proves the host zone took effect (packages/time/src/dst.test.ts). */
export const PROBE_TEST = 'the host zone is the one this run was started under';

/** Read 1 vitest JSON report of a host-zone run. */
export function readZoneReport(zone: string, file: string): ZoneReport {
  const r = JSON.parse(readFileSync(file, 'utf8')) as {
    numPassedTests: number;
    numFailedTests: number;
    testResults: { name?: string; assertionResults: { title: string; fullName?: string; status: string; failureMessages?: string[] }[] }[];
  };
  const all = r.testResults.flatMap((t) => t.assertionResults);
  const tests = r.testResults.flatMap((t) =>
    t.assertionResults.map((a) => ({ file: t.name ?? '', id: `${path.basename(t.name ?? '')}::${a.fullName ?? a.title}`, status: a.status })),
  );
  const passedIds = tests.filter((t) => t.status === 'passed').map((t) => t.id).sort();
  const skippedIds = tests.filter((t) => isSkip(t.status)).map((t) => `${t.id} (${t.status})`);
  return {
    zone,
    passed: r.numPassedTests,
    failed: r.numFailedTests,
    probePassed: all.some((a) => a.title === PROBE_TEST && a.status === 'passed'),
    skipped: skippedIds.length,
    skippedIds,
    files: r.testResults.map((t) => t.name ?? ''),
    tests,
    passedIds,
    failures: r.testResults.flatMap((t) =>
      t.assertionResults
        .filter((a) => a.status === 'failed')
        .map((a) => `${path.basename(t.name ?? '')}::${a.fullName ?? a.title}: ${(a.failureMessages?.join(' ') ?? 'no failure text in the report').replace(/\s+/g, ' ').slice(0, 400)}`),
    ),
  };
}

/**
 * F-373: the acceptance tests a gate pins by name. A deleted case shrinks a whole gate's test set in lockstep and no zone or
 * skip rule sees it, so each pin is a test's exact title (its it() name), and it must name exactly 1 test of the report
 * (F-636): a pin that names no test, or whose 1 test did not pass, is a red, and a pin that names 2 or more is refused, since
 * deleting one of them would leave the gate green. A skipped or todo test is a red too.
 */
export function pinnedProblems(file: string, names: readonly string[]): string[] {
  const r = JSON.parse(readFileSync(file, 'utf8')) as { testResults: { assertionResults: { title: string; fullName?: string; status: string }[] }[] };
  const all = r.testResults.flatMap((t) => t.assertionResults);
  const p: string[] = [];
  for (const n of names) {
    const hits = all.filter((a) => a.title === n);
    if (hits.length === 0) p.push(`the pinned test "${n}" did not run and pass: no test has that exact title`);
    else if (hits.length > 1) p.push(`the pin "${n}" names ${hits.length} tests; a pin must name exactly 1 test`);
    else if (hits[0]!.status !== 'passed') p.push(`the pinned test "${n}" did not run and pass: it is ${hits[0]!.status}`);
  }
  const skipped = all.filter((a) => a.status !== 'passed' && a.status !== 'failed').length;
  if (skipped > 0) p.push(`${skipped} tests skipped or todo; the gate must run every test`);
  return p;
}

/** Skipped, pending or todo: any status but passed and failed. */
function isSkip(status: string): boolean {
  return status !== 'passed' && status !== 'failed';
}

/** What the accepted-skip list is judged against: the committed list, this platform, and the real tree (cases pass their own). */
export interface SkipRules {
  list?: readonly AcceptedSkip[];
  platform?: string;
  exists?: (file: string) => boolean;
  /** The root a report's absolute test paths are read against (F-1426); the cases pass their fixtures' /work. */
  root?: string;
}

export interface SkipJudgment {
  /** Skips whose file and id match a listed entry exactly, by id. */
  accepted: string[];
  /** Every other skipped, pending or todo test, by id with its status: each is a red. */
  refused: string[];
  /** Listed entries this run shows to be wrong, by id with the reason: each is a red. */
  stale: string[];
}

/** A report names a test file by its absolute path; the list names it from the repo root (F-1426: the path from the root, not a suffix). */
const sameFile = (reportFile: string, listed: string, root: string) => reportFile === listed || path.relative(root, reportFile) === listed;

/**
 * F-1422 (owner ruling 341a9f4e): split a zone run's skips into the accepted (accepted-skips.ts, by file and id) and the
 * refused, and find the stale entries. A run that does not hold a listed file (G-CI4 step 3 runs packages/time; G-CI9 its
 * quiet-hours set) cannot judge that entry's test, so only a gone file is stale there.
 */
export function judgeSkips(rep: ZoneReport, rules: SkipRules = {}): SkipJudgment {
  const list = rules.list ?? ACCEPTED_ZONE_SKIPS;
  const platform = rules.platform ?? process.platform;
  const exists = rules.exists ?? ((f: string) => existsSync(path.join(ROOT, f)));
  const root = rules.root ?? ROOT;
  const isListed = (t: ZoneTest, a: AcceptedSkip) => sameFile(t.file, acceptedSkipFile(a), root) && t.id === a.id;
  const accepted: string[] = [];
  const refused: string[] = [];
  for (const t of rep.tests.filter((x) => isSkip(x.status))) {
    if (t.status === 'skipped' && list.some((a) => isListed(t, a))) accepted.push(t.id);
    else refused.push(`${t.id} (${t.status})`);
  }
  const stale: string[] = [];
  const fix = `fix or remove it in ${ACCEPTED_SKIPS_FILE}`;
  for (const a of list) {
    const { id } = a;
    const file = acceptedSkipFile(a);
    if (!exists(file)) {
      stale.push(`${id}: its file ${file} is gone; ${fix}`);
      continue;
    }
    if (!rep.files.some((f) => sameFile(f, file, root))) continue;
    const hits = rep.tests.filter((t) => isListed(t, a));
    if (hits.length === 0) stale.push(`${id}: no test of ${file} has that full name (renamed or deleted); ${fix}`);
    else if (hits.length > 1) stale.push(`${id}: names ${hits.length} tests of ${file}; an entry must name exactly 1; ${fix}`);
    else if (hits[0]!.status === 'passed' && platform !== a.passesOn) stale.push(`${id}: it ran and passed on ${platform}, so it is no longer ${a.passesOn}-only; remove it from ${ACCEPTED_SKIPS_FILE}`);
  }
  return { accepted, refused, stale };
}

/** A zone run counts only when tests passed, none failed, nothing but an accepted test skipped, no entry is stale, and the probe saw this zone. */
export function zoneRunProblems(rep: ZoneReport, rules: SkipRules = {}): string[] {
  const p: string[] = [];
  const j = judgeSkips(rep, rules);
  if (rep.passed === 0) p.push(`${rep.zone}: no test passed`);
  if (rep.failed > 0) p.push(`${rep.zone}: ${rep.failed} tests failed`);
  for (const f of rep.failures.slice(0, 10)) p.push(`${rep.zone}: failed ${f}`);
  const besides = j.accepted.length > 0 ? `, not counting the ${j.accepted.length} accepted by name (${ACCEPTED_SKIPS_RULING})` : '';
  if (j.refused.length > 0) p.push(`${rep.zone}: ${j.refused.length} tests skipped or todo${besides}; a zone run must run every test`);
  for (const s of j.refused.slice(0, 10)) p.push(`${rep.zone}: skipped ${s}`);
  for (const s of j.stale) p.push(`${rep.zone}: stale accepted skip ${s}`);
  if (!rep.probePassed) p.push(`${rep.zone}: the host-zone probe did not pass, so this run is not proven to be in ${rep.zone}`);
  return p;
}

/** The 3 zone runs must have passed the same tests: a test that ran in one zone and not another is a red (F-178). */
export function zoneSetProblems(reps: ZoneReport[]): string[] {
  const [first, ...rest] = reps;
  if (!first) return [];
  const p: string[] = [];
  for (const rep of rest) {
    const mine = new Set(rep.passedIds);
    const theirs = new Set(first.passedIds);
    const missing = first.passedIds.filter((id) => !mine.has(id));
    const extra = rep.passedIds.filter((id) => !theirs.has(id));
    if (missing.length > 0) p.push(`${rep.zone}: did not pass ${missing.length} tests that passed in ${first.zone}, first: ${missing[0]}`);
    if (extra.length > 0) p.push(`${rep.zone}: passed ${extra.length} tests that did not pass in ${first.zone}, first: ${extra[0]}`);
    if (missing.length === 0 && extra.length === 0 && rep.passedIds.length !== first.passedIds.length) p.push(`${rep.zone}: ${rep.passedIds.length} passed tests against ${first.passedIds.length} in ${first.zone}`);
  }
  return p;
}

/**
 * The line printed when the 3 zones passed the same tests. F-1422: it said "none skipped" whenever the sets matched, even when
 * each zone skipped the same tests and the run check above it was red; it now says "none skipped" only when no zone skipped one,
 * counts the skips that are not accepted, and names each accepted skip.
 */
export function zoneSetLine(reps: ZoneReport[], rules: SkipRules = {}): string {
  const head = `the ${reps.length} zones passed the same ${reps[0]?.passedIds.length ?? 0} tests`;
  if (reps.every((r) => r.skipped === 0)) return `${head}, none skipped`;
  const js = reps.map((r) => judgeSkips(r, rules));
  const parts: string[] = [];
  if (js.some((j) => j.refused.length > 0)) parts.push(`skipped or todo, not on the accepted list: ${reps.map((r, i) => `${r.zone} ${js[i]!.refused.length}`).join(', ')}`);
  const names = [...new Set(js.flatMap((j) => j.accepted))];
  if (names.length > 0) {
    const n = js.map((j) => j.accepted.length);
    const count = n.every((x) => x === n[0]) ? `${n[0]} skips in each zone` : `skips ${reps.map((r, i) => `${r.zone} ${n[i]}`).join(', ')}`;
    parts.push(`${count}, accepted by name under ${ACCEPTED_SKIPS_RULING} (Mac-only tests): ${names.join('; ')}`);
  }
  return `${head}; ${parts.join('; ')}`;
}
