// SPDX-License-Identifier: AGPL-3.0-or-later
// P7-LOAD hosted mode (owner answer f3d84787, "Run it on my hosted server"): hosted-day.sh runs 1 load day on the hosted server and
// always puts it back as it found it, locked. The scripts run for real with stubs on PATH (ssh, ssh-keygen, aws, curl, docker, launchctl,
// node) that record what they are sent and answer like the hosted server and Lightsail: no server, no cloud call, no launchd job.
// Every case runs on every host (F-1548): the script reads times with BSD date on the owner's Mac (D16) and GNU date in the CI image.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const script = path.join(root, 'infra/load/hosted-day.sh');
const tempServer = path.join(root, 'infra/load/temp-server.sh');
const LABEL = 'io.bw.load-hosted-restore.brightwater-1';
const MAC = '198.51.100.7';
let work: string;
let state: string;
let log: string;

type Rule = { fromPort: number; toPort: number; protocol: string; cidrs: string[]; ipv6Cidrs: string[]; cidrListAliases: string[] };
// The recorded rules, port 22 with an alias so a rebuilt 22 rule would show.
const recorded: Rule[] = [
  { fromPort: 80, toPort: 80, protocol: 'tcp', cidrs: ['0.0.0.0/0'], ipv6Cidrs: ['::/0'], cidrListAliases: [] },
  { fromPort: 22, toPort: 22, protocol: 'tcp', cidrs: ['0.0.0.0/0'], ipv6Cidrs: ['::/0'], cidrListAliases: ['lightsail-connect'] },
  { fromPort: 443, toPort: 443, protocol: 'tcp', cidrs: ['0.0.0.0/0'], ipv6Cidrs: ['::/0'], cidrListAliases: [] },
];
const portStates = (rules: Rule[]) => ({ portStates: rules.map((r) => ({ ...r, state: 'open' })) });

