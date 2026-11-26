// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling: copy-check must see a new copied block and must not see a comment, a moved line or an excluded file
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { blankComments, filesToScan, findCopies, judge, rowsFor } from './copy-check.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

/** 20 lines of code that share nothing with another seed's lines. */
const block = (seed: string, lines = 20) =>
  Array.from({ length: lines }, (_, i) => `const ${seed}${i} = ${seed}Compute(${i}, '${seed}-${i}', other${seed}[${i}] + ${i * 7});`);
/** Code that stands in 1 place only, down to its first and last token. */
const own = (seed: string) => [`start${seed} &&`, ...block(`own${seed}`, 10), `end${seed}`];
const text = (...parts: string[][]) => `${parts.flat().join('\n')}\n`;

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-copy-test.'));
  roots.push(root);
  for (const [f, t] of Object.entries({ 'scripts/private-paths.txt': '# none\nci/held/\n', ...files })) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), t);
  }
  return root;
}

const copies = (files: Record<string, string>) => {
  const root = tree(files);
  return findCopies(root, filesToScan(root)).copies;
};
const places = (c: { a: { file: string; from: number }; b: { file: string; from: number } }) => [`${c.a.file}:${c.a.from}`, `${c.b.file}:${c.b.from}`];

const A = 'apps/x/a.ts';
const B = 'packages/y/b.ts';
const C = 'ci/c.ts';
const before = { [A]: text(own('p'), block('k'), own('q')), [B]: text(own('r'), block('k'), own('s')) };

