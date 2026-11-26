// SPDX-License-Identifier: AGPL-3.0-or-later
// copy-check: no new copied block of code. jscpd (an exact-version dev dependency, run from node_modules) finds the blocks of code that
// stand in 2 places; ci/copy-check/baseline.json holds the ones that were there when this check began, or that a reviewer agreed to.
// A copy outside that list is red, and the message names both places.
//   node ci/copy-check.ts [--root <dir>]          exit 0 no new copy, 1 a new copy or a run that cannot be trusted, 2 usage
//   node ci/copy-check.ts --prune                 drop the baseline rows that no longer match a copy
//   node ci/copy-check.ts --accept "<reason>"     add a row with this reason for each new copy (a reviewer agrees to it in the same change)
// What counts: a copy of 50 tokens or more and 10 lines of code or more. A line that holds only a comment or nothing is not a line of
// code, and comments are no part of a row, so a comment edited inside a listed copy, or lines added above it, change nothing.
// A row is the file pair and a hash of each whole line of code they share, not a line number. A copy that shrinks, or that an edit
// splits in 2, is still inside its row; the same block pasted once more into the first file, or into a third one, is not.
// What it does not see (F-1936, F-1937): jscpd compares 1 file format at a time, so a block pasted from .ts into .tsx or .mjs is green
// (.ts to .ts, .tsx to .tsx and .ts to .mts are red); and part of a listed copy pasted again into the second file of its own pair is
// green, because that row already holds those lines.
// Not scanned, each for its reason: see EXCLUDED, and the paths scripts/private-paths.txt names (files another tool installs and
// keeps in step, and files the public copy does not hold), read when the check runs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { isMain } from './is-main.ts';
import { isPrivate, listPublicFiles, readPrivateRules } from './public-files.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASELINE = 'ci/copy-check/baseline.json';
const MIN_TOKENS = 50;
const MIN_CODE_LINES = 10;
/** jscpd leaves out a file with fewer than MIN_TOKENS tokens, and says nothing. Fewer than this share of the listed files read is a scan gone wrong. */
const MIN_READ_SHARE = 0.8;

/** The folders of code, and each suffix with the format jscpd reads it as. */
const SCAN = ['apps/', 'packages/', 'ci/', 'infra/', 'scripts/'];
const FORMATS: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
  '.css': 'css', '.sh': 'bash', '.py': 'python', '.swift': 'swift', '.sql': 'sql',
};

const EXCLUDED: readonly { match: RegExp; reason: string }[] = [
  { match: /^apps\/web\/styles\/kit\/kit\.[^/]+\.css$/, reason: 'byte ranges cut from kit.css by apps/web/src/kit-slices.ts; kit.css itself is scanned' },
];

interface Place {
  file: string;
  from: number;
  to: number;
}

/** 1 copied block: its 2 places, and the whole lines of code they share as each place writes them, 1 hash per line. */
export interface Copy {
  a: Place;
  b: Place;
  code: [string, string];
}

export interface Row {
  a: string;
  b: string;
  count: number;
  why: string;
  code: string;
}

interface JscpdReport {
  statistics: { total: { sources: number } };
  duplicates: { firstFile: { name: string; start: number; end: number }; secondFile: { name: string; start: number; end: number } }[];
}

function walk(root: string, rel: string, out: string[]): string[] {
  for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel + e.name;
    if (e.isDirectory()) {
      if (!['node_modules', '.next', 'dist', 'build', 'Pods'].includes(e.name)) walk(root, `${p}/`, out);
    } else if (e.isFile()) out.push(p);
  }
  return out;
}

/** The files of the code folders, private paths left out, in 1 order on every machine. A download of the public copy has no repository, so there the folders are walked. */
export function listCode(root: string): string[] {
  const rules = readPrivateRules(root);
  const all = existsSync(path.join(root, '.git')) ? listPublicFiles(root) : SCAN.filter((d) => existsSync(path.join(root, d))).flatMap((d) => walk(root, d, []));
  return all.filter((f) => SCAN.some((d) => f.startsWith(d)) && !isPrivate(f, rules)).sort();
}

export const filesToScan = (root: string) => listCode(root).filter((f) => path.extname(f) in FORMATS && !EXCLUDED.some((x) => x.match.test(f)));

