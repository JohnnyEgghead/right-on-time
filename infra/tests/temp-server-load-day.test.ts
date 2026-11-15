// SPDX-License-Identifier: AGPL-3.0-or-later
// P7-LOAD: the load-day copy's bring-up, its key pair, its delete backstop and run-day's stop path, and NFR-13's memory count.
// temp-server.sh and run-day.sh run for real with stubs on PATH (ssh, aws, curl, docker, launchctl, node) that record what they are
// sent: no server, no cloud call, no launchd job. Every case runs on every host (F-1548): the script reads times with BSD date on the
// owner's Mac (D16) and GNU date in the CI image.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytesOf, capsOf, fromCgroupLog, fromStatsLog, loadDayMemory } from '../load/load-day-memory.ts';

const root = path.resolve(import.meta.dirname, '../..');
const script = path.join(root, 'infra/load/temp-server.sh');
const runDay = path.join(root, 'infra/load/run-day.sh');
let work: string;
let state: string;
let log: string;

const stub = (name: string, body: string): void => {
  writeFileSync(path.join(work, 'bin', name), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(work, 'bin', name), 0o755);
};

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'bw-load-day-'));
  state = path.join(work, 'state');
  log = path.join(work, 'calls.txt');
  mkdirSync(path.join(work, 'bin'));
  mkdirSync(state);
  writeFileSync(path.join(state, 'ip'), '192.0.2.1');
  writeFileSync(path.join(state, 'key.pem'), 'x');
  // ssh: logs the remote command (its last argument) and drains stdin; BW_STUB_SLOW makes a command matching it hang.
  stub('ssh', 'for a; do last="$a"; done\nprintf "ssh %s\\n" "$last" >> "$BW_STUB_LOG"\ncase "$last" in *"$BW_STUB_SLOW"*) [ -n "$BW_STUB_SLOW" ] && sleep 30 ;; esac\ncat > /dev/null 2>&1 || true');
  // aws: logs the call; answers like Lightsail for the calls the steps read.
  stub('aws', [
    'printf "aws %s\\n" "$*" >> "$BW_STUB_LOG"',
    'case "$*" in',
    // Lightsail keeps one namespace across resource types (F-1442): a name that is a key pair cannot also be an instance.
    '  *create-key-pair*) n="$(echo "$*" | sed "s/.*--key-pair-name \\([^ ]*\\).*/\\1/")"; echo "$n" >> "$BW_STUB_DIR/keys"; printf "%s\\n" "-----BEGIN RSA PRIV""ATE KEY-----" "stub" "-----END RSA PRIV""ATE KEY-----" ;;',
    '  *create-instances*) n="$(echo "$*" | sed "s/.*--instance-names \\([^ ]*\\).*/\\1/")"; if grep -qx "$n" "$BW_STUB_DIR/keys" 2>/dev/null; then echo "InvalidInputException: Some names are already in use: $n" >&2; exit 254; fi; [ -f "$BW_STUB_DIR/fail-create" ] && { echo "LimitExceeded" >&2; exit 254; }; true ;;',
    '  *delete-key-pair*) n="$(echo "$*" | sed "s/.*--key-pair-name \\([^ ]*\\).*/\\1/")"; grep -vx "$n" "$BW_STUB_DIR/keys" > "$BW_STUB_DIR/keys.new" 2>/dev/null; mv "$BW_STUB_DIR/keys.new" "$BW_STUB_DIR/keys" 2>/dev/null; true ;;',
    '  *get-instance-state*) echo running ;;',
    '  *"get-instance "*) echo 192.0.2.1 ;;',
    '  *delete-instance*) touch "$BW_STUB_DIR/deleted" ;;',
    '  *get-instances*) [ -f "$BW_STUB_DIR/deleted" ] || cat "$BW_STUB_DIR/name" 2>/dev/null; echo "other-instance small_3_0 running" ;;',
    '  *get-key-pairs*) echo other-key; cat "$BW_STUB_DIR/keys" 2>/dev/null ;;',
    'esac',
  ].join('\n'));
  stub('curl', 'echo 198.51.100.7');
  stub('docker', 'printf "docker %s\\n" "$*" >> "$BW_STUB_LOG"; [ "$1" = save ] && echo image || true');
  stub('launchctl', 'printf "launchctl %s\\n" "$*" >> "$BW_STUB_LOG"');
  stub('node', 'printf "node %s\\n" "$*" >> "$BW_STUB_LOG"; sleep 30');
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env, PATH: `${path.join(work, 'bin')}:${process.env.PATH}`, HOME: work, BW_LOAD_DIR: state, BW_STUB_LOG: log, BW_STUB_DIR: work,
  BW_LOAD_DELETE_WAIT: '0', ...over,
});
const step = (args: string[], over: Record<string, string> = {}) => spawnSync('bash', [script, ...args], { env: env(over), encoding: 'utf8' });
const calls = (): string => (existsSync(log) ? readFileSync(log, 'utf8') : '');

