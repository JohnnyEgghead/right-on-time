// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling: dead-code-check must see a new dead export or file, only outside its baseline, and must never take a failed scan for a clean one
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findDead, judge, type Rows } from './dead-code.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

const CONFIG = JSON.stringify({ entry: ['ci/main.ts'], project: ['ci/**/*.ts'] });
const CLEAN = {
  'ci/main.ts': "import { used } from './lib.ts';\nconsole.log(used);\n",
  'ci/lib.ts': 'export const used = 1;\n',
};

function tree(files: Record<string, string>, config = CONFIG): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-dead-test.'));
  roots.push(root);
  const all = { 'package.json': '{"name":"x","type":"module"}', 'scripts/private-paths.txt': '# none\n', 'ci/dead-code/knip.jsonc': config, ...files };
  for (const [f, t] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), t);
  }
  copyFileSync(path.join(import.meta.dirname, 'dead-code/reporter.mjs'), path.join(root, 'ci/dead-code/reporter.mjs'));
  return root;
}

const NONE: Rows = { exports: {}, files: {} };
const DEAD = { ...CLEAN, 'ci/lib.ts': 'export const used = 1;\nexport const planted = 2;\nexport type Planted = string;\n', 'ci/orphan.ts': 'export const x = 1;\n' };

describe('dead-code-check', () => {
  // why: tooling: an export no file imports and a file nothing starts are what the check is for, and its red must name the file and the symbol
  it('reports a planted dead export, a dead type and an orphan file outside the baseline', () => {
    expect(judge(findDead(tree(CLEAN)).found, NONE).fresh).toEqual([]);
    const { fresh } = judge(findDead(tree(DEAD)).found, NONE);
    expect(fresh.map((f) => [f.file, f.symbol])).toEqual([['ci/lib.ts', 'Planted'], ['ci/lib.ts', 'planted'], ['ci/orphan.ts', null]]);
  });

  // why: tooling: only a finding outside the baseline fails, and a row covers its own file and symbol only, never the same name in another file
  it('lets a listed export stand, in its own file only', () => {
    const { found } = findDead(tree(DEAD));
    const rows: Rows = { exports: { 'ci/lib.ts': { planted: 'a', Planted: 'b' } }, files: { 'ci/orphan.ts': 'c' } };
    expect(judge(found, rows)).toEqual({ fresh: [], stale: [] });
    expect(judge(found, { ...rows, exports: { 'ci/other.ts': { planted: 'a', Planted: 'b' } } }).fresh).toHaveLength(2);
  });

  // why: tooling: a row left behind would let the same export come back dead unseen, so a row knip does not find must be named
  it('names a row knip does not find', () => {
    const rows: Rows = { exports: { 'ci/lib.ts': { used: 'a' } }, files: { 'ci/main.ts': 'b' } };
    expect(judge(findDead(tree(CLEAN)).found, rows).stale.map((f) => [f.file, f.symbol])).toEqual([['ci/main.ts', null], ['ci/lib.ts', 'used']]);
  });

  // why: tooling: a scan that read nothing, or a scanner that did not run, must never look like a tree with no dead code
  it('throws when there is no file, knip is missing or fails, or it read too few files', () => {
    expect(() => findDead(tree({}))).toThrow('no TypeScript file');
    const root = tree(CLEAN);
    expect(() => findDead(root, path.join(root, 'no-knip'))).toThrow('knip did not finish');
    expect(() => findDead(root, '/usr/bin/true')).toThrow('knip did not finish');
    expect(() => findDead(tree(CLEAN, '{"entry": 5}'))).toThrow('knip did not finish (exit 2)');
    const narrow = JSON.stringify({ entry: ['ci/main.ts'], project: ['ci/main.ts'], ignore: [] });
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`ci/f${i}.ts`, 'export const x = 1;\n']));
    expect(() => findDead(tree({ ...CLEAN, ...many }, narrow))).toThrow('knip read 1 files of a tree with 12');
  });

  // why: tooling: knip leaves out an export tagged public, so the tag would hide dead code with no row and no reviewer
  it('throws on a comment tag that hides an export', () => {
    const root = tree({ ...CLEAN, 'ci/lib.ts': `export const used = 1;\n/** @${'public'} */\nexport const planted = 2;\n` });
    expect(() => findDead(root)).toThrow('hides an export from this check: ci/lib.ts');
  });
});