describe('copy-check', () => {
  // why: tooling: a block of 20 lines pasted into a second file is what the check is for, and its red must send the reader to both places
  it('reports a pasted block of 20 lines outside the baseline with both places', () => {
    const { fresh } = judge(copies(before), []);
    expect(fresh).toHaveLength(1);
    expect(places(fresh[0]!)).toEqual([`${A}:13`, `${B}:13`]);
  });

  // why: tooling: a comment edited or added inside a listed copy changes no code, so it must not make the change red
  it('stays green when a comment is edited inside a listed copy', () => {
    const rows = rowsFor(copies(before), 'listed');
    const k = block('k');
    const commented = [...k.slice(0, 5), '// a new note', '/* and one', ' * over 2 lines */', `${k[5]!} // beside the code`, ...k.slice(6)];
    const now = copies({ ...before, [B]: text(own('r'), commented, own('s')) });
    expect(now.length).toBeGreaterThan(0);
    expect(judge(now, rows)).toEqual({ fresh: [], stale: [] });
  });

  // why: tooling: rows are keyed by code, not by line number, so lines added above a listed copy must not make the change red
  it('stays green when blank lines move a listed copy down', () => {
    const rows = rowsFor(copies(before), 'listed');
    const now = copies({ ...before, [A]: `\n\n\n\n\n${before[A]!}` });
    expect(places(now[0]!)[0]).toBe(`${A}:18`);
    expect(judge(now, rows)).toEqual({ fresh: [], stale: [] });
  });

  // why: tooling: comments are not code, so they must not carry a short block over the line floor
  it('does not count comment lines toward the length of a copy', () => {
    const notes = Array.from({ length: 8 }, (_, i) => `// note ${i}`);
    const short = (n: number) => [...block('k', n).slice(0, 2), ...notes, ...block('k', n).slice(2)];
    const at = (n: number) => copies({ [A]: text(own('p'), short(n), own('q')), [B]: text(own('r'), short(n), own('s')) }).length;
    expect(at(9)).toBe(0);
    expect(at(10)).toBe(1);
  });

  // why: tooling: a listed block pasted once more is a new copy, whether into the same file or a third one; the row must not cover it
  it('reports a listed block pasted again into one of its files, or into a third file', () => {
    const rows = rowsFor(copies(before), 'listed');
    const again = judge(copies({ ...before, [A]: text(own('p'), block('k'), own('q'), block('k'), own('t')) }), rows).fresh;
    expect(again).not.toEqual([]);
    const third = judge(copies({ ...before, [C]: text(own('u'), block('k')) }), rows).fresh;
    expect(third.flatMap(places)).toContain(`${C}:13`);
  });

  // why: tooling: taking code out of a copy, or 1 of 3 copies away, adds no copy, so the cleanup itself must not be red
  it('stays green when a listed copy shrinks, is split by an edit, or loses one of 3 places', () => {
    const k = block('k', 40);
    const long = { [A]: text(own('p'), k, own('q')), [B]: text(own('r'), k, own('s')), [C]: text(own('u'), k, own('v')) };
    const rows = rowsFor(copies(long), 'listed');
    expect(judge(copies({ ...long, [A]: text(own('p'), k.slice(0, 20), ['const inserted = 1;'], k.slice(21), own('q')) }), rows).fresh).toEqual([]);
    for (const gone of [A, B, C]) expect(judge(copies({ ...long, [gone]: text(own('w')) }), rows).fresh).toEqual([]);
  });

  // why: tooling: a row left behind would let the same copy come back unseen, so a row with no copy must be named
  it('names a row whose copy is gone', () => {
    const rows = rowsFor(copies(before), 'listed');
    expect(judge(copies({ ...before, [B]: text(own('r')) }), rows)).toEqual({ fresh: [], stale: rows });
  });

  // why: tooling: the 2 exclusions must leave out what they name and nothing beside it
  it('scans neither a private path nor a generated kit slice, and scans the files beside them', () => {
    const root = tree({ 'ci/held/a.ts': '', 'ci/heldx/a.ts': '', 'apps/web/styles/kit/kit.css': '', 'apps/web/styles/kit/kit.base.css': '', 'apps/web/styles/app/kit.base.css': '', 'docs/a.ts': '', 'ci/a.md': '' });
    expect(filesToScan(root)).toEqual(['apps/web/styles/app/kit.base.css', 'apps/web/styles/kit/kit.css', 'ci/heldx/a.ts']);
  });

  // why: tooling: a scan that read nothing, or a scanner that did not run, must never look like a tree with no copies
  it('throws when there is no file, jscpd is missing or fails, or it read too few files', () => {
    const root = tree(before);
    expect(() => findCopies(root, [])).toThrow('no file to scan');
    expect(() => findCopies(root, [A, B], path.join(root, 'no-jscpd'))).toThrow('jscpd did not finish');
    expect(() => findCopies(root, [A, B], '/usr/bin/false')).toThrow('jscpd did not finish');
    const small = tree({ [A]: 'export {};\n', [B]: 'export {};\n' });
    expect(() => findCopies(small, [A, B])).toThrow('jscpd read 0 of the 2 files');
  });

  // why: tooling: the scanner's own ignore comment would hide a copy with no row and no reviewer
  it('throws on a jscpd ignore comment', () => {
    const root = tree({ ...before, [C]: `// jscpd:${'ignore-start'}\n` });
    expect(() => findCopies(root, filesToScan(root))).toThrow('hides code from this check: ci/c.ts');
  });

  // why: tooling: the code of a row is what is left when comments are blanked; a comment mark inside a string or markup is code
  it('blanks comments and keeps strings, markup text and line numbers', () => {
    expect(blankComments('const a = "// no"; // yes\n/* x\n */ f();\n', 'a.ts').replace(/ +/g, ' ')).toBe('const a = "// no"; \n \n f();\n');
    expect(blankComments('const u = <a>http://x {/* y */ z}</a>;\n', 'a.tsx').replace(/ +/g, ' ')).toBe('const u = <a>http://x { z}</a>;\n');
    expect(blankComments('a { b: c; } /* d\n e */\n', 'a.css').trimEnd()).toBe('a { b: c; }');
    expect(blankComments('x="$#" # y\n', 'a.sh').trimEnd()).toBe('x="$#"');
  });
});
