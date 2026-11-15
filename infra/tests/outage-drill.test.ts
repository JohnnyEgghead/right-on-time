// SPDX-License-Identifier: AGPL-3.0-or-later
// P8-OUTAGE-DRILL: the UptimeRobot answer parser and record writer (infra/drill/uptimerobot.ts), and the driver (infra/drill/outage-drill.sh)
// run for real with stubs on PATH (ssh, curl) that record what they are sent. No server, no monitor, no key: the key in these tests is a
// made-up word, and the cases check it never reaches an argument list, the output, the evidence or the record.
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { durationInBand, ensureRenewalMonitor, envSeconds, findOutages, measure, nyTime, parseMonitor, parseOwnerLook, renderRecord, runF45, withOwnerLook, type Facts, type Post } from '../drill/uptimerobot.ts';

const root = path.resolve(import.meta.dirname, '../..');
const script = path.join(root, 'infra/drill/outage-drill.sh');
const FAKE_KEY = 'FAKEKEY-do-not-leak-7731';

// Synthetic answer in the recorded shape (P1-MONITOR, P8 read). Newest log first, like the API.
const answer = (logs: unknown[], extra: Record<string, unknown> = {}) => ({
  stat: 'ok',
  pagination: { offset: 0, limit: 50, total: 1 },
  monitors: [{ id: 100000001, friendly_name: 'm', type: 1, interval: 300, status: 2, create_datetime: 1793476224, logs, ...extra }],
});
const T0 = 1794700000;
const log = (type: number, datetime: number, duration: number, code = '200', detail = 'OK') => ({ type, datetime, duration, reason: { code, detail } });
const oneOutage = [
  log(2, T0 + 1000, 5000),
  log(1, T0 + 120, 880, '502', 'Bad Gateway'),
  log(2, T0 - 4000, 4000),
  log(1, T0 - 90000, 300, '333333', 'Connection Timeout'),
];

describe('parser', () => {
  // why: P8-OUTAGE-DRILL NFR-11 the drill finds its outage in UptimeRobot answers, so the parser must read the recorded shape
  it('reads the monitor and its logs', () => {
    const m = parseMonitor(answer(oneOutage));
    expect(m).toMatchObject({ id: 100000001, interval: 300, status: 2, createDatetime: 1793476224 });
    expect(m.logs).toHaveLength(4);
    expect(m.logs[1]?.reason).toBe('502 Bad Gateway');
  });
  // why: P8-OUTAGE-DRILL NFR-11 a failed or odd API answer must stop the record, never read as no outage
  it('refuses a failed call, a missing monitor and a bad field with a plain message', () => {
    expect(() => parseMonitor({ stat: 'fail', error: { type: 'invalid_parameter', message: 'logs_start_date is invalid.' } })).toThrow(/logs_start_date is invalid/);
    expect(() => parseMonitor({ stat: 'ok', monitors: [] })).toThrow(/no single monitor/);
    expect(() => parseMonitor('x')).toThrow(/not a JSON object/);
    expect(() => parseMonitor(answer([{ type: 1, datetime: 'soon', duration: 1 }]))).toThrow(/datetime is not a number/);
  });
  // why: P8-OUTAGE-DRILL NFR-11 the Acceptance is 1 outage at the drill time with its start and end
  it('finds the 1 outage in the drill window and pairs it with its up log', () => {
    const o = findOutages(parseMonitor(answer(oneOutage)).logs, T0, T0 + 720, 300);
    expect(o).toEqual([{ downAt: T0 + 120, upAt: T0 + 1000, durationSec: 880, closed: true, reason: '502 Bad Gateway' }]);
  });
  // why: P8-OUTAGE-DRILL NFR-11 older outages on the monitor must not count, and an open one must not read as closed
  it('ignores an older outage outside the window and reports an open one', () => {
    const logs = parseMonitor(answer([log(1, T0 + 60, 99, '502', 'Bad Gateway'), log(2, T0 - 4000, 4000), log(1, T0 - 90000, 300)])).logs;
    const o = findOutages(logs, T0, T0 + 720, 300);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ closed: false, upAt: null, durationSec: null });
  });
  // why: P8-OUTAGE-DRILL NFR-11 the Acceptance says 1 outage, so 2 or 0 must show
  it('counts 2 outages as 2 and none as 0', () => {
    expect(findOutages(parseMonitor(answer([log(1, T0 + 10, 1), log(2, T0 + 100, 1), log(1, T0 + 400, 1), log(2, T0 + 900, 1)])).logs, T0, T0 + 720, 300)).toHaveLength(2);
    expect(findOutages(parseMonitor(answer([log(2, T0 - 10, 1)])).logs, T0, T0 + 720, 300)).toHaveLength(0);
  });
  // why: P8-OUTAGE-DRILL NFR-11 about 12 minutes is the stop plus or minus the 300 s check interval
  it('accepts about 12 minutes: the band is 12 minutes plus or minus one interval', () => {
    expect(durationInBand(720, 720, 300)).toBe(true);
    expect(durationInBand(880, 720, 300)).toBe(true);
    expect(durationInBand(419, 720, 300)).toBe(false);
    expect(durationInBand(1021, 720, 300)).toBe(false);
  });
  // why: F-1686 the F-45 deploy command is run as an array, so a checkout path with a space stays 1 word
  it('runs the default F-45 deploy command quoted, as an array', () => {
    const sh = readFileSync(path.join(root, 'infra/drill/outage-drill.sh'), 'utf8');
    expect(sh).toContain('DEPLOY_CMD=(bash "$root/infra/deploy/deploy.sh" --host-files)');
    expect(sh).toContain('"${DEPLOY_CMD[@]}" >"$EV/f45-deploy.log"');
    expect(sh).not.toMatch(/^\$DEPLOY_CMD /m);
  });
  // why: F-1687 an empty value polls with no delay and '30s' polls forever, so both are refused with an error naming the variable
  it('envSeconds takes the default when unset and refuses empty, malformed and non-positive values', () => {
    expect(envSeconds('X', 30, {})).toBe(30);
    expect(envSeconds('X', 30, { X: '45' })).toBe(45);
    for (const bad of ['', ' ', '30s', 'abc', '0', '-5', 'Infinity']) expect(() => envSeconds('X', 30, { X: bad }), `'${bad}'`).toThrow(/^X must be a positive number of seconds/);
  });
  // why: P8-OUTAGE-DRILL NFR-11 times shown to the owner are America/New_York with the zone label
  it('shows times as America/New_York with the zone label', () => {
    expect(nyTime(1793512622)).toBe('Nov 1, 1:57:02 AM EDT');
    expect(nyTime(1793514952)).toBe('Nov 1, 1:35:52 AM EST');
  });
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  commit: 'abc', preHealthz: 200, stopServerEpoch: T0, stopLocalEpoch: T0, startServerEpoch: T0 + 720, startLocalEpoch: T0 + 721,
  healthzOkEpoch: T0 + 730, healthzOkStatus: 200, stopSecs: 720, intervalSec: 300, apiPolls: 2, ...over,
});

