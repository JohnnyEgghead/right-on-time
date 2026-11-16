// SPDX-License-Identifier: AGPL-3.0-or-later
// infra/deploy/deploy.sh run end to end in a temporary git repo, every remote tool a stub on PATH (ssh, scp, curl, docker; node only
// for "ci/data-assets.ts", whose own tests cover the fetch): no server, no AWS, no network. The ssh target is a TEST-NET address
// (192.0.2.1) so a stub that failed to load would reach nothing. What the deploy stages is captured by the scp stub.
// F-364 (a): the map files and their list are staged. F-1611: --release deploys the published image and builds nothing.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const work = mkdtempSync(path.join(tmpdir(), 'bw-deploy-rig-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const MAPS: Record<string, string> = { 'columbus.pmtiles': 'tiles-columbus', 'ohio.osrm.hsgr': 'routing-hsgr' };
const PUBLIC = 'a'.repeat(40);
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;

const STUBS: Record<string, string> = {
  // ssh -i K -o A -o B -o C HOST CMD...
  ssh: `#!/usr/bin/env bash
while [ "$1" = -i ] || [ "$1" = -o ]; do shift 2; done
shift
cmd="$*"
printf '%s\\n' "$cmd" >> "$RIG/calls/ssh"
case "$cmd" in
  "uname -m") echo x86_64 ;;
  *.verified.sha256*) cat "$RIG/held" 2>/dev/null; exit 0 ;;
  *Config.Env*) [ -f "$RIG/server-env" ] || exit 1; cat "$RIG/server-env" ;;
  *"s/^BW_IMAGE="*) cat "$RIG/live-image" 2>/dev/null; exit 0 ;;
  *"s/^ROUTES="*) cat "$RIG/live-routes" 2>/dev/null; exit 0 ;;
  *"df -Pk"*) echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'; echo "/dev/root 41000000 1000 $(cat "$RIG/free-kib" 2>/dev/null || echo 40000000) 1% /" ;;
  *"tar -x"*) cat > "$RIG/incoming.tar"; [ ! -f "$RIG/tar-fail" ] || exit 1 ;;
  *server-deploy.sh*) exit "$(cat "$RIG/server-rc" 2>/dev/null || echo 0)" ;;
  *"docker image inspect"*) exit 1 ;;
  *"docker load"*) cat > /dev/null; [ ! -f "$RIG/load-env" ] || cp "$RIG/load-env" "$RIG/server-env"; echo "Loaded image" ;;
  *) exit 0 ;;
esac
`,
  scp: `#!/usr/bin/env bash
src=""; for a in "$@"; do case "$a" in -*|*:*) ;; *) [ -d "$a" ] && src="$a" ;; esac; done
echo "scp $src" >> "$RIG/calls/scp"
rm -rf "$RIG/captured"; cp -R "$src" "$RIG/captured"
`,
  curl: `#!/usr/bin/env bash
url="\${!#}"
case " $* " in *" -D "*) printf 'HTTP/2 200\\r\\nstrict-transport-security: max-age=31536000\\r\\n\\r\\n'; exit 0 ;; esac
case " $* " in *" -w "*) case "$url" in */healthz) echo 200 ;; *) cat "$RIG/code" 2>/dev/null || echo 200 ;; esac; exit 0 ;; esac
case "$url" in */healthz) echo ok ;; *) if [ -f "$RIG/open" ]; then echo '<!doctype html><title>Right On Time</title>'; else cat "$RIG/repo/infra/placeholder/index.html"; fi ;; esac
`,
  docker: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RIG/calls/docker"
ctx=""; if [ "$1" = --context ]; then ctx="$2"; shift 2; fi
case "$1 $2" in
  "image inspect")
    f="$4"
    case "$f" in
      *.Id*) cat "$RIG/ctx-id" ;;
      *Config.Env*) printf 'NODE_ENV=production\\nPUBLIC_COMMIT=%s\\n' "$(cat "$RIG/ctx-public")" ;;
      *Labels*) cat "$RIG/ctx-public"; echo ;;
      *.Os*) echo linux/amd64 ;;
    esac ;;
  "save "*|"save") echo image-bytes ;;
  *) exit 0 ;;
