// SPDX-License-Identifier: AGPL-3.0-or-later
// dead-code-check: no new export that no file imports, and no new file that nothing starts or imports. knip (an exact-version dev
// dependency, run from node_modules) finds them with ci/dead-code/knip.jsonc; ci/dead-code/baseline.json holds, by file and symbol, the
// exports that were there when this check began and that another file names, so they are not proved dead. One outside it is red.
// What it does not see (F-1938): exports of entry files (ci/*.ts, infra, scripts), files an index re-exports whole, TypeScript files outside
// the globs of knip.jsonc, and an export that only a test imports.
//   node ci/dead-code.ts [--root <dir>]          exit 0 nothing new, 1 something new or a run that cannot be trusted, 2 usage
//   node ci/dead-code.ts --prune                 drop the baseline rows knip no longer finds
//   node ci/dead-code.ts --accept "<reason>"     add a row with this reason for each new finding (a reviewer agrees to it in the same change)
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listCode } from './copy-check.ts';
import { isMain } from './is-main.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASELINE = 'ci/dead-code/baseline.json';
const CONFIG = 'ci/dead-code/knip.jsonc';
/** Fewer than this share of the tree's TypeScript files read is a scan gone wrong (a pattern that matches nothing), not a clean tree. */
const MIN_READ_SHARE = 0.8;

/** 1 finding: an export of a file, or the file itself (symbol null). */
export interface Found {
  kind: string;
  file: string;
  symbol: string | null;
}

/** The committed rows: exports as file, then symbol, then why; files as file, then why. */
export interface Rows {
  exports: Record<string, Record<string, string>>;
  files: Record<string, string>;
}

/** Runs knip. Anything that is not a full, readable scan is thrown, never an empty list. */
export function findDead(root: string, knip = path.join(ROOT, 'node_modules/.bin/knip')): { found: Found[]; read: number } {
  const listed = listCode(root).filter((f) => /\.tsx?$/.test(f));
  if (listed.length === 0) throw new Error('no TypeScript file to scan');
  // knip leaves out an export whose comment holds one of these 2 tags.
  const hidden = listed.filter((f) => /^\s*(\/\*\*|\*).*@(public|beta)\b/m.test(readFileSync(path.join(root, f), 'utf8')));
  if (hidden.length > 0) throw new Error(`a @public or @beta comment tag hides an export from this check: ${hidden.join(', ')} (take it out; an export that is right gets a row with its reason)`);
  const run = spawnSync(
    knip,
    ['--config', CONFIG, '--no-progress', '--include', 'files,exports,types,nsExports,nsTypes', '--reporter', './ci/dead-code/reporter.mjs'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  // knip exits 0 with no finding, 1 with findings, 2 when it could not run.
  const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('{"read":'));
  if (run.error !== undefined || (run.status !== 0 && run.status !== 1) || line === undefined) {
    throw new Error(`knip did not finish (exit ${String(run.status)}): ${run.error?.message ?? `${run.stdout}${run.stderr}`.trim().slice(-600)}`);
  }
  const d = JSON.parse(line) as { read: number; configErrors: boolean; found: Found[] };
  if (d.configErrors) throw new Error(`knip could not load a tool's configuration file, so its result is not whole: ${run.stderr.trim().slice(-600)}`);
  if (!(d.read >= listed.length * MIN_READ_SHARE)) throw new Error(`knip read ${d.read} files of a tree with ${listed.length} TypeScript files, under ${MIN_READ_SHARE * 100} percent`);
  const found = d.found.map((f) => ({ ...f, file: path.relative(realpathSync(root), path.resolve(root, f.file)).split(path.sep).join('/') }));
  return { found: found.sort((x, y) => (`${x.file}\n${x.symbol ?? ''}` < `${y.file}\n${y.symbol ?? ''}` ? -1 : 1)), read: d.read };
}

/** The findings outside the rows, and the rows knip does not find (an export now used, or gone). */
export function judge(found: readonly Found[], rows: Rows): { fresh: Found[]; stale: Found[] } {
  const why = (f: Found) => (f.symbol === null ? (Object.hasOwn(rows.files, f.file) ? rows.files[f.file] : undefined) : Object.hasOwn(rows.exports, f.file) && Object.hasOwn(rows.exports[f.file]!, f.symbol) ? rows.exports[f.file]![f.symbol] : undefined);
  const now = new Set(found.map((f) => `${f.file}\n${f.symbol ?? ''}`));
  const listed: Found[] = [
    ...Object.keys(rows.files).map((file) => ({ kind: 'files', file, symbol: null })),
    ...Object.entries(rows.exports).flatMap(([file, symbols]) => Object.keys(symbols).map((symbol) => ({ kind: 'exports', file, symbol }))),
  ];
  return { fresh: found.filter((f) => why(f) === undefined), stale: listed.filter((f) => !now.has(`${f.file}\n${f.symbol ?? ''}`)) };
}

/** The committed rows. A missing or malformed file, or a row with no reason in words, is thrown. */
function readRows(root: string): Rows {
  const rows = JSON.parse(readFileSync(path.join(root, BASELINE), 'utf8')) as Rows;
  const reasons = [...Object.values(rows.files), ...Object.values(rows.exports).flatMap((s) => Object.values(s))];
  if (!reasons.every((r) => typeof r === 'string' && r.trim() !== '')) throw new Error(`${BASELINE}: a row has no reason in words`);
  return rows;
}

function writeRows(root: string, rows: Rows): void {
  const sort = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)));
  const exports = sort(Object.fromEntries(Object.entries(rows.exports).filter(([, s]) => Object.keys(s).length > 0).map(([f, s]) => [f, sort(s)])));
  const _doc = 'The exports and files ci/dead-code.ts lets stand, by file and symbol, each with why. Written by its --accept and --prune.';
  writeFileSync(path.join(root, BASELINE), `${JSON.stringify({ _doc, files: sort(rows.files), exports }, null, 1)}\n`);
}

