// SPDX-License-Identifier: AGPL-3.0-or-later
// F-95: infra/deploy/server-deploy.sh must confirm which image answered the health wait. The live proof is the deploy log
// .build/evidence/W19-DEPLOY-deploy.out (Nov 2, 2026, commit 972f21496505, after the F-95 and F-100 fixes: HEALTH new 502 kept waiting, then
// 200, then 'IMAGE new: web runs bw-app:972f21496505'; F-120). The older logs in .build/evidence/P1-DEPLOY predate the fixes. These tests
// keep the confirm step and the compose check from being lost.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '../..');
const sdPath = path.join(root, 'infra/deploy/server-deploy.sh');
const sd = readFileSync(sdPath, 'utf8');

/** One top-level constant line of the script (NAME=value), as the script has it. */
const constant = (name: string) => {
  const m = new RegExp(`^${name}=.*$`, 'm').exec(sd);
  if (!m) throw new Error(`constant ${name} not found in server-deploy.sh`);
  return m[0];
};

const fn = (name: string) => {
  const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm').exec(sd);
  if (!m) throw new Error(`function ${name} not found in server-deploy.sh`);
  return m[0];
};

/** Run confirm_image with a docker stub whose web container reports `running` as its image. */
function confirm(running: string, want: string): { status: number; out: string } {
  const prog = [
    'DEST=/nonexistent-dest',
    fn('ts'),
    fn('log'),
    fn('running_image'),
    fn('confirm_image'),
    'cd() { :; }',
    'docker() { if [ "$1" = inspect ]; then echo "$RUNNING"; else echo cid1; fi; }',
    'confirm_image new "$WANT"',
  ].join('\n');
  try {
    const out = execFileSync('bash', ['-c', prog], { env: { ...process.env, RUNNING: running, WANT: want }, encoding: 'utf8' });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { status: err.status, out: err.stdout };
  }
}