describe('temp-server.sh deploy', () => {
  // why: F-1440 the load-day bring-up starts routing with the rest of the stack, at the .env's 320m (D-21)
  it('starts routing with proxy, web, worker, pbs and db, and writes the 320m routing cap into the .env', () => {
    const data = path.join(work, 'data');
    for (const d of ['generator', 'maps']) mkdirSync(path.join(data, d), { recursive: true });
    writeFileSync(path.join(data, 'street-list.json'), '[]');
    const r = step(['deploy'], { BW_LOAD_IMAGE: 'bw-test:amd64', BW_LOAD_DATA: data });
    expect(r.status, r.stderr).toBe(0);
    const up = calls().split('\n').filter((l) => / up -d /.test(l));
    expect(up).toHaveLength(1);
    expect(up[0]).toMatch(/up -d --no-build --wait --wait-timeout 180 proxy web worker pbs db routing$/);
    expect(readFileSync(script, 'utf8')).toMatch(/echo 'ROUTING_MEM_LIMIT=320m'/);
    // deploy's cap.yaml overrides nothing, so routing runs at the .env's cap
    expect(calls()).toMatch(/ssh cat > \/opt\/bw-load\/infra\/cap\.yaml/);
    expect(readFileSync(script, 'utf8')).toContain("echo 'services: {}' | remote 'cat > /opt/bw-load/infra/cap.yaml'");
  });
});