const name = (f: Found) => (f.symbol === null ? `${f.file}: no file imports it and no entry of ${CONFIG} starts it` : `${f.file}: ${f.symbol} is exported and no other file imports it`);

function main(argv: string[]): number {
  let root = ROOT;
  let prune = false;
  let accept: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) root = path.resolve(argv[++i]!);
    else if (argv[i] === '--prune') prune = true;
    else if (argv[i] === '--accept' && argv[i + 1]?.trim()) accept = argv[++i]!;
    else {
      console.error('dead-code-check: usage: node ci/dead-code.ts [--root <dir>] [--prune] [--accept "<reason>"]');
      return 2;
    }
  }
  try {
    const started = performance.now();
    const rows = readRows(root);
    const { found, read } = findDead(root);
    const { fresh, stale } = judge(found, rows);
    if (prune || accept !== null) {
      if (prune) {
        for (const f of stale) {
          if (f.symbol === null) delete rows.files[f.file];
          else delete rows.exports[f.file]![f.symbol];
        }
      }
      if (accept !== null) {
        for (const f of fresh) {
          if (f.symbol === null) rows.files[f.file] = accept;
          else (rows.exports[f.file] ??= {})[f.symbol] = accept;
        }
      }
      writeRows(root, rows);
      console.log(`dead-code-check: baseline written (${prune ? stale.length : 0} rows dropped, ${accept === null ? 0 : fresh.length} accepted)`);
      return accept === null && fresh.length > 0 ? 1 : 0;
    }
    for (const f of stale) console.log(`dead-code-check: note: a baseline row knip does not find now (drop it with --prune): ${f.file} ${f.symbol ?? ''}`);
    for (const f of fresh) console.error(`dead-code-check: FAIL ${name(f)}`);
    const what = `${read} files read, ${found.length} findings, ${stale.length} unused baseline rows, ${((performance.now() - started) / 1000).toFixed(1)} s`;
    if (fresh.length > 0) {
      console.error(`dead-code-check: FAIL ${fresh.length} new (${what}). Delete it, or drop its export when its own file uses it.`);
      return 1;
    }
    console.log(`dead-code-check: ok (${what})`);
    return 0;
  } catch (e) {
    console.error(`dead-code-check: FAIL the check did not run: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
