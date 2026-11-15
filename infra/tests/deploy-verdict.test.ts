// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1684: infra/deploy/deploy.sh runs here against stubbed ssh and curl (never the hosted server).
// (1) a failed ROUTES read is a failed deploy with a clear line, never "locked"; (2) a probe transport error still reaches the verdict line.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const script = path.join(root, 'infra/deploy/deploy.sh');
const text = readFileSync(script, 'utf8');
const tmp = mkdtempSync(path.join(tmpdir(), 'bw-deploy-verdict-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function stubs(name: string, files: Record<string, string>): string {
  const bin = path.join(tmp, name, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    writeFileSync(path.join(bin, f), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(bin, f), 0o755);
  }
  return bin;
}

describe('infra/deploy/deploy.sh verdicts (stubbed ssh and curl)', () => {
  // why: F-1684
  it('a failed ROUTES read is DEPLOY FAILED, before any build or send', () => {
    const bin = stubs('routes', {
      ssh: 'case "$*" in *"uname -m"*) echo x86_64 ;; *ROUTES*) echo "ssh: connection lost" >&2; exit 255 ;; *) exit 0 ;; esac',
      docker: 'echo "docker was called" >> "$STUB_LOG"; exit 0',
      scp: 'echo "scp was called" >> "$STUB_LOG"; exit 0',
      // Nothing may reach the network, even from a script that lost its stop: curl fails, and the asset fetch is refused.
      curl: 'exit 7',
      node: 'case "$*" in *data-assets*) exit 1 ;; esac; exec "$REAL_NODE" "$@"',
    });
    const stubLog = path.join(tmp, 'routes', 'calls.log');
    writeFileSync(stubLog, '');
    const r = spawnSync('bash', [script, '--allow-dirty'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, BW_HOST: 'admin@192.0.2.1', BW_KEY: '/nonexistent/key', STUB_LOG: stubLog, REAL_NODE: process.execPath },
    });
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/STOP: cannot read ROUTES from the server.*deploy FAILED/);
    expect(r.status).toBe(1);
    expect(readFileSync(stubLog, 'utf8')).toBe('');
  });

  // why: F-1684
  it('a probe transport error still ends in the verdict line and the rollback logic', () => {
    // The public-probe section of deploy.sh, run on its own with a curl that fails every time.
    const start = text.indexOf('log "== public probes"');
    expect(start).toBeGreaterThan(0);
    const bin = stubs('probe', { curl: 'exit 7' });
    const harness = [
      'set -euo pipefail',
      `cd ${JSON.stringify(root)}`,
      'log() { echo "$*"; }',
      'DOMAIN=bw.example.test routes=locked drill="" live_routes=locked rc=0 stage_note=""',
      text.slice(start),
    ].join('\n');
    const r = spawnSync('bash', ['-c', harness], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } });
    expect(r.stdout).toMatch(/DEPLOY FAILED \(server exit 0, \/healthz , routes locked answered: 0\)/);
    expect(r.status).toBe(1);
  });
});
