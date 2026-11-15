// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1609 the hosted server's address is not in any committed file: the deploy, the hosted check and the spike scripts take it from BW_HOST
// (the environment or the owner's private file) and stop with a clear message, before any ssh, when it is missing.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const dir = mkdtempSync(path.join(tmpdir(), 'host-address-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// No BW_HOST and both owner files pointed at nothing: a script must refuse before it reaches ssh, docker or the network.
const bare = { PATH: process.env.PATH ?? '', HOME: dir, BW_OWNER_ENV: path.join(dir, 'none.env'), BW_OWNER_ENV_LOCAL: path.join(dir, 'none-local.env') };
const SCRIPTS: Array<[string, string[]]> = [
  ['infra/deploy/deploy.sh', []],
  ['infra/backup/hosted-check.sh', ['--log', path.join(dir, 'log.txt')]],
  ['infra/spike/s2/deploy.sh', [dir]],
  ['infra/spike/s3/deploy.sh', [dir, path.join(dir, 'x.pmtiles')]],
  ['infra/spike/s3/fetch-logs.sh', [dir]],
];

describe('the hosted server address (F-1609)', () => {
  // why: F-1609 with no BW_HOST the script stops with a message that says how to set it
  it.each(SCRIPTS)('%s stops with a clear message when BW_HOST is missing', (script, args) => {
    const r = spawnSync('bash', [path.join(root, script), ...args], { encoding: 'utf8', env: bare, cwd: root });
    expect(r.status, `${r.stdout}${r.stderr}`).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('BW_HOST is not set');
  });

  // why: F-1609 the address comes from the owner's private file when the environment has none, and the environment wins over the file
  it('reads BW_HOST from the private file, and the environment wins', () => {
    const file = path.join(dir, 'owner-local.env');
    writeFileSync(file, '# the address\nBW_HOST=admin@203.0.113.10\n');
    const probe = (extra: Record<string, string>) =>
      spawnSync('bash', ['-c', `. infra/drill/owner-env.sh; bw_need_host "$PWD" && printf %s "$BW_HOST"`], { encoding: 'utf8', cwd: root, env: { ...bare, BW_OWNER_ENV_LOCAL: file, ...extra } }).stdout;
    expect(probe({})).toBe('admin@203.0.113.10');
    expect(probe({ BW_HOST: 'ops@203.0.113.99' })).toBe('ops@203.0.113.99');
  });

  // why: F-1686 the shell reader and apps/tech-native/release/owner-env.cjs read the same file the same way (no = skips the line, a CR is not the value)
  it('owner-env.sh and owner-env.cjs agree on a line without =, CRLF and the first line winning', () => {
    const file = path.join(dir, 'parity.env');
    writeFileSync(file, '# c\r\nBW_NOEQ\r\nBW_CR=abc\r\nBW_TWICE=1\r\nBW_TWICE=2\r\nBW_INLINE=v # not a comment\r\n');
    const keys = ['BW_NOEQ', 'BW_CR', 'BW_TWICE', 'BW_INLINE'];
    const sh = spawnSync('bash', ['-c', `. infra/drill/owner-env.sh; bw_owner_env "$PWD"; for k in ${keys.join(' ')}; do if [ -n "\${!k+x}" ]; then printf '%s=[%s]\\n' "$k" "\${!k}"; fi; done`], { encoding: 'utf8', cwd: root, env: { ...bare, BW_OWNER_ENV: file } }).stdout;
    const cjs = spawnSync('node', ['-e', `const o=require('./apps/tech-native/release/owner-env.cjs');for(const k of ${JSON.stringify(keys)}){const v=o.ownerValue(k);if(v!==undefined)console.log(k+'=['+v+']')}`], { encoding: 'utf8', cwd: root, env: { ...bare, BW_OWNER_ENV: file } }).stdout;
    expect(sh).toBe(cjs);
    expect(sh).not.toContain('BW_NOEQ');
    expect(sh).toContain('BW_CR=[abc]');
    expect(sh).toContain('BW_TWICE=[1]');
  });

  // why: F-1623 the load day's prepare step reads BW_HOST as deploy.sh does: with none it refuses for that reason, before any ssh or aws call
  it('infra/load/hosted-day.sh prepare refuses with no BW_HOST, before any ssh or aws call', () => {
    const bin = path.join(dir, 'bin');
    const marker = path.join(dir, 'reached.log');
    const state = path.join(dir, 'load-state');
    mkdirSync(bin, { recursive: true });
    mkdirSync(state, { recursive: true });
    for (const tool of ['ssh', 'ssh-keygen', 'scp', 'aws', 'curl']) {
      writeFileSync(path.join(bin, tool), `#!/bin/sh\necho ${tool} >> '${marker}'\nexit 0\n`);
      chmodSync(path.join(bin, tool), 0o755);
    }
    const r = spawnSync('bash', [path.join(root, 'infra/load/hosted-day.sh'), 'prepare'], {
      encoding: 'utf8',
      cwd: root,
      env: { ...bare, PATH: `${bin}:${bare.PATH}`, BW_LOAD_DIR: state, BW_KEY: path.join(dir, 'key.pem') },
    });
    expect(r.status, `${r.stdout}${r.stderr}`).not.toBe(0);
    expect(r.stderr).toContain('BW_HOST is not set');
    expect(r.stderr).not.toContain('must log in as admin');
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(state)).toEqual([]);
  });
});
