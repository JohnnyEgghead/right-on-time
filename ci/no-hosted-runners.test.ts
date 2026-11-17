// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDir, checkRunnerList, checkWorkflow, classifyRunsOn } from './no-hosted-runners.ts';

const repoWorkflows = path.resolve(__dirname, '..', '.github', 'workflows');
// F-1852: .github/workflows/ is a private path (scripts/private-paths.txt), so in a public copy the tests on the real workflows skip
// with a note naming it; the private checkout has it and they run. The planted cases need no file.
const noWf = existsSync(repoWorkflows) ? '' : '.github/workflows/ is not in this copy (a private path the public export leaves out)';
const script = path.resolve(__dirname, 'no-hosted-runners.ts');

const wf = (jobs: string) => `name: t\non: push\njobs:\n${jobs}`;

// The 2 planted bad workflows of BUILD_PLAN P1-CI-SPECTRE (D17: a gate is proven by a planted failure).
const PLANT_HOSTED = wf(`  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`);
const PLANT_MAC_CONTAINER = wf(
  `  native:\n    runs-on: [self-hosted, mac]\n    container:\n      image: node:26\n    steps:\n      - run: echo hi\n`,
);

describe('no-hosted-runners: the 2 planted bad workflows fail', () => {
  // why: SD-38, OA-80
  it('fails a runs-on: ubuntu-latest job', () => {
    const v = checkWorkflow('plant-hosted.yml', PLANT_HOSTED);
    expect(v).toEqual([expect.objectContaining({ job: 'build', rule: 'runs-on' })]);
  });

  // why: SD-38
  it('fails a container: key on the mac job', () => {
    const v = checkWorkflow('plant-mac-container.yml', PLANT_MAC_CONTAINER);
    expect(v).toEqual([expect.objectContaining({ job: 'native', rule: 'container-off-linux' })]);
  });
});

describe('no-hosted-runners: the real workflows pass', () => {
  // why: SD-38
  it('finds the workflows and 0 violations', (ctx) => {
    if (noWf) ctx.skip(noWf);
    const { files, violations } = checkDir(repoWorkflows);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(violations).toEqual([]);
  });
});

describe('no-hosted-runners: runs-on forms', () => {
  // why: SD-38
  it('accepts exactly the 2 label sets, in any order or case', () => {
    expect(classifyRunsOn(['self-hosted', 'linux'])).toBe('linux');
    expect(classifyRunsOn(['mac', 'self-hosted'])).toBe('mac');
    expect(classifyRunsOn(['self-hosted', 'Linux'])).toBe('linux');
  });

  // why: SD-38, OA-80
  it('rejects a hosted label, a bare label, an extra label, an expression, a group and a missing runs-on', () => {
    for (const bad of [
      'ubuntu-latest',
      'macos-15',
      'linux',
      'self-hosted',
      ['self-hosted', 'linux', 'x64'],
      ['self-hosted', 'linux', 'mac'],
      '${{ matrix.os }}',
      ['self-hosted', '${{ inputs.runner }}'],
      { group: 'default', labels: ['self-hosted', 'linux'] },
      undefined,
      [1, 2],
    ]) {
      expect(classifyRunsOn(bad), JSON.stringify(bad)).toEqual({ reason: expect.any(String) });
    }
  });
});

describe('no-hosted-runners: docker keys', () => {
  // why: SD-38
  it('allows container:, services: and docker:// on the linux runner', () => {
    const text = wf(
      `  a:\n    runs-on: [self-hosted, linux]\n    container: node:26\n    services:\n      pg:\n        image: postgres:18\n    steps:\n      - uses: docker://alpine:3\n`,
    );
    expect(checkWorkflow('ok.yml', text)).toEqual([]);
  });

  // why: SD-38
  it('fails services: and a docker:// step on the mac job, and docker keys on a hosted job too', () => {
    const mac = wf(
      `  m:\n    runs-on: [self-hosted, mac]\n    services:\n      pg:\n        image: postgres:18\n    steps:\n      - run: true\n      - uses: docker://alpine:3\n`,
    );
    expect(checkWorkflow('mac.yml', mac).map((v) => v.rule)).toEqual(['container-off-linux', 'container-off-linux']);
    const hosted = wf(`  h:\n    runs-on: ubuntu-latest\n    container: node:26\n    steps:\n      - run: true\n`);
    expect(checkWorkflow('h.yml', hosted).map((v) => v.rule)).toEqual(['runs-on', 'container-off-linux']);
  });
});

