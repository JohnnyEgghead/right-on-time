// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DIST-8 (SPECIFICATIONS section 14, Clean item 6: the smoke engine self-check)
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, 'engine-self-check.sh');
let bin: string;

// A fake `docker` on PATH: `docker exec <eng> docker <cmd...>` answers from FAKE_* env vars.
// FAKE_INFO_FAIL=1 makes `docker info` fail forever (an engine that never comes up).
const FAKE = `#!/usr/bin/env bash
shift 2  # drop: exec <engine>
shift    # drop: docker
case "$1" in
  info) [ "\${FAKE_INFO_FAIL:-0}" = 1 ] && exit 1; exit 0 ;;
  image) printf '%s' "\${FAKE_IMAGES:-}" ;;
  volume) printf '%s' "\${FAKE_VOLUMES:-}" ;;
esac
`;

beforeAll(() => {
  bin = mkdtempSync(path.join(tmpdir(), 'selfcheck-'));
  writeFileSync(path.join(bin, 'docker'), FAKE);
  chmodSync(path.join(bin, 'docker'), 0o755);
});
afterAll(() => rmSync(bin, { recursive: true, force: true }));

function run(env: Record<string, string>, args = ['eng']) {
  return spawnSync('bash', [script, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ENGINE_WAIT_S: '1', ...env },
    encoding: 'utf8',
  });
}

describe('ci/engine-self-check.sh', () => {
  it('passes on an empty engine', () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('holds 0 image(s), 0 volume(s)');
  });

  it('fails on a pre-pulled image, and names it', () => {
    const r = run({ FAKE_IMAGES: 'sha256:aaa\n' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('holds 1 image(s), 0 volume(s)');
    expect(r.stdout).toContain('image  sha256:aaa');
  });

  it('fails on a leftover volume', () => {
    const r = run({ FAKE_VOLUMES: 'cache\nother' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('0 image(s), 2 volume(s)');
  });

  it('fails closed (exit 2) when the engine never answers or no engine is named', () => {
    expect(run({ FAKE_INFO_FAIL: '1' }).status).toBe(2);
    expect(run({}, []).status).toBe(2);
  });
});
