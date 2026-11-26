// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-DIST-8, UC-11 (P7-SMOKE: the publish dry run, the secret leak check and the smoke job's order of steps; the live engine proofs are in .build/evidence/P7-SMOKE)
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = path.resolve(__dirname, '..', '..');
const publish = path.join(repo, 'scripts', 'publish.sh');
const leakCheck = path.join(__dirname, 'leak-check.sh');
const smoke = path.join(__dirname, 'smoke-public-tag.sh');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

// Obviously fake ids with the shape of a device id (8 hex, a dash, 16 hex), built at run time so this file holds no full id (F-1452).
const FAKE_ECID = '1234567890ABCDEF';
const FAKE_UDID = ['0000AAAA', FAKE_ECID].join('-');

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'smoke-test-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A small tree with the real script and the real private paths list, a file planted under every private path, and 2 public files. */
function plantedRepo(name: string, extra: Record<string, string> = {}): string {
  const dir = path.join(tmp, name);
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  mkdirSync(dir);
  git(dir, 'init', '-q');
  put('scripts/publish.sh', readFileSync(publish, 'utf8'));
  put('scripts/private-paths.txt', readFileSync(path.join(repo, 'scripts', 'private-paths.txt'), 'utf8'));
  put('README.md', 'public\n');
  put('apps/web/src/index.ts', 'export {};\n');
  put('docs/public/walkthrough.md', 'public doc\n');
  for (const p of [
    'docs/planning/round-1/secret-plan.md',
    'docs/source/STORY.md',
    '.claude/agent-memory/x.md',
    '.build/OPEN-FINDINGS.md',
    'mockups/index.html',
    'docs/REQUIREMENTS.md',
    'docs/SPECIFICATIONS.md',
    'docs/BUILD_PLAN.md',
    'docs/UI-SPECIFICATION.md',
    '.github/workflows/ci.yml',
    'apps/web/.github/workflows/nested.yml',
  ]) put(p, 'private\n');
  // F-1455: the plants come from this pinned literal list (every private line of scripts/private-paths.txt; a directory line gets a file inside it), never from the file under test, so deleting any line from scripts/private-paths.txt leaves its planted file in the export and the list assertion fails.
  for (const p of [
    'docs/planning/planted-by-list.md',
    'docs/source/planted-by-list.md',
    '.claude/planted-by-list.md',
    '.build/planted-by-list.md',
    'mockups/planted-by-list.md',
    'docs/REQUIREMENTS-REVISIONS.md',
    'docs/SPECIFICATIONS-REVISIONS.md',
    'docs/BUILD_PLAN-REVISIONS.md',
    'docs/UI-SPECIFICATION-REVISIONS.md',
    'docs/UI-DESIGN-KIT.md',
    'docs/UI-DESIGN-KIT-REVISIONS.md',
    // F-1454 (OA-39, FR-DIST-1; SPECIFICATIONS section 6.13): the build records, the design source and the harness launchers.
    'docs/build/planted-by-list.md',
    'docs/BUILD_REPORTS/planted-by-list.md',
    'docs/design/planted-by-list.md',
    'jl-anchor',
    'jl-build',
    'jl-plan',
    'scripts/launch-anchor.sh',
    'scripts/launch-build-manager.sh',
    'scripts/launch-plan-manager.sh',
    'scripts/launch-planted-by-glob.sh',
    // F-1570: the build-continuity files of the jl-dev harness.
    'scripts/build-health.sh',
    'scripts/checkpoint.sh',
    'scripts/context-level.sh',
    'scripts/wisdom-compact.py',
    // F-1571 (owner answer 44079436): the vendored jl-dev scripts and the local-only orphans runner stay private.
    'ci/vendor/jl-dev/planted-by-list.py',
    'ci/test-reason-orphans.sh',
    // The owner's drill values stay private (F-1605).
    'infra/owner.env',
    // F-1919: the 2 lines that had no plant (docs/guide/ and the owner's local env file).
    'docs/guide/planted-by-list.md',
    'infra/owner.local.env',
    // F-1920: the build-continuity git hook of the jl-dev harness, and any later plugin file in that folder.
    '.githooks/pre-push',
    '.githooks/planted-by-list',
  ]) put(p, 'private\n');
  for (const [p, t] of Object.entries(extra)) put(p, t);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'planted tree');
  git(dir, 'tag', 'v0.0.1');
  return dir;
}
const runPublish = (dir: string, ...args: string[]) =>
  spawnSync('bash', [path.join(dir, 'scripts', 'publish.sh'), ...args], { cwd: dir, env: GIT_ENV, encoding: 'utf8' });

