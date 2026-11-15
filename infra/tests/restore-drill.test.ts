// SPDX-License-Identifier: AGPL-3.0-or-later
// P8-RESTORE-DRILL: the drill driver (infra/drill/restore-drill.sh) in its dry run, its guard (infra/drill/guard.sh), its record
// (infra/drill/record.ts) and the temp-server.sh additions it uses. The dry run is the real driver and the real temp-server.sh with the
// guard answering from infra/drill/dry-run; aws and ssh on PATH are trap stubs that mark a file when called, so a dry run that reached
// a real tool fails here.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { arms, failures, flags, localTime, parseResults, render, stampTime } from '../drill/record.ts';

const root = path.resolve(import.meta.dirname, '../..');
const driver = path.join(root, 'infra/drill/restore-drill.sh');
const work = mkdtempSync(path.join(tmpdir(), 'bw-drill-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const trapBin = path.join(work, 'trap-bin');
mkdirSync(trapBin);
for (const t of ['aws', 'ssh']) {
  writeFileSync(path.join(trapBin, t), `#!/usr/bin/env bash\necho "$0 $*" >> "${work}/real-tool-called"\nexit 99\n`);
  chmodSync(path.join(trapBin, t), 0o755);
}
const IPV4 = /\b(\d{1,3}\.){3}\d{1,3}\b/;
// F-1605: a run's record path comes from the environment (else the owner file); the dry runs here are given one in the work folder and
// must never write it.
const recordPath = path.join(work, 'run-record', 'P8-RESTORE-DRILL.md');

let n = 0;
/** A dry run in a new state folder, the fixtures optionally changed first. */
function dry(change?: (fixtures: string) => void, env: Record<string, string> = {}) {
  n += 1;
  const state = path.join(work, `state-${n}`);
  const fixtures = path.join(work, `fixtures-${n}`);
  cpSync(path.join(root, 'infra/drill/dry-run'), fixtures, { recursive: true });
  change?.(fixtures);
  const r = spawnSync('bash', [driver, 'dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${trapBin}:${process.env.PATH}`, BW_DRILL_DIR: state, BW_DRILL_FIXTURES: fixtures, BW_DRILL_HOUR: '12', BW_OWNER_ENV: path.join(work, 'no-owner.env'), BW_OWNER_ENV_LOCAL: path.join(work, 'no-owner-local.env'), BW_HOST: deployHost, BW_RESTORE_DRILL_RECORD: recordPath, BW_RESTORE_DRILL_EVIDENCE: path.join(work, 'run-evidence'), ...env },
    timeout: 120_000,
  });
  const read = (f: string) => (existsSync(path.join(state, f)) ? readFileSync(path.join(state, f), 'utf8') : '');
  return { ...r, state, fixtures, read, results: parseResults(read('results.env')), out: r.stdout + r.stderr };
}
const writes = (calls: string) => calls.split('\n').filter((l) => / aws WRITE /.test(l));
// F-1609: the hosted ssh target the dry run is given (BW_HOST, a documentation address): no drill output may hold it.
const deployHost = 'drill@203.0.113.10';
const LIST_CMD = "sudo env AWS_PAGER= aws s3api list-objects-v2 --bucket brightwater-backup-use1 --region us-east-1 --query 'Contents[].[Key,Size,ETag,LastModified]' --output text";

// why: P8-RESTORE-DRILL owner ruling 7b6bf018 the 1 command loads, backs up, restores on a second copy and smokes; every AWS write is on a drill copy and the hosted server and bucket are only read
describe('the dry run', () => {
  // why: F-1686 the dry run swaps in its stand-in host before the BW_HOST check, so it needs no real host
  it('runs with no BW_HOST at all', () => {
    const noHost = dry(undefined, { BW_HOST: '' });
    expect(noHost.status, noHost.out.slice(-1500)).toBe(0);
    expect(noHost.out).not.toContain('no hosted ssh target');
  });
  const r = dry();
  it('passes end to end and writes its record in the state folder, never the repo', () => {
    expect(r.status, r.out.slice(-2000)).toBe(0);
    expect(r.read('P8-RESTORE-DRILL.md')).toMatch(/^Verdict: PASS - /m);
    expect(r.read('P8-RESTORE-DRILL.md')).toMatch(/^DRY RUN: /m);
    expect(existsSync(recordPath)).toBe(false);
    expect(existsSync(path.join(work, 'run-evidence'))).toBe(false);
  });
  // why: F-1605 the record names its evidence folder without a home path (a dry run's is <state>/evidence/)
  it('names the evidence folder as <state>/evidence/ in the record', () => {
    expect(r.read('P8-RESTORE-DRILL.md')).toMatch(/^- Evidence: <state>\/evidence\/ \(/m);
    expect(r.read('P8-RESTORE-DRILL.md')).not.toContain(r.state);
  });
  it('reaches no real aws or ssh', () => {
    expect(existsSync(path.join(work, 'real-tool-called'))).toBe(false);
  });
  it('prints every remote action, the 10 writes all on the 2 drill copies and their key pairs, none sent', () => {
    const calls = r.read('evidence/aws-ssh-calls.log');
    expect(r.out).toMatch(/every remote action of the dry run \(27 aws calls, 10 of them writes; 48 ssh calls, 2 of them READ-ONLY hosted bucket listings; 0 refused; 0 sent\)/);
    expect(calls).not.toMatch(/^\S+ run /m);
    const w = writes(calls);
    expect(w).toHaveLength(10);
    for (const l of w) expect(l).toMatch(/--(instance-names?|key-pair-name) bw-load-p4-\d{8}-small-drill[12](-key)? /);
    expect(w.filter((l) => / create-instances /.test(l)).every((l) => l.includes('key=purpose,value=restore-drill'))).toBe(true);
    expect(calls).not.toMatch(/WRITE .*brightwater-1/);
    expect(calls).not.toMatch(/ aws (read|WRITE) s3/);
  });
  it('lists the bucket on the hosted server twice, READ-ONLY: before any copy exists and after both are deleted', () => {
    const lines = r.read('evidence/aws-ssh-calls.log').split('\n');
    const listed = lines.flatMap((l, i) => (/ ssh hosted READ-ONLY /.test(l) ? [i] : []));
    expect(listed).toHaveLength(2);
    for (const i of listed) expect(lines[i]).toMatch(new RegExp(` dry ssh hosted READ-ONLY ${LIST_CMD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    const firstWrite = lines.findIndex((l) => / aws WRITE /.test(l));
    const lastDelete = lines.map((l) => / aws WRITE lightsail delete-/.test(l)).lastIndexOf(true);
    expect(listed[0]).toBeLessThan(firstWrite);
    expect(listed[1]).toBeGreaterThan(lastDelete);
    expect(lines.filter((l) => / ssh hosted /.test(l) && !/ READ-ONLY /.test(l))).toEqual([]);
    expect(r.out.match(/^DRY-RUN READ-ONLY ssh hosted: sudo env AWS_PAGER= aws s3api list-objects-v2 /gm)).toHaveLength(2);
    expect(r.results.bucket_before_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(r.results.bucket_after_sha).toBe(r.results.bucket_before_sha);
    expect(r.results.bucket_before_count).toBe('2');
    expect(r.read('P8-RESTORE-DRILL.md')).toMatch(/Bucket listing \(key, size, ETag, last modified; sorted\): equal; 2 objects before, SHA-256 [0-9a-f]{64}; 2 after/);
  });
  it('makes each copy before using it and deletes both, so only the hosted server is left', () => {
    expect(r.read('dry/instances').trim().split('\n').map((l) => l.split('\t')[0])).toEqual(['brightwater-1']);
    expect(r.read('dry/keys')).not.toMatch(/drill/);
    expect(r.results.instances_after).toBe('brightwater-1');
    expect(r.results.drill_keys_after).toBe('0');
    expect(r.results.teardown).toBe('ok');
    expect(r.results.bucket_equal).toBe('yes');
    expect(existsSync(path.join(r.state, 'home/Library/LaunchAgents')) ? spawnSync('ls', [path.join(r.state, 'home/Library/LaunchAgents')], { encoding: 'utf8' }).stdout : '').toBe('');
  });
  it('runs every arm with its required exit, the known-bad ones first on each copy', () => {
    expect(arms(r.results).map((a) => `${a.name}:${a.want}:${a.got}`)).toEqual(['backup:0:0', 'restore-test-planted:1:1', 'restore-test:0:0', 'restore:0:0', 'check-planted:1:1', 'smoke:0:0']);
    const order = r.out.split('\n').filter((l) => /drill: .* arm \S+ \(required/.test(l)).map((l) => l.replace(/.* arm (\S+).*/, '$1'));
    expect(order).toEqual(['backup', 'restore-test-planted', 'restore-test', 'restore', 'check-planted', 'smoke']);
  });
  it('records no address, no hosted target and no local path', () => {
    expect(deployHost).toMatch(/@/);
    expect(r.out.includes(deployHost)).toBe(false);
    expect(r.read('bin/hosted-host').includes(deployHost)).toBe(false);
    for (const f of ['P8-RESTORE-DRILL.md', 'evidence/results.env', 'evidence/aws-ssh-calls.log', 'evidence/arm-smoke.events']) {
      expect(r.read(f), f).not.toMatch(IPV4);
      expect(r.read(f).includes(deployHost), f).toBe(false);
      if (f.startsWith('evidence')) expect(r.read(f), f).not.toContain(r.state);
    }
  });
});

// why: F-1607 a dry run moves HOME into its state folder, and git run after that move loses the caller's global config (the push
// runner's safe.directory line for a checkout another user owns), so git exits 128 and the drill stops before its teardown. git here is a
// stand-in that answers only under the caller's own HOME, as git does on that runner; the drill must read the commit before the move.
describe("git is read with the caller's own config (F-1607)", { timeout: 120_000 }, () => {
  it("a git that answers only under the caller's HOME: the dry run still passes and records the commit", () => {
    const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const gitBin = path.join(work, 'git-bin');
    mkdirSync(gitBin);
    writeFileSync(
      path.join(gitBin, 'git'),
      `#!/usr/bin/env bash\n[ "$HOME" = "${process.env.HOME ?? ''}" ] || { echo "fatal: detected dubious ownership (stand-in: git run with a HOME that is not the caller's)" >&2; exit 128; }\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(path.join(gitBin, 'git'), 0o755);
    const r = dry(undefined, { PATH: `${gitBin}:${trapBin}:${process.env.PATH}` });
    expect(r.out).not.toMatch(/dubious ownership/);
    expect(r.status, r.out.slice(-1500)).toBe(0);
    expect(r.results.commit).toMatch(/^[0-9a-f]{12}$/);
  });
});

// why: P8-RESTORE-DRILL a failed step or a known-bad arm that passes still deletes both copies and records FAIL
describe('a failing step still tears down and records FAIL', { timeout: 120_000 }, () => {
  it('the restore exits 1: FAIL names it, both copies are deleted', () => {
    const r = dry((fx) => writeFileSync(path.join(fx, 'restore.sh'), 'echo \'{"event":"check_failed","msg":"compare"}\'\nexit 1\n'));
    expect(r.status).toBe(1);
    expect(r.read('P8-RESTORE-DRILL.md')).toMatch(/^Verdict: FAIL - step restore failed; arm restore exited 1, required 0; arm check-planted did not run/m);
    expect(r.results.instances_after).toBe('brightwater-1');
    expect(r.results.drill_keys_after).toBe('0');
    expect(writes(r.read('evidence/aws-ssh-calls.log')).filter((l) => / delete-instance /.test(l))).toHaveLength(2);
  });
  it('copy 2 fails at its install: copy 2, just made, is deleted with copy 1', () => {
    const r = dry((fx) => writeFileSync(path.join(fx, 'install2.sh'), 'exit 255\n'));
    expect(r.status).toBe(1);
    expect(r.results.failed_step).toBe('install2');
    expect(writes(r.read('evidence/aws-ssh-calls.log')).filter((l) => / delete-instance /.test(l))).toHaveLength(2);
    expect(r.read('dry/instances').trim()).toMatch(/^brightwater-1\t[^\n]*$/);
    expect(r.read('P8-RESTORE-DRILL.md')).toMatch(/^Verdict: FAIL/m);
  });
  it('a known-bad arm that passes is a FAIL (the check would not have caught a bad set)', () => {
    const r = dry((fx) => writeFileSync(path.join(fx, 'check-planted.sh'), 'exit 0\n'));
    expect(r.status).toBe(1);
    expect(r.read('P8-RESTORE-DRILL.md')).toMatch(/arm check-planted exited 0, required 1/);
  });
});

// why: F-1585 web is healthy when up --wait returns, yet the proxy answers 502 until its stale address of web is resolved again (up to
// its 30 s resolver timeout); the drill waits for 200 up to its cap instead of reading 1 answer
describe('healthz on copy 2 after the restore (F-1585)', { timeout: 120_000 }, () => {
  const healthz = (codes: string) => (fx: string) => writeFileSync(path.join(fx, 'healthz2.txt'), codes);
  const deleted = (r: ReturnType<typeof dry>) => writes(r.read('evidence/aws-ssh-calls.log')).filter((l) => / delete-instance /.test(l));
  it('502, 502, then 200: the drill waits, then passes', () => {
    const r = dry(healthz('502\n502\n200\n'));
    expect(r.status, r.out.slice(-1500)).toBe(0);
    expect(r.results.healthz2_tries).toBe('3');
    expect(r.results.healthz2_seconds).toMatch(/^\d+$/);
    expect(r.results.arm_smoke_rc).toBe('0');
    expect(r.read('P8-RESTORE-DRILL.md')).toMatch(/^Verdict: PASS - /m);
    expect(r.read('P8-RESTORE-DRILL.md')).toMatch(/the stack started, healthz 200 after \d+ s and 3 tries; the smoke sign-in/);
  });
  it('no answer (000), 503 and 504 also mean not up yet', () => {
    const r = dry(healthz('000\n503\n504\n200\n'));
    expect(r.status, r.out.slice(-1500)).toBe(0);
    expect(r.results.healthz2_tries).toBe('4');
  });
  it('502 until the cap: FAIL at healthz2, the smoke never runs, both copies deleted', () => {
    const r = dry(healthz('502\n'));
    expect(r.status).toBe(1);
    expect(r.results.failed_step).toBe('healthz2');
    expect(r.results.healthz2_tries).toBe('45');
    expect(r.out).toMatch(/copy 2 still answered 'healthz 502' after \d+ s and 45 tries \(cap 90 s\)/);
    expect(r.read('P8-RESTORE-DRILL.md')).toMatch(/^Verdict: FAIL - step healthz2 failed; arm smoke did not run/m);
    expect(deleted(r)).toHaveLength(2);
    expect(r.results.instances_after).toBe('brightwater-1');
  });
  it('any other answer (500) fails at once, without waiting out the cap', () => {
    const r = dry(healthz('500\n200\n'));
    expect(r.status).toBe(1);
    expect(r.results.failed_step).toBe('healthz2');
    expect(r.results.healthz2_tries).toBe('1');
    expect(r.out).toMatch(/copy 2 answered 'healthz 500'/);
    expect(deleted(r)).toHaveLength(2);
  });
});

// why: P8-RESTORE-DRILL owner answer 1921a7c5 the hosted bucket is proved unchanged by its listing before and after, read on the server
describe('the bucket listing compare', { timeout: 120_000 }, () => {
  const bucket = readFileSync(path.join(root, 'infra/drill/dry-run/bucket.txt'), 'utf8');
  it('1 object added during the drill: FAIL, unequal', () => {
    const r = dry((fx) => writeFileSync(path.join(fx, 'bucket-2.txt'), `${bucket}backups/x/manifest.json\t1\t"e"\t2026-11-14T12:00:00+00:00\n`));
    expect(r.status).toBe(1);
    expect(r.results.bucket_equal).toBe('no');
    expect(r.results.bucket_after_count).toBe('3');
    expect(r.read('P8-RESTORE-DRILL.md')).toMatch(/the bucket listing changed during the drill/);
    expect(r.read('P8-RESTORE-DRILL.md')).toMatch(/: unequal; 2 objects before/);
    expect(r.results.instances_after).toBe('brightwater-1');
  });
  it('1 ETag changed (same keys, sizes and count): FAIL, unequal', () => {
    const changed = bucket.replace('"2c3d"', '"2c3e"');
    expect(changed).not.toBe(bucket);
    const r = dry((fx) => writeFileSync(path.join(fx, 'bucket-2.txt'), changed));
    expect(r.status).toBe(1);
    expect(r.results.bucket_equal).toBe('no');
    expect(r.results.bucket_after_count).toBe(r.results.bucket_before_count);
    expect(r.results.bucket_after_sha).not.toBe(r.results.bucket_before_sha);
  });
  it('the same objects listed in another order: equal (each listing is sorted)', () => {
    const r = dry((fx) => writeFileSync(path.join(fx, 'bucket-2.txt'), bucket.trim().split('\n').reverse().join('\n') + '\n'));
    expect(r.status, r.out.slice(-1500)).toBe(0);
    expect(r.results.bucket_equal).toBe('yes');
  });
  it('the listing before fails: refused before any AWS write (exit 2, no record)', () => {
    const r = dry((fx) => rmSync(path.join(fx, 'bucket.txt')));
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/the bucket listing on the hosted server failed/);
    expect(writes(r.read('calls.log'))).toHaveLength(0);
  });
});

// why: P8-RESTORE-DRILL touches nothing hosted: a hosted change, a leftover drill key, a late hour or a state folder in the repo is refused before any write
describe('refusals before any AWS write (exit 2, no record)', { timeout: 120_000 }, () => {
  it('an instance besides the hosted server', () => {
    const r = dry((fx) => writeFileSync(path.join(fx, 'instances.txt'), 'brightwater-1\tsmall_3_0\trunning\t198.51.100.10\nbw-load-p4-20261113-small-drill1\tsmall_3_0\trunning\t198.51.100.11\n'));
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/the instance list is not the hosted server only/);
    expect(writes(r.read('calls.log'))).toHaveLength(0);
    expect(r.read('P8-RESTORE-DRILL.md')).toBe('');
  });
  it('a drill key pair left over', () => {
    const r = dry((fx) => writeFileSync(path.join(fx, 'keys.txt'), 'brightwater-1-key\nbw-load-p4-20261113-small-drill2-key\n'));
    expect(r.status).toBe(2);
    expect(writes(r.read('calls.log'))).toHaveLength(0);
  });
  it('the hosted backup window (3 AM) and the smoke day boundary (11 PM)', () => {
    for (const h of ['03', '23']) {
      const r = dry(undefined, { BW_DRILL_HOUR: h });
      expect(r.status, h).toBe(2);
      expect(r.read('calls.log'), h).toBe('');
    }
  });
  it('a state folder inside the repo', () => {
    const r = spawnSync('bash', [driver, 'dry-run'], { encoding: 'utf8', env: { ...process.env, BW_DRILL_DIR: path.join(root, '.build', 'drill-state-test') } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/outside the repo/);
    rmSync(path.join(root, '.build', 'drill-state-test'), { recursive: true, force: true });
  });
});

// why: P8-RESTORE-DRILL the guard is the drill's only door to AWS and ssh: hosted names are read-only, writes only on drill names
describe('the guard', () => {
  // A state folder whose bin is the guard in run mode, the real aws and ssh a recorder: a refused call must never reach it.
  const state = path.join(work, 'guard-state');
  const bin = path.join(state, 'bin');
  mkdirSync(path.join(state, 'copy1'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  cpSync(path.join(root, 'infra/drill/guard.sh'), path.join(bin, 'guard.sh'));
  writeFileSync(path.join(bin, 'mode'), 'run\n');
  const hostedHost = 'admin@hosted.example.test';
  writeFileSync(path.join(bin, 'hosted-host'), `${hostedHost}\n`);
  writeFileSync(path.join(bin, 'hosted-key'), '/keys/hosted.pem\n');
  writeFileSync(path.join(bin, 'hosted-list-cmd'), `${LIST_CMD}\n`);
  writeFileSync(path.join(bin, 'fixtures'), path.join(root, 'infra/drill/dry-run'));
  const reached = path.join(state, 'reached');
  writeFileSync(path.join(state, 'recorder'), `#!/usr/bin/env bash\necho "$*" >> "${reached}"\n`);
  chmodSync(path.join(state, 'recorder'), 0o755);
  writeFileSync(path.join(bin, 'real-aws'), path.join(state, 'recorder'));
  writeFileSync(path.join(bin, 'real-ssh'), path.join(state, 'recorder'));
  writeFileSync(path.join(state, 'copy1', 'ip'), '203.0.113.5\n');
  const g = (...args: string[]) => {
    rmSync(reached, { force: true });
    const r = spawnSync('bash', [path.join(bin, 'guard.sh'), ...args], { encoding: 'utf8' });
    return { status: r.status, reached: existsSync(reached), stderr: r.stderr };
  };
  const aws = (...a: string[]) => g('aws', '--profile', 'brightwater', '--region', 'us-east-1', ...a);
  it('refuses every write on the hosted server and the bucket, and anything not on its list', () => {
    const refused = [
      ['s3', 'cp', 'x', 's3://brightwater-backup-use1/x'],
      ['s3', 'ls', 's3://brightwater-backup-use1'],
      ['s3api', 'put-object', '--bucket', 'brightwater-backup-use1', '--key', 'x'],
      ['s3api', 'delete-object', '--bucket', 'brightwater-backup-use1', '--key', 'x'],
      ['s3api', 'list-objects-v2', '--bucket', 'another-bucket'],
      ['s3api', 'list-objects-v2', '--bucket', 'brightwater-backup-use1'],
      ['lightsail', 'delete-instance', '--instance-name', 'brightwater-1'],
      ['lightsail', 'stop-instance', '--instance-name', 'brightwater-1'],
      ['lightsail', 'reboot-instance', '--instance-name', 'brightwater-1'],
      ['lightsail', 'put-instance-public-ports', '--instance-name', 'brightwater-1'],
      ['lightsail', 'delete-key-pair', '--key-pair-name', 'brightwater-1-key'],
      ['lightsail', 'create-instances', '--instance-names', 'bw-load-p4-20261114-small-drill1', '--tags', 'key=purpose,value=load-temporary'],
      ['lightsail', 'create-instances', '--instance-names', 'bw-load-p4-20261114-small-load', '--tags', 'key=purpose,value=restore-drill'],
      ['lightsail', 'delete-instance', '--instance-name', 'bw-load-p4-20261114-small'],
      ['lightsail', 'delete-bucket', '--bucket-name', 'brightwater-backup-use1'],
      ['lightsail', 'create-instance-snapshot', '--instance-name', 'brightwater-1'],
    ];
    for (const a of refused) {
      const r = aws(...a);
      expect(r.status, a.join(' ')).toBe(97);
      expect(r.reached, a.join(' ')).toBe(false);
    }
  });
  // why: F-1681 the AWS CLI acts on the LAST of a repeated option and reads --opt=value, so the guard refuses both and matches the purpose tag only as a --tags value
  it('refuses a call the AWS CLI would read another way than the guard: repeated options, --opt=value, extra words', () => {
    const d1 = 'bw-load-p4-20261114-small-drill1';
    const refused = [
      ['lightsail', 'delete-instance', '--instance-name', d1, '--instance-name', 'brightwater-1'],
      ['lightsail', 'delete-instance', '--instance-name=brightwater-1'],
      ['lightsail', 'delete-instance', `--instance-name=${d1}`],
      ['lightsail', 'delete-instance', '--instance-name', d1, '--cli-input-json', '{"instanceName":"brightwater-1"}'],
      ['lightsail', 'delete-instance', 'brightwater-1', '--instance-name', d1],
      ['lightsail', 'delete-instance', '--instance-name', d1, 'brightwater-1'],
      ['lightsail', 'delete-instance', '-n', 'brightwater-1', '--instance-name', d1],
      ['lightsail', 'delete-instance', '--instance-name', d1, '--', 'brightwater-1'],
      ['lightsail', 'delete-instance', '--instance-name', `${d1}\nbrightwater-1`],
      ['lightsail', 'delete-key-pair', '--key-pair-name', `${d1}-key`, '--key-pair-name', 'brightwater-1-key'],
      ['lightsail', 'put-instance-public-ports', '--instance-name', d1, '--instance-name', 'brightwater-1', '--port-infos', 'fromPort=22,toPort=22,protocol=tcp'],
      ['lightsail', 'create-instances', '--instance-names', d1, 'brightwater-2', '--tags', 'key=purpose,value=restore-drill'],
      ['lightsail', 'create-instances', '--instance-names', d1, '--tags', 'key=purpose,value=load-temporary', '--key-pair-name', 'key=purpose,value=restore-drill'],
      ['lightsail', 'create-instances', '--instance-names', d1, '--tags', 'key=purpose,value=restore-drill', 'key=purpose,value=load-temporary'],
      ['lightsail', 'create-instances', '--instance-names', d1, '--tags', 'key=purpose,value=restore-drill', '--tags', 'key=purpose,value=load-temporary'],
      ['--profile', 'default', 'lightsail', 'get-instances'],
      ['lightsail', 'get-instances', '--region', 'us-west-2'],
      ['--profile=brightwater', 'lightsail', 'get-instances'],
    ];
    for (const a of refused) {
      const r = aws(...a);
      expect(r.status, a.join(' ')).toBe(97);
      expect(r.reached, a.join(' ')).toBe(false);
    }
  });
  // why: F-1681 the stricter reading must still pass every call the drill and temp-server.sh make, in their own shapes
  it('passes the drill calls of temp-server.sh in their exact shapes', () => {
    const d2 = 'bw-load-p4-20261114-small-drill2';
    for (const a of [
      ['lightsail', 'get-instances', '--query', 'instances[].[name,bundleId,state.name,publicIpAddress]', '--output', 'text'],
      ['lightsail', 'create-key-pair', '--key-pair-name', `${d2}-key`, '--tags', 'key=purpose,value=restore-drill', '--query', 'privateKeyBase64', '--output', 'text'],
      ['lightsail', 'create-instances', '--instance-names', d2, '--availability-zone', 'us-east-1a', '--blueprint-id', 'debian_13', '--bundle-id', 'small_3_0',
        '--key-pair-name', `${d2}-key`, '--tags', 'key=expires,value=2026-11-14T20:00:00Z', 'key=purpose,value=restore-drill'],
      ['lightsail', 'get-instance-state', '--instance-name', d2, '--query', 'state.name', '--output', 'text'],
      ['lightsail', 'put-instance-public-ports', '--instance-name', d2, '--port-infos', 'fromPort=22,toPort=22,protocol=tcp,cidrs=198.51.100.7/32', 'fromPort=443,toPort=443,protocol=tcp,cidrs=198.51.100.7/32'],
      ['lightsail', 'get-instance-port-states', '--instance-name', d2, '--query', 'portStates[].[fromPort,state,join(`,`,cidrs)]', '--output', 'text'],
      ['lightsail', 'get-instance-metric-data', '--instance-name', d2, '--metric-name', 'CPUUtilization', '--period', '300', '--start-time', '2026-11-14T18:00:00Z',
        '--end-time', '2026-11-14T19:00:00Z', '--unit', 'Percent', '--statistics', 'Average', '--query', 'metricData[].[timestamp,average]', '--output', 'text'],
      ['lightsail', 'delete-instance', '--instance-name', d2],
      ['lightsail', 'delete-key-pair', '--key-pair-name', `${d2}-key`],
    ]) {
      const r = aws(...a);
      expect(r.status, `${a.join(' ')}\n${r.stderr}`).toBe(0);
      expect(r.reached, a.join(' ')).toBe(true);
    }
  });
  it('refuses another profile or Region', () => {
    expect(g('aws', '--profile', 'default', '--region', 'us-east-1', 'lightsail', 'get-instances').status).toBe(97);
    expect(g('aws', '--profile', 'brightwater', '--region', 'us-west-2', 'lightsail', 'get-instances').status).toBe(97);
    expect(g('aws', 'lightsail', 'get-instances').status).toBe(97);
  });
  it('passes the reads and the drill copies own writes to the real tool', () => {
    for (const a of [
      ['sts', 'get-caller-identity'],
      ['lightsail', 'get-instances'],
      ['lightsail', 'create-instances', '--instance-names', 'bw-load-p4-20261114-small-drill2', '--tags', 'key=expires,value=x', 'key=purpose,value=restore-drill'],
      ['lightsail', 'delete-instance', '--instance-name', 'bw-load-p4-20261114-small-drill1'],
      ['lightsail', 'delete-key-pair', '--key-pair-name', 'bw-load-p4-20261114-small-drill1-key'],
    ]) {
      const r = aws(...a);
      expect(r.status, a.join(' ')).toBe(0);
      expect(r.reached, a.join(' ')).toBe(true);
    }
  });
  it('lets ssh reach the copies only, and logs no address', () => {
    expect(g('ssh', '-i', 'k', 'admin@203.0.113.5', 'true').reached).toBe(true);
    const other = g('ssh', '-i', 'k', 'admin@203.0.113.9', 'true');
    expect(other.status).toBe(97);
    expect(other.reached).toBe(false);
    expect(other.stderr).not.toMatch(IPV4);
    expect(readFileSync(path.join(state, 'calls.log'), 'utf8')).not.toMatch(IPV4);
  });
  const listing = ['-n', '-i', '/keys/hosted.pem', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', hostedHost, LIST_CMD];
  it('lets ssh reach the hosted server for the exact READ-ONLY bucket listing only', () => {
    const ok = g('ssh', ...listing);
    expect(ok.status).toBe(0);
    expect(ok.reached).toBe(true);
    const refused: string[][] = [
      listing.slice(0, -1).concat('true'),
      listing.slice(0, -1).concat('sudo aws s3 rm s3://brightwater-backup-use1/backups/x'),
      listing.slice(0, -1).concat(`${LIST_CMD}; touch /tmp/x`),
      listing.slice(0, -1).concat(LIST_CMD.replace('list-objects-v2', 'get-object')),
      listing.slice(1),
      ['-i', '/keys/other.pem', ...listing.slice(3)],
      ['-o', 'ProxyCommand=x', ...listing],
      [...listing, 'extra'],
      [hostedHost, LIST_CMD],
    ];
    for (const a of refused) {
      const r = g('ssh', ...a);
      expect(r.status, a.join(' ')).toBe(97);
      expect(r.reached, a.join(' ')).toBe(false);
    }
  });
  // why: F-1692 ssh connects to its FIRST non-option word and reads options before and after it, so the guard parses the words as
  // OpenSSH does, allows only the callers' options, and admits only a drill copy (or the exact hosted listing) as the destination
  it('refuses an ssh call that OpenSSH would send somewhere else than a drill copy', () => {
    const copy1 = 'admin@203.0.113.5';
    const legit = ['-n', '-i', 'k', copy1, 'true'];
    const ok = g('ssh', ...legit);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.reached).toBe(true);
    const refused: string[][] = [
      ['-n', hostedHost, copy1, 'true'],
      ['-n', 'admin@brightwater.example.test', copy1, 'true'],
      ['-n', 'root@203.0.113.5', copy1, 'true'],
      ['-n', '203.0.113.5', 'true'],
      ['-n', 'ssh://admin@203.0.113.5', 'true'],
      ['-l', 'root', '-i', 'k', copy1, 'true'],
      ['-i', 'k', copy1, '-l', 'root', 'true'],
      ['-nl', 'root', copy1, 'true'],
      ['-J', hostedHost, '-i', 'k', copy1, 'true'],
      ['-i', 'k', '-o', 'Hostname=bw.example.test', copy1, 'true'],
      ['-i', 'k', copy1, '-o', 'Hostname=bw.example.test', 'true'],
      ['-oHostName=bw.example.test', copy1, 'true'],
      ['-o', ' hostname bw.example.test', copy1, 'true'],
      ['-o', 'User=root', copy1, 'true'],
      ['-o', 'ProxyJump=admin@bw.example.test', copy1, 'true'],
      ['-o', 'ProxyCommand=ssh admin@bw.example.test -W %h:%p', copy1, 'true'],
      ['-o', 'BatchMode=yes\nHostname=bw.example.test', copy1, 'true'],
      ['-F', '/tmp/other-config', copy1, 'true'],
      ['-W', 'bw.example.test:22', copy1],
      ['-p', '2222', copy1, 'true'],
      ['--', copy1, 'true'],
      ['-i', 'k', copy1, '--', 'true'],
      ['-n', '-i'],
      ['-n', '-i', 'k'],
    ];
    for (const a of refused) {
      const r = g('ssh', ...a);
      expect(r.status, a.join(' ')).toBe(97);
      expect(r.reached, a.join(' ')).toBe(false);
    }
  });
  // why: F-1692 the stricter reading must still pass the copy calls of temp-server.sh in their own shapes, and log the whole command
  it('passes the copy ssh calls of temp-server.sh in their exact shapes', () => {
    const remote = ['-i', '/state/copy1/key.pem', '-o', 'UserKnownHostsFile=/state/copy1/known_hosts', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ServerAliveInterval=30', 'admin@203.0.113.5'];
    for (const a of [
      [...remote, 'true'],
      [...remote, 'sudo', 'docker', 'version', '--format', '{{.Server.Version}}'],
      [...remote, 'sudo', 'bash', '-s'],
      [...remote, 'sudo install -d -m 755 /opt/bw-drill && sudo tar -C /opt/bw-drill -xzf -'],
      ['-ni', 'k', '-oBatchMode=yes', 'admin@203.0.113.5', 'true'],
    ]) {
      const r = g('ssh', ...a);
      expect(r.status, `${a.join(' ')}\n${r.stderr}`).toBe(0);
      expect(r.reached, a.join(' ')).toBe(true);
    }
    expect(readFileSync(path.join(state, 'calls.log'), 'utf8')).toMatch(/ run ssh copy1 sudo docker version --format \{\{\.Server\.Version\}\}\n/);
  });
  it('writes the hosted target as <hosted>, never its name', () => {
    const calls = readFileSync(path.join(state, 'calls.log'), 'utf8');
    expect(calls).toMatch(/ run ssh hosted READ-ONLY sudo env AWS_PAGER= aws s3api list-objects-v2 /);
    expect(calls).toMatch(/REFUSED ssh .*<hosted>/);
    expect(calls).not.toContain('hosted.example.test');
  });
});

// why: P8-RESTORE-DRILL the drill's compare query is the restore test's own, so the drill checks what the real script checks
describe('the drill scripts beside the restore test', () => {
  it('compare.sql is the body of restore-test.sh step 4', () => {
    const rt = readFileSync(path.join(root, 'infra/backup/restore-test.sh'), 'utf8');
    const heredoc = /cat <<'SQL'\n([\s\S]*?)\nSQL\n/.exec(rt)?.[1];
    expect(heredoc).toBeTruthy();
    const body = readFileSync(path.join(root, 'infra/drill/compare.sql'), 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n').trim();
    expect(body).toBe(heredoc!.trim());
  });
});

// why: F-1582 the sets made before F-1579 carry key-only checksums and no method mark; every checker computes the restored side by
// the method its manifest names. The behavior (old and new sets clean, a 1-row change failing under each method, an unknown method
// refused) runs against real PostgreSQL in infra/backup/tests/backup.stack.test.ts "checksum methods (F-1582)"; these pin the wiring.
describe('checksum methods (F-1582)', () => {
  const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
  const sqlBody = (f: string) => read(f).split('\n').filter((l) => !l.startsWith('--')).join('\n');
  it('checksums.sql knows exactly key-only-v1 (no field) and full-row-v2, and new backups write full-row-v2', () => {
    const s = sqlBody('infra/backup/checksums.sql');
    expect(s).toMatch(/bw_checksum_method_written\(\) RETURNS text LANGUAGE sql IMMUTABLE AS \$fn\$ SELECT 'full-row-v2' \$fn\$/);
    expect(s).toMatch(/CASE WHEN m \? 'checksum_method' THEN m->>'checksum_method' ELSE 'key-only-v1' END/);
    expect(s).toMatch(/IF v IS NULL OR v NOT IN \('key-only-v1', 'full-row-v2'\) THEN\s+RAISE EXCEPTION 'unknown checksum method/);
    // 1 table loop for both methods, the full-row settings on its 1 wrapper only.
    expect(s.match(/FOR t IN/g)).toHaveLength(1);
    expect(s.match(/SET "TimeZone"/g)).toHaveLength(1);
    expect(s).toMatch(/bw_checksums_full_row\(\) RETURNS jsonb LANGUAGE sql\s+SET "TimeZone"/);
  });
  it('the compare (restore test and drill) uses the manifest\'s method and backup.sh records the method it wrote', () => {
    expect(sqlBody('infra/drill/compare.sql')).toContain("c AS (SELECT pg_temp.bw_checksums(pg_temp.bw_checksum_method(:'m'::jsonb)) AS t)");
    expect(read('infra/backup/restore-test.sh')).toMatch(/psql_ restore_check -v m="\$manifest" 2>"\$WORK\/compare.err"\)" \|\| cmp_rc=\$\?/);
    const b = read('infra/backup/backup.sh');
    expect(b).toContain('SELECT pg_temp.bw_checksum_method_written() AS method, pg_temp.bw_checksums(pg_temp.bw_checksum_method_written()) AS t');
    expect(b).toContain("'checksum_method', method, 'tables', t");
    expect(b).not.toMatch(/bw_checksums\(\)/);
  });
  // why: F-1686 a psql error in the compare is a failed compare event (restore-test.sh's cmp_rc), never a bare exit 3 with no failed event
  it('restore-copy.sh captures the compare psql exit and fails the compare on it', () => {
    const rc = read('infra/drill/restore-copy.sh');
    expect(rc).toMatch(/psql_ "\$BW_DB_NAME" -v m="\$manifest" 2>"\$WORK\/compare.err"\)" \|\| cmp_rc=\$\?/);
    expect(rc).toMatch(/if \[ "\$cmp_rc" -ne 0 \]; then check compare 0 "the compare stopped \(psql exit \$cmp_rc\)[^\n]*stop_failed; fi/);
  });
  it('restore-copy.sh refuses an unknown method (exit 2) before anything is restored', () => {
    const rc = read('infra/drill/restore-copy.sh');
    const refuse = rc.indexOf('|| die "refused: $(sed -n \'s/^.*ERROR: *//p\' "$WORK/method.err"');
    expect(refuse).toBeGreaterThan(0);
    expect(refuse).toBeLessThan(rc.indexOf('if [ "$cmd" = restore ]; then'));
    expect(rc.slice(refuse, rc.indexOf('\n', refuse))).toMatch(/ 2$/);
  });
  it('the drill ships checksums.sql to the copies with the scripts', () => {
    expect(read('infra/drill/restore-drill.sh')).toMatch(/tar -czf - backup\/\*\.sh backup\/\*\.sql drill\/restore-copy\.sh drill\/compare\.sql/);
  });
});

// why: P8-RESTORE-DRILL temp-server.sh tags drill copies and never runs the drill steps on the hosted server
describe('temp-server.sh additions (P8)', () => {
  const ts = path.join(root, 'infra/load/temp-server.sh');
  const tsState = mkdtempSync(path.join(work, 'ts-'));
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('bash', [ts, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${trapBin}:${process.env.PATH}`, BW_LOAD_DIR: tsState, ...env } });
  it('refuses a bad name tag or purpose before any cloud call', () => {
    expect(run(['create'], { BW_LOAD_NAME_TAG: 'Drill_1' }).status).toBe(2);
    expect(run(['create'], { BW_LOAD_PURPOSE: 'Bad Purpose' }).status).toBe(2);
    expect(existsSync(path.join(work, 'real-tool-called'))).toBe(false);
  });
  it('never runs fresh, compose or remote on the hosted server', () => {
    writeFileSync(path.join(tsState, 'target'), 'hosted\n');
    for (const s of ['fresh', 'compose', 'remote']) {
      const r = run([s, 'ps']);
      expect(r.status, s).toBe(2);
      expect(r.stderr, s).toMatch(/never runs on the hosted server/);
    }
    expect(existsSync(path.join(work, 'real-tool-called'))).toBe(false);
  });
});

// why: P8-RESTORE-DRILL D-13 the measured record passes only when every line holds and shows owner-zone times
describe('record.ts', () => {
  const pass = parseResults(readFileSync(path.join(root, 'infra/drill/dry-run/README.md'), 'utf8')); // no key=value lines: empty
  const good: Record<string, string> = {
    mode: 'run', started_epoch: '1763130000', ended_epoch: '1763133000', instances_before: 'brightwater-1', instances_after: 'brightwater-1',
    drill_keys_after: '0', teardown: 'ok', bucket_equal: 'yes', set_stamp: '20261114T150000Z',
    ...Object.fromEntries(['backup', 'restore_test_planted', 'restore_test', 'restore', 'check_planted', 'smoke'].flatMap((k) => [[`arm_${k}_want`, k.endsWith('planted') ? '1' : '0'], [`arm_${k}_rc`, k.endsWith('planted') ? '1' : '0']])),
  };
  it('passes only when every line holds', () => {
    expect(pass).toEqual({});
    expect(failures(good)).toEqual([]);
    expect(render(good)).toMatch(/^Verdict: PASS - /m);
    expect(render(good)).not.toMatch(/DRY RUN/);
    expect(failures({ ...good, instances_after: 'brightwater-1,bw-load-p4-20261114-small-drill2' })[0]).toMatch(/instances after are not the hosted server only/);
    expect(failures({ ...good, drill_keys_after: '1' })[0]).toMatch(/drill key pairs left/);
    expect(failures({ ...good, teardown: 'failed' })[0]).toMatch(/teardown did not finish/);
    expect(failures({ ...good, bucket_equal: '' })[0]).toMatch(/not compared/);
    expect(failures({ ...good, bucket_equal: 'no' })).toEqual(['the bucket listing changed during the drill']);
    expect(render({ ...good, bucket_equal: 'no' })).toMatch(/after \(unequal\)/);
    expect(render(good)).toMatch(/after \(equal\)/);
    expect(render(good)).not.toMatch(/a changed value outside a key is not seen/);
    const noSmoke = { ...good };
    delete noSmoke.arm_smoke_rc;
    expect(failures(noSmoke)).toEqual(['arm smoke did not run']);
  });
  // why: F-1584 (the drill read an empty hosted bucket, 0 objects before and after, and recorded it as a plain "unchanged")
  it('names an empty bucket listing as empty and flags it, without changing the verdict', () => {
    const empty = { ...good, bucket_before_count: '0', bucket_after_count: '0' };
    expect(flags(good)).toEqual([]);
    expect(render(good)).not.toMatch(/^Flagged:/m);
    expect(render({ ...good, bucket_before_count: '14', bucket_after_count: '14' })).not.toMatch(/^Flagged:|empty/m);
    expect(failures(empty)).toEqual([]);
    const out = render(empty);
    expect(out).toMatch(/^Verdict: PASS - .*listing is unchanged and empty \(0 objects before and 0 after\)/m);
    expect(out).toMatch(/^Flagged: the hosted bucket held 0 objects before and after the drill: .*owner ruling 1c7bcc42.*after P8-UNLOCK it means hosted backups are not landing/m);
    expect(out).toMatch(/^- Bucket listing .*: equal, EMPTY \(flagged above\); 0 objects before/m);
    expect(flags({ ...good, bucket_before_count: '14', bucket_after_count: '0', bucket_equal: 'no' })[0]).toMatch(/held 0 objects after the drill/);
    expect(flags({ ...good, bucket_before_count: '' })).toEqual([]); // not read is not empty
  });
  it('shows times in the owner zone, labeled', () => {
    expect(localTime(1763136000)).toBe('Nov 14, 2025, 11:00:00 AM EST');
    expect(stampTime('20260701T160000Z')).toBe('Jul 1, 2026, 12:00:00 PM EDT');
    expect(render(good)).toMatch(/Date measured: .* EST to .* EST \(50\.0 min\)/);
  });
});
