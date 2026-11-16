// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1621 (owner answer dedc3b70, "Keep them private": the Apple team id and the App Store Connect key id are in no exported file)
// The 3 release pieces that take the owner's Apple ids from the environment or the owner's private file: app.config.js (the team id for
// expo prebuild), release/export-upload.sh (writes the export plist from the committed template) and release/xcb-asc.sh (the key id for
// xcodebuild, with both ids redacted from its output). app.config.js runs in place in a node process; the 2 scripts run in a copy of
// their folder layout with a fake xcb-asc.sh or a fake xcodebuild: no Xcode, no signing, no network. The ids here are fakes built at
// run time; the owner files always point into the temporary folder, so the repo's own owner file is never read.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = path.join(import.meta.dirname, '..', '..');
const TEAM = ['T3AM', 'ID0001'].join('');
const TEAM_FILE = ['T3AM', 'ID0002'].join('');
const KID = ['K3Y', 'ID00001'].join('');
const ISSUER = ['11111111', '2222', '3333', '4444', '555555555555'].join('-');
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'bw-owner-ids-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const put = (rel: string, body: string, mode?: number) => {
  const f = path.join(tmp, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, body);
  if (mode) chmodSync(f, mode);
};
const copy = (rel: string, mode?: number) => {
  mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  copyFileSync(path.join(repo, rel), path.join(tmp, rel));
  if (mode) chmodSync(path.join(tmp, rel), mode);
};
/** A clean environment: PATH (with the fakes first) and HOME, the owner files inside the temporary folder, then `extra`. */
const envWith = (extra: Record<string, string | undefined>) => {
  const all: Record<string, string | undefined> = {
    PATH: `${path.join(tmp, 'bin')}:${process.env['PATH'] ?? ''}`, HOME: path.join(tmp, 'home'), CALLS: path.join(tmp, 'calls.log'),
    BW_OWNER_ENV: path.join(tmp, 'owner.env'), BW_OWNER_ENV_LOCAL: path.join(tmp, 'owner.local.env'), ...extra,
  };
  return Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => e[1] !== undefined));
};
const calls = () => (existsSync(path.join(tmp, 'calls.log')) ? readFileSync(path.join(tmp, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);

describe('app.config.js team id (F-1621)', () => {
  /** The config function's answer for a small app.json config, in its own node process; `out` is the JSON answer or the thrown message. */
  const resolve = (extra: Record<string, string | undefined>) => {
    const code = `try { const f = require(${JSON.stringify(path.join(repo, 'apps/tech-native/app.config.js'))});
      console.log(JSON.stringify(f({ config: { name: 'Right On Time', ios: { bundleIdentifier: 'app.example', buildNumber: '7' } } })));
    } catch (e) { console.log('threw: ' + e.message); process.exit(3); }`;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: envWith(extra) });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr };
  };

  // why: F-1621 the team id is not in app.json: the config takes it from BW_APPLE_TEAM_ID and keeps every other ios field
  it('sets the team id from the environment', () => {
    const r = resolve({ BW_APPLE_TEAM_ID: TEAM });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ name: 'Right On Time', ios: { bundleIdentifier: 'app.example', buildNumber: '7', appleTeamId: TEAM } });
  });

  // why: F-1621 with no team id in the environment, the owner's private file supplies it (the first line for the key wins)
  it('sets the team id from the owner file', () => {
    put('owner.env', `# owner\nBW_ASC_KEY_ID=${KID}\nBW_APPLE_TEAM_ID=${TEAM_FILE}\nBW_APPLE_TEAM_ID=${TEAM}\n`);
    const r = resolve({ BW_RELEASE: '1' });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).ios.appleTeamId).toBe(TEAM_FILE);
  });

  // why: F-1621 the local owner file (BW_OWNER_ENV_LOCAL) is read after the main one, as infra/drill/owner-env.sh reads them
  it('falls back to the local owner file', () => {
    put('owner.env', 'BW_OTHER=1\n');
    put('owner.local.env', `BW_APPLE_TEAM_ID=${TEAM_FILE}\n`);
    expect(JSON.parse(resolve({}).out).ios.appleTeamId).toBe(TEAM_FILE);
  });

  // why: F-1621 a release project is signed with the team: without a team id it refuses, naming the variable and the owner file
  it('refuses a release with no team id', () => {
    const r = resolve({ BW_RELEASE: '1' });
    expect(r.code).toBe(3);
    expect(r.out).toContain('BW_RELEASE=1 needs the Apple team id');
    expect(r.out).toContain("owner's private file");
  });

  // why: F-1621 the simulator rig and a public copy resolve with no team id, the config unchanged
  it.each([['no BW_RELEASE', {}], ['BW_RELEASE=0', { BW_RELEASE: '0' }], ['an empty team id', { BW_APPLE_TEAM_ID: '' }]])(
    'passes the config through with %s',
    (_what, extra) => {
      const r = resolve(extra);
      expect(r.code, r.err).toBe(0);
      expect(JSON.parse(r.out)).toEqual({ name: 'Right On Time', ios: { bundleIdentifier: 'app.example', buildNumber: '7' } });
    },
  );

  // why: F-1621 a malformed team id is never taken for one: it throws, and the message names the key, not the value
  it('throws on a malformed team id without printing it', () => {
    const r = resolve({ BW_APPLE_TEAM_ID: 'not-a-team-77' });
    expect(r.code).toBe(3);
    expect(r.out).toContain('BW_APPLE_TEAM_ID is set but is not 10 capitals or digits');
    expect(r.out + r.err).not.toContain('not-a-team-77');
  });
});

