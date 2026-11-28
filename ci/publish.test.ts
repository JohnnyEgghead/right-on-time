// SPDX-License-Identifier: AGPL-3.0-or-later
// scripts/publish.sh release steps (P8-PUBLISH; FR-DIST-1, FR-DIST-3, SD-40): prepare, image, push and release against a local bare repo
// standing in for the public one, with stand-ins for the secret scan, the public files check, gh and docker (the real ones run in the
// P8-PUBLISH rehearsal: .build/evidence/P8-PUBLISH/). Nothing here reads the network.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carried, compareRelease, dropped, lsTree, PUBLIC_ONLY, releasesOf, rewriteManifest, sameTree, assetsOf } from '../scripts/publish-assets.ts';

const repo = path.resolve(import.meta.dirname, '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'bw-publish-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ID = ['-c', 'user.name=Private Dev', '-c', 'user.email=dev@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false'];
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', [...ID, ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (dir: string, rel: string, body: string | Buffer, mode = 0o644): void => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), body, { mode });
};
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

// The release data files, and the manifests that name them (in the private tree they name a private release).
const DATA = { 'maps/a.pmtiles': Buffer.from('tiles a\n'), 'maps/ohio.osrm.cells': Buffer.from('cells\n'), 'street-list.json': Buffer.from('{"streets":[]}\n') };
const asset = (rel: string, body: Buffer) => ({ id: path.basename(rel), repo: 'Owner/private', tag: 'old-v1', asset: path.basename(rel), bytes: body.length, sha256: sha(body) });
const MAPS = JSON.stringify({ _doc: 'maps', protomapsBuild: '1', assets: [asset('maps/a.pmtiles', DATA['maps/a.pmtiles']), { ...asset('maps/ohio.osrm.cells', DATA['maps/ohio.osrm.cells']), tag: 'old-v2' }] }, null, 2) + '\n';
const STREET = JSON.stringify({ _doc: 'street', assets: [asset('street-list.json', DATA['street-list.json'])] }, null, 2) + '\n';

let priv = '';
let bare = '';
let stand = '';
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: tmp,
  TMPDIR: path.join(tmp, 'tmpdir'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
  BW_PUBLISH_SCAN: path.join(stand, 'scan.sh'),
  BW_PUBLISH_FILES: path.join(stand, 'files.sh'),
  BW_GH: path.join(stand, 'gh.mjs'),
  BW_DOCKER: path.join(stand, 'docker.sh'),
  LOG: path.join(stand, 'calls.log'),
  GH_STATE: path.join(stand, 'gh-state.json'),
  ...extra,
});
const publish = (args: string[], extra: Record<string, string> = {}) =>
  spawnSync('bash', [path.join(priv, 'scripts', 'publish.sh'), ...args], { cwd: priv, env: env(extra), encoding: 'utf8', timeout: 120_000 });
const clone = () => path.join(tmp, 'clone');
const common = () => ['--clone', clone(), '--remote', bare, '--slug', 'Test/pub'];
// F-2055: prepare needs a verdict; this one is a green mode-gates verdict of the private repo's head, listing the 3 required gates.
const REQUIRED_GATES = ['schema-gates', 'unit-tests', 'G-CI7'];
const prepareArgs = (tag: string): string[] => {
  const f = path.join(tmp, 'verdict-prepare.json');
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: priv, encoding: 'utf8' }).stdout.trim();
  writeFileSync(f, JSON.stringify({ result: 'pass', mode: 'gates', scope: 'gates', sha, totalDurationS: 1, gates: REQUIRED_GATES.map((id) => ({ id, status: 'pass' })) }));
  return ['prepare', tag, ...common(), '--verdict', f];
};
const calls = (): string[] => (existsSync(path.join(stand, 'calls.log')) ? readFileSync(path.join(stand, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);
const clearCalls = () => rmSync(path.join(stand, 'calls.log'), { force: true });
const bareRef = (ref: string): string => spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: bare, encoding: 'utf8' }).stdout.trim();
const stateFile = (tag: string): string => path.join(clone(), '.git', 'bw-publish', `${tag}.env`);
const stateOf = (tag: string): string => (existsSync(stateFile(tag)) ? readFileSync(stateFile(tag), 'utf8') : '');
const localTag = (tag: string): string => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { cwd: clone(), encoding: 'utf8' }).stdout.trim();

