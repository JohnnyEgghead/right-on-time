// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-2 (checks ci/typecheck-coverage.ts: root-level TypeScript must be in a typecheck)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cli = path.resolve(import.meta.dirname, 'typecheck-coverage.ts');
let tmp: string;
const run = () => spawnSync('node', [cli], { env: { ...process.env, CI_ROOT: tmp }, encoding: 'utf8' });

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'tscov-'));
  symlinkSync(path.resolve(import.meta.dirname, '..', 'node_modules'), path.join(tmp, 'node_modules'));
  writeFileSync(path.join(tmp, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, types: [] }, include: ['ci/**/*.ts'] }));
  mkdirSync(path.join(tmp, 'ci'));
  writeFileSync(path.join(tmp, 'ci', 'a.ts'), 'export const a: number = 1;\n');
  mkdirSync(path.join(tmp, 'packages', 'p'), { recursive: true });
  mkdirSync(path.join(tmp, 'packages', 'p', 'src'));
  writeFileSync(path.join(tmp, 'packages', 'p', 'src', 'x.ts'), 'export const x = 1;\n');
  writeFileSync(path.join(tmp, 'packages', 'p', 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, types: [] }, include: ['src'] }));
  execFileSync('git', ['init', '-q'], { cwd: tmp });
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('ci/typecheck-coverage.ts', () => {
  it('passes when every root-level TypeScript file is in the root tsconfig include or its own package tsconfig include', () => {
    // why: F-2
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('2 TypeScript files');
  });

  it('fails on a root-level TypeScript file that the tsconfig does not include', () => {
    // why: F-2
    writeFileSync(path.join(tmp, 'vitest.config.ts'), 'export default {};\n');
    const r = run();
    rmSync(path.join(tmp, 'vitest.config.ts'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('vitest.config.ts is in no typecheck');
  });

  it('fails on a package TypeScript or TSX file outside the package tsconfig include (F-23)', () => {
    // why: F-23
    writeFileSync(path.join(tmp, 'packages', 'p', 'next.config.ts'), 'export default {};\n');
    writeFileSync(path.join(tmp, 'packages', 'p', 'Screen.tsx'), 'export const S = 1;\n');
    const r = run();
    rmSync(path.join(tmp, 'packages', 'p', 'next.config.ts'));
    rmSync(path.join(tmp, 'packages', 'p', 'Screen.tsx'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('packages/p/next.config.ts is in no typecheck');
    expect(r.stderr).toContain('packages/p/Screen.tsx is in no typecheck');
  });
});