const stub = (name: string, body: string): void => {
  writeFileSync(path.join(work, 'bin', name), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(work, 'bin', name), 0o755);
};

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'bw-hosted-day-'));
  state = path.join(work, 'state');
  log = path.join(work, 'calls.txt');
  mkdirSync(path.join(work, 'bin'));
  mkdirSync(path.join(work, '.ssh'));
  // A host key line for the hosted address, as deploy.sh's first login leaves it in ~/.ssh/known_hosts. A fixed PUBLIC key literal (a throwaway,
  // never a private key) so no ssh-keygen is needed: the CI image (node bookworm-slim) has no OpenSSH client (F-1518).
  writeFileSync(path.join(work, '.ssh/known_hosts'), '192.0.2.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKG1GCw/5S3WJx3Ejx78qhdfEsM0TTsYoAeqKaDEDdVz\n');
  writeFileSync(path.join(work, 'login.pem'), 'x');
  writeFileSync(path.join(work, 'ports.json'), JSON.stringify(portStates(recorded)));
  writeFileSync(path.join(work, 'env-sha'), 'recorded-sha');
  writeFileSync(path.join(work, 'projects'), 'brightwater');
  writeFileSync(path.join(work, 'steal'), '0');
  const data = path.join(work, 'data');
  for (const d of ['generator', 'maps']) mkdirSync(path.join(data, d), { recursive: true });
  writeFileSync(path.join(data, 'street-list.json'), '[]');
  // ssh: logs the remote command (every argument after the login), answers the hosted server's reads, keeps the hosted stack's state in files.
  stub('ssh', [
    'seen=; last=; for a; do if [ -n "$seen" ]; then last="$last${last:+ }$a"; fi; case "$a" in admin@*) seen=1 ;; esac; done',
    'printf "ssh %s\\n" "$last" >> "$BW_STUB_LOG"',
    'd="$BW_STUB_DIR"',
    'case "$last" in',
    '  *"grep -m1 swpd"*) echo " r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st gu UTC"; s="$(cat "$d/steal")"; for i in 1 2 3; do echo " 1  0      0 100 100 100 0 0 0 0 0 0 30 5 10 0 $s 0 2026-11-12 12:00:00"; done ;;',
    '  *"--profile setup"*) [ -f "$d/fail-world" ] && exit 1; echo \'{"status":"setup done"}\' ;;',
    '  *"sha256sum /opt/brightwater/.env"*) cat "$d/env-sha" ;;',
    '  *"install -m 600 -o root -g root /var/lib/bw-load-keep/env.start"*) echo recorded-sha > "$d/env-sha" ;;',
    '  *"grep -E \'^(ROUTES"*) printf "ROUTES=locked\\nBW_IMAGE=bw-app:hosted\\nPROXY_CONF=hosted.conf\\n" ;;',
    '  *"compose ls -a -q"*) cat "$d/projects" ;;',
    '  *"image ls --format"*) echo bw-app:hosted ;;',
    '  *"ps --status running"*) [ -f "$d/hosted-down" ] || printf "db\\nproxy\\nweb\\n" ;;',
    '  *"cd /opt/brightwater && sudo docker compose stop"*) touch "$d/hosted-down" ;;',
    '  *"cd /opt/brightwater && sudo docker compose up -d"*) rm -f "$d/hosted-down" ;;',
    '  *"volume inspect"*) echo "brightwater_pgdata 2026-11-01T00:00:00Z" ;;',
    '  *"world.customer"*) echo 0 ;;',
    '  *"is-active"*) echo active ;;',
    '  *"df -Pk"*) echo 99999999 ;;',
    '  *"--resolve"*) echo 200 ;;',
    'esac',
    'cat > /dev/null 2>&1 || true',
  ].join('\n'));
  // aws: logs the call; answers like Lightsail; a put replaces the whole rule set, as Lightsail does.
  stub('aws', [
    'printf "aws %s\\n" "$*" >> "$BW_STUB_LOG"',
    'd="$BW_STUB_DIR"',
    'case "$*" in',
    '  *get-instance-port-states*) cat "$d/ports.json" ;;',
    '  *get-instance-metric-data*) echo \'{"metricData": []}\' ;;',
    '  *"get-instance "*) printf "brightwater-1\\trunning\\tsmall_3_0\\t192.0.2.1\\n" ;;',
    '  *put-instance-public-ports*) f="$(echo "$*" | sed "s/.*file:\\/\\/\\([^ ]*\\).*/\\1/")"; n=$(ls "$d" | grep -c "^put-"); cp "$f" "$d/put-$n.json"; python3 -c "import json,sys; r=json.load(open(sys.argv[1])); [x.setdefault(\'state\',\'open\') for x in r]; json.dump({\'portStates\': r}, open(sys.argv[2],\'w\'))" "$f" "$d/ports.json" ;;',
    'esac',
  ].join('\n'));
  stub('curl', [
    'printf "curl %s\\n" "$*" >> "$BW_STUB_LOG"',
    'case "$*" in',
    `  *checkip*) echo ${MAC} ;;`,
    '  *http_code*) echo 200 ;;',
    '  *) if [ -f "$BW_STUB_DIR/unlocked" ]; then echo "<p>app</p>"; else echo "<p>This demo is not open yet</p>"; fi ;;',
    'esac',
  ].join('\n'));
  stub('docker', 'printf "docker %s\\n" "$*" >> "$BW_STUB_LOG"; [ "$1" = save ] && echo image; true');
  stub('launchctl', 'printf "launchctl %s\\n" "$*" >> "$BW_STUB_LOG"');
  // ssh-keygen -F <host> -f <file>, answered as OpenSSH answers it (a "found" comment, then the line; exit 1 when absent): the CI image
  // has no OpenSSH client (F-1518), and the run's preflight and prepare call it (F-1548).
  stub('ssh-keygen', [
    'h=; f=; while [ $# -gt 0 ]; do case "$1" in -F) h="$2"; shift ;; -f) f="$2"; shift ;; esac; shift; done',
    'line="$(grep -n "^$h " "$f" | head -n 1)"',
    '[ -n "$line" ] || exit 1',
    'echo "# Host $h found: line ${line%%:*}"; echo "${line#*:}"',
  ].join('\n'));
  stub('node', 'printf "node %s\\n" "$*" >> "$BW_STUB_LOG"; sleep "${BW_STUB_NODE_SECONDS:-1}"; exit "${BW_STUB_NODE_RC:-0}"');
});
afterEach(() => { if (!process.env.BW_TEST_KEEP) rmSync(work, { recursive: true, force: true }); });

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env, PATH: `${path.join(work, 'bin')}:${process.env.PATH}`, HOME: work, BW_LOAD_DIR: state, BW_STUB_LOG: log, BW_STUB_DIR: work,
  BW_HOST: 'admin@192.0.2.1', BW_KEY: path.join(work, 'login.pem'), BW_LOAD_IMAGE: 'bw-load:amd64-test', BW_LOAD_DATA: path.join(work, 'data'),
  BW_LOAD_RUN_SECONDS: '2', BW_LOAD_STOP_COLLECT_SECONDS: '3', BW_LOAD_HEALTH_WAIT: '3', BW_LOAD_PORT_WAIT: '0',
  BW_WATCHDOG_TICK: '0.2', BW_WATCHDOG_WINDOW: '0.6', ...over,
});
const step = (args: string[], over: Record<string, string> = {}) => spawnSync('bash', [script, ...args], { env: env(over), encoding: 'utf8' });
const calls = (): string => (existsSync(log) ? readFileSync(log, 'utf8') : '');
const lines = (): string[] => calls().split('\n');
const at = (re: RegExp, from = 0): number => lines().findIndex((l, i) => i >= from && re.test(l));
const runAsync = (over: Record<string, string> = {}): Promise<{ code: number | null; out: string }> => new Promise((resolve) => {
  const child = spawn('bash', [script, 'run'], { env: env(over) });
  let out = '';
  child.stdout.on('data', (b) => { out += String(b); });
  child.stderr.on('data', (b) => { out += String(b); });
  child.on('exit', (code) => resolve({ code, out }));
});
const norm = (rules: Rule[]): string[] => rules.map((r) => JSON.stringify({
  fromPort: r.fromPort, toPort: r.toPort, protocol: r.protocol, cidrs: [...r.cidrs].sort(), ipv6Cidrs: [...r.ipv6Cidrs].sort(), cidrListAliases: [...r.cidrListAliases].sort(),
})).sort();
const nowRules = (): Rule[] => (JSON.parse(readFileSync(path.join(work, 'ports.json'), 'utf8')) as { portStates: Rule[] }).portStates;
const puts = (): Rule[][] => readdirSync(work).filter((f) => /^put-\d+\.json$/.test(f)).sort((a, b) => Number(a.slice(4, -5)) - Number(b.slice(4, -5)))
  .map((f) => JSON.parse(readFileSync(path.join(work, f), 'utf8')) as Rule[]);