describe('temp-server.sh create and the delete backstop', () => {
  // why: F-899 the throwaway copy gets a key pair made for it, never the account's default key (the hosted server's login)
  it('makes the instance with its own key pair and never downloads the default key', () => {
    const r = step(['create']);
    expect(r.status, r.stderr).toBe(0);
    const name = readFileSync(path.join(state, 'instance-name'), 'utf8').trim();
    const keyName = readFileSync(path.join(state, 'key-pair-name'), 'utf8').trim();
    expect(keyName).not.toBe(name);
    expect(calls()).toMatch(new RegExp(`aws .*lightsail create-key-pair --key-pair-name ${keyName} `));
    expect(calls()).toMatch(new RegExp(`aws .*lightsail create-instances .*--key-pair-name ${keyName} `));
    expect(calls()).not.toMatch(/download-default-key-pair/);
    expect(readFileSync(path.join(state, 'key.pem'), 'utf8')).toContain('BEGIN RSA PRIVATE KEY');
    expect(readFileSync(script, 'utf8')).not.toMatch(/download-default-key-pair/);
  });

  // why: F-900 a launchd job of this user runs the delete step at the expiry the instance is tagged with, from a copy of the script
  it('installs a backstop that deletes the instance at its expiry tag, in this Mac\'s time', () => {
    const r = step(['create']);
    expect(r.status, r.stderr).toBe(0);
    const name = readFileSync(path.join(state, 'instance-name'), 'utf8').trim();
    const expires = /key=expires,value=(\S+)/.exec(calls())![1]!;
    const label = `io.bw.load-backstop.${name}`;
    const plist = readFileSync(path.join(work, 'Library/LaunchAgents', `${label}.plist`), 'utf8');
    expect(plist).toContain(`<string>${path.join(state, 'temp-server.sh')}</string><string>delete</string>`);
    expect(plist).toContain(`<key>BW_LOAD_DIR</key><string>${state}</string>`);
    const at = new Date(expires.replace(/Z$/, ':00Z'));
    for (const [k, v] of [['Month', at.getMonth() + 1], ['Day', at.getDate()], ['Hour', at.getHours()], ['Minute', at.getMinutes()]] as const) {
      expect(plist).toContain(`<key>${k}</key><integer>${v}</integer>`);
    }
    expect(calls()).toMatch(new RegExp(`launchctl bootstrap gui/\\d+ .*${label}\\.plist`));
    expect(readFileSync(path.join(state, 'temp-server.sh'), 'utf8')).toBe(readFileSync(script, 'utf8'));
  });

  // why: F-899, F-900 the delete step deletes the instance and its key pair, proves both gone from the provider's lists, and removes the backstop
  it('deletes the instance and its key pair, then removes the backstop', () => {
    expect(step(['create']).status).toBe(0);
    const name = readFileSync(path.join(state, 'instance-name'), 'utf8').trim();
    const keyName = readFileSync(path.join(state, 'key-pair-name'), 'utf8').trim();
    writeFileSync(path.join(work, 'name'), `${name} small_3_0 running`);
    const r = step(['delete']);
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toMatch(new RegExp(`delete-instance --instance-name ${name}`));
    expect(calls()).toMatch(new RegExp(`delete-key-pair --key-pair-name ${keyName}`));
    expect(calls()).toMatch(/get-key-pairs/);
    expect(readFileSync(path.join(work, 'keys'), 'utf8').trim()).toBe('');
    expect(existsSync(path.join(work, 'Library/LaunchAgents', `io.bw.load-backstop.${name}.plist`))).toBe(false);
    expect(existsSync(path.join(state, 'key.pem'))).toBe(false);
    expect(calls()).toMatch(new RegExp(`launchctl bootout gui/\\d+/io\\.bw\\.load-backstop\\.${name}`));
  });

  // why: F-1548 the backstop reads only the expiry form create tags (as BSD date -j -f does), so GNU date's looser reading arms no job
  it.each(['tomorrow', '2026-11-14 03:05', '2026-11-14T03:05:00Z'])('refuses the expiry %s and arms no job', (v) => {
    writeFileSync(path.join(state, 'instance-name'), 'bw-load-p4-20261114-small');
    const r = step(['backstop', v]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not an expiry as create tags it/);
    expect(calls()).not.toMatch(/launchctl /);
    expect(existsSync(path.join(work, 'Library/LaunchAgents'))).toBe(false);
  });
});

describe('temp-server.sh BW_LOAD_BACKSTOP_HOURS', () => {
  const hoursAhead = (expires: string): number => (new Date(expires.replace(/Z$/, ':00Z')).getTime() - Date.now()) / 3_600_000;
  const plistFire = (): string => {
    const name = readFileSync(path.join(state, 'instance-name'), 'utf8').trim();
    return readFileSync(path.join(work, 'Library/LaunchAgents', `io.bw.load-backstop.${name}.plist`), 'utf8');
  };
  // why: F-900 with the variable unset the expiry stays 16 hours out, as before
  it('expires in 16 hours when the variable is unset', () => {
    const r = step(['create'], { BW_LOAD_BACKSTOP_HOURS: '' });
    expect(r.status, r.stderr).toBe(0);
    const h = hoursAhead(/key=expires,value=(\S+)/.exec(calls())![1]!);
    expect(h).toBeGreaterThan(15.9);
    expect(h).toBeLessThanOrEqual(16);
  });

  // why: F-900 BW_LOAD_BACKSTOP_HOURS=40 moves both the expiry tag and the launchd backstop's fire time to 40 hours out
  it('uses 40 hours for the tag and the backstop', () => {
    const r = step(['create'], { BW_LOAD_BACKSTOP_HOURS: '40' });
    expect(r.status, r.stderr).toBe(0);
    const expires = /key=expires,value=(\S+)/.exec(calls())![1]!;
    const h = hoursAhead(expires);
    expect(h).toBeGreaterThan(39.9);
    expect(h).toBeLessThanOrEqual(40);
    const at = new Date(expires.replace(/Z$/, ':00Z'));
    const plist = plistFire();
    for (const [k, v] of [['Month', at.getMonth() + 1], ['Day', at.getDate()], ['Hour', at.getHours()], ['Minute', at.getMinutes()]] as const) {
      expect(plist).toContain(`<key>${k}</key><integer>${v}</integer>`);
    }
  });
});