esac
`,
};

let n = 0;
interface Rig {
  dir: string; repo: string; run: (args: string[]) => { status: number; out: string }; calls: (tool: string) => string[];
  /** The map files the deploy sent to the map folder's .incoming (the tar the ssh stub took on stdin), sorted. */
  staged: () => string[];
  /** One sent map file's bytes. */
  sent: (name: string) => string;
  /** The env.base the deploy staged (through the scp capture). */
  envBase: () => string[];
}

/** A fresh repo with the deploy's files, the test map manifest and its files, and the stubs. `prep` runs before the commit. */
function rig(prep?: (repo: string) => void): Rig {
  const dir = path.join(work, `r${n++}`);
  const repo = path.join(dir, 'repo');
  const bin = path.join(dir, 'bin');
  mkdirSync(path.join(dir, 'calls'), { recursive: true });
  mkdirSync(bin);
  for (const p of ['infra/deploy', 'infra/drill/owner-env.sh', 'infra/hosted', 'infra/profiles', 'infra/compose.yaml', 'infra/nginx', 'infra/placeholder', 'infra/backup']) {
    cpSync(path.join(root, p), path.join(repo, p), { recursive: true });
  }
  mkdirSync(path.join(repo, 'packages/maps'), { recursive: true });
  writeFileSync(path.join(repo, 'packages/maps/MANIFEST.json'), JSON.stringify({ assets: Object.entries(MAPS).map(([id, c]) => ({ id, sha256: sha(c), bytes: c.length })) }));
  mkdirSync(path.join(repo, '.build/data/maps'), { recursive: true });
  writeFileSync(path.join(repo, '.build/data/street-list.json'), '[]');
  for (const [id, c] of Object.entries(MAPS)) writeFileSync(path.join(repo, '.build/data/maps', id), c);
  writeFileSync(path.join(repo, '.gitignore'), '.build/\n');
  prep?.(repo);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'rig');
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  const realNode = process.execPath;
  writeFileSync(path.join(bin, 'node'), `#!/usr/bin/env bash\nif [ "$1" = ci/data-assets.ts ]; then printf '%s\\n' "$*" >> "$RIG/calls/node"; exit 0; fi\nexec "${realNode}" "$@"\n`);
  chmodSync(path.join(bin, 'node'), 0o755);
  if (spawnSync('sh', ['-c', 'command -v shasum']).status !== 0) {
    writeFileSync(path.join(bin, 'shasum'), '#!/usr/bin/env bash\nshift 2; exec sha256sum "$@"\n'); // the Linux CI image has sha256sum only
    chmodSync(path.join(bin, 'shasum'), 0o755);
  }
  const env = {
    ...process.env, RIG: dir, PATH: `${bin}:${process.env.PATH}`, HOME: dir,
    BW_HOST: 'stub@192.0.2.1', BW_KEY: path.join(dir, 'no-key'), BW_OWNER_ENV: path.join(dir, 'none'), BW_OWNER_ENV_LOCAL: path.join(dir, 'none'),
    BW_PUBLISH_CLONE: path.join(dir, 'clone'),
  };
  return {
    dir,
    repo,
    run: (args) => {
      const r = spawnSync('bash', ['infra/deploy/deploy.sh', ...args], { cwd: repo, env, encoding: 'utf8' });
      return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
    },
    calls: (tool) => (existsSync(path.join(dir, 'calls', tool)) ? readFileSync(path.join(dir, 'calls', tool), 'utf8').trim().split('\n') : []),
    staged: () => untar(dir).length === 0 ? [] : readdirSync(path.join(dir, 'untarred')).sort(),
    sent: (name) => (untar(dir), readFileSync(path.join(dir, 'untarred', name), 'utf8')),
    envBase: () => readFileSync(path.join(dir, 'captured/env.base'), 'utf8').trim().split('\n'),
  };
}

/** Unpack the tar the ssh stub took (once) into <dir>/untarred; the names it held. */
function untar(dir: string): string[] {
  const tar = path.join(dir, 'incoming.tar');
  if (!existsSync(tar)) return [];
  const out = path.join(dir, 'untarred');
  if (!existsSync(out)) {
    mkdirSync(out);
    execFileSync('tar', ['-xf', tar, '-C', out]);
  }
  return readdirSync(out);
}