const plist = (): string => path.join(work, 'Library/LaunchAgents', `${LABEL}.plist`);
const noForbiddenCloudCall = (): void => {
  expect(calls()).not.toMatch(/lightsail (delete|stop|reboot|create|start)-instance|key-pair|close-instance-public-ports|open-instance-public-ports/);
  expect(calls()).not.toMatch(/temp-server\.sh delete/);
};

// A state folder as prepare and record leave it, for the restore and guard cases.
const preparedState = (): void => {
  mkdirSync(path.join(state, 'start'), { recursive: true });
  const files: Record<string, string> = {
    target: 'hosted', ip: '192.0.2.1', 'instance-name': 'brightwater-1', domain: 'bw.j7l.io', known_hosts: 'x', 'key.pem': 'x',
    'load-image': 'bw-load:amd64-test', 'start/ports.json': JSON.stringify(portStates(recorded)), 'start/env.sha256': 'recorded-sha',
    'start/services.txt': 'db\nproxy\nweb\n', 'start/volumes.txt': 'brightwater_pgdata 2026-11-01T00:00:00Z\n', 'start/world-rows.txt': '0\n',
    'start/certbot-timer.txt': 'active\n', 'start/images.txt': 'bw-app:hosted\n', 'start/plan': 'small_3_0\n',
  };
  for (const [f, v] of Object.entries(files)) writeFileSync(path.join(state, f), v);
};