describe('verdict and record', () => {
  // why: P8-OUTAGE-DRILL NFR-11 the record fields Verdict and Measured feed docs/build/SPIKES.md
  it('passes the API half with 1 outage of about 12 minutes and writes the record fields the spikes index reads', () => {
    const m = measure(facts(), answer(oneOutage));
    expect(m.verdict).toBe('PENDING-WEB');
    const md = renderRecord(m);
    expect(md).toMatch(/^Verdict: PENDING-WEB - /m);
    expect(md).toMatch(/^Measured: app stopped .*(EST|EDT)/m);
    expect(md).toMatch(/## Web history \(human look\)/);
    expect(md).toMatch(/## History retention/);
  });
  // why: P8-OUTAGE-DRILL NFR-11 every way the drill can miss the Acceptance must be a FAIL, not a pass
  it('fails on 0 outages, 2 outages, an open outage, a bad duration or a failed healthz', () => {
    expect(measure(facts(), answer([log(2, T0 - 10, 1)])).verdict).toBe('FAIL');
    expect(measure(facts(), answer([log(1, T0 + 10, 1), log(2, T0 + 100, 1), log(1, T0 + 400, 1), log(2, T0 + 900, 1)])).detail).toMatch(/2 outages/);
    expect(measure(facts(), answer([log(1, T0 + 60, 5)])).detail).toMatch(/no up log yet/);
    expect(measure(facts(), answer([log(2, T0 + 5000, 1), log(1, T0 + 60, 1)])).detail).toMatch(/outside/);
    expect(measure(facts({ healthzOkStatus: 502 }), answer(oneOutage)).detail).toMatch(/502 after the restart/);
  });
  // why: P8-OUTAGE-DRILL the owner's own look at the web history is the only thing that turns PENDING-WEB into PASS, and it never rescues a FAIL
  it('the owner look turns PENDING-WEB into PASS with the answer id and time, and leaves a FAIL alone', () => {
    const look = parseOwnerLook({ answerId: '87aa32f5', answeredEpoch: 1794662820, saw: '1 down and 1 up event' });
    const m = withOwnerLook(measure(facts(), answer(oneOutage)), look);
    expect(m.verdict).toBe('PASS');
    const md = renderRecord(m, undefined, look);
    expect(md).toMatch(/^Verdict: PASS - .*87aa32f5.*Nov 14, 8:27:00 AM EST/m);
    expect(md).toMatch(/^PASS by the owner's look \(dashboard answer 87aa32f5, Nov 14, 8:27:00 AM EST\)/m);
    expect(md).not.toMatch(/^PENDING\./m);
    expect(withOwnerLook(measure(facts(), answer([log(2, T0 - 10, 1)])), look).verdict).toBe('FAIL');
    expect(() => parseOwnerLook({ answerId: '', answeredEpoch: 1, saw: 'x' })).toThrow(/answerId/);
  });
  // why: F-1586 the record must not state the wrong lag model and must say the duration is computed from the log times
  it('states the lag as interval plus the monitor confirm delay and the duration source', () => {
    const md = renderRecord(measure(facts(), answer(oneOutage)));
    expect(md).not.toMatch(/each up to 300 s late/);
    expect(md).toMatch(/plus the monitor's own confirmation delay/);
    expect(md).toMatch(/computed here from the down and up log times/);
  });
  // why: P8-OUTAGE-DRILL NFR-11 the record is committed and must hold no key and no address
  it('carries no key and no address', () => {
    const md = renderRecord(measure(facts(), answer(oneOutage)));
    expect(md).not.toMatch(/api_key|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });
  // why: F-1605 the record names the evidence folder it is given (the driver passes it repo-relative), and no home path of its own
  it('names the evidence folder it is given, and no home path', () => {
    expect(renderRecord(measure(facts(), answer(oneOutage)), undefined, null, 'drill-out/outage-drill')).toContain('Evidence: `drill-out/outage-drill/` (kept there, not in git)');
    const md = renderRecord(measure(facts(), answer(oneOutage)));
    expect(md).toContain('Evidence: the evidence folder the drill wrote');
    expect(md).not.toMatch(/\/Users\/|\/home\/|\.build\/evidence/);
  });
});

// ---- the driver ----
let work: string;
let bin: string;
let ev: string;
let rec: string;
let keyFile: string;

const stub = (name: string, body: string): void => {
  writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(bin, name), 0o755);
};
const read = (f: string): string => (existsSync(path.join(work, f)) ? readFileSync(path.join(work, f), 'utf8') : '');

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'outage-drill-'));
  bin = path.join(work, 'bin');
  ev = path.join(work, 'evidence');
  rec = path.join(work, 'record.md');
  keyFile = path.join(work, 'api_key');
  mkdirSync(bin);
  writeFileSync(keyFile, `${FAKE_KEY}\n`);
  writeFileSync(path.join(work, 'ssh_key'), 'x');
  // ssh: logs every remote command; stop and start answer "0 <epoch>" and keep the time; ps names web. BW_STUB_STOP_RC makes the stop fail.
  // F-1591 switches: BW_STUB_PS_FAIL=1 (ps exits 1), BW_STUB_PS_NOWEB=1 (ps lists no web); "up -d" leaves the file "upd".
  stub(
    'ssh',
    `W="${work}"\nlast=""; for a in "$@"; do last="$a"; done\necho "$last" >> "$W/ssh.log"\n` +
      `case "$last" in\n *"stop web"*) echo "\${BW_STUB_STOP_RC:-0} $(date +%s)"; [ "\${BW_STUB_STOP_RC:-0}" = 0 ] && date +%s > "$W/stopped" ;;\n` +
      ` *"start web"*) echo "0 $(date +%s)"; date +%s > "$W/started" ;;\n *"up -d"*) echo "0 $(date +%s)"; date +%s > "$W/upd" ;;\n` +
      ` *"ps --status"*) [ "\${BW_STUB_PS_FAIL:-0}" = 1 ] && exit 1; [ "\${BW_STUB_PS_NOWEB:-0}" = 1 ] || echo web; echo db ;;\n *) echo ok ;;\nesac`,
  );
  // curl: a healthz call (has -w) prints 200 unless BW_STUB_HZ says otherwise (F-1591): always503 (also before the stop), needs-upd (503 after the
  // stop until the ssh stub has seen "up -d"), after-stop-down (503 after the stop, always). API switches, F-1591: BW_STUB_MON_STATUS (default 2),
  // BW_STUB_API_FAIL_PRE=1 (the preflight read fails), and, for reads after the stop only: BW_STUB_API_FAIL_FIRST=n (the first n calls exit 22),
  // BW_STUB_API_EMPTY_FIRST=n (the first n answers list no outage). A healthz call (has -w) prints 200; an API call (has -K -) eats stdin and prints a monitor whose outage follows the stub clock.
  stub(
    'curl',
    `W="${work}"\necho "$@" >> "$W/curl.log"\ncase "$*" in\n *" -w "*)\n  C=200\n  case "\${BW_STUB_HZ:-}" in\n   always503) C=503 ;;\n   needs-upd) [ -f "$W/stopped" ] && [ ! -f "$W/upd" ] && C=503 ;;\n   after-stop-down) [ -f "$W/stopped" ] && C=503 ;;\n  esac\n  printf %s "$C" ;;\n *)\n cat > /dev/null\n` +
      ` if [ -f "$W/stopped" ]; then\n  N=$(( $(cat "$W/apin" 2>/dev/null || echo 0) + 1 )); echo $N > "$W/apin"\n  [ "$N" -le "\${BW_STUB_API_FAIL_FIRST:-0}" ] && exit 22\n  [ "$N" -le "\${BW_STUB_API_EMPTY_FIRST:-0}" ] && EMPTY=1\n else\n  [ "\${BW_STUB_API_FAIL_PRE:-0}" = 1 ] && exit 22\n fi\n S=0; E=0\n [ -f "$W/stopped" ] && S=$(($(cat "$W/stopped") + 1))\n [ -f "$W/started" ] && E=$(($(cat "$W/started") + 1))\n` +
      ` LOGS=""\n if [ "$S" != 0 ] && [ "\${BW_STUB_NO_OUTAGE:-0}" != 1 ] && [ "\${EMPTY:-0}" != 1 ]; then\n  if [ "$E" != 0 ]; then LOGS='{"type":2,"datetime":'$E',"duration":9,"reason":{"code":"200","detail":"OK"}},'; fi\n` +
      `  LOGS="$LOGS"'{"type":1,"datetime":'$S',"duration":9,"reason":{"code":"502","detail":"Bad Gateway"}},'\n fi\n` +
      ` echo '{"stat":"ok","monitors":[{"id":100000001,"interval":300,"status":'"\${BW_STUB_MON_STATUS:-2}"',"create_datetime":1793476224,"logs":['"$LOGS"'{"type":2,"datetime":1793512927,"duration":5,"reason":{"code":"200","detail":"OK"}}]}]}'\n ;;\nesac`,
  );
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  BW_DRILL_CAFF: '1',
  // F-1605: a made-up monitor id, and no owner file (the real one is private and must not feed the tests)
  BW_DRILL_MONITOR: '100000001',
  BW_OWNER_ENV: path.join(work, 'no-owner.env'), BW_OWNER_ENV_LOCAL: path.join(work, 'no-owner-local.env'),
  BW_HOST: 'stub@example.invalid',
  BW_KEY: path.join(work, 'ssh_key'),
  BW_UPTIMEROBOT_KEY: keyFile,
  BW_DRILL_EVIDENCE: ev,
  BW_DRILL_RECORD: rec,
  BW_DRILL_STOP_SECS: '2',
  BW_DRILL_API_WAIT: '6',
  BW_DRILL_API_POLL: '1',
  BW_DRILL_HEALTHZ_WAIT: '5',
  // F-45 step: never the real status URL or UptimeRobot account; a dead local port unless a test starts the fake server
  BW_DRILL_DEPLOY_CMD: 'true',
  BW_DRILL_API_BASE: 'http://localhost:9',
  BW_DRILL_STATUS_URL: 'http://localhost:9/renewal-status.txt',
  BW_DRILL_F45_WAIT: '1',
  BW_DRILL_F45_POLL: '1',
  ...extra,
});
// Async variant: the F-45 tests serve a fake API from this process, so the event loop must stay free while the driver runs.
const runAsync = (args: string[], extra: Record<string, string> = {}) =>
  new Promise<{ status: number | null; out: string }>((resolve) => {
    const c = spawn('bash', [script, ...args], { env: env(extra), cwd: root });
    let out = '';
    c.stdout.on('data', (d) => (out += String(d)));
    c.stderr.on('data', (d) => (out += String(d)));
    c.on('close', (status) => resolve({ status, out }));
  });