describe('infra/deploy/server-deploy.sh', () => {
  // why: F-95
  it('parses as bash', () => {
    expect(() => execFileSync('bash', ['-n', sdPath])).not.toThrow();
  });

  // why: F-95
  it('passes when web runs the new tag and fails when the old release still answers', () => {
    expect(confirm('bw-app:new', 'bw-app:new').status).toBe(0);
    const old = confirm('bw-app:old', 'bw-app:new');
    expect(old.status).toBe(1);
    expect(old.out).toContain('the 200 did not come from this release');
  });

  // why: F-95
  it('validates the staged compose file before anything is copied, and gates every health wait on the image', () => {
    const code = sd.split('\n').map((l) => l.replace(/^\s*#.*$/, ''));
    const at = (re: RegExp) => code.findIndex((l) => re.test(l));
    const cfg = at(/docker compose --project-directory "\$STAGE" .* config -q/);
    expect(cfg).toBeGreaterThan(-1);
    expect(cfg).toBeLessThan(at(/^changed=0$/));
    const text = code.join('\n');
    expect(text).toMatch(/wait_healthy new && confirm_image new "\$IMAGE"/);
    expect(text).toMatch(/wait_healthy current && confirm_image current "\$IMAGE"/);
    expect(text).toMatch(/wait_healthy rollback && \{ \[ -z "\$prev_image" \] \|\| confirm_image rollback "\$prev_image"; \}/);
    // a status listing must not turn a finished deploy into a script failure under set -e
    for (const l of code.filter((x) => /docker compose -f "\$DEST\/compose.yaml" ps /.test(x))) expect(l).toMatch(/\|\| true$/);
  });

  /** Run import_source_check with a docker stub whose exec answers `out` and exits `rc`. */
  function sourceCheck(rc: number, out: string): { status: number; out: string } {
    const prog = [
      'DEST=/nonexistent-dest', fn('ts'), fn('log'), fn('import_source_check'), 'cd() { :; }',
      'docker() { echo "$*" >&2; echo "$OUT"; return "$RC"; }',
      'import_source_check',
    ].join('\n');
    try {
      return { status: 0, out: execFileSync('bash', ['-c', prog], { env: { ...process.env, RC: String(rc), OUT: out }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { status: err.status, out: err.stdout };
    }
  }

  // why: F-258 on the hosted server, after the deploy, the worker finds the generator's inputs and its export matches the manifest
  it("runs the worker's import source check after every healthy start, and a failed check is exit 5", () => {
    const ok = sourceCheck(0, '{"level":"info","process":"worker","status":"import source ok"}');
    expect(ok.status).toBe(0);
    expect(ok.out).toContain('IMPORT SOURCE OK');
    const bad = sourceCheck(1, '{"level":"error","process":"worker","status":"import source refused","errorCode":"generator_manifest"}');
    expect(bad.status).toBe(5);
    expect(bad.out).toContain('"errorCode":"generator_manifest"');
    // F-532 (a): in its own container, not exec'd into the running worker (which may be executing an owed office run in the same cgroup)
    expect(fn('import_source_check')).toContain('docker compose run --rm --no-deps -T worker node apps/worker/src/import/check.ts');
    expect(fn('import_source_check')).not.toContain('compose exec');
    const code = sd.split('\n').map((l) => l.replace(/^\s*#.*$/, '')).join('\n');
    // both healthy results (deployed, unchanged) run it before they report success
    expect(code).toMatch(/import_source_check \|\| \{ log "RESULT deployed \$IMAGE, import source check failed"; exit 5; \}\n\s*log "RESULT deployed \$IMAGE"/);
    expect(code).toMatch(/import_source_check \|\| \{ log "RESULT unchanged, import source check failed"; exit 5; \}\n\s*log "RESULT unchanged"/);
    // the street list is installed where the Compose file mounts it from, before any compose up
    expect(code.indexOf('install -D -m 0644 "$STAGE/data/street-list.json" "$data_dir/street-list.json"')).toBeLessThan(code.indexOf('compose_up\n'));
    expect(code).toContain('data_dir="${data_dir:-$(dirname "$DEST")/.build/data}"');
  });

  /** Run compose_up with a docker stub that lists `services` for config --services and records the up call. */
  function upCall(services: string[]): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-up-'));
    try {
      const prog = [
        'DEST=/nonexistent-dest', fn('ts'), fn('log'), fn('compose_up'), 'cd() { :; }',
        `docker() { if [ "$1 $2" = "compose config" ]; then printf '%s\\n' ${services.join(' ')}; else echo "$*" >> ${dir}/calls; fi; }`,
        'compose_up',
      ].join('\n');
      execFileSync('bash', ['-c', prog], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return existsSync(path.join(dir, 'calls')) ? readFileSync(path.join(dir, 'calls'), 'utf8') : '';
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // why: F-1305 the hosted deploy starts routing with every other service (BUILD_PLAN D-21: routing stays on, no routing setting)
  it('starts every service outside a profile, routing among them, and leaves no service out by name', () => {
    // A bare "compose up -d" starts every service that no profile holds back; compose.test.ts finds routing in no profile.
    const calls = upCall(['db', 'migrate', 'pbs', 'proxy', 'routing', 'web', 'worker']).trim().split('\n');
    expect(calls[0]).toBe('compose up -d');
    const compose = parse(readFileSync(path.join(root, 'infra/compose.yaml'), 'utf8')) as { services: Record<string, { profiles?: string[] }> };
    expect(compose.services.routing, 'routing is a Compose service').toBeDefined();
    expect(compose.services.routing!.profiles, 'routing is held back by no profile').toBeUndefined();
    // F-1295's exclusion is gone: nothing in compose_up names, filters or skips a service
    expect(fn('compose_up')).not.toMatch(/routing|config --services|grep -v/);
  });

  /** Run install_timers with systemctl, install and cmp stubs; `asked` stages the marker the P8-UNLOCK deploy stages. Returns the systemctl calls. */
  function timers(asked: boolean): string[] {
    const stage = mkdtempSync(path.join(tmpdir(), 'bw-timers-'));
    try {
      if (asked) writeFileSync(path.join(stage, 'backups-on'), '');
      const prog = [
        'DEST=/nonexistent-dest', `STAGE=${stage}`,
        'TIMERS=(brightwater-certbot-renew brightwater-backup brightwater-restore-test)',
        'BACKUP_TIMERS=(brightwater-backup brightwater-restore-test)',
        fn('ts'), fn('log'), fn('install_timers'),
        'cmp() { return 0; }', 'install() { :; }', `systemctl() { echo "$*" >> ${stage}/calls; }`,
        'install_timers',
      ].join('\n');
      execFileSync('bash', ['-c', prog], { encoding: 'utf8' });
      return readFileSync(path.join(stage, 'calls'), 'utf8').split('\n').filter((l) => /^(enable|disable) /.test(l));
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  // why: F-388 (owner ruling 1c7bcc42 "Move hosted half to phase 8"): a deploy before P8-UNLOCK turns neither backup timer on, and P8-UNLOCK's does
  it('turns the 2 backup timers on only when the deploy asks for them', () => {
    expect(timers(false)).toEqual([
      'enable --now brightwater-certbot-renew.timer', 'disable --now brightwater-backup.timer', 'disable --now brightwater-restore-test.timer',
    ]);
    expect(timers(true)).toEqual([
      'enable --now brightwater-certbot-renew.timer', 'enable --now brightwater-backup.timer', 'enable --now brightwater-restore-test.timer',
    ]);
    // only deploy.sh --profile demo (P8-UNLOCK's) stages the marker
    expect(readFileSync(path.join(root, 'infra/deploy/deploy.sh'), 'utf8')).toMatch(/^\[ "\$profile" != demo \] \|\| : > "\$stage\/backups-on"$/m);
  });

  /** Run install_timers with a systemctl stub whose is-enabled / is-active answer `state[timer]` ("enabled active" etc). */
  function timerState(asked: boolean, state: Record<string, string>): { wrong: string; out: string } {
    const stage = mkdtempSync(path.join(tmpdir(), 'bw-tstate-'));
    try {
      if (asked) writeFileSync(path.join(stage, 'backups-on'), '');
      const answers = Object.entries(state).map(([t, s]) => `${t}.timer) set -- ${s} ;;`).join(' ');
      const prog = [
        'set -euo pipefail', 'DEST=/nonexistent-dest', `STAGE=${stage}`,
        'TIMERS=(brightwater-certbot-renew brightwater-backup brightwater-restore-test)',
        'BACKUP_TIMERS=(brightwater-backup brightwater-restore-test)',
        fn('ts'), fn('log'), 'timers_wrong=0', fn('install_timers'),
        'cmp() { return 0; }', 'install() { :; }',
        `systemctl() { local v="$1" t="$2"; case "$v" in is-enabled|is-active) ;; *) return 0 ;; esac; case "$t" in ${answers} *) set -- disabled inactive ;; esac; if [ "$v" = is-enabled ]; then echo "$1"; [ "$1" = enabled ]; else echo "$2"; [ "$2" = active ]; fi; }`,
        'install_timers', 'echo "WRONG=$timers_wrong"',
      ].join('\n');
      const out = execFileSync('bash', ['-c', prog], { encoding: 'utf8' });
      return { wrong: /WRONG=(\d)/.exec(out)![1]!, out };
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  // why: F-560 (a disable that does not take, or a unit that re-enables itself, left a backup timer on while the log said "left off")
  it('reads every timer back after setting it, and marks a backup timer that is on while asked off', () => {
    const good = timerState(false, { 'brightwater-certbot-renew': 'enabled active' });
    expect(good.wrong).toBe('0');
    expect(good.out).toContain('brightwater-backup.timer asked off: is-enabled disabled, is-active inactive');
    expect(good.out).toContain('brightwater-certbot-renew.timer asked on: is-enabled enabled, is-active active');
    expect(good.out).not.toContain('left off');
    const enabled = timerState(false, { 'brightwater-certbot-renew': 'enabled active', 'brightwater-backup': 'enabled inactive' });
    expect(enabled.wrong).toBe('1');
    expect(enabled.out).toContain('TIMER WRONG: brightwater-backup.timer reads enabled while asked off');
    const active = timerState(false, { 'brightwater-certbot-renew': 'enabled active', 'brightwater-restore-test': 'disabled active' });
    expect(active.wrong).toBe('1');
    expect(active.out).toContain('TIMER WRONG: brightwater-restore-test.timer reads active while asked off');
    // asked on (P8-UNLOCK): enabled and active is right
    expect(timerState(true, { 'brightwater-certbot-renew': 'enabled active', 'brightwater-backup': 'enabled active', 'brightwater-restore-test': 'enabled active' }).wrong).toBe('0');
    // the deploy fails (exit 6) on it, right after the timers are set, before any healthy RESULT line
    expect(sd).toMatch(/\n\s*install_timers\n\s*if \[ "\$timers_wrong" = 1 \]; then log "RESULT deployed \$IMAGE, but a backup timer is on while asked off \(F-560\)"; exit 6; fi\n/);
  });

  /** Run write_env on `base` and `cur` (null: no .env yet); returns the new .env and the log. */
  function writeEnv(base: string, cur: string | null): { env: string; out: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-env-'));
    try {
      writeFileSync(path.join(dir, 'env.base'), base);
      if (cur !== null) writeFileSync(path.join(dir, 'cur.env'), cur);
      const prog = [
        'set -euo pipefail', 'IMAGE=bw-app:new', "OWNED_MARK='# deploy-owned keys:'", constant('OWNER_MARK'),
        fn('ts'), fn('log'), fn('write_env'), `write_env ${dir}/env.base ${dir}/cur.env ${dir}/out.env`,
      ].join('\n');
      const out = execFileSync('bash', ['-c', prog], { encoding: 'utf8' });
      return { env: readFileSync(path.join(dir, 'out.env'), 'utf8'), out };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // why: F-98 (every deploy rewrote /opt/brightwater/.env from the committed files only, so an owner-set secret or setting was lost)
  it('keeps every owner-set .env key on a deploy, rewrites the deploy keys, and logs key names only', () => {
    const first = writeEnv('ROUTES=locked\nDOMAIN=bw.example\n', null);
    expect(first.env.split('\n')[0]).toBe('# deploy-owned keys: ROUTES DOMAIN BW_IMAGE');
    expect(first.env).toContain('ROUTES=locked\nDOMAIN=bw.example\nBW_IMAGE=bw-app:new\n');
    // the owner adds 2 keys and edits a deploy key by hand; the next deploy (demo profile added) keeps his 2 keys, byte for byte
    const owner = `${first.env}IOS_INSTALL_KIND=testflight\nOWNER_SETTING=Zq3xY9planted value=x\nROUTES=open\n`;
    const second = writeEnv('ROUTES=locked\nDOMAIN=bw.example\nDEMO_MODE=1\n', owner);
    expect(second.env).toContain('IOS_INSTALL_KIND=testflight\nOWNER_SETTING=Zq3xY9planted value=x\n');
    expect(second.env.match(/^ROUTES=/gm)).toEqual(['ROUTES=']); // the deploy's own value wins, once
    expect(second.env).toContain('ROUTES=locked');
    expect(second.out).toContain('kept the owner-set key OWNER_SETTING');
    expect(second.out).not.toContain('Zq3xY9planted'); // no value is logged
    // a key the last deploy owned and this one does not (the profile not asked) is dropped, not carried as the owner's
    const third = writeEnv('ROUTES=locked\nDOMAIN=bw.example\n', second.env);
    expect(third.env).not.toMatch(/^DEMO_MODE=/m);
    expect(third.out).toContain('dropped DEMO_MODE');
    expect(third.env).toContain('OWNER_SETTING=Zq3xY9planted value=x\n');
    // a .env written before F-98 (no owned-keys line) keeps every key the new base does not hold
    expect(writeEnv('ROUTES=locked\n', 'ROUTES=locked\nBW_IMAGE=bw-app:old\nIOS_INSTALL_LINK=https://x.example/a\n').env)
      .toMatch(/BW_IMAGE=bw-app:new\n[\s\S]*IOS_INSTALL_LINK=https:\/\/x\.example\/a\n$/);
    // the script writes the .env through write_env, carrying the live one
    expect(sd).toContain('write_env "$STAGE/env.base" "$DEST/.env" "$STAGE/.env"');
  });

  /** Run install_maps with a staged list and files; `held` are files already in the map folder (name -> content, recorded). */
  /** The sent files are in <map folder>/.incoming, as deploy.sh's tar leaves them (F-1646); `inodes` are theirs before the run. */
  function maps(list: Record<string, string>, staged: Record<string, string>, held: Record<string, string>, unrecorded: string[] = []): { rc: number; out: string; dir: string; inodes: Record<string, number>; cleanup: () => void } {
    const base = mkdtempSync(path.join(tmpdir(), 'bw-maps-'));
    const stage = path.join(base, 'stage');
    const dir = path.join(base, 'maps');
    const incoming = path.join(dir, '.incoming');
    mkdirSync(stage, { recursive: true });
    mkdirSync(incoming, { recursive: true });
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    writeFileSync(path.join(stage, 'maps.sha256'), Object.entries(list).map(([n, c]) => `${sha(c)}  ${n}\n`).join(''));
    const inodes: Record<string, number> = {};
    for (const [n, c] of Object.entries(staged)) {
      writeFileSync(path.join(incoming, n), c);
      inodes[n] = statSync(path.join(incoming, n)).ino;
    }
    for (const [n, c] of Object.entries(held)) writeFileSync(path.join(dir, n), c);
    writeFileSync(path.join(dir, '.verified.sha256'), Object.entries(held).filter(([n]) => !unrecorded.includes(n)).map(([n, c]) => `${sha(c)}  ${n}\n`).join(''));
    const prog = ['set -euo pipefail', `STAGE=${stage}`, constant('MAPS_RECORD'), constant('MAPS_INCOMING'), constant('MAPS_SENTINEL'),
      fn('ts'), fn('log'), fn('install_maps'), `install_maps ${dir}`].join('\n');
    const cleanup = () => rmSync(base, { recursive: true, force: true });
    try {
      return { rc: 0, out: execFileSync('bash', ['-c', prog], { encoding: 'utf8' }), dir, inodes, cleanup };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { rc: err.status, out: err.stdout, dir, inodes, cleanup };
    }
  }

  // why: F-364 (a) (the deploy never sent the map files, so the hosted map folder Compose mounts could be empty or stale)
  it('installs each staged map file only when its SHA-256 is the manifest one, and refuses unless every listed file is there', () => {
    const list = { 'columbus.pmtiles': 'tiles-c', 'routing-a.osrm': 'route-a' };
    const fresh = maps(list, list, {});
    try {
      expect(fresh.rc).toBe(0);
      expect(readFileSync(path.join(fresh.dir, 'columbus.pmtiles'), 'utf8')).toBe('tiles-c');
      expect(readFileSync(path.join(fresh.dir, '.verified.sha256'), 'utf8').trim().split('\n')).toHaveLength(2);
      expect(fresh.out).toContain('map files: all 2 in');
    } finally { fresh.cleanup(); }
    const later = maps(list, { 'routing-a.osrm': 'route-a' }, { 'columbus.pmtiles': 'tiles-c' }); // only the changed file sent
    try { expect(later.rc).toBe(0); } finally { later.cleanup(); }
    const corrupt = maps(list, { 'columbus.pmtiles': 'tiles-X', 'routing-a.osrm': 'route-a' }, {});
    try {
      expect(corrupt.rc).toBe(1);
      expect(corrupt.out).toContain('map file columbus.pmtiles: its SHA-256 is not the manifest');
      expect(existsSync(path.join(corrupt.dir, 'columbus.pmtiles'))).toBe(false);
    } finally { corrupt.cleanup(); }
    const missing = maps(list, { 'routing-a.osrm': 'route-a' }, {});
    try {
      expect(missing.rc).toBe(1);
      expect(missing.out).toContain('map file columbus.pmtiles: not on the server as the manifest names it');
    } finally { missing.cleanup(); }
    const unchecked = maps(list, {}, list, ['columbus.pmtiles']); // on disk but never checked by this script
    try { expect(unchecked.rc).toBe(1); } finally { unchecked.cleanup(); }
    expect(sd).toContain('if ! install_maps "$maps_dir"; then log "REFUSED: the map files on the server do not match packages/maps/MANIFEST.json"; exit 1; fi');
    expect(sd.indexOf('install_maps "$maps_dir"')).toBeLessThan(sd.indexOf('\ncompose_up\n'));
  });

  // why: F-1649 (write_env dropped non KEY=value lines and owner values of owned keys with no log line, and missed keys Compose reads)
  it('logs every owner line it does not carry, by key or line number, never a value, and reads keys as Compose does', () => {
    const base = 'ROUTES=locked\nDOMAIN=bw.example\n';
    const deploy = writeEnv(base, null).env;
    const owner = [
      'export EXPORTED_KEY=Qv7exported',
      '  INDENTED_KEY=Qv7indented',
      'SPACED_KEY = Qv7spaced',
      'MULTI_KEY="Qv7first',
      'Qv7second line',
      'Qv7third"',
      'this is not a key Qv7garbage',
      'ROUTES=open',
      '# a comment Qv7comment',
      '',
      'AFTER_KEY=Qv7after',
    ].join('\n');
    const cur = `${deploy}${owner}\n`;
    const ownerFrom = deploy.split('\n').length; // the line number of the owner's first line
    const res = writeEnv(base, cur);
    for (const k of ['EXPORTED_KEY', 'INDENTED_KEY', 'SPACED_KEY', 'AFTER_KEY']) expect(res.out, k).toContain(`kept the owner-set key ${k}\n`);
    expect(res.env).toContain('export EXPORTED_KEY=Qv7exported\n  INDENTED_KEY=Qv7indented\nSPACED_KEY = Qv7spaced\n');
    expect(res.env).toContain('MULTI_KEY="Qv7first\nQv7second line\nQv7third"\nAFTER_KEY=Qv7after\n'); // carried whole, the garbage line not
    expect(res.out).toContain(`kept the owner-set key MULTI_KEY (lines ${ownerFrom + 3}-${ownerFrom + 5}, a multi-line value)`);
    expect(res.out).toContain(`line ${ownerFrom + 6} not carried: it is not a KEY=value line`);
    expect(res.out).toContain(`the owner value of ROUTES (line ${ownerFrom + 7}) is not carried: the deploy owns ROUTES`);
    expect(res.env.match(/^ROUTES=.*$/gm)).toEqual(['ROUTES=locked']);
    expect(res.env).not.toContain('Qv7garbage');
    expect(res.out).not.toContain('Qv7'); // no value, no line text, is ever logged
    // the deploy's own lines above the owner line are rewritten in silence: a deploy over its own .env logs nothing
    expect(writeEnv(base, deploy).out).toBe('');
    // a multi-line value of an owned key is skipped whole, and an unclosed quote is named by key and line
    const skip = writeEnv(base, `${deploy}ROUTES="open\nQv7more"\nKEEP=1\nOPEN_KEY='Qv7never closed\n`);
    expect(skip.env).not.toContain('Qv7more');
    expect(skip.env).toContain('KEEP=1\n');
    expect(skip.out).toContain(`the value of OPEN_KEY (from line ${ownerFrom + 3}) never closes its quote`);
    expect(skip.out).not.toContain('Qv7');
  });

  // why: F-1647 (glob order installed ohio.osrm.mldgr, the routing service's start marker, before 12 other ohio.osrm files)
  it('installs the routing sentinel after every other map file, and compose.yaml waits on that same file', () => {
    const sentinel = constant('MAPS_SENTINEL').split('=')[1]!;
    expect(sentinel).toBe('ohio.osrm.mldgr');
    // names that sort after the sentinel, and the list order with the sentinel first
    const list = { [sentinel]: 'mldgr', 'ohio.osrm.names': 'names', 'ohio.osrm.partition': 'partition', 'columbus.pmtiles': 'tiles' };
    const r = maps(list, list, {});
    try {
      expect(r.rc, r.out).toBe(0);
      const order = [...r.out.matchAll(/installed the map file (\S+)/g)].map((m) => m[1]);
      expect(order).toHaveLength(4);
      expect(order.at(-1)).toBe(sentinel);
    } finally { r.cleanup(); }
    const compose = readFileSync(path.join(root, 'infra/compose.yaml'), 'utf8');
    expect(compose).toContain(`until [ -e /data/maps/${sentinel} ]`);
  });

  // why: F-1646 (a copy across filesystems overwrote live map files in place; one bad file must move none)
  it('moves the sent files in by a same-filesystem rename only after every one checks, and always removes .incoming', () => {
    const list = { 'a.pmtiles': 'tiles-a', 'b.osrm': 'route-b', 'z.osrm': 'route-z' };
    const good = maps(list, { ...list, 'stray.bin': 'not listed' }, {});
    try {
      expect(good.rc, good.out).toBe(0);
      for (const n of Object.keys(list)) expect(statSync(path.join(good.dir, n)).ino, n).toBe(good.inodes[n]); // renamed, not copied
      expect(existsSync(path.join(good.dir, '.incoming'))).toBe(false);
      expect(existsSync(path.join(good.dir, 'stray.bin'))).toBe(false);
      expect(readdirSync(good.dir).sort()).toEqual(['.verified.sha256', 'a.pmtiles', 'b.osrm', 'z.osrm']);
    } finally { good.cleanup(); }
    // the last file in the list is bad: the 2 good ones before it are not moved either, and the live ones stay
    const bad = maps(list, { 'a.pmtiles': 'tiles-a', 'b.osrm': 'route-b', 'z.osrm': 'route-X' }, { 'a.pmtiles': 'tiles-old' }, ['a.pmtiles']);
    try {
      expect(bad.rc).toBe(1);
      expect(bad.out).toContain('map file z.osrm: its SHA-256 is not the manifest');
      expect(bad.out).not.toContain('installed the map file');
      expect(readFileSync(path.join(bad.dir, 'a.pmtiles'), 'utf8')).toBe('tiles-old');
      expect(existsSync(path.join(bad.dir, 'b.osrm'))).toBe(false);
      expect(existsSync(path.join(bad.dir, '.incoming'))).toBe(false);
    } finally { bad.cleanup(); }
    // both halves name the same folder: deploy.sh sends to <map folder>/.incoming, the server half reads MAPS_INCOMING
    expect(constant('MAPS_INCOMING')).toBe('MAPS_INCOMING=.incoming');
    expect(readFileSync(path.join(root, 'infra/deploy/deploy.sh'), 'utf8')).toContain('incoming="$server_maps/.incoming"');
  });

  // why: F-1648 (the server half read BW_MAPS_DIR from the merged .env with its own default; deploy.sh read the record from env.base)
  it('reads the map folder from the BW_MAPS_DIR line deploy.sh staged in env.base, and refuses without one', () => {
    expect(sd).toContain('maps_dir=$(sed -n \'s/^BW_MAPS_DIR=//p\' "$STAGE/env.base" | tail -n 1)');
    expect(sd).toMatch(/if \[ -z "\$maps_dir" \]; then log "REFUSED: the staged env\.base names no BW_MAPS_DIR[^"]*"; exit 1; fi/);
    expect(sd).not.toMatch(/maps_dir="\$\{maps_dir:-/);
  });
});