describe('hosted-day.sh run', () => {
  // why: P7-LOAD owner answer f3d84787 the 1 command records, arms the backstop, limits the ports, runs the day on a load copy beside the stopped hosted stack, then restores
  it('calls every step in order and ends with the server restored and locked', async () => {
    const r = await runAsync();
    expect(r.code, r.out).toBe(0);
    const order = [
      /^aws .*get-instance-port-states --instance-name brightwater-1/, // record
      /^ssh sudo install -d -m 700 \/var\/lib\/bw-load-keep/, // record's root-only .env copy
      /^launchctl bootstrap .*io\.bw\.load-hosted-restore\.brightwater-1\.plist/, // backstop
      /^aws .*put-instance-public-ports --instance-name brightwater-1/, // ports limited
      /^ssh sudo systemctl stop brightwater-certbot-renew\.timer/, // stop-hosted
      /^ssh cd \/opt\/brightwater && sudo docker compose stop$/,
      /^ssh sudo docker load/, // deploy
      /--profile setup run --rm --no-deps setup/, // world
      /^ssh nohup sh -c 'vmstat -n -t 5/, // sample
      /^node .*cli\.ts .*--server-kind/, // day
      /^ssh sudo pkill -f '\[b\]w-cgroup-sampler\.sh'/, // unsample
      /^ssh .*down -v --remove-orphans/, // restore: the load copy
      /^ssh cd \/opt\/brightwater && sudo docker compose up -d$/, // restore: the hosted stack
      /^ssh sudo systemctl start brightwater-certbot-renew\.timer/,
      /^aws .*put-instance-public-ports --instance-name brightwater-1/, // restore: the ports
      /^launchctl bootout gui\/\d+\/io\.bw\.load-hosted-restore\.brightwater-1/, // the backstop removed
    ];
    let i = -1;
    for (const re of order) {
      const j = at(re, i + 1);
      expect(j, `${re} after line ${i}`).toBeGreaterThan(i);
      i = j;
    }
    // the day ran on the load copy with the watchdog, and collected without any delete
    expect(calls()).toMatch(/--instance-plan small_3_0 .*--routing on --server-kind the hosted server \(brightwater-1\)/);
    expect(existsSync(path.join(state, 'collect-realspeed-hosted-1'))).toBe(true);
    expect(readFileSync(path.join(state, 'watchdog.log'), 'utf8')).toMatch(/start, run pid/);
    // the limited rules: 80 and 443 to this Mac only, 22 exactly as recorded; then the recorded rules again
    const [limited, back] = puts();
    expect(norm(limited!.filter((p) => p.fromPort === 22))).toEqual(norm(recorded.filter((p) => p.fromPort === 22)));
    for (const p of [80, 443]) expect(limited!.find((x) => x.fromPort === p)).toMatchObject({ cidrs: [`${MAC}/32`], ipv6Cidrs: [], cidrListAliases: [] });
    expect(norm(back!)).toEqual(norm(recorded));
    expect(norm(nowRules())).toEqual(norm(recorded));
    // the hosted world is never set up again by the load day: setup ran only in the load copy's project
    expect(lines().filter((l) => /--profile setup/.test(l)).every((l) => /-p bw-p4-load /.test(l))).toBe(true);
    expect(existsSync(path.join(work, 'hosted-down'))).toBe(false);
    expect(existsSync(plist())).toBe(false);
    expect(readFileSync(path.join(state, 'VERDICT'), 'utf8')).toMatch(/^hosted-day RESULT: day exit 0; restore PASSED/);
    expect(readFileSync(path.join(state, 'hosted-day.log'), 'utf8')).toMatch(/RESTORE PASSED/);
    noForbiddenCloudCall();
  }, 40_000);

  // why: P7-LOAD owner answer f3d84787 a failed step still restores (the trap): the ports, the hosted stack and the backstop's removal
  it('restores when a step fails', async () => {
    writeFileSync(path.join(work, 'fail-world'), '');
    const r = await runAsync();
    expect(r.code, r.out).toBe(1);
    const world = at(/--profile setup run/);
    expect(world).toBeGreaterThan(-1);
    expect(at(/^ssh cd \/opt\/brightwater && sudo docker compose up -d$/, world)).toBeGreaterThan(world);
    expect(at(/^node /)).toBe(-1);
    expect(norm(nowRules())).toEqual(norm(recorded));
    expect(existsSync(plist())).toBe(false);
    expect(readFileSync(path.join(state, 'VERDICT'), 'utf8')).toMatch(/stopped: step world failed; restore PASSED/);
    noForbiddenCloudCall();
  }, 40_000);

  // why: P7-LOAD owner answer f3d84787 the watchdog's mid-run abort stops the day, collects, never deletes, and the run restores the hosted server
  it('restores after the watchdog aborts the day', async () => {
    writeFileSync(path.join(work, 'steal'), '50');
    const r = await runAsync({ BW_STUB_NODE_SECONDS: '30' });
    expect(r.code, r.out).toBe(143);
    expect(readFileSync(path.join(state, 'ABORTED'), 'utf8')).toMatch(/2 consecutive 5-minute windows over 5\.0% steal/);
    expect(existsSync(path.join(state, 'collect-realspeed-hosted-1-stopped'))).toBe(true);
    expect(at(/^ssh cd \/opt\/brightwater && sudo docker compose up -d$/, at(/^node /))).toBeGreaterThan(-1);
    expect(norm(nowRules())).toEqual(norm(recorded));
    expect(readFileSync(path.join(state, 'VERDICT'), 'utf8')).toMatch(/day ABORTED by the watchdog .*; restore PASSED/);
    // run-day's stop path collected and released nothing: BW_LOAD_RELEASE=none
    expect(readFileSync(path.join(state, 'hosted-day.log'), 'utf8')).toMatch(/run-day: release none: the server is not deleted/);
    expect(readFileSync(path.join(state, 'hosted-day.log'), 'utf8')).not.toMatch(/DELETE FAILED|refused: 'delete'/);
    noForbiddenCloudCall();
  }, 40_000);

  // why: P7-LOAD owner answer f3d84787 the backstop runs restore from copies in the state folder at the expiry, and a passed restore removes it
  it('installs the backstop with restore at the expiry, and a passed restore removes it', () => {
    preparedState();
    const r = step(['backstop'], { BW_LOAD_BACKSTOP_HOURS: '16' });
    expect(r.status, r.stderr).toBe(0);
    const p = readFileSync(plist(), 'utf8');
    expect(p).toContain(`<string>${path.join(state, 'hosted-day.sh')}</string><string>restore</string>`);
    expect(p).toContain(`<key>BW_LOAD_DIR</key><string>${state}</string>`);
    const fire = new Date(`${readFileSync(path.join(state, 'backstop-expires'), 'utf8').trim().replace(/Z$/, ':00Z')}`);
    expect(Math.round((fire.getTime() - Date.now()) / 3_600_000)).toBe(16);
    for (const [k, v] of [['Month', fire.getMonth() + 1], ['Day', fire.getDate()], ['Hour', fire.getHours()], ['Minute', fire.getMinutes()]] as const) {
      expect(p).toContain(`<key>${k}</key><integer>${v}</integer>`);
    }
    expect(readFileSync(path.join(state, 'hosted-day.sh'), 'utf8')).toBe(readFileSync(script, 'utf8'));
    expect(existsSync(path.join(state, 'hosted-ports.py'))).toBe(true);
    // the copy in the state folder restores on its own
    const back = spawnSync('bash', [path.join(state, 'hosted-day.sh'), 'restore'], { env: env(), encoding: 'utf8' });
    expect(back.status, back.stdout + back.stderr).toBe(0);
    expect(existsSync(plist())).toBe(false);
    expect(calls()).toMatch(new RegExp(`launchctl bootout gui/\\d+/${LABEL.replace(/\./g, '\\.')}`));
  });
});

