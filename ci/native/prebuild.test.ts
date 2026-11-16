// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1207
// The native suite's iOS project on a checkout that has none, or a stale one (F-1207): xcuitest/prebuild.sh --if-stale generates ios/
// again unless it holds the key of the current inputs, and suite.sh stops at the first class when that class's run did not build.
// Both scripts run here in a copy of their folder layout, with fake expo, brew, ruby and pod commands that only log their calls, and a
// fake run.sh: no Xcode, no network, no simulator. The real path is the mac half's (BW_CI_ARGS=--nightly bash ci/wave-run.sh --mac-half).
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = path.join(import.meta.dirname, '..', '..');
const here = 'apps/tech-native/xcuitest';
let root: string;

const put = (rel: string, body: string, mode?: number) => {
  const f = path.join(root, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, body);
  if (mode) chmodSync(f, mode);
};
const calls = () => (existsSync(path.join(root, 'calls.log')) ? readFileSync(path.join(root, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);
const prebuild = (...args: string[]) =>
  spawnSync('bash', [path.join(root, here, 'prebuild.sh'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`, CALLS: path.join(root, 'calls.log') },
  });
const stamp = () => path.join(root, 'apps/tech-native/ios/.bw-prebuild-key');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bw-prebuild-'));
  mkdirSync(path.join(root, here), { recursive: true });
  copyFileSync(path.join(repo, here, 'prebuild.sh'), path.join(root, here, 'prebuild.sh'));
  put(`${here}/add-uitests.rb`, '# adds the test target\n');
  put('ci/license-gates.ts', '// stub\n');
  put('apps/tech-native/plugins/with-map-assets.js', '// the plugin\n');
  put(`${here}/AUITests.swift`, 'final class AUITests {}\n');
  put('apps/tech-native/app.json', '{"expo":{"name":"Right On Time"}}\n');
  put('apps/tech-native/app.config.js', 'module.exports = ({ config }) => config;\n');
  put('apps/tech-native/release/owner-env.cjs', 'module.exports = {};\n');
  put('apps/tech-native/package.json', '{"name":"bw-tech-native"}\n');
  put('apps/tech-native/assets/icon.png', 'png');
  put('apps/tech-native/modules/bw-x/expo-module.config.json', '{}\n');
  put('apps/tech-native/modules/bw-x/ios/BwX.podspec', 'spec\n');
  put('apps/tech-native/modules/bw-x/ios/BwXModule.swift', 'module source\n');
  put('apps/web/src/map/assets/fonts/a.pbf', 'glyphs');
  put('apps/web/src/map/assets/sprites/s.json', '{}');
  put('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  // The fakes: expo prebuild --clean replaces ios/ with a generated project; pod install fails when POD_FAILS is set.
  const log = 'echo "$(basename "$0") $*" >>"$CALLS"';
  // F-1621: npx logs BW_RELEASE, which app.config.js reads (a release project refuses to resolve without the owner's team id).
  put('bin/npx', `#!/usr/bin/env bash\necho "npx $* BW_RELEASE=\${BW_RELEASE:-}" >>"$CALLS"\nrm -rf ios && mkdir -p ios/RightOnTime.xcodeproj ios/RightOnTime.xcworkspace ios/map-assets/fonts ios/map-assets/sprites\n`, 0o755);
  put('bin/pnpm', `#!/usr/bin/env bash\n${log}\n[ -z "\${PNPM_FAILS:-}" ] || exit 4\n`, 0o755);
  put('bin/xcodebuild', `#!/usr/bin/env bash\necho "Xcode \${XCODE_V:-26.0}"\n`, 0o755);
  put('bin/brew', `#!/usr/bin/env bash\necho /nowhere\n`, 0o755);
  put('bin/ruby', `#!/usr/bin/env bash\n${log}\n`, 0o755);
  put('bin/node', `#!/usr/bin/env bash\n${log}\n[ -z "\${PODS_CHECK_FAILS:-}" ] || exit 1\n`, 0o755);
  put('bin/pod', `#!/usr/bin/env bash\n[ "$1" != --version ] || { echo "\${POD_V:-1.16.2}"; exit 0; }\necho "pod $* BW_RELEASE=\${BW_RELEASE:-}" >>"$CALLS"\n[ -z "\${POD_FAILS:-}" ] || exit 3\n`, 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('prebuild.sh --if-stale (F-1207)', () => {
  it('generates ios/ when the checkout has none, writes the key last, then leaves a current ios/ alone', () => {
    const first = prebuild('--if-stale');
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('prebuild: generating ios/: there is no ios/');
    expect(calls()).toEqual([
      'pnpm install --frozen-lockfile --prefer-offline',
      'npx expo prebuild --platform ios --clean --no-install BW_RELEASE=0',
      'ruby xcuitest/add-uitests.rb',
      'pod install BW_RELEASE=0',
      'node ci/license-gates.ts pods',
    ]);
    expect(readFileSync(stamp(), 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(path.join(root, 'apps/tech-native/ios/map-assets')).sort()).toEqual(['fonts', 'sprites']);
    const again = prebuild('--if-stale');
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('prebuild: ios/ is current');
    expect(calls()).toHaveLength(5);
  });

  it('generates ios/ again when an input changed: a suite file added, a project edit, the app config, the map set, a pod spec', () => {
    const edits: Array<[string, () => void]> = [
      ['a suite file written after the prebuild', () => put(`${here}/BUITests.swift`, 'final class BUITests {}\n')],
      ['add-uitests.rb', () => put(`${here}/add-uitests.rb`, '# adds the test target, now with a new setting\n')],
      ['app.json', () => put('apps/tech-native/app.json', '{"expo":{"name":"Right On Time","version":"0.2.0"}}\n')],
      // F-1621: the config is app.json plus app.config.js and the owner-file reader it calls
      ['app.config.js', () => put('apps/tech-native/app.config.js', 'module.exports = ({ config }) => ({ ...config });\n')],
      ['release/owner-env.cjs', () => put('apps/tech-native/release/owner-env.cjs', 'module.exports = { ownerAppleId: () => null };\n')],
      ['the lockfile', () => put('pnpm-lock.yaml', 'lockfileVersion: 9\n# a new pin\n')],
      ['a map glyph file', () => put('apps/web/src/map/assets/fonts/b.pbf', 'more glyphs')],
      ['a pod spec', () => put('apps/tech-native/modules/bw-x/ios/BwX.podspec', 'spec 2\n')],
      ['a module source file added (the podspec glob is expanded by pod install, F-1217)', () => put('apps/tech-native/modules/bw-x/ios/BwXMore.swift', 'more source\n')],
      ['prebuild.sh itself', () => put(`${here}/prebuild.sh`, `${readFileSync(path.join(root, here, 'prebuild.sh'), 'utf8')}# edited\n`)],
    ];
    expect(prebuild('--if-stale').status).toBe(0);
    for (const [what, edit] of edits) {
      const before = readFileSync(stamp(), 'utf8');
      edit();
      const r = prebuild('--if-stale');
      expect(r.status, what).toBe(0);
      expect(r.stdout, what).toContain('prebuild: generating ios/: ios/ was generated from other inputs');
      expect(readFileSync(stamp(), 'utf8'), what).not.toBe(before);
    }
  });

  it('leaves ios/ alone when only a suite file body or a module source changed (run.sh copies the suites into ios/ on each build)', () => {
    expect(prebuild('--if-stale').status).toBe(0);
    put(`${here}/AUITests.swift`, 'final class AUITests { func test0() {} }\n');
    put('apps/tech-native/modules/bw-x/ios/BwXModule.swift', 'module source 2\n');
    const r = prebuild('--if-stale');
    expect(r.stdout).toContain('prebuild: ios/ is current');
    expect(calls()).toHaveLength(5);
  });

  // why: F-1217 the key leaves out the toolchain: a new Xcode or CocoaPods makes the old Pods project stale
  it('generates ios/ again when the Xcode or CocoaPods version changed', () => {
    expect(prebuild('--if-stale').status).toBe(0);
    for (const env of [{ XCODE_V: '27.0' }, { POD_V: '1.17.0' }]) {
      const r = spawnSync('bash', [path.join(root, here, 'prebuild.sh'), '--if-stale'], {
        encoding: 'utf8', env: { ...process.env, ...env, PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`, CALLS: path.join(root, 'calls.log') },
      });
      expect(r.stdout, JSON.stringify(env)).toContain('prebuild: generating ios/: ios/ was generated from other inputs');
    }
  });

  // why: F-1216 the key hashes the lockfile, so ios/ is generated only after pnpm install --frozen-lockfile succeeded; a failed install leaves no key
  it('stops with no key when pnpm install fails, before expo runs', () => {
    const r = spawnSync('bash', [path.join(root, here, 'prebuild.sh'), '--if-stale'], {
      encoding: 'utf8', env: { ...process.env, PNPM_FAILS: '1', PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`, CALLS: path.join(root, 'calls.log') },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('pnpm install --frozen-lockfile exited 4');
    expect(existsSync(stamp())).toBe(false);
    expect(calls().some((c) => c.startsWith('npx'))).toBe(false);
  });

  it('generates ios/ again with no key, no workspace or no map-assets folder', () => {
    expect(prebuild('--if-stale').status).toBe(0);
    rmSync(stamp());
    expect(prebuild('--if-stale').stdout).toContain('ios/ has no prebuild key');
    rmSync(path.join(root, 'apps/tech-native/ios/RightOnTime.xcworkspace'), { recursive: true });
    expect(prebuild('--if-stale').stdout).toContain('ios/ has no RightOnTime.xcworkspace');
    rmSync(path.join(root, 'apps/tech-native/ios/map-assets'), { recursive: true });
    expect(prebuild('--if-stale').stdout).toContain('ios/map-assets is missing');
    expect(calls().filter((c) => c.startsWith('pod install'))).toHaveLength(4);
  });

  it('fails with the failing step exit and no key when a step fails, so the next run generates again', () => {
    const failed = spawnSync('bash', [path.join(root, here, 'prebuild.sh'), '--if-stale'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`, CALLS: path.join(root, 'calls.log'), POD_FAILS: '1' },
    });
    expect(failed.status).toBe(3);
    expect(existsSync(stamp())).toBe(false);
    expect(prebuild('--if-stale').stdout).toContain('ios/ has no prebuild key');
  });

  // why: F-988 F-86 the TestFlight project is generated in release mode (BW_RELEASE=1 leaves the look reader out), a rig project never stands in for it,
  // and a failed Pods acknowledgments check stops the prebuild with no key
  it('--release generates the project with BW_RELEASE=1, keys the mode, and stops with no key when the acknowledgments check fails', () => {
    expect(prebuild('--if-stale').status).toBe(0);
    const rig = readFileSync(stamp(), 'utf8');
    const r = prebuild('--if-stale', '--release');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ios/ was generated from other inputs');
    expect(r.stdout).toContain('mode release');
    expect(readFileSync(stamp(), 'utf8')).not.toBe(rig);
    expect(calls().filter((c) => c.startsWith('pod install'))).toEqual(['pod install BW_RELEASE=0', 'pod install BW_RELEASE=1']);
    expect(calls().filter((c) => c.startsWith('npx'))).toEqual(['npx expo prebuild --platform ios --clean --no-install BW_RELEASE=0', 'npx expo prebuild --platform ios --clean --no-install BW_RELEASE=1']);
    const failed = spawnSync('bash', [path.join(root, here, 'prebuild.sh'), '--release'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`, CALLS: path.join(root, 'calls.log'), PODS_CHECK_FAILS: '1' },
    });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('acknowledgments check');
    expect(existsSync(stamp())).toBe(false);
  });

  it('fails at once, running nothing, when an input is missing or an argument is unknown', () => {
    rmSync(path.join(root, 'apps/tech-native/assets'), { recursive: true });
    const r = prebuild('--if-stale');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('apps/tech-native/assets');
    expect(calls()).toEqual([]);
    put('apps/tech-native/assets/icon.png', 'png');
    expect(prebuild('--when-stale').status).toBe(2);
    expect(calls()).toEqual([]);
  });
});

describe('suite.sh stops when the building class did not build (F-1207)', () => {
  // A fake run.sh: it writes the times.txt line a build writes (BUILD_RC, default 0) unless --no-build, then exits RUN_RC (default 0).
  const fakeRun = [
    '#!/usr/bin/env bash',
    'mkdir -p "$BW_NATIVE_EVIDENCE"',
    'echo "$BW_NATIVE_TESTS $*" >>"$CALLS"',
    'echo "$BW_NATIVE_TESTS|${BW_A11Y_METHOD:-}|${BW_A11Y_REDUCE:-}" >>"$(dirname "$CALLS")/methods.log"',
    'if [ "${1:-}" != "--no-build" ]; then',
    '  if [ "${BUILD_RC:-0}" = 0 ]; then echo "build-for-testing: exit 0, 1 s (cap 600 s)" >>"$BW_NATIVE_EVIDENCE/times.txt"',
    '  else echo "run: FAIL the iOS project was not generated: xcuitest/prebuild.sh --if-stale exited 1"; exit 1; fi',
    'fi',
    'exit "${RUN_RC:-0}"',
  ].join('\n');
  const suite = (env: Record<string, string>) => {
    copyFileSync(path.join(repo, here, 'suite.sh'), path.join(root, here, 'suite.sh'));
    put(`${here}/run.sh`, `${fakeRun}\n`, 0o755);
    put('ci/gates/native-no-demo.sh', '#!/usr/bin/env bash\necho "native-no-demo: PASS"\n', 0o755);
    const out = path.join(root, 'out');
    const r = spawnSync('bash', [path.join(root, here, 'suite.sh')], {
      encoding: 'utf8',
      env: { ...process.env, CALLS: path.join(root, 'calls.log'), BW_NATIVE_SUITE_EVIDENCE: out, ...env },
    });
    return { ...r, summary: readFileSync(path.join(out, 'summary.txt'), 'utf8') };
  };

  it('a first class that did not build ends the suite at once, naming the cause; no other class runs', () => {
    const r = suite({ BUILD_RC: '1' });
    expect(r.status).toBe(1);
    expect(calls()).toEqual(['ShellUITests ']);
    expect(r.summary).toContain("suite: FAIL the app was not built in ShellUITests's run, so no other class ran: run: FAIL the iOS project was not generated");
    expect(r.summary).not.toContain('native-no-demo');
  });

  it('a first class that built runs every other class on that build, and a test red there is a FAIL of the suite, not a stop', () => {
    const r = suite({ RUN_RC: '1' });
    expect(r.status).toBe(1);
    expect(calls()).toEqual([
      'ShellUITests ',
      'MapMeUITests --no-build',
      'JobUITests --no-build',
      'TodayUITests --no-build',
      'WaitingUITests --no-build',
      'SpanishUITests --no-build',
      'StepsUITests --no-build',
      // F-1475: the accessibility class runs as 5 passes (test1, test2, test3, test4 reduce on and off), each on its own stack
      'AccessibilityUITests --no-build',
      'AccessibilityUITests --no-build',
      'AccessibilityUITests --no-build',
      'AccessibilityUITests --no-build',
      'AccessibilityUITests --no-build',
    ]);
    // F-1825: the 5 passes are pinned by method and Reduce Motion value, and testPlants never runs
    const methods = readFileSync(path.join(root, 'methods.log'), 'utf8').split('\n').filter((l) => l.startsWith('AccessibilityUITests|'));
    expect(methods).toEqual([
      'AccessibilityUITests|test1AccessibilityAuditOfEveryNativeScreen|',
      'AccessibilityUITests|test2Structure|',
      'AccessibilityUITests|test3LargestTextSize|',
      'AccessibilityUITests|test4ReduceMotion|on',
      'AccessibilityUITests|test4ReduceMotion|off',
    ]);
    expect(readFileSync(path.join(root, 'methods.log'), 'utf8')).not.toContain('testPlants');
    expect(r.summary).toContain('native-no-demo: exit 0');
    expect(r.summary).toContain('suite: FAIL');
    expect(suite({}).status).toBe(0);
  });
});
