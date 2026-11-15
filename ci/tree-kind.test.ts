// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1685 (a gate may skip a check only in the public export; the private repo and a damaged tree never skip)
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CI = import.meta.dirname;
const ROOT = path.join(CI, '..');
const MARKERS = [...readFileSync(path.join(CI, 'tree-kind.sh'), 'utf8').matchAll(/^BW_PRIVATE_MARKERS=\((.*)\)$/gm)].flatMap((m) => (m[1] ?? '').split(/\s+/));

/** A throwaway tree holding ci/tree-kind.sh and ci/test-reason.sh, with the given private markers and tool. */
function tree(markers: string[], tool: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), 'tree-kind-'));
  mkdirSync(path.join(root, 'ci', 'vendor', 'jl-dev'), { recursive: true });
  for (const f of ['tree-kind.sh', 'test-reason.sh']) copyFileSync(path.join(CI, f), path.join(root, 'ci', f));
  for (const m of markers) {
    mkdirSync(path.dirname(path.join(root, m)), { recursive: true });
    writeFileSync(path.join(root, m), '');
  }
  if (tool) {
    const t = path.join(root, 'ci', 'vendor', 'jl-dev', 'test-reason-check.py');
    writeFileSync(t, 'import sys\nsys.exit(0)\n');
    chmodSync(t, 0o755);
  }
  const run = spawnSync('bash', [path.join(root, 'ci', 'test-reason.sh'), 'HEAD'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: root } });
  return { status: run.status, out: run.stdout + run.stderr };
}

describe('ci/tree-kind.sh and ci/test-reason.sh (F-1685)', () => {
  // why: F-1685 (a marker the export keeps would make a public copy read as private, so every marker is on the private list)
  it('lists only paths that scripts/private-paths.txt leaves out of the export', () => {
    expect(MARKERS.length).toBeGreaterThan(2);
    const list = readFileSync(path.join(ROOT, 'scripts', 'private-paths.txt'), 'utf8').split('\n');
    for (const m of MARKERS) expect(list, m).toContain(m);
  });

  // why: F-1685 (a public copy has no vendored tool: skipped, exit 0)
  it('skips a missing tool in a public tree', () => {
    const r = tree([], false);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('skipped');
  });

  // why: F-1685 (the private repo without its checker is red, never a skipped pass)
  it('fails a missing tool in a private tree', () => {
    const r = tree(MARKERS, false);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('missing in the private repo');
  });

  // why: F-1685 (some private-only paths present and some missing: neither side can be determined)
  it('exits 2 in a tree that is neither side', () => {
    expect(tree(MARKERS.slice(0, 1), false).status).toBe(2);
  });
});