describe('hosted-day.sh restore', () => {
  // why: P7-LOAD owner answer f3d84787 restore puts back exactly the recorded port rules and .env, and starts the hosted stack with its world untouched
  it('puts back the recorded ports and .env, removes the load copy and starts the hosted stack', () => {
    preparedState();
    writeFileSync(path.join(work, 'ports.json'), JSON.stringify(portStates([
      recorded[1]!, { ...recorded[0]!, cidrs: [`${MAC}/32`], ipv6Cidrs: [] }, { ...recorded[2]!, cidrs: [`${MAC}/32`], ipv6Cidrs: [] },
    ])));
    writeFileSync(path.join(work, 'env-sha'), 'changed-sha');
    writeFileSync(path.join(work, 'hosted-down'), '');
    const r = step(['restore']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(norm(nowRules())).toEqual(norm(recorded));
    expect(norm(puts().at(-1)!)).toEqual(norm(recorded));
    expect(calls()).toMatch(/^ssh sudo install -m 600 -o root -g root \/var\/lib\/bw-load-keep\/env\.start \/opt\/brightwater\/\.env$/m);
    expect(readFileSync(path.join(work, 'env-sha'), 'utf8').trim()).toBe('recorded-sha');
    expect(calls()).toMatch(/^ssh cd \/opt\/brightwater && sudo docker compose up -d$/m);
    expect(calls()).toMatch(/docker image rm 'bw-load:amd64-test'/);
    expect(calls()).toMatch(/^ssh sudo rm -rf \/opt\/bw-load \/etc\/bw-load /m);
    // the hosted world: its volumes and rows are checked, never set up again (setup there waits for P8-UNLOCK)
    expect(calls()).toMatch(/volume inspect/);
    expect(calls()).toMatch(/select count\(\*\) from world\.customer/);
    expect(calls()).not.toMatch(/--profile setup/);
    expect(readFileSync(path.join(state, 'RESTORED'), 'utf8')).toMatch(/^RESTORED at /);
    // and again: safe to repeat
    const again = step(['restore']);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(norm(nowRules())).toEqual(norm(recorded));
    noForbiddenCloudCall();
  });

  // why: P7-LOAD owner answer f3d84787 restore is judged from this Mac: a start page that is not the locked page fails it and keeps the backstop
  it('fails when the start page is not the locked page, and keeps the backstop', () => {
    preparedState();
    writeFileSync(path.join(state, 'backstop-label'), LABEL);
    mkdirSync(path.join(work, 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(plist(), 'x');
    writeFileSync(path.join(work, 'unlocked'), '');
    const r = step(['restore'], { BW_LOAD_HEALTH_WAIT: '0' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/RESTORE FAILED: mac-check/);
    expect(existsSync(plist())).toBe(true);
    // the ports are put back even so
    expect(norm(nowRules())).toEqual(norm(recorded));
  });

  // why: F-1548 restore checks the hosted stack at least once with a wait of 0, also when the clock's second turns between the wait's start and its first test
  it('checks the hosted stack once with a wait of 0 when every epoch read is 1 s later', () => {
    preparedState();
    // A clock that moves 1 s per epoch read, as a loaded host can make it look; every other date call is the real one.
    stub('date', [
      'if [ "$#" = 1 ] && [ "$1" = +%s ]; then',
      '  f="$BW_STUB_DIR/epoch"; [ -f "$f" ] || /bin/date +%s > "$f"',
      '  n=$(cat "$f"); echo $((n + 1)) > "$f"; echo "$n"; exit 0',
      'fi',
      'exec /bin/date "$@"',
    ].join('\n'));
    const r = step(['restore'], { BW_LOAD_HEALTH_WAIT: '0' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/RESTORE PASSED/);
    expect(calls()).toMatch(/https:\/\/[^ ]+\/healthz/);
  });
});

describe('hosted-day.sh guards', () => {
  const infos = (rules: Rule[]): string => { const f = path.join(work, 'infos.json'); writeFileSync(f, JSON.stringify(rules)); return `file://${f}`; };
  // why: P7-LOAD owner answer f3d84787 the hosted mode never deletes, stops, reboots or makes an instance and never touches a key pair
  it.each([
    ['delete-instance', '--instance-name', 'brightwater-1'],
    ['stop-instance', '--instance-name', 'brightwater-1'],
    ['reboot-instance', '--instance-name', 'brightwater-1'],
    ['create-instances', '--instance-names', 'brightwater-1'],
    ['delete-key-pair', '--key-pair-name', 'LightsailDefaultKeyPair'],
    ['create-key-pair', '--key-pair-name', 'x'],
    ['download-default-key-pair'],
    ['open-instance-public-ports', '--instance-name', 'brightwater-1'],
    ['close-instance-public-ports', '--instance-name', 'brightwater-1'],
  ])('refuses lightsail %s before any call', (...args) => {
    preparedState();
    const r = step(['lightsail', ...args]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refused/);
    expect(calls()).not.toMatch(/^aws /m);
  });

  // why: P7-LOAD owner answer f3d84787 a port rule write that would change port 22 is refused
  it('refuses a port rule write that changes port 22', () => {
    preparedState();
    const r = step(['lightsail', 'put-instance-public-ports', '--instance-name', 'brightwater-1', '--port-infos',
      infos(recorded.map((p) => (p.fromPort === 22 ? { ...p, cidrs: [`${MAC}/32`] } : p)))]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/would change port 22/);
    const drop = step(['lightsail', 'put-instance-public-ports', '--instance-name', 'brightwater-1', '--port-infos', infos(recorded.filter((p) => p.fromPort !== 22))]);
    expect(drop.status).toBe(2);
    expect(calls()).not.toMatch(/^aws /m);
  });

  // why: P7-LOAD owner answer f3d84787 Lightsail writes are limited to brightwater-1's port rules
  it('refuses a port rule write on another instance, and lets the guarded write through', () => {
    preparedState();
    const other = step(['lightsail', 'put-instance-public-ports', '--instance-name', 'other', '--port-infos', infos(recorded)]);
    expect(other.status).toBe(2);
    const two = step(['lightsail', 'put-instance-public-ports', '--instance-name', 'brightwater-1', '--instance-name', 'other', '--port-infos', infos(recorded)]);
    expect(two.status).toBe(2);
    expect(calls()).not.toMatch(/^aws /m);
    const ok = step(['lightsail', 'put-instance-public-ports', '--instance-name', 'brightwater-1', '--port-infos', infos(recorded)]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(calls()).toMatch(/^aws .*put-instance-public-ports --instance-name brightwater-1/m);
  });

  // why: P7-LOAD owner answer f3d84787 temp-server.sh, pointed at the hosted server, refuses its create, install, delete and backstop steps
  it.each(['create', 'install', 'delete', 'backstop'])('temp-server.sh %s is refused in a hosted state folder', (s) => {
    preparedState();
    const r = spawnSync('bash', [tempServer, s, '2026-11-13T00:00Z'], { env: env(), encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/never runs on the hosted server/);
    expect(calls()).toBe('');
  });
});

describe('hosted-day.sh state folder', () => {
  // why: P7-LOAD owner answer f3d84787 a missing or bad state folder refuses before any remote call
  it.each([
    ['restore with BW_LOAD_DIR unset', ['restore'], { BW_LOAD_DIR: '' }, /set BW_LOAD_DIR/],
    ['restore with no such folder', ['restore'], { BW_LOAD_DIR: '/nonexistent/bw-hosted' }, /no state folder at/],
    ['restore with a relative path', ['restore'], { BW_LOAD_DIR: 'state' }, /absolute path/],
    ['run inside the repo', ['run'], { BW_LOAD_DIR: path.join(root, '.build/bw-hosted-test-never-made') }, /inside the repo/],
  ] as const)('refuses %s', (_n, args, over, why) => {
    const r = step([...args], over);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(why);
    expect(calls()).toBe('');
    expect(existsSync(path.join(root, '.build/bw-hosted-test-never-made'))).toBe(false);
  });

  // why: P7-LOAD owner answer f3d84787 a folder that is not a hosted state folder (no target file) refuses restore before any call
  it('refuses restore on a folder that is not a hosted state folder', () => {
    preparedState();
    rmSync(path.join(state, 'target'));
    expect(step(['restore']).status).toBe(2);
    writeFileSync(path.join(state, 'target'), 'hosted');
    writeFileSync(path.join(state, 'instance-name'), 'bw-load-p4-20261112-small');
    expect(step(['restore']).status).toBe(2);
    expect(calls()).toBe('');
  });

  // why: P7-LOAD owner answer f3d84787 a second run on a folder that holds a record would record the test's own ports as the start: refused
  it('refuses run when the folder already holds a recorded start', () => {
    preparedState();
    const r = step(['run']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/recorded a run already/);
    expect(calls()).toBe('');
  });

  // why: P7-LOAD owner answer f3d84787 restore with no record has nothing to put back and makes no remote call
  it('restore with no record changes nothing and passes', () => {
    preparedState();
    rmSync(path.join(state, 'start'), { recursive: true });
    const r = step(['restore']);
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).not.toMatch(/^(ssh|aws) /m);
  });
});

describe('hosted-day.sh --help', () => {
  // why: P7-LOAD owner answer f3d84787 the usage names every step and every variable the script reads
  it('names every step and variable', () => {
    const r = step(['--help']);
    expect(r.status).toBe(0);
    const src = readFileSync(script, 'utf8');
    const steps = /^ {2}(run \| prepare [^)]*)\) ;;$/m.exec(src)![1]!.split(' | ');
    expect(steps.length).toBeGreaterThan(10);
    for (const s of steps) expect(r.stdout).toMatch(new RegExp(`^ {2}${s}\\b`, 'm'));
    const vars = new Set([...src.matchAll(/\$\{?(BW_[A-Z_]+)/g)].map((m) => m[1]!).concat([...src.matchAll(/\b(BW_LOAD_[A-Z_]+)=/g)].map((m) => m[1]!)));
    for (const v of vars) expect(r.stdout, v).toContain(v);
  });
});
