// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = path.resolve('ci/look-values/cli.ts');
const run = (...args: string[]) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

// Browser-free usage checks: every one exits 2 before a browser is launched.
describe('look-values cli usage', () => {
  it('exits 2 when a --kit-sheet value has no =', () => {
    // reason: F-35; a missing = used to drop the last character of the path and exit 1 as a difference
    const r = run('--kit-sheet', 'docs/design/kit.css');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--kit-sheet needs');
  });
  it('exits 2 when --frame-pair is not given once per --pair', () => {
    // reason: F-35; the frame selector is matched to --pair by position, so a count mismatch is a usage error
    const r = run('--app', 'file:///a.html', '--frame', 'b.html', '--pair', '.a', '--pair', '.b', '--frame-pair', '.c');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--frame-pair given 1 time(s) for 2 --pair(s)');
  });
  it('exits 2 with no arguments', () => {
    // reason: F-35; usage is exit 2
    expect(run().status).toBe(2);
  });
});
