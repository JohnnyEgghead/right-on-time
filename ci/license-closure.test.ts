// SPDX-License-Identifier: AGPL-3.0-or-later
// F-107: the license gate's server closure walker sees a real server dependency now that one has landed: the web app
// depends on @bw/api-server, which depends on @bw/db and its PostgreSQL driver. The walker (closure in
// ci/license-gates.ts) must reach @bw/db from the shipped roots, and pnpm's production license list of @bw/db must name pg.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { closure } from './license-gates.ts';

const root = path.resolve(import.meta.dirname, '..');

function workspaceDeps(): Map<string, string[]> {
  const ws = new Map<string, string[]>();
  for (const dir of ['apps', 'packages']) {
    for (const name of readdirSync(path.join(root, dir))) {
      let pkg: { name?: string; dependencies?: Record<string, string> };
      try {
        pkg = JSON.parse(readFileSync(path.join(root, dir, name, 'package.json'), 'utf8')) as typeof pkg;
      } catch {
        continue;
      }
      if (pkg.name) ws.set(pkg.name, Object.keys(pkg.dependencies ?? {}));
    }
  }
  return ws;
}

describe('server closure (F-107)', () => {
  // why: F-107, SD-39
  it('reaches @bw/db and the kernel from the shipped roots, and @bw/db ships the PostgreSQL driver', () => {
    const policy = JSON.parse(readFileSync(path.join(root, 'ci', 'license', 'policy.json'), 'utf8')) as { shippedRoots: string[] };
    const reached = closure(policy.shippedRoots, workspaceDeps());
    for (const p of ['bw-web', '@bw/api-server', '@bw/db', '@bw/config', '@bw/log', '@bw/api', '@bw/time']) expect(reached, p).toContain(p);
    const raw = execFileSync('pnpm', ['--filter', '@bw/db', 'licenses', 'list', '--json', '--prod'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const names = Object.values(JSON.parse(raw) as Record<string, { name: string }[]>).flat().map((e) => e.name);
    expect(names).toContain('pg');
  });
});