/** `text` with each comment blanked, every line where it was. */
export function blankComments(text: string, file: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  const ext = path.extname(file);
  if (ext === '.css') return text.replace(/\/\*[^]*?\*\//g, blank);
  if (ext === '.sql') return text.replace(/--.*/g, blank).replace(/\/\*[^]*?\*\//g, blank);
  if (ext === '.swift') return text.replace(/\/\*[^]*?\*\//g, blank).replace(/(^|\s)\/\/.*/gm, blank);
  if (ext === '.sh' || ext === '.py') return text.replace(/(^|\s)#.*/gm, blank);
  const kind = ext === '.tsx' || ext === '.jsx' ? ts.ScriptKind.TSX : ext === '.ts' || ext === '.mts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const parts: string[] = [];
  const visit = (n: ts.Node): void => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = n.getChildren(source);
    if (kids.length > 0 && !ts.isToken(n)) return kids.forEach(visit);
    // What stands between a token's full start and its start is space and comments only.
    const start = n.kind === ts.SyntaxKind.JsxText ? n.pos : n.getStart(source, false);
    parts.push(blank(text.slice(n.pos, start)), text.slice(start, n.end));
  };
  visit(source);
  return parts.join('');
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10);

/** The whole lines of code inside a place. Its first and last line can be shared with code outside the copy, so they are left out. */
function codeLines(blanked: string[], p: Place): string[] {
  return blanked.slice(p.from, p.to - 1).map((l) => l.trim().replace(/\s+/g, ' ')).filter((l) => l !== '').map(hash);
}

/** Runs jscpd. Anything that is not a full, readable scan is thrown, never an empty list. */
export function findCopies(root: string, files: readonly string[], jscpd = path.join(ROOT, 'node_modules/.bin/jscpd')): { copies: Copy[]; read: number } {
  if (files.length === 0) throw new Error('no file to scan');
  const hidden = files.filter((f) => readFileSync(path.join(root, f), 'utf8').includes('jscpd:' + 'ignore-'));
  if (hidden.length > 0) throw new Error(`a jscpd ignore comment hides code from this check: ${hidden.join(', ')} (take it out; a copy that is right gets a row with its reason)`);
  const out = mkdtempSync(path.join(tmpdir(), 'bw-copy-check.'));
  try {
    const args = ['--mode', 'weak', '--min-tokens', String(MIN_TOKENS), '--min-lines', String(MIN_CODE_LINES), '--max-lines', '1000000', '--max-size', '100mb',
      '--format', [...new Set(Object.values(FORMATS))].join(','), '--no-gitignore', '--absolute', '--reporters', 'json,silent', '--output', out, '--exit-code', '0'];
    const run = spawnSync(jscpd, [...args, ...files], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const report = path.join(out, 'jscpd-report.json');
    if (run.error !== undefined || run.status !== 0 || !existsSync(report)) {
      throw new Error(`jscpd did not finish (exit ${String(run.status)}): ${run.error?.message ?? `${run.stdout}${run.stderr}`.trim().slice(-600)}`);
    }
    const d = JSON.parse(readFileSync(report, 'utf8')) as JscpdReport;
    const real = realpathSync(root);
    const read = d.statistics.total.sources;
    if (!(read >= files.length * MIN_READ_SHARE)) throw new Error(`jscpd read ${read} of the ${files.length} files listed, under ${MIN_READ_SHARE * 100} percent`);
    const blanked = new Map<string, string[]>();
    const linesOf = (f: string) => {
      if (!blanked.has(f)) blanked.set(f, blankComments(readFileSync(path.join(root, f), 'utf8'), f).split('\n'));
      return blanked.get(f)!;
    };
    const place = (x: { name: string; start: number; end: number }): Place => ({ file: path.relative(real, path.resolve(real, x.name)).split(path.sep).join('/'), from: x.start, to: x.end });
    const copies = d.duplicates
      .map((c) => [place(c.firstFile), place(c.secondFile)].sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : x.from - y.from)) as [Place, Place])
      .map(([a, b]): Copy => ({ a, b, code: [codeLines(linesOf(a.file), a).join(' '), codeLines(linesOf(b.file), b).join(' ')] }))
      // The first and last line of a copy are code too, so the whole lines between them are 2 short of its lines of code.
      .filter((c) => c.code[0].split(' ').length >= MIN_CODE_LINES - 2)
      .sort((x, y) => (order(x) < order(y) ? -1 : 1));
    return { copies, read };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const order = (c: Copy) => [c.a.file, c.b.file, String(c.a.from).padStart(7, '0'), String(c.b.from).padStart(7, '0')].join('\n');
const copyPair = (c: Copy) => `${c.a.file}\n${c.b.file}`;
const rowPair = (r: Row) => `${r.a}\n${r.b}`;
const holds = (row: Row, c: Copy) => c.code.some((s) => ` ${row.code} `.includes(` ${s} `));

/** The copies outside the rows, and the rows that match no copy. */
export function judge(copies: readonly Copy[], rows: readonly Row[]): { fresh: Copy[]; stale: Row[] } {
  const used = new Set<Row>();
  const seen = new Map<string, number>();
  const fresh: Copy[] = [];
  for (const c of copies) {
    const holding = rows.filter((r) => holds(r, c));
    const own = holding.filter((r) => rowPair(r) === copyPair(c));
    if (own.length > 0) {
      own.forEach((r) => used.add(r));
      const k = `${copyPair(c)}\n${c.code[0]}`;
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      if (n > own.reduce((sum, r) => sum + r.count, 0)) fresh.push(c);
      continue;
    }
    // 3 files that hold 1 block are reported as 2 pairs. When 1 of them changes, jscpd pairs the other 2: no copy is new there.
    const listed = (f: string) => holding.some((r) => r.a === f || r.b === f);
    if (c.a.file !== c.b.file && listed(c.a.file) && listed(c.b.file)) holding.forEach((r) => used.add(r));
    else fresh.push(c);
  }
  return { fresh, stale: rows.filter((r) => !used.has(r)) };
}

/** Rows for copies: 1 per file pair and code, with how often that pair holds it. */
export function rowsFor(copies: readonly Copy[], why: string): Row[] {
  const by = new Map<string, Row>();
  for (const c of copies) {
    const k = `${copyPair(c)}\n${c.code[0]}`;
    const row = by.get(k);
    if (row) row.count += 1;
    else by.set(k, { a: c.a.file, b: c.b.file, count: 1, why, code: c.code[0] });
  }
  return [...by.values()];
}

/** The committed rows. A missing or malformed file is thrown. */
function readRows(root: string): Row[] {
  const { rows } = JSON.parse(readFileSync(path.join(root, BASELINE), 'utf8')) as { rows: Row[] };
  if (!Array.isArray(rows)) throw new Error(`${BASELINE} has no rows list`);
  for (const r of rows) {
    if (![r.a, r.b, r.why, r.code].every((v) => typeof v === 'string' && v.trim() !== '') || !Number.isInteger(r.count) || r.count < 1) {
      throw new Error(`${BASELINE}: a row needs a, b, code, a why in words and a count of 1 or more: ${JSON.stringify(r).slice(0, 160)}`);
    }
  }
  return rows;
}

function writeRows(root: string, rows: readonly Row[]): void {
  const doc = 'The copied blocks of code ci/copy-check.ts lets stand: a file pair, how often it holds the block, why, and 1 hash per whole line of code. Written by its --accept and --prune.';
  const sorted = [...rows].sort((x, y) => (rowPair(x) + x.code < rowPair(y) + y.code ? -1 : 1));
  writeFileSync(path.join(root, BASELINE), `{"_doc": ${JSON.stringify(doc)},\n"rows": [\n${sorted.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`);
}

function main(argv: string[]): number {
  let root = ROOT;
  let prune = false;
  let accept: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i]!);
    else if (argv[i] === '--prune') prune = true;
    else if (argv[i] === '--accept' && argv[i + 1]?.trim()) accept = argv[++i]!;
    else {
      console.error('copy-check: usage: node ci/copy-check.ts [--root <dir>] [--prune] [--accept "<reason>"]');
      return 2;
    }
  }
  try {
    const started = performance.now();
    const rows = readRows(root);
    const files = filesToScan(root);
    const { copies, read } = findCopies(root, files);
    const { fresh, stale } = judge(copies, rows);
    if (prune || accept !== null) {
      const kept = prune ? rows.filter((r) => !stale.includes(r)) : rows;
      writeRows(root, [...kept, ...(accept === null ? [] : rowsFor(fresh, accept))]);
      console.log(`copy-check: baseline written (${prune ? stale.length : 0} rows dropped, ${accept === null ? 0 : fresh.length} copies accepted)`);
      return accept === null && fresh.length > 0 ? 1 : 0;
    }
    for (const r of stale) console.log(`copy-check: note: a baseline row matches no copy now (drop it with --prune): ${r.a} and ${r.b}`);
    for (const c of fresh) console.error(`copy-check: FAIL a new copy: ${c.a.file}:${c.a.from}-${c.a.to} and ${c.b.file}:${c.b.from}-${c.b.to}`);
    const what = `${read} of ${files.length} files read, ${copies.length} copies, ${rows.length} baseline rows, ${stale.length} of them unused, ${((performance.now() - started) / 1000).toFixed(1)} s`;
    if (fresh.length > 0) {
      console.error(`copy-check: FAIL ${fresh.length} new (${what}). Share the code; a copy that is right needs a row with its reason (--accept), agreed in review.`);
      return 1;
    }
    console.log(`copy-check: ok (${what})`);
    return 0;
  } catch (e) {
    console.error(`copy-check: FAIL the check did not run: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