describe('no-hosted-runners: other job shapes', () => {
  // why: SD-38
  it('allows a local reusable workflow call and fails a remote one', () => {
    const text = wf(`  l:\n    uses: ./.github/workflows/x.yml\n  r:\n    uses: some/org/.github/workflows/x.yml@v1\n`);
    expect(checkWorkflow('r.yml', text)).toEqual([expect.objectContaining({ job: 'r', rule: 'runs-on' })]);
  });

  // why: tooling
  it('fails closed on bad YAML, a file with no jobs, an empty directory and a missing directory', () => {
    expect(checkWorkflow('bad.yml', 'jobs: [unclosed')[0]?.rule).toBe('parse');
    expect(checkWorkflow('nojobs.yml', 'name: x\non: push\n')[0]?.rule).toBe('parse');
    const empty = mkdtempSync(path.join(tmpdir(), 'nhr-'));
    try {
      expect(checkDir(empty).violations).toHaveLength(1);
      expect(checkDir(path.join(empty, 'missing')).violations).toHaveLength(1);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  // why: SD-38
  it('expands YAML merge keys before checking', () => {
    const text = `name: t\non: push\nx-base: &base\n  runs-on: ubuntu-latest\njobs:\n  j:\n    <<: *base\n    steps:\n      - run: true\n`;
    expect(checkWorkflow('m.yml', text)).toEqual([expect.objectContaining({ rule: 'runs-on' })]);
  });
});

describe('no-hosted-runners: the registered runner set (F-12)', () => {
  const r = (name: string, ...labels: string[]) => ({ name, labels: labels.map((l) => ({ name: l })) });
  const linux = r('linux', 'self-hosted', 'Linux', 'X64');
  const mac = r('mac', 'self-hosted', 'macOS', 'ARM64', 'mac');

  // why: SD-38 (F-12)
  it('accepts exactly 1 linux and 1 mac runner', () => {
    expect(checkRunnerList({ runners: [linux, mac] })).toEqual([]);
  });

  // why: SD-38 (F-12)
  it('fails a third self-hosted Linux runner, a missing mac runner and a bad shape', () => {
    expect(checkRunnerList({ runners: [linux, mac, r('rogue', 'self-hosted', 'Linux', 'X64')] }).length).toBeGreaterThan(0);
    expect(checkRunnerList({ runners: [linux, r('other', 'self-hosted', 'macOS')] }).length).toBeGreaterThan(0);
    expect(checkRunnerList({}).length).toBeGreaterThan(0);
  });

  // why: SD-38 (F-12)
  it('--runners exits 1 on a planted third runner and 0 on the real pair', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nhr-r-'));
    try {
      const ok = path.join(dir, 'ok.json');
      const bad = path.join(dir, 'bad.json');
      writeFileSync(ok, JSON.stringify({ runners: [linux, mac] }));
      writeFileSync(bad, JSON.stringify({ runners: [linux, mac, r('rogue', 'self-hosted', 'Linux')] }));
      expect(spawnSync(process.execPath, [script, '--runners', ok], { encoding: 'utf8' }).status).toBe(0);
      expect(spawnSync(process.execPath, [script, '--runners', bad], { encoding: 'utf8' }).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('no-hosted-runners: command line', () => {
  // why: SD-38
  it('exits 1 on a planted bad workflow and 0 on the real workflows', (ctx) => {
    if (noWf) ctx.skip(noWf);
    const dir = mkdtempSync(path.join(tmpdir(), 'nhr-'));
    try {
      writeFileSync(path.join(dir, 'plant.yml'), PLANT_HOSTED);
      const bad = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain('plant.yml:build: runs-on:');
      const good = spawnSync(process.execPath, [script, repoWorkflows], { encoding: 'utf8' });
      expect(good.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