/** Every file under a folder, as paths relative to it. */
function walk(top: string, rel = ''): string[] {
  return readdirSync(path.join(top, rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(top, path.join(rel, e.name)) : [path.join(rel, e.name)]);
}

/** Write the publish state of v1.0.0 (scripts/publish.sh format) and the image the stub Docker context holds. */
function published(r: Rig, over: Record<string, string> = {}, ctx: { id?: string; publicCommit?: string } = {}): void {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.repo, encoding: 'utf8' }).trim();
  const state = { TAG: 'v1.0.0', COMMIT: PUBLIC, PRIVATE: head, PUSHED: '1', IMAGE_ID, IMAGE_COMMIT: PUBLIC, IMAGE_CONTEXT: 'ctx-release', ...over };
  mkdirSync(path.join(r.dir, 'clone/.git/bw-publish'), { recursive: true });
  writeFileSync(path.join(r.dir, 'clone/.git/bw-publish/v1.0.0.env'), Object.entries(state).map(([k, v]) => `${k}=${v}\n`).join(''));
  writeFileSync(path.join(r.dir, 'ctx-id'), `${ctx.id ?? IMAGE_ID}\n`);
  writeFileSync(path.join(r.dir, 'ctx-public'), ctx.publicCommit ?? PUBLIC);
  writeFileSync(path.join(r.dir, 'load-env'), `PUBLIC_COMMIT=${ctx.publicCommit ?? PUBLIC}\n`);
}