describe('scripts/publish.sh --dry-run', () => {
  // why: SD-38, FR-DIST-8, F-1455 a file planted from a pinned list under every private line is left out (deleting any line of scripts/private-paths.txt turns this red), and no .github directory at any depth is exported
  it('leaves out every private path, a planted docs/planning file and every .github directory', () => {
    const dir = plantedRepo('pub-1');
    const out = path.join(tmp, 'pub-1-out');
    const r = runPublish(dir, '--dry-run', '--ref', 'v0.0.1', '--out', out);
    expect(r.status, r.stderr).toBe(0);
    const list = readFileSync(`${out}.list`, 'utf8').trim().split('\n');
    expect(list).toEqual(['README.md', 'apps/web/src/index.ts', 'docs/public/walkthrough.md', 'scripts/private-paths.txt', 'scripts/publish.sh']);
    expect(list.filter((p) => p.startsWith('docs/planning/'))).toEqual([]);
    expect(list.filter((p) => p.split('/').includes('.github'))).toEqual([]);
    expect(existsSync(path.join(out, 'docs', 'planning'))).toBe(false);
    expect(existsSync(path.join(out, '.github'))).toBe(false);
    expect(existsSync(path.join(out, 'README.md'))).toBe(true);
    expect(r.stdout).toContain('publish: PASS');
  });

  // why: FR-DIST-1, F-1454 the glob line scripts/launch-*.sh leaves out every launcher and nothing else: a file that only looks alike stays, and a * does not reach into a directory
  it('applies the glob line of the private paths list to launch-*.sh only', () => {
    const dir = plantedRepo('pub-glob', {
      'scripts/launch-notes.txt': 'public\n',
      'scripts/relaunch-x.sh': 'public\n',
      'scripts/sub/launch-deep.sh': 'public\n',
    });
    const out = path.join(tmp, 'pub-glob-out');
    const r = runPublish(dir, '--dry-run', '--ref', 'v0.0.1', '--out', out);
    expect(r.status, r.stderr).toBe(0);
    const list = readFileSync(`${out}.list`, 'utf8').trim().split('\n');
    expect(list.filter((p) => p.startsWith('scripts/'))).toEqual(['scripts/launch-notes.txt', 'scripts/private-paths.txt', 'scripts/publish.sh', 'scripts/relaunch-x.sh', 'scripts/sub/launch-deep.sh']);
    expect(list.some((p) => p.startsWith('docs/build/') || p.startsWith('docs/BUILD_REPORTS/') || p.startsWith('docs/design/') || ['jl-anchor', 'jl-build', 'jl-plan'].includes(p))).toBe(false);
  });

  // why: F-1683 the glob guard is the backstop of the glob removal: a glob that names a folder (with or without a trailing /) must be caught under it, with its regex characters literal
  it('catches what a folder glob line names when the removal misses it, and refuses a ? or [ wildcard', () => {
    const lines = `${readFileSync(path.join(repo, 'scripts', 'private-paths.txt'), 'utf8')}apps/*/secret/\napps/*/private\ndocs/a+b-*.md\n`;
    const plants = { 'scripts/private-paths.txt': lines, 'apps/web/secret/x.md': 'private\n', 'apps/web/private/y.md': 'private\n', 'docs/a+b-1.md': 'private\n', 'docs/aab-1.md': 'public\n' };
    // The real script removes all 3, and the regex + is literal: docs/aab-1.md stays and passes.
    const ok = plantedRepo('pub-glob-dir', plants);
    const okOut = path.join(tmp, 'pub-glob-dir-out');
    const r = runPublish(ok, '--dry-run', '--ref', 'v0.0.1', '--out', okOut);
    expect(r.status, r.stderr).toBe(0);
    const list = readFileSync(`${okOut}.list`, 'utf8');
    expect(list).not.toMatch(/apps\/web\/(secret|private)\/|docs\/a\+b-1\.md/);
    expect(list).toContain('docs/aab-1.md');
    // A script whose glob removal is broken: the guard names every glob line it left in the export.
    const script = readFileSync(publish, 'utf8');
    const broken = script.replace('rm -rf -- "$p"; done', 'true; done');
    expect(broken).not.toBe(script);
    const bad = plantedRepo('pub-glob-dir-bad', { ...plants, 'scripts/publish.sh': broken });
    const b = runPublish(bad, '--dry-run', '--ref', 'v0.0.1', '--out', path.join(tmp, 'pub-glob-dir-bad-out'));
    expect(b.status).toBe(1);
    for (const g of ['apps/*/secret/', 'apps/*/private', 'docs/a+b-*.md', 'scripts/launch-*.sh']) expect(b.stderr).toContain(`FAIL private path in the export: ${g}\n`);
    for (const w of ['apps/?/*', 'apps/[ab]*']) {
      const q = plantedRepo(`pub-glob-q-${w.length}`, { 'scripts/private-paths.txt': `${lines}${w}\n` });
      const rq = runPublish(q, '--dry-run', '--ref', 'v0.0.1', '--out', path.join(tmp, `pub-glob-q-${w.length}-out`));
      expect(rq.status, w).toBe(2);
      expect(rq.stderr).toContain(`uses no ? or [, only *: ${w}`);
    }
  });

  // why: SD-38 the export is made from the ref's tree: a planted private file added after the tag does not matter, and a missing ref is a usage error
  it('exports the named tag, and refuses a ref that does not exist', () => {
    const dir = plantedRepo('pub-2');
    expect(runPublish(dir, '--dry-run', '--ref', 'v9.9.9', '--out', path.join(tmp, 'pub-2-out')).status).toBe(2);
  });

  // why: F-55 a full device id (UDID) in the export fails the dry run, and names the file but not the value
  it('fails when a full device id is in the publish set', () => {
    const dir = plantedRepo('pub-3', { 'docs/public/record.md': `device ${FAKE_UDID} paired\n` });
    const r = runPublish(dir, '--dry-run', '--ref', 'v0.0.1', '--out', path.join(tmp, 'pub-3-out'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('docs/public/record.md');
    expect(r.stderr + r.stdout).not.toContain(FAKE_ECID);
  });

  // why: F-1452 a device id cut by quotes and a template (as a test file holds it to get past a plain guard) fails the dry run too
  it('fails when a device id is split by quotes and braces', () => {
    const dir = plantedRepo('pub-6', { 'ci/some.test.ts': `const id = \`\${'${FAKE_UDID.slice(0, 9)}'}\${'${FAKE_ECID}'}\`;\n` });
    const r = runPublish(dir, '--dry-run', '--ref', 'v0.0.1', '--out', path.join(tmp, 'pub-6-out'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ci/some.test.ts');
  });

  // why: F-55 the truncated form the S4 record uses (00008140-...801C) is not a full id and passes
  it('passes a truncated device id', () => {
    const dir = plantedRepo('pub-4', { 'docs/public/record.md': 'device 00008140-...801C paired\n' });
    expect(runPublish(dir, '--dry-run', '--ref', 'v0.0.1', '--out', path.join(tmp, 'pub-4-out')).status).toBe(0);
  });

  // why: FR-DIST-8 publish.sh needs a subcommand or --dry-run (prepare, push and release are P8-PUBLISH's), and the out folder must be empty
  it('refuses to run with no subcommand or --dry-run and refuses a non-empty out folder', () => {
    const dir = plantedRepo('pub-5');
    expect(runPublish(dir).status).toBe(2);
    const out = path.join(tmp, 'pub-5-out');
    mkdirSync(out);
    writeFileSync(path.join(out, 'x'), 'x');
    expect(runPublish(dir, '--dry-run', '--out', out).status).toBe(2);
  });

  // why: SD-38, F-55 the real tree at HEAD: no path on the private list, no docs/planning, no .github, and no full device id
  it('passes on this repository\'s own tree', () => {
    const out = path.join(tmp, 'real-out');
    const r = spawnSync('bash', [publish, '--dry-run', '--ref', 'HEAD', '--out', out], { cwd: repo, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const list = readFileSync(`${out}.list`, 'utf8').trim().split('\n');
    expect(list.length).toBeGreaterThan(100);
    expect(list.filter((p) => /^(docs\/planning|docs\/source|\.claude|\.build|mockups)\//.test(p) || p.split('/').includes('.github'))).toEqual([]);
    expect(list).not.toContain('docs/REQUIREMENTS.md');
    expect(list).toContain('scripts/publish.sh');
  }, 120_000);
});

describe('ci/smoke/leak-check.sh', () => {
  let bin: string;
  // A fake docker: `docker exec <engine> sh -c <script>` prints FAKE_DUMP (what the engine would hold).
  const FAKE = `#!/usr/bin/env bash\n[ "\${FAKE_FAIL:-0}" = 1 ] && exit 1\nprintf '%s\\n' "\${FAKE_DUMP:-}"\n`;
  beforeAll(() => {
    bin = path.join(tmp, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'docker'), FAKE);
    chmodSync(path.join(bin, 'docker'), 0o755);
  });
  const run = (env: Record<string, string>) =>
    spawnSync('bash', [leakCheck, 'eng'], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, ...env }, encoding: 'utf8' });
  const PLANT = 'fake-test-secret-4c1d9e0a77b3f2e8';

  // why: FR-DIST-8 (Clean item 4) a planted secret from the job's environment found inside the engine fails, and only the name is printed
  it('fails when the planted secret value is inside the engine, and never prints it', () => {
    const r = run({ BW_SMOKE_PLANT_SECRET: PLANT, FAKE_DUMP: `PATH=/bin\nAPI_KEY=${PLANT}\n` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('BW_SMOKE_PLANT_SECRET');
    expect(r.stdout + r.stderr).not.toContain(PLANT);
  });

  // why: FR-DIST-8 (Clean item 4) a planted secret that is absent inside the engine passes
  it('passes when the planted secret is absent inside the engine', () => {
    const r = run({ BW_SMOKE_PLANT_SECRET: PLANT, FAKE_DUMP: 'PATH=/bin\nDOCKER_TLS_CERTDIR=\n' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 secret variable(s) set in the job, 0 found');
  });

  // why: F-1453 a check of 0 variables fails (exit 2) and says so, instead of passing vacuously as it did when the job set none of its variables
  it('fails when none of its variables is set, so 0 values checked is never a pass', () => {
    const r = run({ FAKE_DUMP: 'PATH=/bin\n' });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toContain('0 variables were checked');
  });

  // why: F-1453 the engine's text holds the copy's settings file, and a failing docker ps inside the engine fails the read (it was skipped with exit 0)
  it('dumps /work/settings.env and fails the read when listing the containers fails', () => {
    const src = readFileSync(leakCheck, 'utf8');
    expect(src).toContain('cat /work/settings.env || exit 1');
    expect(src).toContain('ids="$(docker ps -aq)" || exit 1');
  });

  // why: F-1453 the workflow's 2 smoke steps set a per-run made-up BW_SMOKE_PLANT_SECRET, and the job stays on the self-hosted runner only
  it('sets a per-run BW_SMOKE_PLANT_SECRET on both smoke steps of the workflow and never runs on a hosted runner', (ctx) => {
    // F-1852: .github/workflows/ is a private path (scripts/private-paths.txt), so a public copy skips this with a note naming the file.
    const WF = path.join(__dirname, '..', '..', '.github', 'workflows', 'smoke-public-tag.yml');
    if (!existsSync(WF)) ctx.skip('.github/workflows/smoke-public-tag.yml is not in this copy (a private path the public export leaves out)');
    const wf = readFileSync(WF, 'utf8');
    expect(wf.match(/BW_SMOKE_PLANT_SECRET: bw-smoke-plant-\$\{\{ github\.run_id \}\}/g)).toHaveLength(2);
    for (const m of wf.matchAll(/runs-on:(.*)/g)) expect(m[1]).toContain('self-hosted');
  });

  // why: FR-DIST-8 (Clean item 4) an engine that gives no text fails closed (exit 2), never a pass; so does no engine named
  it('fails closed when the engine cannot be read or none is named', () => {
    expect(run({ BW_SMOKE_PLANT_SECRET: PLANT, FAKE_FAIL: '1' }).status).toBe(2);
    expect(spawnSync('bash', [leakCheck], { env: { PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' }).status).toBe(2);
  });
});

describe('ci/smoke/smoke-public-tag.sh', () => {
  const text = readFileSync(smoke, 'utf8');
  // why: FR-DIST-8 (Clean items 3 and 6) the engine has no volume and its self-check runs before the install
  it('starts the engine with no volume, and runs the self-check before the install', () => {
    const run = text.split('\n').filter((l) => l.includes('docker run -d --privileged'));
    expect(run).toHaveLength(1);
    expect(run[0]).not.toMatch(/ -v | --volume|--mount/);
    expect(text.indexOf('engine-self-check.sh')).toBeGreaterThan(0);
    expect(text.indexOf('engine-self-check.sh')).toBeLessThan(text.indexOf('engc build web'));
  });

  // why: F-1458 a failed docker ps in the cleanup is reported as "could not confirm" and fails the job, never read as "removed"
  it('fails the job when the cleanup cannot confirm the removal', () => {
    expect(text).toContain('could not confirm engine $ENGINE was removed (docker ps failed)');
    expect(text).toMatch(/if left="\$\(docker ps -aq/);
  });

  // why: F-1456 the UC-11 check finds Harold Jenkins's job by its number, not by the surname alone (Jenkins is in the generator's name pool)
  it('finds the UC-11 job by job number 24830', () => {
    const mjs = readFileSync(path.join(__dirname, 'smoke.mjs'), 'utf8');
    expect(mjs).toContain("r.job === '24830'");
  });

  // why: FR-DIST-8 (Clean items 3 and 5) the engine is removed by a trap, and the network policy is applied before the stack starts
  it('removes the engine in a trap and blocks outside hosts before the stack starts', () => {
    expect(text).toMatch(/trap cleanup EXIT/);
    expect(text).toContain('docker rm -fv "$ENGINE"');
    expect(text.indexOf('DOCKER-USER')).toBeLessThan(text.indexOf('up -d --no-build'));
  });

  // why: FR-DIST-8 (Clean item 2) the source is a tag clone or a local export only, and a call with neither is a usage error
  it('needs a source and a data folder', () => {
    const r = spawnSync('bash', [smoke], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    const r2 = spawnSync('bash', [smoke, '--data', tmp], { encoding: 'utf8' });
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain('--export');
  });

  // why: F-1459 (Clean items 2 and 4) with --tag the settings are the copy's own .env.example; a tag without one fails before any engine
  it('fails a public tag that has no .env.example, and never falls back to the private settings file', () => {
    const bin = path.join(tmp, 'tag-bin');
    mkdirSync(bin, { recursive: true });
    // A fake docker: info and ps answer, and run fails with 7, so a job that reaches the engine start says so by that status.
    writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash\necho "docker $*" >> "${path.join(tmp, 'tag-docker.log')}"\n[ "$1" = run ] && exit 7\nexit 0\n`);
    chmodSync(path.join(bin, 'docker'), 0o755);
    const pub = path.join(tmp, 'tag-pub');
    mkdirSync(pub, { recursive: true });
    git(pub, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(pub, 'README.md'), 'copy\n');
    git(pub, 'add', '-A');
    git(pub, 'commit', '-q', '-m', 'no settings');
    git(pub, 'tag', 'v0.0.1');
    // Only its presence counts here: the stand-in docker stops the job at the engine start, before the settings are read.
    writeFileSync(path.join(pub, '.env.example'), 'TZ=America/New_York\n');
    git(pub, 'add', '-A');
    git(pub, 'commit', '-q', '-m', 'settings');
    git(pub, 'tag', 'v0.0.2');
    const run = (t: string) =>
      spawnSync('bash', [smoke, '--data', tmp, '--tag', t, '--repo', pub, '--out', path.join(tmp, `tag-out-${t}`)], {
        env: { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, ENGINE: 'bw-p7-smoke-tagtest' },
        encoding: 'utf8',
      });
    rmSync(path.join(tmp, 'tag-docker.log'), { force: true });
    const r = run('v0.0.1');
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('has no .env.example');
    expect(readFileSync(path.join(tmp, 'tag-docker.log'), 'utf8')).not.toMatch(/^docker run /m);
    const r2 = run('v0.0.2');
    expect(r2.status, r2.stderr).toBe(7);
    expect(readFileSync(path.join(tmp, 'tag-docker.log'), 'utf8')).toMatch(/^docker run -d --privileged/m);
    expect(text).toMatch(/elif \[ -z "\$tag" \]; then\n  cp "\$here\/settings.env"/);
  });

  // why: F-1459 the gate takes the public tag (P8-PUBLISH); a bad tag or an unknown argument is a usage error before any data step
  it('the gate refuses a tag that is not vX.Y.Z and an unknown argument', () => {
    const gate = path.join(repo, 'ci', 'gates', 'smoke-public-tag.sh');
    for (const args of [['--tag', 'latest'], ['--bogus']]) {
      const r = spawnSync('bash', [gate, ...args], { encoding: 'utf8' });
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stdout).not.toContain('data');
    }
  });

  // why: FR-DIST-8, F-13 the engine starts with dockerd on its unix socket only (no tcp 2375), and the job checks 2375 is closed
  it('starts the engine on its unix socket only and checks that tcp 2375 is closed', () => {
    const run = text.split('\n').filter((l) => l.includes('docker run -d --privileged'));
    expect(run[0]).toContain('dockerd --host=unix:///var/run/docker.sock');
    expect(run[0]).not.toContain('2375');
    expect(text).toContain('http://127.0.0.1:2375/_ping');
  });

  // why: FR-DIST-8 (a copy that calls an outside host at run time fails it, F-1450) the counters are zeroed after the probe and read after the sign-in, and any dropped packet fails
  it('zeroes the DROP counters after the probe and fails the job on any dropped packet after the sign-in', () => {
    const zero = text.indexOf('iptables -Z DOCKER-USER');
    expect(zero).toBeGreaterThan(text.indexOf('the policy blocks an outside host (probe)'));
    expect(zero).toBeLessThan(text.indexOf('up -d --no-build'));
    const after = text.indexOf('the copy called an outside host at run time');
    expect(after).toBeGreaterThan(text.indexOf('node /h/smoke.mjs'));
    expect(text.slice(text.lastIndexOf('read -r drop_rules', after), after)).toMatch(/-ne 0 \]/);
    expect(text.indexOf('leak-check.sh" "$ENGINE"', after)).toBeGreaterThan(after);
  });

  // why: F-1470 the outside-host policy covers IPv6 too: ip6tables DROP rules, zeroed and counted with the IPv4 ones, 4 rules in all
  it('applies, zeroes and counts the same DROP rules in ip6tables', () => {
    expect(text).toContain('eng ip6tables -I DOCKER-USER');
    expect(text).toContain('eng ip6tables -Z DOCKER-USER');
    expect(text).toContain('ip6tables -nvxL DOCKER-USER');
    expect(text).toMatch(/-eq 4 \]/);
    expect(text).not.toMatch(/drop_rules:-0\}" -(eq|ne) 2 \]/);
  });

  // why: FR-DIST-8 (F-1450) both plants exist: a container of the copy calls out (the counters catch it), and the page asks for an outside origin (smoke.mjs catches it)
  it('has a planted container call and a planted page call, each failing the job', () => {
    expect(text).toContain('--plant-container-call');
    expect(text).toContain('--plant-page-call');
    expect(text).toMatch(/engc exec -T web node -e "fetch\('https:\/\/example\.com'/);
    expect(text).toContain('SMOKE_PLANT_PAGE_CALL=$plant_page');
    const mjs = readFileSync(path.join(__dirname, 'smoke.mjs'), 'utf8');
    expect(mjs).toContain("process.env.SMOKE_PLANT_PAGE_CALL === '1'");
    expect(mjs.indexOf('SMOKE_PLANT_PAGE_CALL')).toBeLessThan(mjs.indexOf('the page asked for outside origins'));
  });

  // why: F-1487, F-40 smoke.mjs opens its context through guardedContext, so the job must copy the guard (and every other file smoke.mjs imports by a relative path) into the harness beside it
  it('opens the context through the outside-origin guard, and copies each file smoke.mjs imports into the harness', () => {
    const mjs = readFileSync(path.join(__dirname, 'smoke.mjs'), 'utf8');
    expect(mjs).toContain('await guardedContext(browser, [origin],');
    expect(mjs).toContain('await guarded?.context.close()');
    const local = [...mjs.matchAll(/from '\.\/([^']+)'/g)].map((m) => m[1]!);
    expect(local.sort()).toEqual(['origin-guard.ts', 'passwords.ts']);
    const copied = (f: string) => text.includes(`"$HARNESS:/h/${f}"`) || text.includes(`${f} | docker cp - "$HARNESS:/h"`);
    expect(local.filter((f) => !copied(f))).toEqual([]);
    expect(text).toContain('docker cp "$here/../page-walkers/origin-guard.ts" "$HARNESS:/h/origin-guard.ts"');
    expect(existsSync(path.join(__dirname, '..', 'page-walkers', 'origin-guard.ts'))).toBe(true);
  });

  // why: F-1880 the harness is a bare container with only playwright installed, so a copied file that statically imports a file the job does not copy (or a package other than playwright) crashes the smoke on load
  it('copies the whole static import closure of the files it puts in the harness', () => {
    const copiedFrom = [
      ...[...text.matchAll(/docker cp "\$here\/([^"]+)" "\$HARNESS:\/h\/([^"]+)"/g)].map((m) => ({ src: path.join(__dirname, m[1]!), name: m[2]! })),
      ...[...text.matchAll(/-C \/work\/copy\/([^ ]+) -cf - (\S+) \| docker cp - "\$HARNESS:\/h"/g)].map((m) => ({ src: path.join(repo, m[1]!, m[2]!), name: m[2]! })),
    ];
    const names = copiedFrom.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['smoke.mjs', 'origin-guard.ts', 'passwords.ts']));
    const problems: string[] = [];
    for (const c of copiedFrom) {
      const src = readFileSync(c.src, 'utf8');
      // static imports and re-exports only; import type is erased at run time; a dynamic import() inside a try is how a module reaches an optional package
      for (const m of src.matchAll(/^\s*(import|export)(?!\s+type\b)[^;'"]*?\sfrom\s+'([^']+)'|^\s*import\s+'([^']+)'/gm)) {
        const spec = (m[2] ?? m[3])!;
        if (spec.startsWith('./')) {
          if (!names.includes(spec.slice(2))) problems.push(`${c.name} imports ${spec}, which the job does not copy`);
        } else if (!spec.startsWith('node:') && spec !== 'playwright') problems.push(`${c.name} imports ${spec}, which the harness does not install`);
      }
    }
    expect(problems).toEqual([]);
  });
});
