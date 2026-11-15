// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-409
// The CI image key (ci/wave-image-key.ts) must be stable for equal inputs and change with every input that
// shapes the image, so a stale image can never be selected (owner ruling ffd9f9ff). Fixture trees only, no docker.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeKey, keyFiles, stage, type KeyInputs } from './wave-image-key.ts';

const IN: KeyInputs = { base: 'node:26@sha256:aaa', apt: 'git=1 curl=2', pnpm: '12.14.0' };
let root: string;

const put = (rel: string, body: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), body);
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'wave-key-'));
  put('pnpm-lock.yaml', 'lock-1');
  put('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
  put('.node-version', '26.12.1');
  put('package.json', JSON.stringify({ devDependencies: { playwright: '1.64.1' } }));
  put('apps/web/package.json', '{"name":"web"}');
  put('packages/db/package.json', '{"name":"db"}');
  put('ci/wave-image/Dockerfile', 'FROM x');
  put('ci/wave-image-key.ts', '// recipe');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('wave image key (F-409)', () => {
  it('the same inputs give the same key, in another directory too', () => {
    // why: a key that varied with the path or the run would never hit the cache
    const k = computeKey(root, IN);
    expect(computeKey(root, { ...IN })).toBe(k);
    expect(k).toMatch(/^[0-9a-f]{20}$/);
    const other = mkdtempSync(path.join(tmpdir(), 'wave-key2-'));
    try {
      for (const rel of keyFiles(root)) {
        mkdirSync(path.dirname(path.join(other, rel)), { recursive: true });
        writeFileSync(path.join(other, rel), readFileSync(path.join(root, rel)));
      }
      expect(computeKey(other, IN)).toBe(k);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('each scalar input changes the key', () => {
    // why: base digest, apt list and pnpm version all shape the image; a stale one must not be reused
    const k = computeKey(root, IN);
    expect(computeKey(root, { ...IN, base: 'node:26@sha256:bbb' })).not.toBe(k);
    expect(computeKey(root, { ...IN, apt: 'git=1 curl=3' })).not.toBe(k);
    expect(computeKey(root, { ...IN, pnpm: '12.14.1' })).not.toBe(k);
  });

  it.each([
    ['the lockfile', 'pnpm-lock.yaml', 'lock-2'],
    ['the workspace file', 'pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n# x\n'],
    ['.node-version', '.node-version', '26.12.2'],
    ['a workspace package.json', 'apps/web/package.json', '{"name":"web","v":2}'],
    ['another workspace package.json', 'packages/db/package.json', '{"name":"db","v":2}'],
    ['the Dockerfile', 'ci/wave-image/Dockerfile', 'FROM x\n# comment'],
    ['the key script', 'ci/wave-image-key.ts', '// recipe 2'],
  ])('a one-byte change to %s changes the key', (_n, rel, body) => {
    // why: F-409 required inputs; each must reach the hash or a stale image would be used
    const k = computeKey(root, IN);
    put(rel, body);
    expect(computeKey(root, IN)).not.toBe(k);
  });

  it('the Playwright version changes the key', () => {
    // why: the browsers in the image are the pinned Playwright's
    const k = computeKey(root, IN);
    put('package.json', JSON.stringify({ devDependencies: { playwright: '1.64.2' } }));
    expect(computeKey(root, IN)).not.toBe(k);
  });

  it('a new workspace package.json changes the key', () => {
    // why: the population is read from the workspace globs, not a fixed list
    const k = computeKey(root, IN);
    put('packages/new/package.json', '{}');
    expect(computeKey(root, IN)).not.toBe(k);
  });

  it('a root without a pinned Playwright is an error, never a key', () => {
    // why: an unpinned browser version would let the image drift
    put('package.json', '{}');
    expect(() => computeKey(root, IN)).toThrow(/playwright/);
  });

  it('stage copies exactly the key files', () => {
    // why: the build context must not hold an input the key does not hash (F-461)
    const dest = mkdtempSync(path.join(tmpdir(), 'wave-stage-'));
    try {
      put('apps/web/src/index.ts', 'not an input');
      put('ci/not-an-input.ts', 'not an input either');
      put('stray-at-the-root.txt', 'not an input');
      stage(root, dest);
      for (const rel of keyFiles(root)) expect(existsSync(path.join(dest, rel))).toBe(true);
      expect(existsSync(path.join(dest, 'apps/web/src/index.ts'))).toBe(false);
      // F-461: the staged tree is exactly the key files, not a superset (a copy of the whole ci/ folder would go red).
      const staged = (readdirSync(dest, { recursive: true, withFileTypes: true }) as Dirent[])
        .filter((e) => e.isFile())
        .map((e) => path.relative(dest, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
        .sort();
      expect(staged).toEqual([...keyFiles(root)].sort());
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('the CLI prints the same key as the module', () => {
    // why: wave-run.sh calls the CLI; it must agree with the function the tests pin
    const r = spawnSync(
      'node',
      ['ci/wave-image-key.ts', 'key', root, '--base', IN.base, '--apt', IN.apt, '--pnpm', IN.pnpm],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(computeKey(root, IN));
  });

  it('wave-run.sh keeps the lockfile proof and uses the keyed image', () => {
    // why: F-409 requirement 2 and 4; install stays frozen (offline), and the run prints cache hit or rebuild
    // F-462: live lines only (comment lines dropped), because the header comment repeats 'pnpm install --frozen-lockfile --offline'.
    const live = readFileSync('ci/wave-run.sh', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(live).toMatch(/^pnpm install --frozen-lockfile --offline --store-dir /m);
    expect(live).toMatch(/wave-image-key\.ts" key "\$WORK\/export" --base "\$IMAGE" --apt "\$APT_PINS" --pnpm "\$PNPM_VERSION"/);
    const s = live;
    expect(s).toContain('ci-image: CACHE HIT');
    expect(s).toContain('ci-image: REBUILD');
    expect(s).toContain('--entrypoint sleep "$CI_IMG"');
  });

  // F-460: the pre-run image steps run before the whole-run timer, so each needs its own cap. These read the LIVE command
  // lines only (comment lines dropped), because the header comments repeat command text (F-462).
  const liveLines = (): string[] =>
    readFileSync('ci/wave-run.sh', 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l));

  it('every pre-run Spectre image call in wave-run.sh runs through bounded()', () => {
    const all = readFileSync('ci/wave-run.sh', 'utf8').split('\n');
    const end = all.findIndex((l) => l.includes("# 2. The run's own engine"));
    expect(end).toBeGreaterThan(0);
    const region = all
      .slice(0, end)
      .filter((l) => !/^\s*#/.test(l))
      .filter((l) => /docker --context "\$CTX" (build|image inspect|images|rmi)\b/.test(l));
    expect(region.length).toBeGreaterThanOrEqual(5); // build, inspect, list, rmi, count
    for (const l of region) expect(l).toMatch(/\bbounded "\$[A-Z_]+_CAP_S" "[^"]*(\$old)?[^"]*" (quiet )?docker /);
  });

  it('no bounded() call site sends its stderr away, so a timeout names its step on the console', () => {
    // why: F-480 - bounded() writes its RED line to stderr; a 2>/dev/null around the call discarded it at 4 of 5 sites
    for (const l of liveLines().filter((x) => /\bbounded "/.test(x))) expect(l).not.toMatch(/2>\s*\/dev\/null|2>&1/);
  });

  it('the cold image build is capped by CI_BUILD_CAP_S, at most 2x the measured 714 s', () => {
    const live = liveLines().join('\n');
    expect(live).toMatch(/bounded "\$CI_BUILD_CAP_S" "cold CI image build" docker --context "\$CTX" build /);
    const cap = Number(/^CI_BUILD_CAP_S=(\d+)/m.exec(live)?.[1]);
    expect(cap).toBeGreaterThanOrEqual(714);
    expect(cap).toBeLessThanOrEqual(1500);
  });

  it('bounded() on expiry returns 124, names the step, and leaves no child process', () => {
    const src = readFileSync('ci/wave-run.sh', 'utf8');
    const a = src.indexOf('kill_tree() {');
    const b = src.indexOf('cleanup() {');
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    const script = `${src.slice(a, b)}\nbounded 1 "probe step" bash -c 'sleep 4242 & sleep 4243 & wait'\nexit $?`;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(124);
    expect(r.stderr).toContain("RED: step 'probe step' timed out after 1s");
    // F-484: a missing pgrep (slim CI image without procps) must fail loudly, never read as "no child left".
    const left = spawnSync('pgrep', ['-f', 'sleep 424[23]'], { encoding: 'utf8' });
    expect(left.error, 'pgrep is not installed: this test cannot observe leftover children (install procps)').toBeUndefined();
    expect([0, 1]).toContain(left.status);
    expect(left.stdout.trim()).toBe('');
  });

  it('the image replaces the browsers Mesa 22.3.6 with the pinned Mesa 25.0.7 after playwright install (F-499)', () => {
    // why: F-499 - Mesa 22.3.6 llvmpipe reads another context's scene unlocked, which crashed WebKit map pages in the
    // wave run; the install step brings that Mesa, so the pinned one must come after it, from bookworm-backports
    const live = readFileSync('ci/wave-image/Dockerfile', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const browsers = live.indexOf('playwright install --with-deps');
    const mesa = live.indexOf('libgl1-mesa-dri=');
    expect(browsers).toBeGreaterThan(0);
    expect(mesa).toBeGreaterThan(browsers);
    expect(live).toContain('Suites: bookworm-backports');
    for (const p of ['libgl1-mesa-dri', 'libegl-mesa0', 'libgbm1', 'libglx-mesa0', 'mesa-libgallium']) {
      expect(live).toMatch(new RegExp(`\\s${p}=25\\.0\\.7-2~bpo12\\+1\\s`));
    }
  });
});