describe('temp-server.sh BW_LOAD_BACKSTOP_HOURS refused', () => {
  // why: F-900 a length that is not a whole number from 1 to 48 is refused before any cloud call, so no server can outlive a wrong backstop
  it.each(['0', '49', 'abc', '-3', '1.5', '100'])('refuses %s before any aws call', (v) => {
    const r = step(['create'], { BW_LOAD_BACKSTOP_HOURS: v });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/BW_LOAD_BACKSTOP_HOURS must be a whole number from 1 to 48/);
    expect(calls()).not.toMatch(/aws |launchctl /);
  });
});

describe('temp-server.sh create when the provider refuses the instance', () => {
  // why: F-1442 a failed create-instances leaves no billable or leftover resource: the key pair made a step earlier is deleted
  it('deletes the key pair it made and exits non-zero', () => {
    writeFileSync(path.join(work, 'fail-create'), '');
    const r = step(['create']);
    expect(r.status).not.toBe(0);
    expect(calls()).toMatch(/create-key-pair/);
    expect(calls()).toMatch(/delete-key-pair --key-pair-name bw-load-p4-\d+-small-key/);
    expect(readFileSync(path.join(work, 'keys'), 'utf8').trim()).toBe('');
    expect(existsSync(path.join(state, 'key.pem'))).toBe(false);
    expect(calls()).not.toMatch(/launchctl bootstrap/);
  });

  // why: F-1442 the stub refuses an instance whose name is already a key pair, as Lightsail does
  it('the stubbed provider rejects an instance named like an existing key pair', () => {
    writeFileSync(path.join(work, 'keys'), 'bw-load-p4-x\n');
    const r = spawnSync('aws', ['lightsail', 'create-instances', '--instance-names', 'bw-load-p4-x'], { env: env(), encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/names are already in use/);
  });
});

describe('temp-server.sh delete without a backstop', () => {
  // why: F-1442 a state folder from the first version (key pair named like the instance, no key-pair-name file) is still cleaned up
  it('deletes the key pair named like the instance when the state folder has no key-pair-name file', () => {
    writeFileSync(path.join(state, 'instance-name'), 'bw-load-p4-20261111-small');
    writeFileSync(path.join(work, 'keys'), 'bw-load-p4-20261111-small\n');
    const r = step(['delete']);
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toMatch(/delete-key-pair --key-pair-name bw-load-p4-20261111-small$/m);
    expect(readFileSync(path.join(work, 'keys'), 'utf8').trim()).toBe('');
  });

  // why: F-1442 the delete is safe to repeat once the instance and key pair are gone
  it('is safe to repeat', () => {
    writeFileSync(path.join(state, 'instance-name'), 'bw-load-p4-20261111-small');
    writeFileSync(path.join(state, 'key-pair-name'), 'bw-load-p4-20261111-small-key');
    expect(step(['delete']).status).toBe(0);
    writeFileSync(path.join(state, 'instance-name'), 'bw-load-p4-20261111-small');
    expect(step(['delete']).status).toBe(0);
  });

  // why: F-899 the delete fails loudly when the provider still lists the instance
  it('fails when the instance is still listed after the delete', () => {
    writeFileSync(path.join(state, 'instance-name'), 'bw-load-p4-20261111-small');
    stub('aws', 'printf "aws %s\\n" "$*" >> "$BW_STUB_LOG"; case "$*" in *get-instances*) echo "bw-load-p4-20261111-small small_3_0 running" ;; esac');
    const r = step(['delete']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/still listed/);
  });
});

describe('run-day.sh stopped by a signal', () => {
  // why: F-900 on TERM the collect is cut at its limit, so the delete runs inside a supervisor's grace period
  it('cuts a hanging collect and still deletes', async () => {
    writeFileSync(path.join(state, 'instance-name'), 'bw-load-p4-20261111-small');
    const child = spawn('bash', [runDay, 'main', '1', '1', '60', '0', 'on'], { env: env({ BW_LOAD_STOP_COLLECT_SECONDS: '2', BW_STUB_SLOW: 'bw-vmstat.log' }) });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    for (let i = 0; i < 100 && !calls().includes('node '); i++) await new Promise((r) => setTimeout(r, 50));
    const t0 = performance.now();
    child.kill('SIGTERM');
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    expect(code).toBe(143);
    expect(performance.now() - t0).toBeLessThan(15_000);
    expect(out).toMatch(/collect cut at its limit/);
    expect(calls()).toMatch(/delete-instance --instance-name bw-load-p4-20261111-small/);
    // the load script was started with the P7-LOAD flags run-day passes through
    expect(calls()).toMatch(/--task P4-LOAD --pages off --page-cert /);
  }, 20_000);
});

describe('run-day.sh and the routing arm (F-1498)', () => {
  // why: F-1498 BW_LOAD_ROUTING picks the arm: off stops the routing service before the chunk and tells the load script, so its runs say which arm they are
  it('stops routing for the off arm and passes the arm to the load script', async () => {
    writeFileSync(path.join(state, 'instance-name'), 'bw-load-p4-20261111-small');
    const child = spawn('bash', [runDay, 'norouting', '1', '1', '60', '0', 'on'], { env: env({ BW_LOAD_ROUTING: 'off', BW_LOAD_STOP_COLLECT_SECONDS: '1' }) });
    for (let i = 0; i < 100 && !calls().includes('node '); i++) await new Promise((r) => setTimeout(r, 50));
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    const c = calls();
    expect(c).toMatch(/ssh sudo docker compose -p bw-p4-load .* stop routing\n/);
    expect(c.indexOf(' stop routing')).toBeLessThan(c.indexOf('node '));
    expect(c).toMatch(/node .*--routing off/);
    expect(c).not.toMatch(/up -d --no-build --wait --wait-timeout 180 routing/);
  }, 20_000);

  // why: F-1498 the default arm is routing up at the .env's cap (D-21), started if it is not
  it('starts routing for the on arm', async () => {
    writeFileSync(path.join(state, 'instance-name'), 'bw-load-p4-20261111-small');
    const child = spawn('bash', [runDay, 'main', '1', '1', '60', '0', 'on'], { env: env({ BW_LOAD_STOP_COLLECT_SECONDS: '1' }) });
    for (let i = 0; i < 100 && !calls().includes('node '); i++) await new Promise((r) => setTimeout(r, 50));
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    expect(calls()).toMatch(/up -d --no-build --wait --wait-timeout 180 routing\n/);
    expect(calls()).toMatch(/node .*--routing on/);
  }, 20_000);

  // why: F-1498 an arm that is neither on nor off starts nothing
  it('refuses an unknown arm before any call', () => {
    const r = spawnSync('bash', [runDay, 'main', '1', '1', '60', '0', 'on'], { env: env({ BW_LOAD_ROUTING: 'maybe' }), encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(calls()).toBe('');
    expect(step(['routing-arm', 'maybe']).status).toBe(2);
  });
});

describe('temp-server.sh collect (F-1498)', () => {
  // why: F-1498 the collect keeps the route signal's lines, the stored legs by kind and the whole of /proc/meminfo
  it('collects the route signal lines, the live and baked leg rows and the full meminfo', () => {
    writeFileSync(path.join(state, 'instance-name'), 'bw-load-p4-20261111-small');
    const r = step(['collect', 't']);
    expect(r.status, r.stderr).toBe(0);
    const c = calls();
    expect(c).toMatch(/ssh sudo docker compose -p bw-p4-load .* logs --no-color --timestamps web worker 2>&1 \| grep -F 'live route failed'\n/);
    expect(c).toMatch(/build_id = 'live' .* from world\.van_track group by 1/);
    expect(c).toMatch(/ssh free -b; cat \/proc\/meminfo\n/);
    expect(c).not.toMatch(/meminfo \| head/);
    expect(readFileSync(path.join(state, 'collect-t', 'server-memory.txt'), 'utf8')).toMatch(/^route signal lines 0$/m);
    expect(existsSync(path.join(state, 'collect-t', 'server-legs.txt'))).toBe(true);
  });
});

describe('the cgroup sampler\'s host line (F-1498)', () => {
  // why: F-1498 the host line carries /proc/meminfo's parts beside MemTotal - MemAvailable, so the peak can be split
  it('writes used memory, the total and the meminfo parts in bytes', () => {
    const meminfo = path.join(work, 'meminfo');
    writeFileSync(meminfo, ['MemTotal: 2000000 kB', 'MemFree: 100000 kB', 'MemAvailable: 800000 kB', 'Buffers: 1000 kB', 'Cached: 600000 kB', 'AnonPages: 700000 kB',
      'Shmem: 150000 kB', 'SUnreclaim: 40000 kB', 'PageTables: 9000 kB', 'Hugepagesize: 2048 kB'].join('\n') + '\n');
    const out = path.join(work, 'cg.log');
    const r = spawnSync('sh', [path.join(root, 'infra/load/cgroup-sampler.sh'), out], { env: { ...process.env, BW_SAMPLER_MEMINFO: meminfo, BW_SAMPLER_ONCE: '1' }, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const line = readFileSync(out, 'utf8').trim().split('\n').find((l) => / host /.test(l))!;
    expect(line).toMatch(/^\d+ host 1228800000 total=2048000000 MemFree=102400000 Buffers=1024000 Cached=614400000 AnonPages=716800000 Shmem=153600000 SUnreclaim=40960000 PageTables=9216000$/);
    // and load-day-memory reads it back at the peak
    const t = Number(line.split(' ')[0]);
    const c = fromCgroupLog(line, {}, t, t);
    expect(c.host.split).toMatchObject({ AnonPages: 716800000, Shmem: 153600000, SUnreclaim: 40960000, PageTables: 9216000 });
  });
});

describe('NFR-13\'s count over the load day (load-day-memory.ts)', () => {
  const MiB = 1048576;
  const cg = (t: number, id: string, cur: number, extra = ''): string => `${t} ${id} ${cur * MiB} anon=${Math.round(cur / 2) * MiB} file=1 ${extra}`;
  const host = (t: number, used: number, total = 2000): string => `${t} host ${used * MiB} total=${total * MiB}`;

  // why: NFR-13 the pass line is host used memory's peak inside the run window, as a percent of MemTotal (D-21); outside it never counts
  it('takes the host line\'s peak inside the window, and the cgroup sum at 1 instant beside it', () => {
    const text = [host(99, 1900), cg(100, 'a', 300), cg(100, 'b', 500), host(100, 1100), cg(102, 'a', 700), cg(102, 'b', 200), host(102, 1150), host(200, 1990)].join('\n');
    const c = fromCgroupLog(text, { a: 'web', b: 'routing' }, 100, 150);
    expect(c.samples).toBe(2);
    expect(c.host.usedBytes / MiB).toBe(1150);
    expect(c.sum.bytes / MiB).toBe(900);
    expect(c.services).toEqual({ web: { peakCurrentMiB: 700, peakAnonMiB: 350 }, routing: { peakCurrentMiB: 500, peakAnonMiB: 250 } });
  });

  // why: NFR-13 docker stats is recorded beside it: each container's max, their sum, and the sum at 1 instant
  it('reads docker stats sizes and dates its time-of-day lines from the window, across midnight', () => {
    expect(bytesOf('200.5MiB')).toBe(200.5 * MiB);
    expect(bytesOf('1.5GiB')).toBe(1536 * MiB);
    expect(bytesOf('512KiB')).toBe(512 * 1024);
    expect(() => bytesOf('lots')).toThrow();
    const start = Date.UTC(2026, 10, 11, 23, 59, 0) / 1000;
    const text = ['23:59:30 bw-p4-load-web-1 3.2% 200MiB / 256MiB', '23:59:30 bw-p4-load-db-1 1.0% 300MiB / 512MiB', '00:00:15 bw-p4-load-web-1 3.2% 220MiB / 256MiB', '00:00:15 bw-p4-load-db-1 1.0% 250MiB / 512MiB'].join('\n');
    expect(fromStatsLog(text, start, start + 120)).toEqual({ perContainerMaxMiB: { web: 220, db: 300 }, sumOfMaxMiB: 520, peakInstantSumMiB: 500 });
    expect(fromStatsLog(text, start, start + 40).perContainerMaxMiB).toEqual({ web: 200, db: 300 });
  });

  // why: NFR-13 the verdict is the host count against 60%, with the caps from memory.max recorded beside it
  it('passes at 60% and fails above it, from a collect folder and the load summary', () => {
    const c = path.join(work, 'collect');
    mkdirSync(c);
    const t = Date.UTC(2026, 10, 11, 12, 0, 0) / 1000;
    writeFileSync(path.join(c, 'server-ids.txt'), 'a bw-p4-load-web-1\nb bw-p4-load-routing-1\n');
    writeFileSync(path.join(c, 'server-memory.txt'), `web memory.max ${256 * MiB}\nrouting memory.max ${320 * MiB}\nproxy memory.max max\n`);
    writeFileSync(path.join(c, 'server-stats.log'), '12:00:15 bw-p4-load-web-1 1% 100MiB / 256MiB\n');
    const summary = { firstRunStart: new Date(t * 1000).toISOString(), lastRunEnd: new Date((t + 60) * 1000).toISOString() };
    for (const [used, pass] of [[1200, true], [1201, false]] as const) {
      writeFileSync(path.join(c, 'server-cgroup.log'), [cg(t + 2, 'a', 150), cg(t + 2, 'b', 300), host(t + 2, used)].join('\n'));
      const m = loadDayMemory(c, summary);
      expect(m.nfr13).toMatchObject({ limitPct: 60, passes: pass });
      expect(m.host.peakPct).toBe(used === 1200 ? 60 : 60.1);
      expect(m.cgroupSum).toMatchObject({ peakMiB: 450, peakPct: 22.5 });
      expect(m.services.web).toEqual({ peakCurrentMiB: 150, peakAnonMiB: 75, capMiB: 256 });
      expect(m.dockerStats.sumOfMaxMiB).toBe(100);
    }
    expect(capsOf('proxy memory.max max\n')).toEqual({ proxy: null });
    writeFileSync(path.join(c, 'server-cgroup.log'), host(t - 10, 900));
    expect(() => loadDayMemory(c, summary)).toThrow(/no host sample/);
  });

  // why: F-1494 NFR-13 compares the unrounded percent: 1200.9 of 2000 MiB is 60.045%, shown as 60 but over the line
  it('fails 60.045% though it rounds to 60.0, and splits the host peak by meminfo', () => {
    const c = path.join(work, 'collect');
    mkdirSync(c);
    const t = Date.UTC(2026, 10, 11, 12, 0, 0) / 1000;
    writeFileSync(path.join(c, 'server-ids.txt'), 'a bw-p4-load-web-1\n');
    writeFileSync(path.join(c, 'server-memory.txt'), `web memory.max ${256 * MiB}\n`);
    writeFileSync(path.join(c, 'server-stats.log'), '');
    const summary = { firstRunStart: new Date(t * 1000).toISOString(), lastRunEnd: new Date((t + 60) * 1000).toISOString() };
    const split = (anon: number): string => `AnonPages=${anon * MiB} Shmem=${150 * MiB} SUnreclaim=${40 * MiB} PageTables=${9 * MiB}`;
    writeFileSync(path.join(c, 'server-cgroup.log'), [cg(t + 2, 'a', 150), `${host(t + 2, 1100)} ${split(600)}`, `${t + 4} host ${Math.round(1200.9 * MiB)} total=${2000 * MiB} ${split(700)}`].join('\n'));
    const m = loadDayMemory(c, summary);
    expect(m.host.peakPct).toBe(60);
    expect(m.host.peakPctExact).toBeCloseTo(60.045, 6);
    expect(m.nfr13.passes).toBe(false);
    expect(m.hostSplitMiB).toEqual({ AnonPages: 700, Shmem: 150, SUnreclaim: 40, PageTables: 9 });
    // a log made before F-1498 has no split
    writeFileSync(path.join(c, 'server-cgroup.log'), host(t + 2, 1000));
    expect(loadDayMemory(c, summary)).toMatchObject({ hostSplitMiB: null, nfr13: { passes: true } });
  });
});
