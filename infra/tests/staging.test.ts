// SPDX-License-Identifier: AGPL-3.0-or-later
// infra/deploy/staging.sh (G-IPHONE-WEB's staging copy, the copy P6-TESTFLIGHT-4 uses): a temporary Lightsail copy of the hosted plan
// routes live (BUILD_PLAN section 3 D-21; F-1305). Its deploy step sends the routing files with the map files, starts the routing service
// with the other services, and its .env caps routing at the cap measured on small_3_0. Nothing here creates an instance: write_env runs
// with a stub for the remote shell, and the start lines are read from the script.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { samplePassword, showSamplePassword } from '../../packages/db/src/passwords.ts';

const root = path.resolve(import.meta.dirname, '../..');
const st = readFileSync(path.join(root, 'infra/deploy/staging.sh'), 'utf8');
const fn = (name: string): string => {
  const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm').exec(st);
  if (!m) throw new Error(`function ${name} not found in staging.sh`);
  return m[0];
};
const deployStep = st.slice(st.indexOf('\n  deploy)\n'), st.indexOf('\n  world)\n'));
const worldStep = st.slice(st.indexOf('\n  world)\n'), st.indexOf('\n  check)\n'));

/** Run write_env with `remote` writing its stdin to a file, and return the .env it would put on the copy. */
function stagedEnv(): Record<string, string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'bw-staging-'));
  try {
    writeFileSync(path.join(dir, 'host'), '203-0-113-7.sslip.io\n');
    writeFileSync(path.join(dir, 'image'), 'bw-app:staging-t1\n');
    const prog = [`dir='${dir}'`, 'OPT=/opt/bw-staging', `remote() { cat > '${dir}/env'; }`, fn('write_env'), 'write_env staging.conf'].join('\n');
    execFileSync('bash', ['-c', prog], { encoding: 'utf8' });
    return Object.fromEntries(readFileSync(path.join(dir, 'env'), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('infra/deploy/staging.sh', () => {
  // why: F-1305 the staging copy starts routing with every other service, so P6-TESTFLIGHT-4's copy routes live (D-21: no routing setting)
  it('starts routing with the other services on every full start, and sends the routing files with the map files', () => {
    const starts = [...deployStep.matchAll(/\$dc up -d --no-build[^"]*/g), ...worldStep.matchAll(/\$dc up -d --no-build[^"]*/g)].map((m) => m[0]);
    expect(starts.length, 'the deploy start and the world --again restart').toBe(2);
    for (const s of starts) expect(s.split(/\s+/), s).toEqual(expect.arrayContaining(['proxy', 'web', 'worker', 'pbs', 'db', 'routing']));
    // the only other start is the first deploy's port-80 bootstrap proxy, alone (--no-deps)
    expect([...st.matchAll(/\$dc up -d (?!--no-build)[^"]*/g)].map((m) => m[0])).toEqual(['$dc up -d --no-deps proxy']);
    // the map folder the deploy tars to the copy holds the routing files: the fetch asks for them (ci/data-assets.ts --with-routing)
    const fetch = deployStep.split('\n').find((l) => l.includes('--manifest packages/maps/MANIFEST.json'));
    expect(fetch).toContain('--with-routing');
    expect(deployStep.indexOf('--with-routing')).toBeLessThan(deployStep.indexOf('tar -C .build/data -czf - street-list.json maps'));
    expect(st).not.toMatch(/--no-routing/);
  });

  // why: NFR-13 the staging copy is a Lightsail small_3_0 copy, so routing runs at the 320 MiB cap measured there, not the local default
  it("caps routing at 320m in the copy's .env", () => {
    const env = stagedEnv();
    expect(env.ROUTING_MEM_LIMIT).toBe('320m');
    expect(env.APP_ORIGIN).toBe('https://203-0-113-7.sslip.io');
  });
  // why: NFR-14 F-1350 the office account the builder's scripts use gets its password file the way Maria's is made: from the seed, mode 600, never printed
  it("writes Maria Santos's and the office's (Keisha Thompson's) passwords into the state folder, mode 600, printing nothing", () => {
    const loop = /^    for pw in [\s\S]*?^    done$/m.exec(worldStep)?.[0];
    expect(loop, 'the password loop in the world step').toBeDefined();
    expect(worldStep.indexOf('umask 077')).toBeLessThan(worldStep.indexOf(loop!));
    expect(worldStep.indexOf(loop!)).toBeLessThan(worldStep.indexOf('umask 022'));
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-staging-'));
    try {
      writeFileSync(path.join(dir, 'seed'), 'f1350-test-seed\n');
      const out = execFileSync('bash', ['-c', [`dir='${dir}'`, `root='${root}'`, 'umask 077', loop!].join('\n')], { encoding: 'utf8' });
      expect(out).toBe('');
      for (const [file, email] of [['maria-password.txt', 'maria.santos@brightwater.example'], ['office-password.txt', 'keisha.t@brightwater.example']] as const) {
        expect(readFileSync(path.join(dir, file), 'utf8'), file).toBe(`${showSamplePassword(samplePassword('f1350-test-seed', email))}\n`);
        expect(statSync(path.join(dir, file)).mode & 0o777, file).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
