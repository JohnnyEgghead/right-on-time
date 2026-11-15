// SPDX-License-Identifier: AGPL-3.0-or-later
// F-196 (the F-195 class; the helper itself reads argv[1] and is the one exempt file): every script decides "am I the program?" with ci/is-main.ts, which compares real paths.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMain } from './is-main.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const run = (args: string[]) => spawnSync('git', ['ls-files', '-z', '--', ...args], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);

/** The 1-based lines of a module that read the program's own path from argv with no realpathSync on the line (F-196, F-239). */
const rawArgv1Lines = (source: string): number[] => {
  if (!/import\.meta/.test(source)) return [];
  // The names that hold process.argv itself: the literal, `const a = process.argv;`, `const { argv } = process;`, `import { argv } from 'node:process'`.
  const names = ['process\\.argv'];
  for (const m of source.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*process\.argv\s*[;\n]/g)) names.push(m[1] as string);
  if (/\{[^}]*\bargv\b[^}]*\}\s*=\s*process\b|import\s*\{[^}]*\bargv\b[^}]*\}\s*from\s*['"](?:node:)?process['"]/.test(source)) names.push('argv');
  const n = `(?:${names.join('|')})`;
  const at1 = new RegExp(`\\b${n}\\s*\\[\\s*1\\s*\\]|\\b${n}\\.at\\(\\s*1\\s*\\)|\\b${n}\\.slice\\(\\s*1\\s*\\)|\\[\\s*\\w*\\s*,\\s*[A-Za-z_$]\\w*\\s*[,\\]]\\s*=\\s*${n}\\s*[;\\n]`);
  return source.split('\n').flatMap((l, i) => (!/^\s*(?:\/\/|\*|\/\*)/.test(l) && at1.test(l) && !/realpathSync/.test(l) ? [i + 1] : []));
};

describe('the main-module guard (F-196)', () => {
  // why: F-196 a symlinked argv[1] must still count as the main module, and a different module must not
  it('is true for the module run through a symlink and false for another module', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ismain-'));
    const file = path.join(dir, 'real.mjs');
    writeFileSync(file, 'export {};\n');
    const link = path.join(dir, 'link.mjs');
    symlinkSync(file, link);
    const meta = `file://${file}`;
    expect(isMain(meta, link)).toBe(true);
    expect(isMain(meta, file)).toBe(true);
    expect(isMain(meta, path.join(dir, 'other.mjs'))).toBe(false);
    expect(isMain(meta, undefined)).toBe(false);
  });

  // why: F-196 the 3 gates (no-hosted-runners, license-gates, page-inventory) must run their body through a symlinked path
  it('runs the gate scripts through a symlinked path instead of exiting 0 silently', () => {
    const link = path.join(mkdtempSync(path.join(tmpdir(), 'ismain-link-')), 'ci');
    symlinkSync(path.join(ROOT, 'ci'), link);
    // An empty directory is a misconfiguration for no-hosted-runners: exit 1 with a message, which the skipped body could not give.
    const empty = mkdtempSync(path.join(tmpdir(), 'ismain-empty-'));
    const r = spawnSync(process.execPath, [path.join(link, 'no-hosted-runners.ts'), empty], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/no-hosted-runners/);
  });

  // why: F-196 the class check: a raw read of the program path from argv (no realpathSync on that line) in a module that uses import.meta is a fail
  it('no tracked script reads the program path from argv without realpathSync', () => {
    const files = run(['*.ts', '*.mjs', '*.js']).filter((f) => f !== 'ci/is-main.ts' && f !== 'ci/is-main.test.ts' &&!f.startsWith('.build/') && !f.startsWith('.claude/') && !f.includes('node_modules'));
    const raw = files.flatMap((f) => rawArgv1Lines(readFileSync(path.join(ROOT, f), 'utf8')).map((i) => `${f}:${i}`));
    expect(raw).toEqual([]);
  });

  // why: F-239 the guard pattern saw only the literal process.argv[1]; every other spelling of that read must be found, and user-argument reads must not
  it('finds each spelling of the argv[1] read and leaves user-argument reads alone (known-bad)', () => {
    const bad = [
      'const me = process.argv[1];', 'const me = process.argv[ 1 ];','const me = process.argv.at(1);', 'const me = process.argv.slice(1)[0];',
      'const [, entry] = process.argv;', 'const [node, entry] = process.argv;',
    ];
    for (const line of bad) expect(rawArgv1Lines(`import.meta.url;\n${line}\n`), line).toEqual([2]);
    expect(rawArgv1Lines('import.meta.url;\nconst a = process.argv;\nconst me = a[1];\n'), 'an alias').toEqual([3]);
    expect(rawArgv1Lines('import.meta.url;\nconst { argv } = process;\nconst me = argv[1];\n'), 'a destructured argv').toEqual([3]);
    expect(rawArgv1Lines('import.meta.url;\nfunction main(argv) { return argv[1]; }\n'), 'a parameter named argv is the caller\'s list').toEqual([]);
    expect(rawArgv1Lines('import.meta.url;\n// the old guard compared process.argv[1] directly\n')).toEqual([]);
    expect(rawArgv1Lines('import.meta.url;\nconst me = realpathSync(process.argv[1]);\n')).toEqual([]);
    expect(rawArgv1Lines('import.meta.url;\nconst [, , first] = process.argv;\nconst rest = process.argv.slice(2);\n')).toEqual([]);
    expect(rawArgv1Lines('const me = process.argv[1];\n'), 'a file with no import.meta is not a module guard').toEqual([]);
  });
});
