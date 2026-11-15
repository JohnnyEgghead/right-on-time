// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DIST-6, HC-07 (checks ci/license-gates.ts: license-inventory and ios-bundle-copyleft against planted known-bads)
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  autolinkedProblems, bundlePackages, declaredSwiftPackages, flatten, floorProblems, foreignSources, inventory, iosCopyleft, licenseFileProblems, loadPolicy, lockfileSnapshots, missingRoots,
  optionalShipped, parseAcknowledgements, parsePodfileLock, podsProblems, satisfies, shippedProblem,
} from './license-gates.ts';

const cli = path.resolve(import.meta.dirname, 'license-gates.ts');
const cases = path.resolve(import.meta.dirname, 'gates', 'license-gates', 'cases');
const run = (mode: string, c?: string) =>
  spawnSync('node', [cli, mode, ...(c ? ['--fixture', path.join(cases, c)] : [])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const policy = loadPolicy(path.resolve(import.meta.dirname, '..'));

describe('license-inventory (FR-DIST-6)', () => {
  it('passes a clean tree: permissive shipped packages, a shipped dual license with a permissive choice, a dev-only MPL tool', () => {
    // why: FR-DIST-6 the gate must not cry wolf, or the owner learns to ignore it
    const r = run('inventory', 'clean');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('2 shipped packages checked');
  });

  it('fails a planted shipped GPL-3.0 dependency, naming the package and the allow-list as the reason', () => {
    // why: FR-DIST-6 a GPL-3.0 package in what ships must fail CI
    const r = run('inventory', 'shipped-gpl');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('license-inventory: FAIL shipped planted-gpl-dep@3.1.0 license GPL-3.0 is not on the SD-39 allow-list');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('fails a planted shipped dependency with no license field, naming the missing license as the reason', () => {
    // why: FR-DIST-6 a package with no license must fail CI (pnpm reports it as Unknown)
    const r = run('inventory', 'shipped-no-license');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('license-inventory: FAIL shipped planted-unlicensed-dep@0.0.1 has no declared license');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('passes a planted dev-only AGPL-3.0 tool and records it as never shipped (OA-81)', () => {
    // why: FR-DIST-6 tools that never ship may carry any license (OA-81), so this must stay green
    const r = run('inventory', 'devonly-agpl');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 never-shipped packages recorded');
    expect(r.stdout).toContain('carrying copyleft (allowed, OA-81): 1');
  });

  it('passes a disallowed-license package that only Expo build tooling pulls in: it is in the tree but not in the Metro bundle source list', () => {
    // why: FR-DIST-6 SD-39 ships the iPhone app's bundle, not its build tools, so a Python-2.0 package outside the bundle must not fail
    const r = run('inventory', 'buildtool-only');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 packages in the iPhone app');
    expect(r.stdout).toContain('1 shipped packages checked');
  });

  it('fails the same package when its path is in the bundle source list, naming the package and the allow-list', () => {
    // why: FR-DIST-6 a disallowed license that Metro really bundles is shipped, so the split must not hide it
    const r = run('inventory', 'bundled-tool');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('license-inventory: FAIL shipped planted-build-tool@2.0.0 license Python-2.0 is not on the SD-39 allow-list');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('reads name and version from pnpm paths in a source map, scoped names and peer suffixes included, and flags a node_modules path it cannot read', () => {
    // why: FR-DIST-6 the bundle set is derived from source-map paths, so the parse must be exact or a shipped package slips through
    const r = bundlePackages([
      '/apps/x/index.ts',
      '../../node_modules/.pnpm/@scope+pkg@1.2.3_react@19.3.0/node_modules/@scope/pkg/a.js',
      '../../node_modules/.pnpm/plain@4.5.6/node_modules/plain/b.js',
      '../../node_modules/loose/c.js',
    ]);
    expect(r.pkgs).toEqual([{ name: '@scope/pkg', version: '1.2.3' }, { name: 'plain', version: '4.5.6' }]);
    expect(r.unresolved).toEqual(['../../node_modules/loose/c.js']);
  });

  it('accepts OFL-1.1 only on a font package and ODbL-1.0 only on a named data package; rejects everything off the list', () => {
    // why: FR-DIST-6 SD-39 limits OFL-1.1 to font files and ODbL-1.0 to map data, so a code package may not use either
    expect(shippedProblem({ name: '@fontsource/inter', version: '1.0.0', license: 'OFL-1.1' }, policy)).toBeNull();
    expect(shippedProblem({ name: 'some-lib', version: '1.0.0', license: 'OFL-1.1' }, policy)).toContain('not on the SD-39 allow-list');
    expect(shippedProblem({ name: 'some-lib', version: '1.0.0', license: 'ODbL-1.0' }, policy)).toContain('not on the SD-39 allow-list');
    expect(shippedProblem({ name: 'x', version: '1', license: 'MPL-2.0' }, policy)).toContain('MPL-2.0');
    expect(shippedProblem({ name: 'x', version: '1', license: 'SEE LICENSE IN LICENSE.md' }, policy)).toContain('no declared license');
  });

  it('allows CC-BY-4.0 on caniuse-lite only; any other package, or caniuse-lite under another non-allowed license, still fails', () => {
    // why: F-245 caniuse-lite (browser-support data, a next dependency) ships under CC-BY-4.0; the exception is by package name so no other CC-BY-4.0 package slips in
    expect(shippedProblem({ name: 'caniuse-lite', version: '1.0.30001816', license: 'CC-BY-4.0' }, policy)).toBeNull();
    expect(shippedProblem({ name: 'some-lib', version: '1.0.0', license: 'CC-BY-4.0' }, policy)).toContain('not on the SD-39 allow-list');
    expect(shippedProblem({ name: 'caniuse-lite', version: '1.0.30001816', license: 'MPL-2.0' }, policy)).toContain('MPL-2.0');
  });

  it('reads SPDX expressions: OR takes any allowed alternative, AND needs every term, an unparseable expression fails', () => {
    // why: FR-DIST-6 real packages ship dual licenses such as (MIT OR Apache-2.0); AND must not hide a bad term
    const ok = (id: string) => policy.allow.includes(id);
    expect(satisfies('(MIT OR Apache-2.0)', ok)).toBe(true);
    expect(satisfies('(BSD-3-Clause OR GPL-2.0)', ok)).toBe(true);
    expect(satisfies('MIT AND GPL-3.0', ok)).toBe(false);
    expect(satisfies('MIT AND', ok)).toBe(false);
  });

  it('prints a vendored build-verified entry as VENDORED, not PENDING (F-530)', () => {
    // why: SD-39 / F-530 the map's glyph and sprite files are in the repo, outside every package manager, with their license text kept and hashed
    const r = inventory([], [], policy, [{ component: 'glyphs', kind: 'vendored' as const, package: 'p', spdx: 'OFL-1.1', evidence: 'e', licenseFile: 'f.txt', licenseSha256: '0'.repeat(64) }]);
    expect(r.lines).toContain('build-verified glyphs: OFL-1.1 VENDORED (kept license text hashed; evidence: e)');
    expect(r.failures).toEqual([]);
  });

  it('prints a build-verified PENDING line per kind: a Swift Package Manager entry is outside the npm tree, never "not in the lockfile yet"', () => {
    // why: FR-DIST-6 the map library's BSD-2-Clause comes in by Swift Package Manager; an npm-only PENDING wording would state a falsehood about it
    const v = (kind: 'npm' | 'container' | 'spm', pkg: string) => ({ component: `c-${kind}`, kind, package: pkg, spdx: 'MIT', evidence: 'e' });
    const r = inventory([], [], policy, [v('npm', 'a'), v('container', 'b'), v('spm', 'c')]);
    expect(r.lines).toContain('build-verified c-npm: MIT PENDING (not in the lockfile yet; evidence: e)');
    expect(r.lines).toContain('build-verified c-container: MIT PENDING (container, outside the npm tree; evidence: e)');
    expect(r.lines).toContain('build-verified c-spm: MIT PENDING (Swift Package Manager, outside the npm tree; evidence: e)');
  });
});

describe('license-inventory closing-pass arms (F-84, F-85, F-88, F-89, F-90)', () => {
  it('fails a GPL-3.0 package the native app imports, in the inventory and in the iOS gate', () => {
    // why: FR-DIST-6 GPL-3.0 imported by the native app must fail, in the bundle list and in the iOS closure (F-90)
    const inv = run('inventory', 'native-gpl');
    expect(inv.status).toBe(1);
    expect(inv.stderr).toContain('license-inventory: FAIL shipped planted-native-gpl@1.0.0 license GPL-3.0 is not on the SD-39 allow-list');
    const ios = run('ios', 'native-gpl');
    expect(ios.status).toBe(1);
    expect(ios.stderr).toContain('ios-bundle-copyleft: FAIL planted-native-gpl@1.0.0 is GPL-3.0');
  });

  it('fails a never-shipped tool with no license (F-90)', () => {
    // why: SD-39 every never-shipped tool must declare a license, even though any license is allowed
    const r = run('inventory', 'never-shipped-unknown');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('license-inventory: FAIL never-shipped planted-unlicensed-tool@0.0.1 has no declared license');
  });

  it('prints each never-shipped tool with its version and license (F-89)', () => {
    // why: SD-39 the inventory records each never-shipped tool's license; a count is not a record
    const r = run('inventory', 'devonly-agpl');
    expect(r.stdout).toMatch(/^never-shipped \S+@\S+: AGPL-3\.0/m);
  });

  it('counts a native module the autolinker links although the JS bundle never imports it (F-84)', () => {
    // why: FR-DIST-6 the iPhone app ships native code, so an off-list license on an autolinked module must fail
    const r = run('inventory', 'autolinked-native');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('license-inventory: FAIL shipped planted-native-mpl@1.0.0 license MPL-2.0 is not on the SD-39 allow-list');
  });

  it('fails a bundle source outside node_modules that is not under apps/ or packages/ (F-85)', () => {
    // why: SD-39 a source that is not provably first-party could be third-party code with no license check
    const r = run('inventory', 'foreign-source');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('/etc/outside/evil.ts is outside node_modules but not under apps/ or packages/');
  });

  it('fails an unknown root and a bundle below its floor (F-85)', () => {
    // why: SD-39 a shrink of the shipped set must not pass silently
    expect(missingRoots(['bw-web', 'bw-nope'], new Map([['bw-web', []]]))).toEqual([
      'license-inventory: FAIL root bw-nope is not a workspace package, so its closure was not checked',
    ]);
    expect(floorProblems(29, 30)).toHaveLength(1);
    expect(floorProblems(30, 30)).toEqual([]);
    expect(foreignSources(['/apps/x.ts', '/packages/y.ts', '\0polyfill:external-require', '../../node_modules/a/b.js', '/etc/z.ts'])).toEqual(['/etc/z.ts']);
  });

  it('fails an autolinked module with no name or version, and a count below the autolinker floor (F-112)', () => {
    // why: SD-39 a failed read of the native module list is not a clean answer: an incomplete module is named, and 0 modules is a shrink
    const ok = { modules: Array.from({ length: 10 }, (_, i) => ({ packageName: `m${i}`, packageVersion: '1.0.0' })) };
    expect(autolinkedProblems(ok, 10)).toEqual([]);
    expect(autolinkedProblems({ modules: [] }, 10)).toEqual([expect.stringContaining('resolved 0 native modules, below the floor of 10')]);
    expect(autolinkedProblems({ modules: [...ok.modules.slice(1), { packageName: 'expo-x' }] }, 10)).toEqual([expect.stringContaining('expo-x')]);
    expect(autolinkedProblems({ modules: [...ok.modules.slice(1), { packageVersion: '2.0.0' }] }, 10)).toEqual([expect.stringContaining('has no name')]);
    expect(autolinkedProblems({}, 10)).toEqual([expect.stringContaining('no modules list')]);
    // the app's own modules carry no version and are first-party
    expect(autolinkedProblems({ modules: [...ok.modules, { packageName: 'bw-look', packageVersion: '' }] }, 10, new Set(['bw-look']))).toEqual([]);
  });

  it('fails a PENDING npm entry whose owning task has merged, and not before (F-88)', () => {
    // why: SD-39 a PENDING entry may not stay PENDING under a green gate forever
    const v = [{ component: 'c', kind: 'npm' as const, package: 'absent-pkg', spdx: 'MIT', evidence: 'e', owner: 'T-OWN' }];
    expect(inventory([], [], policy, v, new Set()).failures).toEqual([]);
    expect(inventory([], [], policy, v, new Set(['T-OWN'])).failures).toEqual([
      'license-inventory: FAIL build-verified c is still PENDING but its owning task T-OWN has merged; add the package to the lockfile or retire the entry',
    ]);
    const r = run('inventory', 'owner-merged');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('expo-secure-store is still PENDING but its owning task P6-NATIVE-SHELL has merged');
  });

  it('prints a retired npm entry as RETIRED after its owner merged, and fails the day its package lands (F-1163)', () => {
    // why: SD-39 a fallback the owning task did not take is recorded as not shipped, and that record must not outlive the truth
    const v = (retired: string) => [{ component: 'c', kind: 'npm' as const, package: 'fallback-pkg', spdx: 'MIT', evidence: 'e', owner: 'T-OWN', retired }];
    const quiet = inventory([], [], policy, v('fallback not taken'), new Set(['T-OWN']));
    expect(quiet.failures).toEqual([]);
    expect(quiet.lines).toContain('build-verified c: MIT RETIRED (not shipped: fallback not taken; evidence: e)');
    expect(inventory([{ name: 'fallback-pkg', version: '1.0.0', license: 'MIT' }], [], policy, v('fallback not taken'), new Set()).failures).toEqual([
      'license-inventory: FAIL build-verified c is retired (fallback not taken) but fallback-pkg@1.0.0 is in the lockfile; un-retire the entry so its license is checked',
    ]);
    expect(inventory([], [], policy, v(' '), new Set()).failures).toHaveLength(1);
    const r = run('inventory', 'retired-shipped');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('react-native-webview is retired (the SD-34 fallback was not taken');
    expect(r.stderr).toContain('but react-native-webview@14.0.1 is in the lockfile');
  });

  it('checks a kept license text against its recorded SHA-256 and terms line (F-88)', () => {
    // why: SD-39 certbot is a container that cannot be tree-checked, so its license text is pinned by hash
    const text = 'Licensed Apache Version 2.0\n';
    const sha = createHash('sha256').update(text).digest('hex');
    const v = (licenseSha256: string) => [{ component: 'k', kind: 'container' as const, package: 'k', spdx: 'Apache-2.0', evidence: 'e', licenseFile: 'f.txt', licenseSha256, licenseTerms: 'Licensed Apache Version 2.0' }];
    expect(licenseFileProblems(v(sha), () => text)).toEqual([]);
    expect(licenseFileProblems(v('0'.repeat(64)), () => text)).toHaveLength(1);
    expect(licenseFileProblems(v(sha), () => null)).toHaveLength(1);
    expect(licenseFileProblems(v(sha), () => text.replace('Apache', 'Other'))).toHaveLength(1);
  });

  it('pins the routing container\'s kept license text (OSRM, BSD-2-Clause) and fails it changed, missing or without its terms', () => {
    // why: FR-DIST-6, FR-MAP-3 P6-LIVE-ROUTING: the routing service (SD-49) ships as a container, so its record is checked by its kept text's hash
    const record = (JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'license', 'build-verified.json'), 'utf8')) as { entries: Parameters<typeof licenseFileProblems>[0] }).entries;
    const osrm = record.filter((e) => e.package === 'osrm-backend');
    expect(osrm.map((e) => [e.kind, e.spdx])).toEqual([['container', 'BSD-2-Clause']]);
    const text = readFileSync(path.resolve(import.meta.dirname, 'license', osrm[0]!.licenseFile!), 'utf8');
    expect(licenseFileProblems(osrm, () => text)).toEqual([]);
    expect(licenseFileProblems(osrm, () => `${text} `)).toHaveLength(1);
    expect(licenseFileProblems(osrm, () => null)).toHaveLength(1);
    expect(licenseFileProblems([{ ...osrm[0]!, licenseSha256: createHash('sha256').update(text.replace('Redistribution', 'Use')).digest('hex') }], () => text.replace('Redistribution', 'Use'))).toHaveLength(1);
  });
});

describe('libvips on the server only (owner ruling 0963dc1d, F-1263)', () => {
  it('passes sharp and its libvips binary (LGPL-3.0-or-later) in the server closure, under the named exception', () => {
    // why: FR-DIST-6 owner ruling 0963dc1d ("Allow LGPL for libvips"): the server image ships sharp's libvips for the photo small copy (SD-32)
    const r = run('inventory', 'server-libvips');
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toContain('4 shipped packages checked');
  });

  it('fails an LGPL-3.0-or-later package outside the libvips name, and one whose name only starts like it', () => {
    // why: FR-DIST-6 the exception is 1 named package set, not LGPL: any other LGPL package that ships still fails CI
    const r = run('inventory', 'shipped-lgpl-other');
    expect(r.status).toBe(1);
    expect(r.stderr.trim().split('\n').sort()).toEqual([
      'license-inventory: FAIL shipped @img/sharp-libvips-linux-x64-extras@1.0.0 license LGPL-3.0-or-later is not on the SD-39 allow-list',
      'license-inventory: FAIL shipped planted-lgpl-imagelib@1.0.0 license LGPL-3.0-or-later is not on the SD-39 allow-list',
    ]);
  });

  it('fails libvips in the iPhone app\'s bundle in both arms: the exception is the server\'s only', () => {
    // why: HC-07, FR-DIST-6 the iPhone bundle ban on GPL, LGPL and AGPL is unchanged by the server exception
    const b = run('inventory', 'bundled-libvips');
    expect(b.status).toBe(1);
    expect(b.stderr.trim()).toBe('license-inventory: FAIL shipped @img/sharp-libvips-linux-x64@1.3.4 license LGPL-3.0-or-later is not on the SD-39 allow-list (in the iPhone app)');
    const i = run('ios', 'ios-libvips');
    expect(i.status).toBe(1);
    expect(i.stderr.trim()).toBe('ios-bundle-copyleft: FAIL @img/sharp-libvips-linux-x64@1.3.4 is LGPL-3.0-or-later, third-party copyleft is not allowed in the iOS bundle (HC-07)');
    expect(shippedProblem({ name: '@img/sharp-libvips-linux-x64', version: '1.3.4', license: 'LGPL-3.0-or-later' }, policy)).toBeNull();
    expect(shippedProblem({ name: '@img/sharp-libvips-linux-x64', version: '1.3.4', license: 'LGPL-3.0-or-later' }, policy, true)).toContain('not on the SD-39 allow-list');
  });

  it('counts a shipped package\'s installed optional dependencies, transitively, as shipped: pnpm --prod leaves them out', () => {
    // why: FR-DIST-6 sharp's platform binary and libvips are optionalDependencies that ship with it; a closure without them would never check libvips
    const snaps = lockfileSnapshots(`---
lockfileVersion: '9.0'
snapshots:
  pnpm@12.14.0: {}
---
lockfileVersion: '9.0'
snapshots:
  sharp@0.35.5(@types/node@26.6.5):
    dependencies:
      detect-libc: 2.1.2
    optionalDependencies:
      '@img/sharp-darwin-arm64': 0.35.5
      '@img/sharp-linux-x64': 0.35.5
  '@img/sharp-linux-x64@0.35.5':
    optionalDependencies:
      '@img/sharp-libvips-linux-x64': 1.3.4
  '@img/sharp-libvips-linux-x64@1.3.4': {}
  detect-libc@2.1.2: {}
`);
    const all = [
      { name: 'sharp', version: '0.35.5', license: 'Apache-2.0' }, { name: 'detect-libc', version: '2.1.2', license: 'Apache-2.0' },
      { name: '@img/sharp-linux-x64', version: '0.35.5', license: 'Apache-2.0' }, { name: '@img/sharp-libvips-linux-x64', version: '1.3.4', license: 'LGPL-3.0-or-later' },
    ];
    // darwin's binary is in the lockfile but not installed here, so it is not this install's shipped set.
    expect(optionalShipped([all[0]!, all[1]!], all, snaps).map((p) => p.name)).toEqual(['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64']);
  });
});

describe('the optional walk over the iPhone closure and over what an added optional package depends on (F-1266)', () => {
  it('fails an LGPL package that only an optional edge of the iPhone closure reaches', () => {
    // why: F-1266 (a) pnpm licenses list --prod leaves optional edges out, so ios-bundle-copyleft read the iPhone closure without them
    const r = run('ios', 'ios-optional-lgpl');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ios-bundle-copyleft: FAIL opt-lgpl-bin@3.0.0 is LGPL-3.0');
  });

  it('fails a GPL package that is a regular dependency of an added optional package', () => {
    // why: F-1266 (b) the walk followed optional edges only, so the dependencies of an added package were never-shipped, where any license passes
    const r = run('inventory', 'optional-dependency-gpl');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('license-inventory: FAIL shipped opt-bin-dep@2.0.0 license GPL-3.0 is not on the SD-39 allow-list');
  });

  it('adds the dependencies of an added optional package but not the regular dependencies of a package already shipped', () => {
    // why: F-1266 (b) a shipped package's regular edges are the closure the caller passed; only what the walk adds ships whole
    const snaps = { 'a@1.0.0': { dependencies: { c: '1.0.0' }, optionalDependencies: { b: '1.0.0' } }, 'b@1.0.0': { dependencies: { d: '1.0.0' } }, 'c@1.0.0': null, 'd@1.0.0': null };
    const all = ['a', 'b', 'c', 'd'].map((name) => ({ name, version: '1.0.0', license: 'MIT' }));
    expect(optionalShipped([all[0]!], all, snaps).map((p) => p.name)).toEqual(['b', 'd']);
  });
});

describe('ios-bundle-copyleft (HC-07)', () => {
  it('passes a clean iOS bundle list, including a dual license with a permissive choice', () => {
    // why: HC-07 only third-party copyleft is barred; MIT and a dual license with a permissive option are fine
    const r = run('ios', 'clean');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('2 iOS bundle packages');
  });

  it('fails a planted LGPL package in the iOS bundle list, naming HC-07 as the reason', () => {
    // why: HC-07 an LGPL package in the iPhone bundle must fail CI
    const r = run('ios', 'ios-lgpl');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ios-bundle-copyleft: FAIL planted-lgpl-lib@2.2.0 is LGPL-2.1, third-party copyleft is not allowed in the iOS bundle (HC-07)');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('does not fail the same planted LGPL package in license-inventory when it is not shipped, so the iOS list alone decides', () => {
    // why: HC-07 the iOS gate must catch what the inventory allow-list does not see (a package only in the iOS list)
    expect(run('inventory', 'ios-lgpl').status).toBe(0);
  });

  it('fails an AGPL or GPL CocoaPods acknowledgment and ignores a permissive one', () => {
    // why: HC-07 the gate resolves the CocoaPods acknowledgments as well as the npm closure
    const plist = `<dict><key>License</key><string>MIT</string><key>Title</key><string>GoodPod</string></dict>
<dict><key>License</key><string>GPL-3.0</string><key>Title</key><string>BadPod</string></dict>`;
    const acks = parseAcknowledgements(plist);
    expect(acks).toHaveLength(2);
    const r = iosCopyleft(flatten({}), acks);
    expect(r.failures).toEqual(['ios-bundle-copyleft: FAIL CocoaPods acknowledgment BadPod is GPL-3.0 (HC-07)']);
  });
});

describe('ios-bundle-copyleft in the prebuild job (F-86)', () => {
  it('fails when the Pods acknowledgments are absent, instead of counting 0', () => {
    // why: F-86 apps/tech-native/ios is gitignored, so an absent input must fail in the job that generates it
    const r = podsProblems([], [], []);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('0 CocoaPods acknowledgments found');
  });

  it('fails GPL spellings the SPDX test misses, and a Swift package no build-verified entry names', () => {
    // why: F-86 the copyleft match missed GPLv3 and GNU GPL, and MapLibre Native comes by Swift Package Manager, which no plist lists
    const acks = [{ name: 'A', license: 'GPLv3' }, { name: 'B', license: 'GNU General Public License v2' }, { name: 'C', license: 'MIT' }];
    const r = podsProblems(acks, ['maplibre-gl-native-distribution', 'new-package'], ['maplibre-gl-native-distribution']);
    expect(r.failures).toEqual([
      'ios-bundle-copyleft: FAIL CocoaPods acknowledgment A is GPLv3 (HC-07)',
      'ios-bundle-copyleft: FAIL CocoaPods acknowledgment B is GNU General Public License v2 (HC-07)',
      'ios-bundle-copyleft: FAIL Swift package new-package (Package.resolved) has no entry in ci/license/build-verified.json, so its license is not checked (F-86)',
    ]);
  });

  it('passes permissive acknowledgments and known Swift packages', () => {
    // why: F-86 the new check must not cry wolf on the pods the app ships today
    expect(podsProblems([{ name: 'RCT', license: 'MIT' }], ['maplibre-gl-native-distribution'], ['maplibre-gl-native-distribution']).failures).toEqual([]);
  });
});

// F-1221: pods mode judges what the generated project declares and links at prebuild time, not what the files written later hold.
const PBX_KNOWN = '/* Begin XCRemoteSwiftPackageReference section */\n\tA1 /* XCRemoteSwiftPackageReference "maplibre-gl-native-distribution" */ = {\n\t\tisa = XCRemoteSwiftPackageReference;\n\t\trepositoryURL = "https://github.com/maplibre/maplibre-gl-native-distribution";\n\t};\n';
const PBX_NEW = `${PBX_KNOWN}\tB2 = {\n\t\trepositoryURL = "https://example.test/acme/new-package.git";\n\t};\n`;
const LOCK = [
  'PODS:', '  - BwLook (0.0.0)', '  - RCT-Folly (2024.1)', '  - Expo (58.0.14)', '  - "Expo/Core (58.0.14)"', '  - Trunkpod (1.0.0)', '', 'DEPENDENCIES:', '  - Trunkpod', '',
  'EXTERNAL SOURCES:', '  BwLook:', '    :path: "../modules/bw-look/ios"', '  Expo:', '    :path: "../../../node_modules/.pnpm/expo@58/node_modules/expo"',
  '  RCT-Folly:', '    :path: build/rndeps-facades/RCT-Folly', '', 'SPEC CHECKSUMS:', '  Expo: x', '',
].join('\n');
const inRepoOnly = (p: string): boolean => p.startsWith('../modules') || p.startsWith('build/');

describe('pods mode reads what the app links (F-1221)', () => {
  it('reads the Swift packages an Xcode project declares, by repository name, with no Package.resolved', () => {
    // why: F-1221 (a) Package.resolved does not exist when prebuild.sh runs the check, so 0 Swift packages passed; the project declares them by then
    expect(declaredSwiftPackages(PBX_NEW)).toEqual(['maplibre-gl-native-distribution', 'new-package']);
  });

  it('fails a declared Swift package no build-verified entry names, with no Package.resolved at all', () => {
    // why: F-1221 (a) the known-bad: an unlisted package declared in the project, the resolve not yet run
    const r = podsProblems([{ name: 'A', license: 'MIT' }], declaredSwiftPackages(PBX_NEW), ['maplibre-gl-native-distribution']);
    expect(r.failures).toEqual(['ios-bundle-copyleft: FAIL Swift package new-package (Package.resolved) has no entry in ci/license/build-verified.json, so its license is not checked (F-86)']);
  });

  it('sorts the pods of Podfile.lock into npm, first-party and other, a subspec counting as its pod', () => {
    // why: F-1221 (b) the population is Podfile.lock minus the npm-sourced pods, the project's own exempt by path
    expect(parsePodfileLock(LOCK, inRepoOnly)).toEqual([
      { name: 'BwLook', origin: 'first-party' }, { name: 'Expo', origin: 'npm' }, { name: 'RCT-Folly', origin: 'first-party' }, { name: 'Trunkpod', origin: 'other' },
    ]);
  });

  it('fails a non-npm third-party pod with no license text and no build-verified entry, and passes it with either', () => {
    // why: F-1221 (b) 99 of 107 pods had no acknowledgment and nothing counted them
    const pods = parsePodfileLock(LOCK, inRepoOnly);
    const acks = [{ name: 'Expo', license: 'MIT' }];
    expect(podsProblems(acks, [], [], pods).failures.join('\n')).toContain('pod Trunkpod (Podfile.lock) is not from npm');
    expect(podsProblems([...acks, { name: 'Trunkpod', license: 'MIT' }], [], [], pods).failures).toEqual([]);
    expect(podsProblems(acks, [], ['trunkpod'], pods).failures).toEqual([]);
  });

  it('does not fail the project\'s own pod for a LICENSE beside its podspec, and still fails a third-party copyleft acknowledgment', () => {
    // why: F-1221 (c) HC-07 is about third-party code; BwLook is AGPL by the project's own choice
    const pods = parsePodfileLock(LOCK, inRepoOnly);
    expect(podsProblems([{ name: 'BwLook', license: 'GNU Affero General Public License v3' }, { name: 'Trunkpod', license: 'MIT' }], [], [], pods).failures).toEqual([]);
    expect(podsProblems([{ name: 'Trunkpod', license: 'GPLv3' }], [], [], pods).failures).toEqual(['ios-bundle-copyleft: FAIL CocoaPods acknowledgment Trunkpod is GPLv3 (HC-07)']);
  });

  it('the CLI fails a generated project that declares an unlisted package before any resolve, and passes the same tree with it listed', () => {
    // why: F-1221 end to end: a tree as prebuild leaves it (project and Podfile.lock written, acknowledgments written, no Package.resolved)
    const root = mkdtempSync(path.join(os.tmpdir(), 'bw-license-pods-'));
    try {
      const repo = path.resolve(import.meta.dirname, '..');
      mkdirSync(path.join(root, 'ci', 'license'), { recursive: true });
      for (const f of ['policy.json', 'build-verified.json']) copyFileSync(path.join(repo, 'ci', 'license', f), path.join(root, 'ci', 'license', f));
      const ios = path.join(root, 'apps', 'tech-native', 'ios');
      mkdirSync(path.join(ios, 'RightOnTime.xcodeproj'), { recursive: true });
      mkdirSync(path.join(ios, 'Pods', 'Target Support Files', 'Pods-App'), { recursive: true });
      mkdirSync(path.join(root, 'apps', 'tech-native', 'modules', 'bw-look', 'ios'), { recursive: true });
      writeFileSync(path.join(ios, 'Podfile.lock'), LOCK.replace('  - Trunkpod (1.0.0)\n', '').replace('  - Trunkpod\n', ''));
      writeFileSync(path.join(ios, 'Pods', 'Target Support Files', 'Pods-App', 'Pods-App-acknowledgements.plist'),
        '<dict><key>License</key><string>MIT</string><key>Title</key><string>Expo</string></dict>');
      const pbx = path.join(ios, 'RightOnTime.xcodeproj', 'project.pbxproj');
      writeFileSync(pbx, PBX_NEW);
      const env = { ...process.env, CI_ROOT: root };
      const bad = spawnSync('node', [cli, 'pods'], { encoding: 'utf8', env });
      expect(bad.status, bad.stdout + bad.stderr).toBe(1);
      expect(bad.stderr).toContain('Swift package new-package');
      writeFileSync(pbx, PBX_KNOWN);
      const good = spawnSync('node', [cli, 'pods'], { encoding: 'utf8', env });
      expect(good.status, good.stdout + good.stderr).toBe(0);
      rmSync(path.join(ios, 'RightOnTime.xcodeproj'), { recursive: true });
      const none = spawnSync('node', [cli, 'pods'], { encoding: 'utf8', env });
      expect(none.status, 'no project at all is a failure, not 0 packages').toBe(1);
      expect(none.stderr).toContain('no Xcode project');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
