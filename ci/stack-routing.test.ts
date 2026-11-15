// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1367
// Every CI rig that starts web or worker with `compose up` must start routing too, as the default stack does. Reads that plan or time
// a day ask http://routing:5000 for any leg with no stored track (packages/maps/src/route-source.ts, SD-49); where the name does not
// resolve and the lookup is slow (Spectre, about 3.9 s, F-643) each such read spends its whole 3 s budget and suite waits fail, while
// the same run on a fast-failing Mac stays green (F-1361, F-1415). This reads every ci/**/*.sh, so a rig with any name is covered.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ciDir = path.resolve(__dirname);
const root = path.resolve(ciDir, '..');

// Rig scripts outside ci/ that start the stack too (F-1418); the gates that run them are in ci/gates.json.
// The rigs that start web or worker today (26 under ci/, 2 of them found only by joining a split line, and the 2 outside); a rig added or one that leaves the scan changes this count.
const PINNED_RIGS = 28;
const OUTSIDE = ['apps/tech-native/xcuitest/run.sh', 'infra/backup/tests/stack.sh'];

// Rigs that deliberately start without routing, each with the reason and where the script says so.
const ALLOWED: Record<string, string> = {
  // ci/route-bake-stack.sh:64 and :77: the suite (ci/route-bake-stack/route.stack.ts) starts and stops routing itself, and the
  // script fails when routing runs before the suite starts it.
  'route-bake-stack.sh': 'the suite starts routing itself (route-bake-stack.sh:64, :77)',
  // The native-suite gate runs on the Mac, where an unresolved name fails in milliseconds, and its default stack ref p5-checkpoint has
  // no routing service (git show p5-checkpoint:infra/compose.yaml); the ref is a parameter, so a HEAD stack ref wants routing here.
  'run.sh': 'native-suite on the Mac fails an unresolved name fast, and its default stack ref p5-checkpoint has no routing service (F-1418)',
  // The restore-test gate's suite reads no leg, so a missing routing name costs nothing there (nightly run 4a1c239f, 249.77 s, passed).
  'stack.sh': 'the restore-test suite reads no routing leg (F-1418)',
};

const shFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' ? [] : shFiles(path.join(dir, e.name))) : e.name.endsWith('.sh') ? [path.join(dir, e.name)] : [],
  );

// The `compose up` lines that start web or worker by name, as whole lines of code (comments dropped). A line with --no-deps recreates
// one service on a project that is already up, so it is not a start of the stack.
// A start line split over lines with a trailing backslash is read as 1 line, and a trailing comment is dropped before the match, so a
// comment that holds the word routing cannot satisfy it (F-1418).
export const startLines = (text: string): string[] =>
  text
    .replace(/\s*\\\n\s*/g, ' ')
    .split('\n')
    .map((l) => (l.trim().startsWith('#') ? l : l.replace(/\s#.*$/, '')))
    .filter((l) => !l.trim().startsWith('#'))
    .filter((l) => /\bcompose\b.*\bup\b/.test(l) && !l.includes('--no-deps'))
    .filter((l) => /\s(web|worker)(\s|;|$)/.test(l));

describe('stack rigs start routing (F-1367)', () => {
  const files = [...shFiles(ciDir), ...OUTSIDE.map((r) => path.join(root, r))].map((f) => ({ f, rel: path.relative(ciDir, f), text: readFileSync(f, 'utf8') }));

  it('finds the rigs it is meant to guard', () => {
    // why: F-1367 and F-1418; an empty scan would pass for the wrong reason, and a floor lets rigs leave it unseen: the count is pinned
    expect(files.filter((x) => startLines(x.text).length > 0).length).toBe(PINNED_RIGS);
  });

  for (const { rel, text } of files) {
    const lines = startLines(text);
    if (lines.length === 0) continue;
    it(`${rel} starts routing with web and worker`, () => {
      // why: F-1367; see the file header
      if (ALLOWED[path.basename(rel)]) return;
      for (const l of lines) expect(l, `${rel}: ${l.trim()}`).toMatch(/\srouting(\s|;|$)/);
    });
  }

  it('every allow-list entry is still a rig that omits routing', () => {
    // why: F-1367; a stale entry would hide a rig that now starts routing, or a rig that no longer exists
    for (const name of Object.keys(ALLOWED)) {
      const hit = files.find((x) => path.basename(x.rel) === name);
      expect(hit, `${name} exists`).toBeDefined();
      expect(startLines(hit!.text).some((l) => !/\srouting(\s|;|$)/.test(l)), `${name} omits routing`).toBe(true);
    }
  });
});

describe('the start-line scan (F-1418)', () => {
  it('reads a start line split by a backslash as 1 line, and a trailing comment does not count as the routing name', () => {
    // why: F-1418; a split start line left the scan, and a comment holding the word routing satisfied the match
    const split = startLines('compose up -d \\\n  proxy web worker db\n');
    expect(split).toEqual(['compose up -d proxy web worker db']);
    const withComment = startLines('compose up -d proxy web worker # routing is not started\n');
    expect(withComment.every((l) => /\srouting(\s|;|$)/.test(l))).toBe(false);
  });
});