describe('deploy.sh stages the map files (F-364 (a))', () => {
  // why: F-364 (a) (the deploy never sent the map files; the hosted map folder Compose mounts was never filled or checked)
  it('checks the manifest files here, stages the list and every file the server has not recorded', () => {
    const r = rig();
    const res = r.run([]);
    expect(res.status, res.out).toBe(0);
    expect(r.calls('node')).toContain('ci/data-assets.ts ensure --with-routing --manifest packages/maps/MANIFEST.json --dir .build/data/maps');
    const list = readFileSync(path.join(r.dir, 'captured/maps.sha256'), 'utf8');
    expect(list).toBe(Object.entries(MAPS).map(([id, c]) => `${sha(c)}  ${id}\n`).join(''));
    expect(r.staged()).toEqual(Object.keys(MAPS).sort());
    expect(r.sent('columbus.pmtiles')).toBe(MAPS['columbus.pmtiles']);
    expect(r.calls('ssh')).toContain('sudo cat /opt/.build/data/maps/.verified.sha256 2>/dev/null');
    const bytes = Object.values(MAPS).reduce((a, c) => a + c.length, 0);
    expect(res.out).toContain(`map files: 2 in the manifest, checked here; 2 to send, ${bytes} bytes`);
  });

  // why: F-364 (a) (a later deploy sends only a file the server's record does not hold, not 2.8 GB each time)
  it('stages only the files whose line the server record lacks', () => {
    const r = rig();
    writeFileSync(path.join(r.dir, 'held'), `${sha(MAPS['ohio.osrm.hsgr']!)}  ohio.osrm.hsgr\n${sha('old tiles')}  columbus.pmtiles\n`);
    expect(r.run([]).status).toBe(0);
    expect(r.staged()).toEqual(['columbus.pmtiles']); // the server's columbus line is another SHA-256: sent again
    expect(readFileSync(path.join(r.dir, 'captured/maps.sha256'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  // why: F-364 (a)
  it('stops before any copy when the manifest gives no usable list', () => {
    const r = rig((repo) => writeFileSync(path.join(repo, 'packages/maps/MANIFEST.json'), JSON.stringify({ assets: [{ id: '../escape', sha256: 'x' }] })));
    const res = r.run([]);
    expect(res.status).toBe(2);
    expect(res.out).toContain('STOP: packages/maps/MANIFEST.json gave no usable map list');
    expect(r.calls('scp')).toEqual([]);
  });
});

describe('deploy.sh --release (F-1611)', () => {
  const builds = (r: Rig) => r.calls('docker').filter((l) => /(^| )build /.test(l));

  // why: F-1611 (the hosted deploy built HEAD with PUBLIC_COMMIT unknown, so the footer's Source link named no public commit)
  it('deploys the published image from its Docker context, builds nothing, and checks it on the server after the load', () => {
    const r = rig();
    published(r);
    writeFileSync(path.join(r.dir, 'open'), ''); // the release deploy opens the demo (F-1645): the probes answer the app
    const res = r.run(['--release', 'v1.0.0', '--profile', 'demo']);
    expect(res.status, res.out).toBe(0);
    expect(builds(r)).toEqual([]);
    expect(r.calls('docker')).toContain('--context ctx-release save bw-app:v1.0.0');
    expect(r.calls('ssh')).toContain('sudo bash /tmp/bw-deploy-stage/server-deploy.sh /tmp/bw-deploy-stage bw-app:v1.0.0');
    expect(res.out).toContain(`bw-app:v1.0.0 (${IMAGE_ID}) carries PUBLIC_COMMIT ${PUBLIC}, linux/amd64`);
    expect(existsSync(path.join(r.dir, 'captured/backups-on'))).toBe(true); // P8-UNLOCK's deploy, F-388
    // a re-run: the server holds that tag with that PUBLIC_COMMIT, so nothing is sent again
    rmSync(path.join(r.dir, 'calls/docker'));
    expect(r.run(['--release', 'v1.0.0', '--profile', 'demo']).status).toBe(0);
    expect(r.calls('docker').filter((l) => / save /.test(l))).toEqual([]);
  });

  // why: F-1611 (each refusal is a known-bad of the check above: a release that is not the published one never reaches the server)
  it('refuses a release that is not published, not the checked image, or not the files the deploy ships', () => {
    const cases: [string, (r: Rig) => void, string][] = [
      ['not pushed', (r) => published(r, { PUSHED: '0' }), 'is not published'],
      ['no state', () => undefined, 'no publish state for v1.0.0'],
      ['image checked for another commit', (r) => published(r, { IMAGE_COMMIT: 'c'.repeat(40) }), 'no release image of v1.0.0 is checked'],
      ['the tag now another image', (r) => published(r, {}, { id: `sha256:${'d'.repeat(64)}` }), 'is now another image'],
      ['the image PUBLIC_COMMIT stale', (r) => published(r, {}, { publicCommit: 'e'.repeat(40) }), 'the PUBLIC_COMMIT of bw-app:v1.0.0 is not'],
      ['private commit unknown', (r) => published(r, { PRIVATE: 'f'.repeat(40) }), 'is not in this repo'],
    ];
    for (const [name, set, msg] of cases) {
      const r = rig();
      set(r);
      const res = r.run(['--release', 'v1.0.0']);
      expect(res.status, name).toBe(2);
      expect(res.out, name).toContain(msg);
      expect(r.calls('scp'), name).toEqual([]);
      expect(r.calls('docker').filter((l) => / save |^save /.test(l)), name).toEqual([]);
    }
    // the files the deploy ships changed since the release's private commit
    const r = rig();
    published(r);
    writeFileSync(path.join(r.repo, 'infra/nginx/http.conf'), '# changed\n', { flag: 'a' });
    execFileSync('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', 'commit', '-q', '-am', 'later'], { cwd: r.repo });
    const later = r.run(['--release', 'v1.0.0']);
    expect(later.status).toBe(2);
    expect(later.out).toContain('differs from the release\'s private commit');
  });

  // why: F-1611
  it('fails when the server does not hold the published image after the load', () => {
    const r = rig();
    published(r);
    writeFileSync(path.join(r.dir, 'load-env'), 'PUBLIC_COMMIT=unknown\n');
    const res = r.run(['--release', 'v1.0.0']);
    expect(res.status).toBe(1);
    expect(res.out).toContain(`the server's bw-app:v1.0.0 does not carry PUBLIC_COMMIT ${PUBLIC}`);
    expect(r.calls('scp')).toEqual([]);
  });

  // why: F-1611 (P8-UNLOCK's deploy, --profile demo, must be the published image; a plain dev deploy keeps PUBLIC_COMMIT unknown)
  it('refuses --profile demo without --release, and --release with a flag it cannot honor', () => {
    const r = rig();
    for (const args of [['--profile', 'demo'], ['--release', 'v1.0.0', '--allow-dirty'], ['--release', 'v1.0.0', '--drill', '500'], ['--release', 'v1.0.0', '--host-files'], ['--release', 'latest']]) {
      expect(r.run(args).status, args.join(' ')).toBe(2);
    }
    expect(r.calls('ssh')).toEqual([]);
    expect(r.run(['--profile', 'demo']).out).toContain('--profile demo needs --release');
  });
});

describe('deploy.sh sets ROUTES from the deploy mode (F-1645) and probes for it (F-1641)', () => {
  const routesLines = (r: Rig) => r.envBase().filter((l) => l.startsWith('ROUTES='));

  // why: F-1645 (P8-UNLOCK had no legal way to open the demo: hosted.env pinned ROUTES=locked and the --release guard refuses any file change)
  it('stages exactly 1 ROUTES=open for --release <tag> --profile demo, and passes only when every probe answers the app', () => {
    const open = rig();
    published(open);
    writeFileSync(path.join(open.dir, 'open'), '');
    const ok = open.run(['--release', 'v1.0.0', '--profile', 'demo']);
    expect(ok.status, ok.out).toBe(0);
    expect(routesLines(open)).toEqual(['ROUTES=open']);
    expect(ok.out).toContain('routes open (from the deploy mode)');
    expect(ok.out).toContain('DEPLOY OK bw-app:v1.0.0, routes open');
    // F-1641 known-bad: the open deploy answered by the placeholder (the lock still on) is a failed deploy
    const shut = rig();
    published(shut);
    const bad = shut.run(['--release', 'v1.0.0', '--profile', 'demo']);
    expect(bad.status, bad.out).toBe(1);
    expect(bad.out).toContain('routes open expected: NOT every probe answers so');
    expect(bad.out).toContain('DEPLOY FAILED (server exit 0, /healthz 200, routes open answered: 0, HSTS: 1)');
    // and an open site that answers a 5xx on a probed path is not open
    const five = rig();
    published(five);
    writeFileSync(path.join(five.dir, 'open'), '');
    writeFileSync(path.join(five.dir, 'code'), '502\n');
    expect(five.run(['--release', 'v1.0.0', '--profile', 'demo']).status).toBe(1);
  });

  // why: F-1645 (every deploy but the release with the demo profile keeps the lock; a plain deploy of HEAD can never open the demo)
  it('stages exactly 1 ROUTES=locked for a plain deploy and a release without the demo profile, and fails when a probe answers the app', () => {
    const plain = rig();
    const res = plain.run([]);
    expect(res.status, res.out).toBe(0);
    expect(routesLines(plain)).toEqual(['ROUTES=locked']);
    expect(res.out).toContain('routes locked expected: every probe answers so');
    const rel = rig();
    published(rel);
    expect(rel.run(['--release', 'v1.0.0']).status).toBe(0);
    expect(routesLines(rel)).toEqual(['ROUTES=locked']);
    // F-1641 known-bad: a locked deploy whose paths answer the app is a failed deploy
    const leak = rig();
    writeFileSync(path.join(leak.dir, 'open'), '');
    const bad = leak.run([]);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain('routes locked answered: 0');
  });

  // why: F-1645 (a ROUTES line in a committed env file would give 2 ROUTES lines or reopen the hole; the mode is the 1 source)
  it('stops before any copy when hosted.env or demo.env sets ROUTES', () => {
    for (const [file, args] of [['infra/hosted/hosted.env', []], ['infra/profiles/demo.env', ['--release', 'v1.0.0', '--profile', 'demo']]] as const) {
      const r = rig((repo) => writeFileSync(path.join(repo, file), 'ROUTES=open\n', { flag: 'a' }));
      published(r);
      const res = r.run([...args]);
      expect(res.status, file).toBe(2);
      expect(res.out, file).toContain('sets ROUTES; the deploy mode sets it');
      expect(r.calls('scp'), file).toEqual([]);
      expect(r.calls('ssh').filter((l) => l.includes('tar -x')), file).toEqual([]);
    }
  });

  // why: F-1641 (a drill on the opened demo rolls back to the open release: expecting the lock would fail every drill after P8-UNLOCK)
  it('a drill expects the routes the server ran before it', () => {
    for (const live of ['locked', 'open'] as const) {
      const r = rig();
      writeFileSync(path.join(r.dir, 'live-image'), 'bw-app:live\n');
      writeFileSync(path.join(r.dir, 'live-routes'), `${live}\n`);
      writeFileSync(path.join(r.dir, 'server-rc'), '3');
      if (live === 'open') writeFileSync(path.join(r.dir, 'open'), '');
      const res = r.run(['--drill', '500']);
      expect(res.status, res.out).toBe(0);
      expect(res.out).toContain(`DRILL PASS: rolled back, /healthz 200, routes still ${live}`);
    }
    // known-bad: the server ran open, the rollback answers the placeholder
    const r = rig();
    writeFileSync(path.join(r.dir, 'live-image'), 'bw-app:live\n');
    writeFileSync(path.join(r.dir, 'live-routes'), 'open\n');
    writeFileSync(path.join(r.dir, 'server-rc'), '3');
    const res = r.run(['--drill', '500']);
    expect(res.status).toBe(1);
    expect(res.out).toContain('DRILL FAIL (server exit 3, /healthz 200, routes open answered: 0)');
  });
});

describe('deploy.sh does not silently re-lock an open server (F-1660)', () => {
  const routesLines = (r: Rig) => r.envBase().filter((l) => l.startsWith('ROUTES='));
  const live = (r: Rig, routes: string) => writeFileSync(path.join(r.dir, 'live-routes'), `${routes}\n`);
  const writes = (r: Rig) => r.calls('ssh').filter((l) => !/^(uname -m|sudo sed -n |sudo sh -c 'if \[ -f \/opt\/brightwater\/\.env \]; then sed -n )/.test(l));

  // why: F-1660 (a plain deploy staged ROUTES=locked over the open demo and logged DEPLOY OK)
  it('stops (exit 2) before anything is copied or changed when the server runs open and the deploy would lock', () => {
    const r = rig();
    live(r, 'open');
    const res = r.run([]);
    expect(res.status, res.out).toBe(2);
    expect(res.out).toContain('re-run with --release <tag> --profile demo to keep it open, or add --lock');
    expect(r.calls('scp')).toEqual([]);
    expect(writes(r)).toEqual([]);
    expect(r.calls('docker')).toEqual([]);
    // a release without the demo profile would lock too
    const rel = rig();
    published(rel);
    live(rel, 'open');
    expect(rel.run(['--release', 'v1.0.0']).status).toBe(2);
    expect(rel.calls('scp')).toEqual([]);
  });

  // why: F-1660 (--lock is the explicit way to lock on purpose)
  it('with --lock over an open server it proceeds and stages ROUTES=locked', () => {
    const r = rig();
    live(r, 'open');
    const res = r.run(['--lock']);
    expect(res.status, res.out).toBe(0);
    expect(routesLines(r)).toEqual(['ROUTES=locked']);
    expect(r.calls('scp')).toHaveLength(1);
  });

  // why: F-1660 (the redeploy command that keeps the demo open must not be stopped by the guard)
  it('proceeds and stages ROUTES=open for --release <tag> --profile demo over an open server', () => {
    const r = rig();
    published(r);
    live(r, 'open');
    writeFileSync(path.join(r.dir, 'open'), '');
    const res = r.run(['--release', 'v1.0.0', '--profile', 'demo']);
    expect(res.status, res.out).toBe(0);
    expect(routesLines(r)).toEqual(['ROUTES=open']);
  });

  // why: F-1660 (a locked server deploys as before)
  it('proceeds as before over a locked server', () => {
    const r = rig();
    live(r, 'locked');
    const res = r.run([]);
    expect(res.status, res.out).toBe(0);
    expect(routesLines(r)).toEqual(['ROUTES=locked']);
  });

  // why: F-1660 (a first deploy, no .env and no ROUTES line, deploys as before)
  it('proceeds as before when the server has no ROUTES line', () => {
    const r = rig();
    const res = r.run([]);
    expect(res.status, res.out).toBe(0);
    expect(routesLines(r)).toEqual(['ROUTES=locked']);
  });

  // why: F-1660 (--lock changes nothing but the guard: it never combines with a mode that sets the routes)
  it('refuses --lock with --drill, --profile or --host-files', () => {
    const r = rig();
    for (const args of [['--lock', '--drill', '500'], ['--lock', '--profile', 'demo'], ['--lock', '--host-files']]) expect(r.run(args).status, args.join(' ')).toBe(2);
    expect(r.calls('ssh')).toEqual([]);
  });
});

describe('deploy.sh sends the map files to the map folder, never /tmp (F-1646, F-1648)', () => {
  // why: F-1646 (2653 MiB of map files staged in the server's /tmp, a RAM-backed tmpfs on Debian 13, could pin half the RAM)
  it('sends no map file through /tmp: the files go by tar to <map folder>/.incoming after a free-space read there', () => {
    const r = rig();
    const res = r.run([]);
    expect(res.status, res.out).toBe(0);
    const captured = path.join(r.dir, 'captured');
    const bodies = new Set(Object.values(MAPS));
    for (const f of walk(captured)) expect(bodies.has(readFileSync(path.join(captured, f), 'utf8')), f).toBe(false);
    expect(existsSync(path.join(captured, 'maps'))).toBe(false);
    const ssh = r.calls('ssh');
    const df = ssh.findIndex((l) => l === 'sudo rm -rf /opt/.build/data/maps/.incoming && sudo mkdir -p /opt/.build/data/maps/.incoming && df -Pk /opt/.build/data/maps/.incoming');
    const tar = ssh.indexOf('sudo tar -x --no-same-owner -f - -C /opt/.build/data/maps/.incoming');
    expect(df).toBeGreaterThan(-1);
    expect(tar).toBeGreaterThan(df);
    expect(r.staged()).toEqual(Object.keys(MAPS).sort());
  });

  // why: F-1646 (a send that cannot fit stops before a byte goes, and leaves no .incoming behind)
  it('stops (exit 2) before the send when the map folder filesystem lacks the bytes plus 1 GiB', () => {
    const r = rig();
    writeFileSync(path.join(r.dir, 'free-kib'), '1048575\n'); // 1 KiB short of 1 GiB: the files need 1 GiB plus their bytes
    const res = r.run([]);
    expect(res.status).toBe(2);
    expect(res.out).toContain('STOP: the map folder\'s filesystem has 1023 MiB free; the map files need 0 MiB plus 1 GiB');
    const ssh = r.calls('ssh');
    expect(ssh.filter((l) => l.includes('tar -x'))).toEqual([]);
    expect(ssh.at(-1)).toBe('sudo rm -rf /opt/.build/data/maps/.incoming');
    expect(r.calls('scp')).toEqual([]);
  });

  // why: F-1646 (a failed send must not leave a part set on the server, nor run the server half)
  it('removes .incoming and stops (exit 1) when the send fails', () => {
    const r = rig();
    writeFileSync(path.join(r.dir, 'tar-fail'), '');
    const res = r.run([]);
    expect(res.status).toBe(1);
    expect(res.out).toContain('STOP: sending the map files to /opt/.build/data/maps/.incoming failed');
    expect(r.calls('ssh').at(-1)).toBe('sudo rm -rf /opt/.build/data/maps/.incoming');
    expect(r.calls('scp')).toEqual([]);
  });

  // why: F-1646 (nothing to send: no free-space read, no .incoming made)
  it('makes no .incoming when the server record holds every file', () => {
    const r = rig();
    writeFileSync(path.join(r.dir, 'held'), Object.entries(MAPS).map(([id, c]) => `${sha(c)}  ${id}\n`).join(''));
    const res = r.run([]);
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('0 to send, 0 bytes');
    expect(r.calls('ssh').filter((l) => l.includes('.incoming'))).toEqual([]);
  });

  // why: F-1648 (the 2 deploy halves read BW_MAPS_DIR from 2 sources: an owner-set folder made every deploy re-send 2653 MiB)
  it('reads the map folder from 1 line it stages in env.base, for the record, the send and the server half', () => {
    const plain = rig();
    expect(plain.run([]).status).toBe(0);
    expect(plain.envBase().filter((l) => l.startsWith('BW_MAPS_DIR='))).toEqual(['BW_MAPS_DIR=/opt/.build/data/maps']);
    const set = rig((repo) => writeFileSync(path.join(repo, 'infra/hosted/hosted.env'), 'BW_MAPS_DIR=/srv/bw-maps\n', { flag: 'a' }));
    const res = set.run([]);
    expect(res.status, res.out).toBe(0);
    expect(set.envBase().filter((l) => l.startsWith('BW_MAPS_DIR='))).toEqual(['BW_MAPS_DIR=/srv/bw-maps']);
    expect(set.calls('ssh')).toContain('sudo cat /srv/bw-maps/.verified.sha256 2>/dev/null');
    expect(set.calls('ssh')).toContain('sudo tar -x --no-same-owner -f - -C /srv/bw-maps/.incoming');
    expect(res.out).toContain('map folder /srv/bw-maps');
    const odd = rig((repo) => writeFileSync(path.join(repo, 'infra/hosted/hosted.env'), 'BW_MAPS_DIR=srv maps\n', { flag: 'a' }));
    const bad = odd.run([]);
    expect(bad.status).toBe(2);
    expect(bad.out).toContain('is not a plain absolute path');
  });
});
