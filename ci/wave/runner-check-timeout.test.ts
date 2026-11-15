// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-113
// ci/wave-run.sh step 3b runs `node ci/no-hosted-runners.ts --runners`, which reads the runner list with gh.
// A stalled gh call must turn that step red within its bound, never hang the wave run. A fake gh on PATH stands
// in for GitHub: one that never answers (known-bad) and one that answers a good list (control, so the bound is
// not always-red).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GH_TIMEOUT_MS, runnersMain } from '../no-hosted-runners.ts';

let dir: string;
const savedPath = process.env.PATH;

function withFakeGh(body: string, run: () => number): number {
  const bin = mkdtempSync(path.join(dir, 'bin-'));
  const gh = path.join(bin, 'gh');
  writeFileSync(gh, `#!/bin/sh\n${body}\n`);
  chmodSync(gh, 0o755);
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
  try {
    return run();
  } finally {
    process.env.PATH = savedPath;
  }
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'runner-check-timeout-'));
});
afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

describe('runner-set check: a hung gh is bounded (F-113)', () => {
  it('the bound the wave run uses is about 60 s', () => {
    // why: F-113
    expect(GH_TIMEOUT_MS).toBe(60_000);
  });

  it('a gh that never answers is killed at the bound and the check is red', () => {
    // why: F-113
    const t0 = Date.now();
    const rc = withFakeGh('exec sleep 600', () => runnersMain(undefined, 500));
    const tookMs = Date.now() - t0;
    expect(rc).toBe(1);
    expect(tookMs).toBeLessThan(10_000);
  });

  it('a gh that ignores SIGTERM is still killed at the bound', () => {
    // why: F-113
    const t0 = Date.now();
    const rc = withFakeGh("trap '' TERM\nwhile :; do sleep 1; done", () => runnersMain(undefined, 500));
    expect(rc).toBe(1);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('control: a gh that answers the 2 runners in time is green', () => {
    // why: F-113
    const list = JSON.stringify({
      runners: [
        { name: 'linux', labels: [{ name: 'self-hosted' }, { name: 'Linux' }] },
        { name: 'mac', labels: [{ name: 'self-hosted' }, { name: 'mac' }] },
      ],
    });
    const rc = withFakeGh(`printf '%s' '${list}'`, () => runnersMain(undefined, 5_000));
    expect(rc).toBe(0);
  });
});