beforeAll(() => {
  writeFileSync(path.join(tmp, 'gitconfig'), '');
  stand = path.join(tmp, 'stand-ins');
  mkdirSync(path.join(tmp, 'tmpdir'));
  mkdirSync(stand);
  put(stand, 'scan.sh', '#!/usr/bin/env bash\necho "scan $*" >> "$LOG"\n[ -z "${FAIL_SCAN:-}" ]\n', 0o755);
  // F-1620: the public files check stand-in fails when FAIL_FILES is set, as the real one fails on an ipv4 or private-refs hit.
  put(stand, 'files.sh', '#!/usr/bin/env bash\necho "files $*" >> "$LOG"\n[ -z "${FAIL_FILES:-}" ]\n', 0o755);
  // gh: the releases API listing, release create, upload and edit, on a JSON state file.
  put(stand, 'gh.mjs', `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const a = process.argv.slice(2);
appendFileSync(process.env.LOG, 'gh ' + a.join(' ') + '\\n');
const st = existsSync(process.env.GH_STATE) ? JSON.parse(readFileSync(process.env.GH_STATE, 'utf8')) : [];
const save = () => writeFileSync(process.env.GH_STATE, JSON.stringify(st));
const rel = (t) => st.find((r) => r.tag_name === t);
// The API's pages of 100 (newest last here): 1 page without --paginate, every page as an array of pages with --paginate --slurp.
if (a[0] === 'api') {
  const pages = []; for (let i = 0; i < Math.max(st.length, 1); i += 100) pages.push(st.slice(i, i + 100));
  process.stdout.write(JSON.stringify(a.includes('--paginate') && a.includes('--slurp') ? pages : pages[0])); process.exit(0);
}
if (a[0] === 'release' && a[1] === 'create') { st.push({ tag_name: a[2], draft: a.includes('--draft'), assets: [] }); save(); process.exit(0); }
if (a[0] === 'release' && a[1] === 'upload') {
  const r = rel(a[2]); const f = a[3]; const name = path.basename(f); const b = readFileSync(f);
  if (r.assets.some((x) => x.name === name) && !a.includes('--clobber')) process.exit(1);
  r.assets = r.assets.filter((x) => x.name !== name);
  r.assets.push({ name, size: statSync(f).size, state: 'uploaded', digest: 'sha256:' + createHash('sha256').update(b).digest('hex') });
  save(); process.exit(0);
}
if (a[0] === 'release' && a[1] === 'edit') { rel(a[2]).draft = !a.includes('--draft=false'); save(); process.exit(0); }
process.exit(9);
`, 0o755);
  // docker: buildx build (records the build args per image name and whether the context is the tag's tree), image inspect, and run
  // (app-info). A leading --context <name> is taken off (and logged). An image's id follows its PUBLIC_COMMIT, so a rebuild for another
  // commit is another id. FAKE_PC (another PUBLIC_COMMIT and label), FAKE_ID (another id) and FAKE_NO_IMAGE (no such image) make the
  // inspect answer as a stale, replaced or missing image would.
  put(stand, 'docker.sh', `#!/usr/bin/env bash
echo "docker $*" >> "$LOG"
st="$LOG.docker"
[ "$1" = --context ] && shift 2
img=; for a in "$@"; do case "$a" in bw-app:*) img="$a" ;; esac; done
case "$1" in
  buildx) for a in "$@"; do case "$a" in PUBLIC_COMMIT=*) echo "\${a#*=}" > "$st.$img.pc" ;; SOURCE_COMMIT=*) echo "\${a#*=}" > "$st.$img.sc" ;; esac; done
          ctx="\${@: -1}"; [ -f "$ctx/README.md" ] && [ ! -e "$ctx/docs/planning" ] && echo tag-tree > "$st.ctx"; exit 0 ;;
  image) [ -z "\${FAKE_NO_IMAGE:-}" ] && [ -f "$st.$img.pc" ] || { echo "Error: No such image: $img" >&2; exit 1; }
         pc="\${FAKE_PC:-$(cat "$st.$img.pc")}"
         case "$4" in *Architecture*) echo "\${FAKE_ARCH:-linux/amd64}" ;; *Env*) echo "PATH=/usr/bin"; echo "PUBLIC_COMMIT=$pc" ;; *Labels*) echo "\${FAKE_PC:-$(cat "$st.$img.sc")}" ;; *Id*) echo "\${FAKE_ID:-sha256:feed$(cat "$st.$img.pc" | cut -c1-12)}" ;; esac ;;
  run) repo=https://github.com/JohnnyEgghead/right-on-time
       for a in "$@"; do case "$a" in SOURCE_REPO_URL=*) repo="\${a#*=}"; repo="\${repo%/}" ;; esac; done
       c="\${FAKE_COMMIT:-$(cat "$st.$img.pc")}"; printf '{"status":200,"sourceUrl":"%s/commit/%s","sourceCommit":"%s","notices":true}\\n' "$repo" "$c" "$c" ;;
esac
`, 0o755);

  // The private repo: the publish tools, the manifests, a public file, an executable, and private files that must stay out.
  priv = path.join(tmp, 'private');
  mkdirSync(priv);
  git(priv, 'init', '-q', '-b', 'main');
  for (const f of ['scripts/publish.sh', 'scripts/publish-assets.ts', 'scripts/private-paths.txt', 'ci/is-main.ts', 'ci/wave-run.sh']) put(priv, f, readFileSync(path.join(repo, f)));
  put(priv, 'README.md', 'public\n');
  put(priv, 'bin/run.sh', '#!/bin/sh\necho run\n', 0o755);
  put(priv, 'packages/maps/MANIFEST.json', MAPS);
  put(priv, 'packages/db/src/data-manifest.json', STREET);
  put(priv, 'docs/planning/plan.md', 'private\n');
  put(priv, '.github/workflows/ci.yml', 'private\n');
  // A private file named by 1 plain line of the list (F-1622).
  put(priv, 'infra/owner.env', 'BW_STAND_IN=1\n');
  git(priv, 'add', '-A');
  git(priv, 'commit', '-q', '-m', 'private 1');

  // The public repo: 1 commit on main by its owner.
  bare = path.join(tmp, 'public.git');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = path.join(tmp, 'seed');
  git(tmp, 'clone', '-q', bare, seed);
  put(seed, 'LICENSE', 'license\n');
  // F-1682: the public-only file a release keeps, a file since deleted from the private repo, and a path since made private.
  put(seed, 'CONTRIBUTING.md', 'bug reports welcome\n');
  put(seed, 'old/removed.txt', 'deleted since\n');
  put(seed, 'docs/planning/old.md', 'made private since\n');
  spawnSync('git', ['-c', 'user.name=Pub Owner', '-c', 'user.email=owner@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '--allow-empty', '-m', 'Initial'], { cwd: seed });
  git(seed, 'add', '-A');
  spawnSync('git', ['-c', 'user.name=Pub Owner', '-c', 'user.email=owner@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'License'], { cwd: seed });
  git(seed, 'push', '-q', 'origin', 'main');

  const data = path.join(tmp, 'data');
  for (const [rel, body] of Object.entries(DATA)) put(data, rel, body);
});

describe('publish.sh prepare (P8-PUBLISH)', () => {
  // why: SD-40 FR-DIST-1 the public commit is the export (private paths out, manifests on the public release) on top of the public main, local only
  it('makes 1 local commit and tag whose tree is the export, and pushes nothing', () => {
    const r = publish(prepareArgs('v1.0.0'));
    expect(r.status, r.stderr).toBe(0);
    const c = clone();
    const commit = git(c, 'rev-parse', 'refs/tags/v1.0.0^{commit}');
    expect(git(c, 'rev-parse', `${commit}^`)).toBe(bareRef('refs/heads/main'));
    expect(git(c, 'cat-file', '-t', 'refs/tags/v1.0.0')).toBe('tag');
    const files = git(c, 'ls-tree', '-r', '--name-only', commit).split('\n');
    expect(files).toEqual(expect.arrayContaining(['README.md', 'bin/run.sh', 'packages/maps/MANIFEST.json', 'scripts/publish.sh']));
    expect(files.some((f) => f.startsWith('docs/planning/') || f.includes('.github/'))).toBe(false);
    // A public-only file (PUBLIC_ONLY) is kept, blob for blob: a release never deletes it.
    expect(git(c, 'rev-parse', `${commit}:CONTRIBUTING.md`)).toBe(git(c, 'rev-parse', `${commit}^:CONTRIBUTING.md`));
    expect(r.stdout).toContain('kept from the public main (files the export does not have): CONTRIBUTING.md\n');
    // F-1682: any other public main path the export lacks is dropped from the release, and named.
    for (const f of ['LICENSE', 'old/removed.txt', 'docs/planning/old.md']) expect(files, f).not.toContain(f);
    expect(r.stdout).toContain('dropped from the public main (not in the export, not a public-only file): LICENSE docs/planning/old.md old/removed.txt\n');
    expect(git(c, 'ls-tree', commit, 'bin/run.sh')).toMatch(/^100755 /);
    for (const m of ['packages/maps/MANIFEST.json', 'packages/db/src/data-manifest.json']) {
      const assets = (JSON.parse(git(c, 'show', `${commit}:${m}`)) as { assets: { repo: string; tag: string }[] }).assets;
      expect(assets.every((x) => x.repo === 'Test/pub' && x.tag === 'v1.0.0'), m).toBe(true);
    }
    expect(git(c, 'log', '-1', '--format=%an <%ae>|%cn', commit)).toBe('Pub Owner <owner@example.invalid>|Pub Owner');
    expect(git(c, 'log', '-1', '--format=%B', commit)).not.toMatch(/private|[0-9a-f]{40}/i);
    expect(bareRef('refs/tags/v1.0.0')).toBe('');
    expect(calls().filter((l) => l.startsWith('scan dir ')).length).toBe(1);
    expect(calls().some((l) => l.startsWith('files '))).toBe(true);
    // The scratch (export, checkout) is under TMPDIR, outside the repo, and gone when the run ends.
    expect(calls().find((l) => l.startsWith('scan dir '))).toContain(path.join(tmp, 'tmpdir', 'bw-publish-v1.0.0.'));
    expect(readdirSync(path.join(tmp, 'tmpdir'))).toEqual([]);
    expect(existsSync(path.join(priv, '.build', 'publish', 'work'))).toBe(false);
    expect(readFileSync(path.join(c, '.git/bw-publish/v1.0.0.env'), 'utf8')).toContain(`COMMIT=${commit}\n`);
  });

  // why: SD-40 a re-run of prepare with the same inputs makes the same commit, replacing only the unpushed local tag
  it('is repeatable: a second prepare gives the same commit', () => {
    const before = git(clone(), 'rev-parse', 'refs/tags/v1.0.0^{commit}');
    const r = publish(prepareArgs('v1.0.0'));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('replacing the unpushed local tag v1.0.0');
    expect(git(clone(), 'rev-parse', 'refs/tags/v1.0.0^{commit}')).toBe(before);
  });

  // why: NFR-14 a hit in the secret scan of the export stops prepare before any commit or tag
  it('stops on a failed secret scan, and refuses a tag that is not vX.Y.Z', () => {
    const r = publish(prepareArgs('v1.0.9'), { FAIL_SCAN: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the secret scan of the export');
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/tags/v1.0.9'], { cwd: clone() }).status).not.toBe(0);
    expect(publish(prepareArgs('1.0')).status).toBe(2);
    expect(publish(prepareArgs('v1.0.0-rc1')).status).toBe(2);
  });

  // why: F-1620 a failed public files check leaves nothing prepared: no new tag or state, and image, push and release refuse the tag
  it('leaves nothing prepared when the public files check fails', () => {
    const before = localTag('v1.0.0');
    const r = publish(prepareArgs('v1.0.0'), { FAIL_FILES: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the public files check of the candidate commit');
    expect(stateOf('v1.0.0')).toContain('PREPARED=0\n');
    expect(stateOf('v1.0.0')).not.toContain('PREPARED=1');
    for (const args of [['image', 'v1.0.0'], ['push', 'v1.0.0'], ['push', 'v1.0.0', '--granted'], ['release', 'v1.0.0', '--granted', '--data', path.join(tmp, 'data')]]) {
      const x = publish([...args, '--clone', clone()]);
      expect(x.status, args.join(' ')).toBe(1);
      expect(x.stderr).toContain('the release v1.0.0 is not prepared');
    }
    expect(git(clone(), 'for-each-ref', 'refs/bw-publish/')).toBe('');
    expect(localTag('v1.0.0')).toBe(before);
    // A tag never prepared gets no tag and no state at all.
    const fresh = publish(prepareArgs('v1.0.7'), { FAIL_FILES: '1' });
    expect(fresh.status).toBe(1);
    expect(localTag('v1.0.7')).toBe('');
    expect(existsSync(stateFile('v1.0.7'))).toBe(false);
    expect(readdirSync(path.join(tmp, 'tmpdir'))).toEqual([]);
    // A passing prepare makes it prepared again, with the same commit.
    expect(publish(prepareArgs('v1.0.0')).status).toBe(0);
    expect(stateOf('v1.0.0')).toContain('PREPARED=1\n');
    expect(localTag('v1.0.0')).toBe(before);
  });

  // why: F-1622 the private list is the exported ref's own: an edit of the working tree's list, not committed, lets no private path out
  it('reads the private paths list from the ref, not from the working tree', () => {
    const p = path.join(priv, 'scripts', 'private-paths.txt');
    const body = readFileSync(p, 'utf8');
    expect(body.split('\n')).toContain('infra/owner.env');
    writeFileSync(p, body.split('\n').filter((l) => l !== 'infra/owner.env').join('\n'));
    try {
      const out = path.join(tmp, 'dry-f1622');
      const r = publish(['--dry-run', '--ref', 'HEAD', '--out', out, '--list', `${out}.list`]);
      expect(r.status, r.stderr).toBe(0);
      const listed = readFileSync(`${out}.list`, 'utf8').split('\n');
      expect(listed).toContain('README.md');
      expect(listed).not.toContain('infra/owner.env');
      expect(existsSync(path.join(out, 'infra', 'owner.env'))).toBe(false);
    } finally {
      writeFileSync(p, body);
    }
    expect(git(priv, 'status', '--porcelain')).toBe('');
  });
});

describe('publish.sh prepare --verdict (K-07, P10-CHECKS)', () => {
  const head = () => git(priv, 'rev-parse', 'HEAD');
  const verdictFile = (name: string, over: Record<string, unknown> = {}, gates = REQUIRED_GATES.map((id) => ({ id, status: 'pass' }))): string => {
    const f = path.join(tmp, `verdict-${name}.json`);
    writeFileSync(f, JSON.stringify({ result: 'pass', mode: 'gates', scope: 'gates', sha: head(), totalDurationS: 1, gates, ...over }));
    return f;
  };
  const verdictClone = () => path.join(tmp, 'clone-verdict');
  const prep = (file: string) => publish(['prepare', 'v1.0.7', '--clone', verdictClone(), '--remote', bare, '--slug', 'Test/pub', '--verdict', file]);
  const refused = (r: ReturnType<typeof publish>) => {
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('does not clear');
    // a refused prepare makes no export, no scan and no files check
    expect(calls().some((l) => l.startsWith('scan ') || l.startsWith('files '))).toBe(false);
    expect(existsSync(path.join(verdictClone(), '.git', 'bw-publish', 'v1.0.7.env')) ? readFileSync(path.join(verdictClone(), '.git', 'bw-publish', 'v1.0.7.env'), 'utf8') : '').not.toContain('PREPARED=1');
  };

  // why: K-07 F-2013 a verdict of another commit says nothing about this one, so prepare refuses it before it exports
  it('refuses a verdict for another sha', () => {
    clearCalls();
    const r = prep(verdictFile('other', { sha: 'f'.repeat(40) }));
    refused(r);
    expect(r.stderr).toContain('is not the requested sha');
  });

  // why: K-07 F-2013 a verdict whose schema-gates is red (or that does not list it) is no clearance for a release
  it('refuses a verdict whose schema-gates is red, or that lacks unit-tests', () => {
    clearCalls();
    const red = prep(verdictFile('red', {}, [{ id: 'schema-gates', status: 'fail' }, { id: 'unit-tests', status: 'pass' }, { id: 'G-CI7', status: 'pass' }]));
    refused(red);
    expect(red.stderr).toContain('does not list schema-gates as pass');
    const missing = prep(verdictFile('missing', {}, [{ id: 'schema-gates', status: 'pass' }, { id: 'G-CI7', status: 'pass' }]));
    refused(missing);
    expect(missing.stderr).toContain('does not list unit-tests as pass');
    const failed = prep(verdictFile('failed', { result: 'fail' }));
    refused(failed);
    expect(failed.stderr).toContain('verdict result is fail');
    const absent = prep(path.join(tmp, 'no-such-verdict.json'));
    refused(absent);
    expect(absent.stderr).toContain('is missing');
  });

  // why: F-2055 G-CI7 runs 4 of the 5 K-07 db suites, so a verdict with G-CI7 red (or absent) is no clearance for a release
  it('refuses a verdict whose G-CI7 is red or absent', () => {
    clearCalls();
    const red = prep(verdictFile('gci7-red', {}, [{ id: 'schema-gates', status: 'pass' }, { id: 'unit-tests', status: 'pass' }, { id: 'G-CI7', status: 'fail' }]));
    refused(red);
    expect(red.stderr).toContain('does not list G-CI7 as pass');
    const absent = prep(verdictFile('gci7-absent', {}, [{ id: 'schema-gates', status: 'pass' }, { id: 'unit-tests', status: 'pass' }]));
    refused(absent);
    expect(absent.stderr).toContain('does not list G-CI7 as pass');
  });

  // why: F-2055 a prepare with no --verdict is no clearance either; it refuses before it exports
  it('refuses a prepare with no --verdict', () => {
    clearCalls();
    const r = publish(['prepare', 'v1.0.7', '--clone', verdictClone(), '--remote', bare, '--slug', 'Test/pub']);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('prepare needs --verdict');
    expect(calls().some((l) => l.startsWith('scan ') || l.startsWith('files '))).toBe(false);
  });

  // why: K-07 F-2013 the head's own verdict, with schema-gates, unit-tests and G-CI7 green, lets prepare run as before
  it('prepares with the head\'s verdict', () => {
    clearCalls();
    const r = prep(verdictFile('head'));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('verdict: result pass, sha');
    expect(readFileSync(path.join(verdictClone(), '.git', 'bw-publish', 'v1.0.7.env'), 'utf8')).toContain('PREPARED=1\n');
  });
});

describe('publish.sh image (P8-PUBLISH)', () => {
  // why: FR-DIST-3 the release image is built from the tag's tree for linux/amd64 with the public commit, and checked through app-info
  it('builds from the tag tree for linux/amd64 with PUBLIC_COMMIT, and checks the Source link', () => {
    clearCalls();
    const commit = git(clone(), 'rev-parse', 'refs/tags/v1.0.0^{commit}');
    const r = publish(['image', 'v1.0.0', '--clone', clone()]);
    expect(r.status, r.stderr).toBe(0);
    const build = calls().find((l) => l.includes(' buildx build '))!;
    expect(build).toContain('--platform linux/amd64');
    expect(build).toContain(`PUBLIC_COMMIT=${commit}`);
    expect(build).toContain('--target release');
    expect(readFileSync(path.join(stand, 'calls.log.docker.ctx'), 'utf8')).toContain('tag-tree');
    expect(r.stdout).toContain(`Source link https://github.com/JohnnyEgghead/right-on-time/commit/${commit}`);
    expect(r.stdout).toContain(`Source link https://example.org/own/copy/commit/${commit}`);
    expect(calls().some((l) => / push /.test(l))).toBe(false);
  });
  // why: F-1624 the release image is built on the Docker engine of context spectre (SD-40 step 3) unless another is named, and the
  // engine is recorded with the image so push and release check the image where it was built
  it('builds on the Docker context spectre by default and records the engine with the image', () => {
    expect(calls().filter((l) => l.startsWith('docker ')).every((l) => l.startsWith('docker --context spectre '))).toBe(true);
    expect(calls().find((l) => l.includes(' buildx build '))).toMatch(/^docker --context spectre buildx build /);
    expect(stateOf('v1.0.0')).toContain('IMAGE_CONTEXT=spectre\n');
    clearCalls();
    const other = publish(['image', 'v1.0.0', '--clone', clone(), '--docker-context', 'desktop-linux']);
    expect(other.status, other.stderr).toBe(0);
    expect(calls().find((l) => l.includes(' buildx build '))).toMatch(/^docker --context desktop-linux buildx build /);
    expect(stateOf('v1.0.0')).toContain('IMAGE_CONTEXT=desktop-linux\n');
    clearCalls();
    expect(publish(['push', 'v1.0.0', '--clone', clone()]).status).toBe(3);
    expect(calls().length).toBeGreaterThan(0);
    expect(calls().every((l) => l.startsWith('docker --context desktop-linux image inspect '))).toBe(true);
    expect(publish(['image', 'v1.0.0', '--clone', clone()]).status).toBe(0);
    expect(stateOf('v1.0.0')).toContain('IMAGE_CONTEXT=spectre\n');
  });
  // why: FR-DIST-3 an image of another platform, or one whose app-info names another commit, fails the step
  it('fails on another platform or another commit in the Source link', () => {
    expect(publish(['image', 'v1.0.0', '--clone', clone()], { FAKE_ARCH: 'linux/arm64' }).stderr).toContain('not linux/amd64');
    const r = publish(['image', 'v1.0.0', '--clone', clone()], { FAKE_COMMIT: 'abcdef1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('app-info in the image gave');
    // F-1618: a failed image run leaves no checked image, so push refuses until a run passes.
    expect(stateOf('v1.0.0')).not.toContain('IMAGE_ID=');
    const p = publish(['push', 'v1.0.0', '--clone', clone()]);
    expect(p.status).toBe(1);
    expect(p.stderr).toContain('no release image is checked for the prepared commit');
    expect(publish(['image', 'v1.0.0', '--clone', clone()]).status).toBe(0);
  });
});

describe('publish.sh push and release (P8-PUBLISH, owner grant)', () => {
  // why: SD-40 the public writes run only with the owner's grant: without --granted they print the plan, exit 3 and touch nothing
  it('prints the plan and exits 3 without --granted', () => {
    clearCalls();
    const p = publish(['push', 'v1.0.0', '--clone', clone()]);
    expect(p.status).toBe(3);
    expect(p.stdout).toContain('push --atomic origin');
    const rel = publish(['release', 'v1.0.0', '--clone', clone(), '--data', path.join(tmp, 'data')]);
    expect(rel.status).toBe(3);
    expect(bareRef('refs/tags/v1.0.0')).toBe('');
    // Only the reads of the image check (F-1618) ran: no scan, no git push, no gh.
    expect(calls().length).toBeGreaterThan(0);
    expect(calls().every((l) => l.startsWith('docker --context spectre image inspect '))).toBe(true);
  });

  // why: F-1618 push and release refuse an image that is not the one checked for the prepared commit (stale, replaced or missing),
  // before any public write, granted or not
  it('refuses a stale, replaced or missing release image', () => {
    clearCalls();
    const cases: [Record<string, string>, string][] = [
      [{ FAKE_PC: 'f'.repeat(40) }, '(a stale image)'],
      [{ FAKE_ID: 'sha256:another' }, 'is now another image'],
      [{ FAKE_NO_IMAGE: '1' }, 'is not in the Docker engine of context spectre'],
    ];
    for (const [extra, why] of cases) {
      for (const args of [['push', 'v1.0.0'], ['push', 'v1.0.0', '--granted'], ['release', 'v1.0.0', '--granted', '--data', path.join(tmp, 'data')]]) {
        const r = publish([...args, '--clone', clone()], extra);
        expect(r.status, `${args.join(' ')} ${JSON.stringify(extra)}`).toBe(1);
        expect(r.stderr).toContain(why);
      }
    }
    expect(bareRef('refs/tags/v1.0.0')).toBe('');
    expect(calls().some((l) => !l.startsWith('docker --context spectre image inspect '))).toBe(false);
  });

  // why: F-1618 a prepare that makes another commit for the tag drops the image checked for the old one; the same commit keeps it
  it('drops the checked image when a prepare makes another commit for the tag', () => {
    expect(publish(prepareArgs('v1.0.5')).status).toBe(0);
    expect(publish(['image', 'v1.0.5', '--clone', clone()]).status).toBe(0);
    expect(publish(prepareArgs('v1.0.5')).status).toBe(0);
    expect(publish(['push', 'v1.0.5', '--clone', clone()]).status).toBe(3);
    put(priv, 'README.md', 'public, for v1.0.5\n');
    git(priv, 'commit', '-q', '-am', 'private for v1.0.5');
    try {
      expect(publish(prepareArgs('v1.0.5')).status).toBe(0);
      expect(stateOf('v1.0.5')).not.toContain('IMAGE_ID=');
      const r = publish(['push', 'v1.0.5', '--granted', '--clone', clone()]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('no release image is checked for the prepared commit');
      expect(bareRef('refs/tags/v1.0.5')).toBe('');
    } finally {
      git(priv, 'reset', '-q', '--hard', 'HEAD~1');
    }
  });

  // why: SD-40 push sends the commit to main and the tag in 1 atomic push after a re-scan, and a re-run is a no-op
  it('pushes main and the tag atomically, then reports a re-run as done', () => {
    clearCalls();
    const commit = git(clone(), 'rev-parse', 'refs/tags/v1.0.0^{commit}');
    const r = publish(['push', 'v1.0.0', '--granted', '--clone', clone()]);
    expect(r.status, r.stderr).toBe(0);
    expect(calls().filter((l) => l.startsWith('scan dir ')).length).toBe(1);
    expect(bareRef('refs/heads/main')).toBe(commit);
    expect(bareRef('refs/tags/v1.0.0^{commit}')).toBe(commit);
    const again = publish(['push', 'v1.0.0', '--granted', '--clone', clone()]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('already public');
  });

  // why: SD-40 a public tag is never moved: prepare of a public tag with the same tree is a no-op, with another tree a refusal
  it('never moves a public tag', () => {
    const same = publish(prepareArgs('v1.0.0'));
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout).toContain('already public with this same tree');
    put(priv, 'README.md', 'public, changed\n');
    git(priv, 'commit', '-q', '-am', 'private 2');
    const moved = publish(prepareArgs('v1.0.0'));
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain('a public tag is never moved');
  });

  // why: SD-40 push refuses when the public main moved after prepare (the commit's parent is no longer the public main)
  it('refuses to push when the public main moved', () => {
    const prep = publish(prepareArgs('v1.1.0'));
    expect(prep.status, prep.stderr).toBe(0);
    const other = path.join(tmp, 'other');
    git(tmp, 'clone', '-q', bare, other);
    put(other, 'NOTE.md', 'x\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'moved');
    git(other, 'push', '-q', 'origin', 'main');
    const noImage = publish(['push', 'v1.1.0', '--granted', '--clone', clone()]);
    expect(noImage.status).toBe(1);
    expect(noImage.stderr).toContain('no release image is checked');
    expect(publish(['image', 'v1.1.0', '--clone', clone()]).status).toBe(0);
    const r = publish(['push', 'v1.1.0', '--granted', '--clone', clone()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('run prepare v1.1.0 again');
    expect(bareRef('refs/tags/v1.1.0')).toBe('');
  });

  // why: FR-DIST-1 the release is made only from data that matches the tag's manifests: a wrong file stops it before any gh call
  it('checks every data file before it calls gh', () => {
    clearCalls();
    const bad = path.join(tmp, 'data-bad');
    for (const [rel, body] of Object.entries(DATA)) put(bad, rel, rel === 'maps/a.pmtiles' ? Buffer.from('tiles X\n') : body);
    const r = publish(['release', 'v1.0.0', '--granted', '--clone', clone(), '--data', bad]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('a.pmtiles: SHA-256');
    expect(calls().some((l) => l.startsWith('gh '))).toBe(false);
  });

  // why: FR-DIST-1 the release is a draft until every asset is uploaded and matches size and digest, then published; a re-run is a no-op
  it('creates a draft, uploads every asset, publishes it, and is done on a re-run', () => {
    clearCalls();
    const r = publish(['release', 'v1.0.0', '--granted', '--clone', clone(), '--data', path.join(tmp, 'data')]);
    expect(r.status, r.stderr).toBe(0);
    const gh = calls().filter((l) => l.startsWith('gh release'));
    expect(gh[0]).toMatch(/^gh release create v1\.0\.0 --repo Test\/pub --verify-tag --draft /);
    expect(gh.filter((l) => l.startsWith('gh release upload')).length).toBe(3);
    expect(gh.at(-1)).toBe('gh release edit v1.0.0 --repo Test/pub --draft=false');
    const st = JSON.parse(readFileSync(path.join(stand, 'gh-state.json'), 'utf8')) as { draft: boolean; assets: unknown[] }[];
    expect(st[0]!.draft).toBe(false);
    expect(st[0]!.assets).toHaveLength(3);
    clearCalls();
    const again = publish(['release', 'v1.0.0', '--granted', '--clone', clone(), '--data', path.join(tmp, 'data')]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('already published');
    expect(calls().some((l) => l.startsWith('gh release'))).toBe(false);
  });

  // why: F-1683 the release is found on any page of the releases listing: with 100 others before it, a re-run is still a no-op
  it('reads every page of the releases listing', () => {
    const f = path.join(stand, 'gh-state.json');
    const before = readFileSync(f, 'utf8');
    const older = Array.from({ length: 100 }, (_, i) => ({ tag_name: `v0.0.${i}`, draft: false, assets: [] }));
    writeFileSync(f, JSON.stringify([...older, ...(JSON.parse(before) as unknown[])]));
    clearCalls();
    const r = publish(['release', 'v1.0.0', '--granted', '--clone', clone(), '--data', path.join(tmp, 'data')]);
    writeFileSync(f, before);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('already published');
    expect(calls().some((l) => l.startsWith('gh api --paginate --slurp repos/Test/pub/releases'))).toBe(true);
    expect(calls().some((l) => l.startsWith('gh release'))).toBe(false);
  });

  // why: FR-DIST-1 a published release whose assets differ is refused, never changed by the script
  it('refuses to change a published release', () => {
    const f = path.join(stand, 'gh-state.json');
    const st = JSON.parse(readFileSync(f, 'utf8')) as { assets: { digest: string }[] }[];
    st[0]!.assets[0]!.digest = 'sha256:0000';
    writeFileSync(f, JSON.stringify(st));
    clearCalls();
    const r = publish(['release', 'v1.0.0', '--granted', '--clone', clone(), '--data', path.join(tmp, 'data')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('never changes a published release');
    expect(calls().some((l) => l.startsWith('gh release upload'))).toBe(false);
  });
});

describe('publish.sh docs (P8-APPSTORE: PRIVACY.md and SUPPORT.md between releases)', () => {
  const docsClone = () => path.join(tmp, 'docs-clone');
  const docsArgs = (...more: string[]) => ['docs', '--clone', docsClone(), '--remote', bare, '--slug', 'Test/pub', ...more];
  const tagsBefore = (): string => spawnSync('git', ['tag', '-l'], { cwd: bare, encoding: 'utf8' }).stdout;
  // why: P8-APPSTORE the 2 listing pages go to the public main alone, as 1 commit, with a dry run, an owner grant and no force
  it('dry run and no grant push nothing; the grant pushes 1 commit that changes only the 2 files, no tag', () => {
    put(priv, 'PRIVACY.md', '# Privacy\n');
    put(priv, 'SUPPORT.md', '# Support\n');
    git(priv, 'add', 'PRIVACY.md', 'SUPPORT.md');
    git(priv, 'commit', '-q', '-m', 'listing pages');
    const main0 = bareRef('refs/heads/main');
    const tags0 = tagsBefore();

    const dry = publish(docsArgs('--dry-run'));
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('changes: PRIVACY.md SUPPORT.md');
    expect(dry.stdout).toContain('nothing was pushed');
    expect(bareRef('refs/heads/main')).toBe(main0);

    const plan = publish(docsArgs());
    expect(plan.status).toBe(3);
    expect(plan.stdout).toContain('only with --granted');
    expect(bareRef('refs/heads/main')).toBe(main0);

    const bad = publish(docsArgs('--granted'), { FAIL_SCAN: '1' });
    expect(bad.status).toBe(1);
    expect(bareRef('refs/heads/main')).toBe(main0);

    // F-1714: the content checks (the files check stand-in) run on the 2 files and a failure there stops the push
    const badFiles = publish(docsArgs('--granted'), { FAIL_FILES: '1' });
    expect(badFiles.status).toBe(1);
    expect(badFiles.stderr).toContain('the public files check of the 2 files');
    expect(bareRef('refs/heads/main')).toBe(main0);

    const go = publish(docsArgs('--granted'));
    expect(go.status, go.stderr).toBe(0);
    const main1 = bareRef('refs/heads/main');
    // F-1714: the public message does not name the private commit id
    expect(git(bare, 'log', '-1', '--format=%B', main1)).not.toContain(git(priv, 'rev-parse', 'HEAD'));
    expect(main1).not.toBe(main0);
    expect(git(bare, 'rev-parse', `${main1}^`)).toBe(main0);
    expect(git(bare, 'diff-tree', '-r', '--no-commit-id', '--name-only', main0, main1).split('\n').sort()).toEqual(['PRIVACY.md', 'SUPPORT.md']);
    expect(git(bare, 'show', `${main1}:PRIVACY.md`)).toBe('# Privacy');
    expect(tagsBefore()).toBe(tags0);

    const again = publish(docsArgs('--granted'));
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('nothing to push');
    expect(bareRef('refs/heads/main')).toBe(main1);
  });

  // why: P8-APPSTORE a file the export does not carry is refused before any push
  it('refuses a file that is not committed at the ref', () => {
    const r = publish(docsArgs('--granted', '--ref', 'HEAD~1'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not in the export');
  });
});

describe('publish-assets helpers (P8-PUBLISH)', () => {
  const assets = assetsOf(MAPS, STREET);
  // why: F-364(b) the manifests are rewritten to the public release for every asset and keep their committed layout
  it('rewrites repo and tag only, in the committed layout', () => {
    const out = rewriteManifest(MAPS, 'Test/pub', 'v2.0.0');
    expect(out.endsWith('}\n')).toBe(true);
    expect(out.replaceAll('Test/pub', 'Owner/private').replace('"tag": "v2.0.0"', '"tag": "old-v1"').replace('"tag": "v2.0.0"', '"tag": "old-v2"')).toBe(MAPS);
    expect(assets.map((a) => a.rel)).toEqual(['maps/a.pmtiles', 'maps/ohio.osrm.cells', 'street-list.json']);
  });
  // why: FR-DIST-1 an asset counts only when uploaded with the manifest's size and digest, and an extra file is named
  it('compares a release listing with the manifests', () => {
    const ok = assets.map((a) => ({ name: a.asset, size: a.bytes, state: 'uploaded', digest: `sha256:${a.sha256}` }));
    expect(compareRelease(assets, [{ tag_name: 'v1.0.0', draft: false, assets: ok }], 'v1.0.0').ok).toBe(true);
    expect(compareRelease(assets, [], 'v1.0.0').release).toBe('none');
    // F-1683: the listing is read over every page: a release on page 2 of gh api --paginate --slurp is found, a single page still reads.
    const older = Array.from({ length: 100 }, (_, i) => ({ tag_name: `v0.0.${i}`, draft: false, assets: [] }));
    expect(compareRelease(assets, releasesOf(JSON.stringify([older, [{ tag_name: 'v1.0.0', draft: false, assets: ok }]])), 'v1.0.0').ok).toBe(true);
    expect(compareRelease(assets, releasesOf(JSON.stringify(older)), 'v1.0.0').release).toBe('none');
    expect(() => releasesOf('{}')).toThrow(/not a JSON array/);
    const c = compareRelease(assets, [{ tag_name: 'v1.0.0', draft: true, assets: [{ ...ok[0]!, state: 'starter' }, ok[1]!, ok[2]!, { ...ok[0]!, name: 'x.bin' }] }], 'v1.0.0');
    expect([c.ok, c.release, c.differs, c.extra]).toEqual([false, 'draft', ['a.pmtiles'], ['x.bin']]);
    expect(compareRelease(assets, [{ tag_name: 'v1.0.0', draft: false, assets: ok.map((x) => ({ ...x, digest: null })) }], 'v1.0.0').ok).toBe(false);
  });
  // why: SD-40 the public tree must be the private tree blob for blob (mode too) apart from the 2 manifests
  it('finds a changed blob, a changed mode, a missing path and an extra one', () => {
    const z = (rows: [string, string, string][]) => rows.map(([m, s, p]) => `${m} blob ${s}\t${p}`).join('\0') + '\0';
    const p = lsTree(z([['100644', 'a1', 'README.md'], ['100755', 'b1', 'bin/run.sh'], ['100644', 'm1', 'packages/maps/MANIFEST.json']]));
    const list = ['README.md', 'bin/run.sh', 'packages/maps/MANIFEST.json'];
    expect(sameTree(p, lsTree(z([['100644', 'a1', 'README.md'], ['100755', 'b1', 'bin/run.sh'], ['100644', 'm2', 'packages/maps/MANIFEST.json']])), list)).toEqual([]);
    const bad = sameTree(p, lsTree(z([['100644', 'a2', 'README.md'], ['100644', 'b1', 'bin/run.sh'], ['100644', 'x', 'extra.md']])), list);
    expect(bad.join('\n')).toMatch(/lacks packages\/maps\/MANIFEST.json[\s\S]*holds extra.md[\s\S]*README.md is 100644 a2[\s\S]*bin\/run.sh is 100644 b1/);
  });

  // why: SD-40 a file only the public main has (its CONTRIBUTING.md) stays in the release commit as the public main's own entry
  it('carries the public-only files and checks they are unchanged', () => {
    const z = (rows: [string, string, string][]) => rows.map(([m, s, p]) => `${m} blob ${s}\t${p}`).join('\0') + '\0';
    const list = ['README.md'];
    const p = lsTree(z([['100644', 'a1', 'README.md']]));
    const base = lsTree(z([['100644', 'r0', 'README.md'], ['100644', 'c1', 'CONTRIBUTING.md']]));
    const carry = carried(base, list);
    expect([...carry]).toEqual([['CONTRIBUTING.md', '100644 c1']]);
    expect(sameTree(p, lsTree(z([['100644', 'a1', 'README.md'], ['100644', 'c1', 'CONTRIBUTING.md']])), list, carry)).toEqual([]);
    expect(sameTree(p, lsTree(z([['100644', 'a1', 'README.md'], ['100644', 'c2', 'CONTRIBUTING.md']])), list, carry).join('\n')).toMatch(/CONTRIBUTING.md is 100644 c2 in the public tree, 100644 c1 on the public main/);
    expect(sameTree(p, lsTree(z([['100644', 'a1', 'README.md']])), list, carry).join('\n')).toMatch(/CONTRIBUTING.md is absent/);
  });

  // why: F-1639 F-1694 F-1823 a git archive piped into tar exits 141 (SIGPIPE) under load; the export is a file, then extracted
  it('never pipes git archive into tar', () => {
    for (const f of ['scripts/publish.sh', 'apps/tech-native/xcuitest/run.sh']) {
      const src = readFileSync(path.join(import.meta.dirname, '..', f), 'utf8');
      const code = src.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
      expect(code, f).not.toMatch(/archive[^\n]*\|\s*tar\b/);
      expect(code, f).toMatch(/archive[^\n]* -o /);
    }
  });

  // why: F-1682 only the named public-only files are carried: a file deleted, renamed or made private since leaves the next release
  it('carries only PUBLIC_ONLY, and names every other public main path the export lacks as dropped', () => {
    const z = (rows: [string, string, string][]) => rows.map(([m, s, p]) => `${m} blob ${s}\t${p}`).join('\0') + '\0';
    expect(PUBLIC_ONLY).toEqual(['CONTRIBUTING.md']);
    const base = lsTree(z([['100644', 'r0', 'README.md'], ['100644', 'c1', 'CONTRIBUTING.md'], ['100644', 'g1', 'gone.md'], ['100644', 'o1', 'infra/owner.env']]));
    expect([...carried(base, ['README.md'])]).toEqual([['CONTRIBUTING.md', '100644 c1']]);
    expect(dropped(base, ['README.md'])).toEqual(['gone.md', 'infra/owner.env']);
    // An exported CONTRIBUTING.md is the export's own, never carried, and nothing is dropped when the export holds every path.
    expect([...carried(base, ['README.md', 'CONTRIBUTING.md', 'gone.md', 'infra/owner.env'])]).toEqual([]);
    expect(dropped(base, ['README.md', 'CONTRIBUTING.md', 'gone.md', 'infra/owner.env'])).toEqual([]);
    // The public tree may not keep a dropped path: same-tree names it.
    const p = lsTree(z([['100644', 'a1', 'README.md']]));
    const pub = lsTree(z([['100644', 'a1', 'README.md'], ['100644', 'c1', 'CONTRIBUTING.md'], ['100644', 'g1', 'gone.md']]));
    expect(sameTree(p, pub, ['README.md'], carried(base, ['README.md'])).join('\n')).toMatch(/the public tree holds gone.md, which the export does not/);
  });
});
