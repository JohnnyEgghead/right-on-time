// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1223 (archive.sh <n> must produce build <n> or refuse; its OK line is backed by the CFBundleVersion read back)
// release/check-build.sh compares a number with app.json ios.buildNumber, or with a plist's CFBundleVersion. Here it reads planted files:
// a plist at 2 asked for 3 fails, one at 3 passes. archive.sh itself is run with a number app.json does not name: it must refuse
// (exit 2) before step 1, so no prebuild log is written and nothing is archived.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const release = path.resolve(import.meta.dirname, '../../apps/tech-native/release');
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-build-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (script: string, ...args: string[]) => spawnSync('bash', [path.join(release, script), ...args], { encoding: 'utf8' });
const plist = (version: string) => {
  const f = path.join(dir, 'Info.plist');
  writeFileSync(f, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleVersion</key><string>${version}</string></dict></plist>\n`);
  return f;
};

describe('F-1223 build number', () => {
  it('a plist at 2 asked for 3 fails; at 3 it passes', () => {
    const bad = run('check-build.sh', 'plist', '3', plist('2'));
    expect([bad.status, bad.stderr]).toEqual([2, expect.stringContaining('is 2, not 3')]);
    expect(run('check-build.sh', 'plist', '3', plist('3')).status).toBe(0);
  });

  it('app.json at 2 asked for 3 fails; at 3 it passes', () => {
    const f = path.join(dir, 'app.json');
    writeFileSync(f, '{"expo":{"ios":{"buildNumber":"2"}}}');
    expect(run('check-build.sh', 'app-json', '3', f).status).toBe(2);
    writeFileSync(f, '{"expo":{"ios":{"buildNumber":"3"}}}');
    expect(run('check-build.sh', 'app-json', '3', f).status).toBe(0);
  });

  it('archive.sh refuses a number app.json does not name, before the prebuild, without printing OK', () => {
    const ev = path.join(dir, 'ev');
    const r = run('archive.sh', '99999', ev);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain('archive: OK');
    expect(r.stderr).toContain('app.json does not name build 99999');
    expect(existsSync(path.join(ev, '01-prebuild.log'))).toBe(false);
  });
});
