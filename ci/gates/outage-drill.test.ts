// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: NFR-11, SD-37 (F-1612: the outage-drill gate checks the drill's record only where the record exists, so a public copy passes)
// The gate script run in a throwaway tree with a stub pnpm (the instrument test is infra/tests/outage-drill.test.ts, run by its own gate step).
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.join(import.meta.dirname, 'outage-drill.sh');

/** The private-only files ci/tree-kind.sh looks for (the 'private' tree has all, 'public' none, 'damaged' some). */
const MARKERS = ['jl-build', 'jl-plan', 'jl-anchor', 'docs/REQUIREMENTS.md'];

function tree(record: string | null, kind: 'private' | 'public' | 'damaged' = 'private') {
  const root = mkdtempSync(path.join(tmpdir(), 'outage-gate-'));
  mkdirSync(path.join(root, 'ci', 'gates'), { recursive: true });
  copyFileSync(SCRIPT, path.join(root, 'ci', 'gates', 'outage-drill.sh'));
  copyFileSync(path.join(import.meta.dirname, '..', 'tree-kind.sh'), path.join(root, 'ci', 'tree-kind.sh'));
  for (const m of kind === 'private' ? MARKERS : kind === 'damaged' ? MARKERS.slice(0, 2) : []) {
    mkdirSync(path.dirname(path.join(root, m)), { recursive: true });
    writeFileSync(path.join(root, m), '');
  }
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(bin, 'pnpm'), 0o755);
  if (record !== null) {
    mkdirSync(path.join(root, 'docs', 'build', 'spikes'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'build', 'spikes', 'P8-OUTAGE-DRILL.md'), record);
  }
  const run = spawnSync('bash', [path.join(root, 'ci', 'gates', 'outage-drill.sh')], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root } });
  return { status: run.status, out: run.stdout + run.stderr };
}

describe('the outage-drill gate record check (F-1612)', () => {
  // why: F-1612 (a public copy has no record: the gate passes the tree and says it skipped the check)
  it('passes a public tree without the record and says the record check was skipped', () => {
    const r = tree(null, 'public');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('absent');
  });

  // why: F-1685 (a private repo that lost its record is red, not skipped)
  it('fails a private tree without the record, and exits 2 on a tree that is neither side', () => {
    const r = tree(null, 'private');
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('absent in the private repo');
    expect(tree(null, 'damaged').status).toBe(2);
  });

  // why: F-1612 (a record that is present still has to read PASS: the skip is for absence only)
  it('fails a present record that does not read Verdict: PASS, and passes one that does', () => {
    expect(tree('Verdict: FAIL - the monitor saw nothing\n').status).toBe(1);
    expect(tree('Verdict: PASS - the monitor recorded the outage\n').status).toBe(0);
  });
});