describe('release/export-upload.sh plist from the template (F-1621)', () => {
  const rel = 'apps/tech-native/release';
  const plistOf = (mode: string) => path.join(tmp, 'apps/tech-native/build', `ExportOptions-${mode}.plist`);
  beforeEach(() => {
    copy(`${rel}/export-upload.sh`, 0o755);
    copy(`${rel}/ExportOptions-manual.template.plist`);
    copy('infra/drill/owner-env.sh');
    mkdirSync(path.join(tmp, 'apps/tech-native/ios'), { recursive: true });
    mkdirSync(path.join(tmp, 'apps/tech-native/build/RightOnTime.xcarchive'), { recursive: true });
    // The fake signer logs its arguments and keeps a copy of the plist it was given.
    put(`${rel}/xcb-asc.sh`, '#!/usr/bin/env bash\necho "xcb-asc $*" >>"$CALLS"\nwhile [ $# -gt 0 ]; do [ "$1" != -exportOptionsPlist ] || cp "$2" "$CALLS.plist"; shift; done\necho "** EXPORT SUCCEEDED **"\n', 0o755);
  });
  const run = (mode: string, extra: Record<string, string | undefined>) =>
    spawnSync('bash', [path.join(tmp, rel, 'export-upload.sh'), mode, path.join(tmp, 'ev')], { encoding: 'utf8', env: envWith(extra) });

  // why: F-1621 the committed template holds a placeholder, never a team id: each run writes the plist with the owner's team id once
  // why: F-1721 export and upload stay TestFlight internal only (true); store is the App Store eligible upload (false)
  it.each([['export', 'export', 'true'], ['upload', 'upload', 'true'], ['store', 'upload', 'false']])('writes the %s plist with the team id, the %s destination and internal-only %s', (mode, dest, internal) => {
    const r = run(mode, { BW_APPLE_TEAM_ID: TEAM });
    expect(r.status, r.stderr).toBe(0);
    const plist = readFileSync(plistOf(mode), 'utf8');
    expect(plist.split(`<string>${TEAM}</string>`).length - 1).toBe(1);
    expect(plist).not.toContain('<string>BW_APPLE_TEAM_ID</string>');
    expect(plist).toMatch(new RegExp(`<key>destination</key>\\s*<string>${dest}</string>`));
    expect(plist).toMatch(new RegExp(`<key>testFlightInternalTestingOnly</key>\\s*<${internal}/>`));
    expect(plist).not.toContain('BW_INTERNAL_TESTING_ONLY');
    expect(statSync(plistOf(mode)).mode & 0o077).toBe(0);
    expect(readFileSync(path.join(tmp, 'calls.log.plist'), 'utf8')).toBe(plist);
    expect(calls()).toHaveLength(1);
    expect(r.stdout).toContain(`export-upload: ${mode} exit 0`);
  });

  // why: F-1621 the committed template holds the placeholder in the team id's place (ci/public-files.ts owner-ids checks no id is there)
  it('commits the template with the placeholder as the team id', () => {
    const template = readFileSync(path.join(repo, rel, 'ExportOptions-manual.template.plist'), 'utf8');
    expect(template).toMatch(/<key>teamID<\/key>\s*<string>BW_APPLE_TEAM_ID<\/string>/);
    expect(template).toMatch(/<key>destination<\/key>\s*<string>export<\/string>/);
    expect(template).toMatch(/<key>testFlightInternalTestingOnly<\/key>\s*<BW_INTERNAL_TESTING_ONLY\/>/);
  });

  // why: F-1621 with no team id in the environment the owner's private file supplies it
  it('takes the team id from the owner file', () => {
    put('owner.env', `BW_APPLE_TEAM_ID=${TEAM_FILE}\n`);
    const r = run('export', {});
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(plistOf('export'), 'utf8')).toContain(`<string>${TEAM_FILE}</string>`);
  });

  // why: F-1621 no team id, or a malformed one: exit 2 before any plist is written or the signer runs, and the value is never printed
  it.each([['no team id', {}], ['an empty team id', { BW_APPLE_TEAM_ID: '' }], ['a malformed team id', { BW_APPLE_TEAM_ID: 'not-a-team-77' }]])(
    'refuses with %s',
    (_what, extra) => {
      const r = run('upload', extra);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('BW_APPLE_TEAM_ID (the Apple team id, 10 capitals or digits) is not set');
      expect(r.stdout + r.stderr).not.toContain('not-a-team-77');
      expect(existsSync(plistOf('upload'))).toBe(false);
      expect(calls()).toEqual([]);
    },
  );
});