const run = (args: string[], extra: Record<string, string> = {}) => spawnSync('bash', [script, ...args], { env: env(extra), encoding: 'utf8', cwd: root, timeout: 120_000 });
const allText = (): string => {
  const parts = [read('ssh.log'), read('curl.log')];
  for (const dir of [ev]) if (existsSync(dir)) for (const f of readdirSync(dir)) parts.push(readFileSync(path.join(dir, f), 'utf8'));
  if (existsSync(rec)) parts.push(readFileSync(rec, 'utf8'));
  return parts.join('\n');
};

describe('driver', () => {
  // why: P8-OUTAGE-DRILL NFR-11 the owner grants the stop on the dry run, which must run nothing remote and write nothing
  it('--dry-run prints every remote command, calls nothing and writes nothing', () => {
    const r = run(['run', '--dry-run']);
    expect(r.status).toBe(0);
    for (const c of ['docker compose stop web', 'docker compose start web', 'docker compose up -d --no-deps web', 'docker compose ps --status running --services']) expect(r.stdout).toContain(c);
    expect(r.stdout).toMatch(/0 remote writes/);
    // F-45: the deploy step and the monitor create are listed, as writes
    expect(r.stdout).toContain('deploy.sh --host-files');
    expect(r.stdout).toContain('server-deploy.sh /tmp/bw-deploy-stage --host-files');
    expect(r.stdout).toMatch(/WOULD WRITE \(UptimeRobot account[\s\S]*newMonitor[\s\S]*type=2[\s\S]*keyword_type=2[\s\S]*keyword_value=RENEWAL_OK/);
    expect(r.stdout).toContain('WOULD RUN (remote, write)');
    expect(r.stdout + r.stderr).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|example\.invalid|FAKEKEY/);
    expect(existsSync(path.join(work, 'ssh.log'))).toBe(false);
    expect(existsSync(path.join(work, 'curl.log'))).toBe(false);
    expect(existsSync(ev)).toBe(false);
    expect(existsSync(rec)).toBe(false);
  });

  // why: P8-OUTAGE-DRILL NFR-11 restore and reread are real actions and must not pretend to be dry
  it('a dry run is refused for restore and reread', () => {
    expect(run(['restore', '--dry-run']).status).toBe(2);
  });

  // F-1605: an env with the given BW_ names removed (so the owner file, or nothing, supplies them).
  const without = (names: string[], extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const e = env(extra);
    for (const n of names) delete e[n];
    return e;
  };
  const runEnv = (args: string[], e: NodeJS.ProcessEnv) => spawnSync('bash', [script, ...args], { env: e, encoding: 'utf8', cwd: root, timeout: 120_000 });
  // why: F-1605 no monitor id is written in the public script: with none in the environment and no owner file, run, its dry run and reread refuse
  it('refuses run, the dry run and reread when no monitor id is given', () => {
    for (const args of [['run', '--dry-run'], ['run'], ['reread']]) {
      const r = runEnv(args, without(['BW_DRILL_MONITOR']));
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toMatch(/no UptimeRobot monitor id: set BW_DRILL_MONITOR, or put it in the owner file/);
    }
    expect(existsSync(path.join(work, 'ssh.log'))).toBe(false);
    expect(existsSync(path.join(work, 'curl.log'))).toBe(false);
  });
  // why: F-1605 the owner file supplies the monitor id and the output paths (relative ones under the repo), and the environment wins over it
  it('reads the monitor id and the record path from the owner file, and lets the environment win', () => {
    const owner = path.join(work, 'owner.env');
    writeFileSync(owner, `# owner values\nBW_DRILL_MONITOR=100000002\nBW_DRILL_RECORD=${path.join(work, 'owner-record.md')}\nBW_DRILL_EVIDENCE=drill-out/f1605-probe\nnot a line\n`);
    const r = runEnv(['run', '--dry-run'], without(['BW_DRILL_MONITOR', 'BW_DRILL_RECORD', 'BW_DRILL_EVIDENCE'], { BW_OWNER_ENV: owner }));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('monitor 100000002');
    expect(r.stdout).toContain(`WOULD WRITE: ${path.join(work, 'owner-record.md')}`);
    expect(r.stdout).toContain(`evidence in ${path.join(root, 'drill-out/f1605-probe')}`);
    const r2 = runEnv(['run', '--dry-run'], without(['BW_DRILL_RECORD'], { BW_OWNER_ENV: owner }));
    expect(r2.stdout).toContain('monitor 100000001');
    expect(r2.stdout).not.toContain('100000002');
    expect(existsSync(path.join(root, 'drill-out/f1605-probe'))).toBe(false);
  });

  // why: P8-OUTAGE-DRILL NFR-11 the 1 command must stop, wait, start, read the monitor and write the record without leaking the key
  it('runs the drill: stop, wait, start, healthz, API poll, record; the key never leaves curl stdin', () => {
    const r = run(['run']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const ssh = read('ssh.log');
    expect(ssh.indexOf('ps --status')).toBeLessThan(ssh.indexOf('stop web'));
    expect(ssh.indexOf('stop web')).toBeLessThan(ssh.indexOf('start web'));
    expect(ssh).not.toContain('up -d');
    const md = readFileSync(rec, 'utf8');
    expect(md).toMatch(/^Verdict: PENDING-WEB - API half passes/m);
    expect(md).toMatch(/Outages whose down log falls in the drill window: 1\./);
    expect(existsSync(path.join(ev, 'measured.json'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(ev, 'facts.json'), 'utf8')).healthzOkStatus).toBe(200);
    expect(allText()).not.toContain(FAKE_KEY);
    expect(r.stdout + r.stderr).not.toContain(FAKE_KEY);
    expect(read('curl.log')).toContain('-K -');
  });

  // why: P8-OUTAGE-DRILL NFR-11 the drill is one planned outage and must not repeat by accident
  it('refuses to run twice over the same record', () => {
    expect(run(['run']).status).toBe(0);
    expect(run(['run']).status).toBe(2);
  });

  // why: P8-OUTAGE-DRILL NFR-11 a drill the monitor did not record is a failure, and the app must still be started
  it('exits 1 when the monitor never lists the outage, and the app was started', () => {
    const r = run(['run'], { BW_STUB_NO_OUTAGE: '1' });
    expect(r.status).toBe(1);
    expect(readFileSync(rec, 'utf8')).toMatch(/^Verdict: FAIL - the API lists 0 outages/m);
    expect(read('ssh.log')).toContain('start web');
  });

  // why: P8-OUTAGE-DRILL NFR-11 a failed stop must never leave the demo down (trap)
  it('starts the app again when the stop reports failure', () => {
    const r = run(['run'], { BW_STUB_STOP_RC: '1' });
    expect(r.status).toBe(1);
    expect(read('ssh.log')).toContain('start web');
  });

  // why: P8-OUTAGE-DRILL NFR-11 an interrupted run must still start the app (trap on SIGTERM)
  it('starts the app again when it is stopped in the middle of the wait (SIGTERM)', async () => {
    const child = spawn('bash', [script, 'run'], { env: env({ BW_DRILL_STOP_SECS: '60' }), cwd: root });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    const code = new Promise<number | null>((resolve) => child.on('close', resolve));
    for (let i = 0; i < 200 && !out.includes('app is down'); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(out).toContain('app is down');
    child.kill('SIGTERM');
    expect(await code).toBe(143);
    const ssh = read('ssh.log');
    expect(ssh).toContain('stop web');
    expect(ssh).toContain('start web');
  }, 30_000);

  // why: P8-OUTAGE-DRILL NFR-11 the hand restore is the way back after a hard kill
  it('restore starts web by hand', () => {
    const r = run(['restore']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(read('ssh.log')).toContain('start web');
    expect(read('ssh.log')).not.toContain('stop web');
  });

  // why: F-1591 every preflight read must refuse before the stop; each case removes its own line in outage-drill.sh and the stop would be sent
  it.each([
    ['healthz not 200 before the stop (the [ "$pre_hz" = 200 ] line)', { BW_STUB_HZ: 'always503' }, 'REFUSED: /healthz answers 503 before the stop'],
    ['ps cannot be read (the ps_out=... || line)', { BW_STUB_PS_FAIL: '1' }, 'REFUSED: cannot read the server'],
    ['web not in the ps list (the grep -qx web line)', { BW_STUB_PS_NOWEB: '1' }, 'REFUSED: web is not running'],
    ['the API read fails (the api_get api-pre line)', { BW_STUB_API_FAIL_PRE: '1' }, 'REFUSED: cannot read the UptimeRobot API'],
    ['the monitor is not up (the grep status 2 line)', { BW_STUB_MON_STATUS: '0' }, 'REFUSED: the monitor is not up'],
  ])('preflight refuses and sends no stop: %s', (_name, extra, word) => {
    const r = run(['run'], extra);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain(word);
    expect(read('ssh.log')).not.toContain('stop web');
    expect(existsSync(rec)).toBe(false);
  });

  // why: F-1591 a start that leaves /healthz down must try up -d --no-deps web once, and say so. Removing the "ssh_ $R_UP" line in start_app
  // leaves the log without "up -d", and the final wait never sees /healthz 200, so exit and the up -d assertions fail
  it('falls back to up -d when /healthz is not 200 after start, and the record shows the restart', () => {
    const r = run(['run'], { BW_STUB_HZ: 'needs-upd' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const ssh = read('ssh.log');
    expect(ssh).toContain('start web');
    expect(ssh).toContain('up -d --no-deps web');
    expect(ssh.indexOf('start web')).toBeLessThan(ssh.indexOf('up -d --no-deps web'));
    expect(r.stdout).toContain('/healthz 200 again (after up -d)');
  });

  // why: F-1591 when both starts fail the run must exit 1 and print the hand-restore line; removing the DEMO MAY BE DOWN log line fails the word check,
  // removing "return 1" after it makes the run exit 0 or take the record path
  it('says DEMO MAY BE DOWN and exits 1 when /healthz never comes back', () => {
    const r = run(['run'], { BW_STUB_HZ: 'after-stop-down' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('DEMO MAY BE DOWN');
    expect(r.stdout).toContain('up -d web');
    const ssh = read('ssh.log');
    expect(ssh).toContain('start web');
    expect(ssh).toContain('up -d --no-deps web');
  });

  // why: F-1591 a network failure on the monitor read must retry, not end the drill. Removing the retry log line in the else branch fails the
  // log check; making the else branch break instead of loop leaves no record, so the status and record checks fail
  it('retries a failed API read and still writes the record', () => {
    const r = run(['run'], { BW_STUB_API_FAIL_FIRST: '2' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('API read 1 failed (network); retrying');
    expect(r.stdout).toContain('API read 2 failed (network); retrying');
    expect(readFileSync(rec, 'utf8')).toMatch(/^Verdict: PENDING-WEB - API half passes/m);
    expect(JSON.parse(readFileSync(path.join(ev, 'facts.json'), 'utf8')).apiPolls).toBe(3);
  });

  // why: F-1591 an answer with no outage yet (the monitor is slow) must be read again. Removing the 'lists 0 outages' pattern from the case in the
  // poll loop breaks out at read 1 and the final record reads FAIL with exit 1
  it('reads the monitor again while it lists 0 outages, then passes the API half', () => {
    const r = run(['run'], { BW_STUB_API_EMPTY_FIRST: '2' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/API read 1: VERDICT FAIL .*lists 0 outages/);
    expect(r.stdout).toMatch(/API read 3: VERDICT PENDING-WEB/);
    expect(readFileSync(rec, 'utf8')).toMatch(/^Verdict: PENDING-WEB - API half passes/m);
  });

  // why: F-1591 reread is the way to refresh a record after a slow monitor. Removing the apiPolls sed line leaves the count unchanged; removing
  // the finish_record call in the reread branch leaves the FAIL record in place
  it('reread rewrites the record from a fresh API read and counts the read', () => {
    expect(run(['run'], { BW_STUB_NO_OUTAGE: '1' }).status).toBe(1);
    expect(readFileSync(rec, 'utf8')).toMatch(/^Verdict: FAIL/m);
    const before = JSON.parse(readFileSync(path.join(ev, 'facts.json'), 'utf8')).apiPolls as number;
    const r = run(['reread']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(rec, 'utf8')).toMatch(/^Verdict: PENDING-WEB - API half passes/m);
    expect(JSON.parse(readFileSync(path.join(ev, 'facts.json'), 'utf8')).apiPolls).toBe(before + 1);
  });
});

// ---- F-45: the certificate renewal alert ----
const statusScript = path.join(root, 'infra/hosted/renewal-status.sh');
const runStatus = (mode: string, env: Record<string, string>) => spawnSync('bash', [statusScript, mode], { env: { ...process.env, ...env }, encoding: 'utf8' });

describe('F-45 status file (server side)', () => {
  let file: string;
  beforeEach(() => {
    file = path.join(work, 'acme', '.well-known', 'acme-challenge', 'renewal-status.txt');
  });
  // why: F-45 a failed renewal attempt must leave RENEWAL_FAILED where the monitor reads it, or the failure end path stays silent
  it('writes RENEWAL_FAILED with a UTC time on the failure path (SERVICE_RESULT not success)', () => {
    const r = runStatus('unit', { BW_RENEWAL_STATUS_FILE: file, SERVICE_RESULT: 'exit-code', EXIT_STATUS: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(file)).toBe(true);
    const body = readFileSync(file, 'utf8');
    expect(body.split('\n')[0]).toBe('RENEWAL_FAILED');
    expect(body).toMatch(/^checked_at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m);
    expect(body).toContain('exit-code');
    expect(body).not.toContain('RENEWAL_OK');
  });
  // why: F-45 a successful attempt must flip the file back, or one old failure alerts forever
  it('writes RENEWAL_OK on success and replaces an earlier failure', () => {
    runStatus('unit', { BW_RENEWAL_STATUS_FILE: file, SERVICE_RESULT: 'timeout' });
    expect(readFileSync(file, 'utf8').split('\n')[0]).toBe('RENEWAL_FAILED');
    expect(runStatus('unit', { BW_RENEWAL_STATUS_FILE: file, SERVICE_RESULT: 'success', EXIT_STATUS: '0' }).status).toBe(0);
    expect(readFileSync(file, 'utf8').split('\n')[0]).toBe('RENEWAL_OK');
  });
  // why: F-45 a missing SERVICE_RESULT must read as a failure, never as OK
  it('treats an unknown result as a failure', () => {
    runStatus('unit', { BW_RENEWAL_STATUS_FILE: file, SERVICE_RESULT: '' });
    expect(readFileSync(file, 'utf8').split('\n')[0]).toBe('RENEWAL_FAILED');
  });
  // why: F-45 the deploy seed must not hide a real failed attempt, and must not claim OK for a certificate it cannot read
  it('the seed writes only when no file exists, and from the certificate (missing certificate reads FAILED)', () => {
    const missingCert = path.join(work, 'no-cert.pem');
    expect(runStatus('seed', { BW_RENEWAL_STATUS_FILE: file, BW_RENEWAL_CERT: missingCert }).status).toBe(0);
    expect(readFileSync(file, 'utf8').split('\n')[0]).toBe('RENEWAL_FAILED');
    runStatus('unit', { BW_RENEWAL_STATUS_FILE: file, SERVICE_RESULT: 'exit-code' });
    const before = readFileSync(file, 'utf8');
    runStatus('seed', { BW_RENEWAL_STATUS_FILE: file, BW_RENEWAL_CERT: missingCert });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  // why: F-45 a seed from a good certificate (more than 30 days) is OK; the file holds no key text
  it('the seed from a certificate valid for more than 30 days writes RENEWAL_OK', () => {
    const cert = path.join(work, 'c.pem');
    const k = path.join(work, 'k.pem');
    const g = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', k, '-out', cert, '-days', '90', '-subj', '/CN=test'], { encoding: 'utf8' });
    expect(g.status, g.stderr).toBe(0);
    expect(runStatus('seed', { BW_RENEWAL_STATUS_FILE: file, BW_RENEWAL_CERT: cert }).status).toBe(0);
    const body = readFileSync(file, 'utf8');
    expect(body.split('\n')[0]).toBe('RENEWAL_OK');
    expect(body).not.toMatch(/PRIVATE KEY|BEGIN/);
  });
  // why: F-45 the unit must run the script after success AND failure (ExecStopPost), and the deploy must ship and manage the script
  it('is wired: the service runs ExecStopPost, the deploy stages and manages the script, --host-files exists', () => {
    const unit = readFileSync(path.join(root, 'infra/hosted/systemd/brightwater-certbot-renew.service'), 'utf8');
    expect(unit).toMatch(/^ExecStopPost=-\/usr\/bin\/bash \/opt\/brightwater\/renewal-status\.sh$/m);
    expect(readFileSync(path.join(root, 'infra/deploy/deploy.sh'), 'utf8').match(/renewal-status\.sh/g)?.length).toBeGreaterThanOrEqual(2);
    const sd = readFileSync(path.join(root, 'infra/deploy/server-deploy.sh'), 'utf8');
    expect(sd).toMatch(/^MANAGED=\(.*renewal-status\.sh.*\)$/m);
    expect(sd).toContain('--host-files');
  });
});

// A fake UptimeRobot (v2 shapes) that records every call; contacts come from the first monitor.
const fakeApi = () => {
  const calls: { action: string; params: Record<string, string> }[] = [];
  let created: Record<string, string> | null = null;
  const post: Post = async (action, params) => {
    calls.push({ action, params });
    if (action === 'getMonitors' && params.search) return { stat: 'ok', monitors: created ? [{ id: 9001, friendly_name: created.friendly_name, url: created.url, status: 2 }] : [] };
    if (action === 'getMonitors' && params.alert_contacts) return { stat: 'ok', monitors: [{ id: 100000001, alert_contacts: [{ id: '777', type: 2, threshold: 0, recurrence: 0 }] }] };
    if (action === 'getMonitors') return { stat: 'ok', monitors: [{ id: 9001, status: 2 }] };
    if (action === 'newMonitor') {
      created = params;
      return { stat: 'ok', monitor: { id: 9001, status: 1 } };
    }
    throw new Error(`unexpected ${action}`);
  };
  return { post, calls };
};
const URL_ = 'http://bw.example/.well-known/acme-challenge/renewal-status.txt';

describe('F-45 monitor (UptimeRobot side, fake API)', () => {
  // why: F-45 the monitor must alert when RENEWAL_OK is missing (failed file, 404, dead server) and reach the owner's existing contact
  it('creates a keyword monitor that alerts when the OK keyword is missing, with the first monitor\'s contacts', async () => {
    const f = fakeApi();
    expect(await ensureRenewalMonitor(f.post, { existingMonitorId: 100000001, url: URL_ })).toEqual({ id: 9001, created: true });
    const n = f.calls.find((c) => c.action === 'newMonitor');
    expect(n?.params).toMatchObject({ type: '2', keyword_type: '2', keyword_value: 'RENEWAL_OK', interval: '300', url: URL_, alert_contacts: '777_0_0' });
  });
  // why: F-45 a re-run of the drill must not create a duplicate monitor (find-by-name first)
  it('is idempotent: a second call finds the monitor by name and creates nothing', async () => {
    const f = fakeApi();
    await ensureRenewalMonitor(f.post, { existingMonitorId: 100000001, url: URL_ });
    expect(await ensureRenewalMonitor(f.post, { existingMonitorId: 100000001, url: URL_ })).toEqual({ id: 9001, created: false });
    expect(f.calls.filter((c) => c.action === 'newMonitor')).toHaveLength(1);
  });
  // why: F-45 a monitor with no alert contact would be silent, which is the finding itself
  it('refuses to create a monitor when the first monitor lists no contact', async () => {
    const post: Post = async (action, params) => (action === 'getMonitors' && params.search ? { stat: 'ok', monitors: [] } : { stat: 'ok', monitors: [{ id: 1, alert_contacts: [] }] });
    await expect(ensureRenewalMonitor(post, { existingMonitorId: 1, url: URL_ })).rejects.toThrow(/no alert contact/);
  });
  // why: F-45 the drill must not create a monitor that alerts at once when the file is not OK
  it('creates nothing when the status file is not RENEWAL_OK, and passes when file, deploy and first check are good', async () => {
    const bad = fakeApi();
    const r1 = await runF45(bad.post, async () => ({ http: 200, body: 'RENEWAL_FAILED\nchecked_at=x\n' }), { existingMonitorId: 1, statusUrl: URL_, deployRc: 0, waitSec: 0, pollSec: 1 });
    expect(r1.verdict).toBe('FAIL');
    expect(bad.calls).toHaveLength(0);
    const good = fakeApi();
    const r2 = await runF45(good.post, async () => ({ http: 200, body: 'RENEWAL_OK\nchecked_at=x\n' }), { existingMonitorId: 100000001, statusUrl: URL_, deployRc: 0, waitSec: 0, pollSec: 1 });
    expect(r2).toMatchObject({ verdict: 'PASS', monitorId: 9001, created: true, firstCheckStatus: 2 });
    const r3 = await runF45(fakeApi().post, async () => ({ http: 200, body: 'RENEWAL_OK\n' }), { existingMonitorId: 100000001, statusUrl: URL_, deployRc: 1, waitSec: 0, pollSec: 1 });
    expect(r3.verdict).toBe('FAIL');
  });
  // why: F-45 the record shows the status file check, the monitor id and its first check
  it('the record gains an F-45 section with the file check, the monitor id and the first check; no key', () => {
    const f45 = { deployRc: 0, statusUrl: URL_, statusHttp: 200, statusFirstLine: 'RENEWAL_OK', statusOk: true, monitorId: 9001, created: true, firstCheckStatus: 2, polls: 1, verdict: 'PASS' as const, detail: 'ok' };
    const md = renderRecord(measure(facts(), answer(oneOutage)), f45);
    expect(md).toMatch(/^## F-45: certificate renewal alert/m);
    expect(md).toMatch(/id 9001, created by this run/);
    expect(md).toMatch(/status 2 \(2 = up\)/);
    expect(md).toMatch(/HTTP 200, first line "RENEWAL_OK"/);
    expect(md).not.toMatch(/api_key/);
  });
});

describe('F-45 in the driver', () => {
  let srv: Server;
  let base: string;
  let seen: string[];
  beforeEach(async () => {
    seen = [];
    srv = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += String(d)));
      req.on('end', () => {
        const p = new URLSearchParams(body);
        seen.push(`${req.method} ${req.url} ${[...p.keys()].filter((k) => k !== 'api_key').join(',')}`);
        if (body.includes(FAKE_KEY)) seen.push(`KEY-IN-BODY-OK`);
        res.setHeader('content-type', 'application/json');
        if (req.url === '/status') return void res.end('RENEWAL_OK\nchecked_at=2026-11-14T00:00:00Z\n');
        if (req.url === '/v2/getMonitors' && p.get('search')) return void res.end(JSON.stringify({ stat: 'ok', monitors: [] }));
        if (req.url === '/v2/getMonitors' && p.get('alert_contacts')) return void res.end(JSON.stringify({ stat: 'ok', monitors: [{ id: 100000001, alert_contacts: [{ id: '777' }] }] }));
        if (req.url === '/v2/getMonitors') return void res.end(JSON.stringify({ stat: 'ok', monitors: [{ id: 9001, status: 2 }] }));
        if (req.url === '/v2/newMonitor') return void res.end(JSON.stringify({ stat: 'ok', monitor: { id: 9001, status: 1 } }));
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => srv.close(() => r())));

  // why: F-45 the server change must go in INSIDE the stop window: after the stop is confirmed, before the start, through the deploy command
  it('runs the deploy step between the stop and the start, then writes the F-45 section with the monitor id and first check', async () => {
    const deploy = path.join(work, 'fake-deploy.sh');
    writeFileSync(deploy, `#!/bin/sh\necho "DEPLOY $*" >> "${work}/ssh.log"\nexit 0\n`);
    chmodSync(deploy, 0o755);
    const r = await runAsync(['run'], { BW_DRILL_DEPLOY_CMD: `${deploy} --host-files`, BW_DRILL_API_BASE: `${base}/v2`, BW_DRILL_STATUS_URL: `${base}/status`, BW_DRILL_F45_WAIT: '5' });
    expect(r.status, r.out).toBe(0);
    const ssh = read('ssh.log');
    expect(ssh).toContain('DEPLOY --host-files');
    expect(ssh.indexOf('stop web')).toBeLessThan(ssh.indexOf('DEPLOY --host-files'));
    expect(ssh.indexOf('DEPLOY --host-files')).toBeLessThan(ssh.indexOf('start web'));
    const md = readFileSync(rec, 'utf8');
    expect(md).toMatch(/^F-45: PASS/m);
    expect(md).toMatch(/id 9001, created by this run/);
    expect(seen.filter((x) => x.includes('/v2/newMonitor'))).toHaveLength(1);
    expect(seen.some((x) => x.includes('KEY-IN-BODY-OK'))).toBe(true);
    expect(allText()).not.toContain(FAKE_KEY);
    expect(r.out).not.toContain(FAKE_KEY);
  }, 60_000);

  // why: F-45 a deploy step that fails must not stop the restart, and the record must say so
  it('a failed deploy step is recorded as an F-45 FAIL and the app is still started', async () => {
    const r = await runAsync(['run'], { BW_DRILL_DEPLOY_CMD: 'false', BW_DRILL_API_BASE: `${base}/v2`, BW_DRILL_STATUS_URL: `${base}/status`, BW_DRILL_F45_WAIT: '5' });
    expect(read('ssh.log')).toContain('start web');
    expect(readFileSync(rec, 'utf8')).toMatch(/^F-45: FAIL - the deploy step exited 1/m);
    expect(r.status, r.out).toBe(0);
  }, 60_000);
});