describe('release/xcb-asc.sh key id and redaction (F-1621)', () => {
  const rel = 'apps/tech-native/release';
  beforeEach(() => {
    copy(`${rel}/xcb-asc.sh`, 0o755);
    copy('infra/drill/owner-env.sh');
    put('home/.appstoreconnect/issuer_id.txt', `${ISSUER}\n`);
    // The fake xcodebuild logs its call and echoes its command line (as the real one does), plus a line naming the team.
    put('bin/xcodebuild', `#!/usr/bin/env bash\necho "xcodebuild" >>"$CALLS"\necho "xcodebuild $*"\necho "Signing for team \${TEAM_ECHO:-none}"\nexit "\${XCB_RC:-0}"\n`, 0o755);
  });
  const run = (extra: Record<string, string | undefined>) =>
    spawnSync('bash', [path.join(tmp, rel, 'xcb-asc.sh'), '-exportArchive', '-archivePath', 'a.xcarchive'], { encoding: 'utf8', env: envWith(extra) });

  // why: F-1621 the key id comes from BW_ASC_KEY_ID; the issuer id, the key id and the team id never reach the output (it is saved as evidence)
  it('passes the key id and redacts the 3 ids, keeping the exit', () => {
    const r = run({ BW_ASC_KEY_ID: KID, BW_APPLE_TEAM_ID: TEAM, TEAM_ECHO: TEAM, XCB_RC: '3' });
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('-authenticationKeyID <key-id>');
    expect(r.stdout).toContain('AuthKey_<key-id>.p8');
    expect(r.stdout).toContain('-authenticationKeyIssuerID <issuer-id>');
    expect(r.stdout).toContain('Signing for team <team-id>');
    expect(r.stdout).toContain('xcb-asc: xcodebuild exit 3');
    for (const v of [KID, TEAM, ISSUER]) expect(r.stdout + r.stderr).not.toContain(v);
    expect(calls()).toEqual(['xcodebuild']);
  });

  // why: F-1621 with no key id in the environment the owner's private file supplies it; no team id is needed here
  it('takes the key id from the owner file', () => {
    put('owner.env', `BW_ASC_KEY_ID=${KID}\n`);
    const r = run({});
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('-authenticationKeyID <key-id>');
    expect(r.stdout).not.toContain(KID);
  });

  // why: F-1621 no key id, or a malformed key or team id: exit 2 before xcodebuild runs, and the value is never printed
  it.each([
    ['no key id', {}, 'BW_ASC_KEY_ID (the App Store Connect API key id, 10 capitals or digits) is not set'],
    ['a malformed key id', { BW_ASC_KEY_ID: 'bad-key-id-77' }, 'BW_ASC_KEY_ID (the App Store Connect API key id, 10 capitals or digits) is not set'],
    ['a malformed team id', { BW_ASC_KEY_ID: KID, BW_APPLE_TEAM_ID: 'not-a-team-77' }, 'BW_APPLE_TEAM_ID is set but is not 10 capitals or digits'],
  ])('refuses with %s', (_what, extra, message) => {
    const r = run(extra);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(message);
    expect(r.stdout + r.stderr).not.toMatch(/bad-key-id-77|not-a-team-77/);
    expect(calls()).toEqual([]);
  });
});
