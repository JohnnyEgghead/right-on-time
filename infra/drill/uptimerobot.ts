// SPDX-License-Identifier: AGPL-3.0-or-later
// P8-OUTAGE-DRILL: reads UptimeRobot's getMonitors answer (v2 API, POST getMonitors with logs=1), finds the outage the drill caused,
// and writes the spike record from the values outage-drill.sh measured. No network and no key here: the driver fetches the JSON.
//
// Shapes read (recorded from the live monitor, P1-MONITOR and the P8 read): { stat: 'ok', monitors: [{ id, interval, status, create_datetime,
// logs: [{ type: 1 down | 2 up, datetime: <true UTC epoch s>, duration: <s>, reason: { code, detail } }] }] }. Logs arrive newest first.
// A down log's duration is closed when an up log follows it; the newest up log's duration is a running counter (P1-MONITOR).
//
//   node infra/drill/uptimerobot.ts finish --dir <evidence folder> --out <record .md> [--evidence-label <how the record names the folder>]
// reads <dir>/facts.json and <dir>/api-raw.json (and <dir>/f45.json when the F-45 step ran, and <dir>/owner-look.json when the owner has
// looked at the monitor's web history: { answerId, answeredEpoch, saw }), writes <dir>/measured.json and <out>,
// prints the last line "VERDICT <word>".
//   node infra/drill/uptimerobot.ts f45 --dir <evidence folder> --key-file <file> --existing <monitor id> --status-url <url> --deploy-rc <n>
// F-45 (certificate renewal alert), after the restart: reads the renewal status file, finds or creates the 2nd monitor, reads its first
// check, writes <dir>/f45.json. This is the only code here that talks to UptimeRobot, and the only write is newMonitor (once, find-by-name
// first). API docs: https://uptimerobot.com/api/v2/ (newMonitor: type, keyword_type, keyword_value, keyword_case_type, alert_contacts as
// id_threshold_recurrence joined by "-", interval; getMonitors: search, alert_contacts). Keyword monitors are on the Free plan with a 5 minute
// interval: https://uptimerobot.com/pricing/ (read Nov 14, 2026). The key is read from the key file, sent in a POST body, never printed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMain } from '../../ci/is-main.ts';

export type Log = { type: number; datetime: number; duration: number; reason: string };
export type Outage = { downAt: number; upAt: number | null; durationSec: number | null; closed: boolean; reason: string };
export type Monitor = { id: number; interval: number; status: number; createDatetime: number; logs: Log[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads one monitor out of the getMonitors JSON. Throws a plain message on a failed call or an unexpected shape. */
export function parseMonitor(json: unknown): Monitor {
  if (!isObj(json)) throw new Error('UptimeRobot answer is not a JSON object');
  if (json.stat !== 'ok') {
    const err = isObj(json.error) ? String(json.error.message ?? json.error.type ?? 'unknown') : 'no error field';
    throw new Error(`UptimeRobot answered stat=${String(json.stat)} (${err})`);
  }
  const list = json.monitors;
  if (!Array.isArray(list) || list.length !== 1 || !isObj(list[0])) throw new Error('UptimeRobot answer holds no single monitor');
  const m = list[0];
  const num = (v: unknown, name: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`monitor field ${name} is not a number`);
    return v;
  };
  const rawLogs = m.logs === undefined ? [] : m.logs;
  if (!Array.isArray(rawLogs)) throw new Error('monitor logs is not a list');
  const logs: Log[] = rawLogs.map((l, i) => {
    if (!isObj(l)) throw new Error(`log ${i} is not an object`);
    const r = isObj(l.reason) ? `${String(l.reason.code ?? '')} ${String(l.reason.detail ?? '')}`.trim() : '';
    return { type: num(l.type, `logs[${i}].type`), datetime: num(l.datetime, `logs[${i}].datetime`), duration: num(l.duration, `logs[${i}].duration`), reason: r };
  });
  return { id: num(m.id, 'id'), interval: num(m.interval, 'interval'), status: num(m.status, 'status'), createDatetime: num(m.create_datetime, 'create_datetime'), logs };
}

/**
 * The outages whose down log falls in [startEpoch, endEpoch + intervalSec]: a check cannot see the stop before it happens, and a check
 * just after the restart can still catch the app coming up. Each is paired with the first up log after it (upAt null while still down).
 */
export function findOutages(logs: Log[], startEpoch: number, endEpoch: number, intervalSec: number): Outage[] {
  const asc = [...logs].sort((a, b) => a.datetime - b.datetime);
  const out: Outage[] = [];
  for (const d of asc) {
    if (d.type !== 1 || d.datetime < startEpoch || d.datetime > endEpoch + intervalSec) continue;
    const up = asc.find((u) => u.type === 2 && u.datetime > d.datetime);
    out.push({ downAt: d.datetime, upAt: up ? up.datetime : null, durationSec: up ? up.datetime - d.datetime : null, closed: Boolean(up), reason: d.reason });
  }
  return out;
}

/**
 * The monitor sees a stop of `stopSec` between (stopSec - interval) and (stopSec + interval) seconds wide: the down log lands at the first
 * check after the stop (0 to interval late) and the up log at the first check after the restart (0 to interval late).
 */
export function durationInBand(durationSec: number, stopSec: number, intervalSec: number): boolean {
  return durationSec >= stopSec - intervalSec && durationSec <= stopSec + intervalSec;
}

const FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
/** "Nov 14, 1:02:03 PM EST": the epoch shown in America/New_York with its zone label. */
export function nyTime(epoch: number): string {
  return FMT.format(new Date(epoch * 1000));
}
const utcTime = (epoch: number): string => `${new Date(epoch * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
const both = (epoch: number): string => `${nyTime(epoch)} (${utcTime(epoch)}, epoch ${epoch})`;
const minSec = (s: number): string => `${Math.floor(s / 60)} min ${s % 60} s`;

export type Facts = {
  commit: string;
  preHealthz: number;
  stopServerEpoch: number;
  stopLocalEpoch: number;
  startServerEpoch: number;
  startLocalEpoch: number;
  healthzOkEpoch: number | null;
  healthzOkStatus: number;
  stopSecs: number;
  intervalSec: number;
  apiPolls: number;
};

export type Measured = {
  verdict: string;
  detail: string;
  facts: Facts;
  stoppedSecs: number | null;
  monitorId: number;
  monitorStatus: number;
  outages: Outage[];
  oldestLogEpoch: number | null;
  createdEpoch: number;
};

export type OwnerLook = { answerId: string; answeredEpoch: number; saw: string };

/** Parses <dir>/owner-look.json: the owner's own look at the monitor's web history, saved as data. Throws a plain message on a bad shape. */
export function parseOwnerLook(json: unknown): OwnerLook {
  if (!isObj(json)) throw new Error('owner-look.json is not a JSON object');
  const { answerId, answeredEpoch, saw } = json;
  if (typeof answerId !== 'string' || answerId === '') throw new Error('owner-look.json: answerId is not a string');
  if (typeof answeredEpoch !== 'number' || !Number.isFinite(answeredEpoch)) throw new Error('owner-look.json: answeredEpoch is not a number');
  if (typeof saw !== 'string' || saw === '') throw new Error('owner-look.json: saw is not a string');
  return { answerId, answeredEpoch, saw };
}

/** The owner's look turns PENDING-WEB into PASS. It never changes any other verdict: a FAIL stays a FAIL. */
export function withOwnerLook(m: Measured, look: OwnerLook | null): Measured {
  if (look === null || m.verdict !== 'PENDING-WEB') return m;
  return { ...m, verdict: 'PASS', detail: `the API half passes and the owner confirmed the web history by his own look (answer ${look.answerId}, ${nyTime(look.answeredEpoch)})` };
}

export function measure(facts: Facts, apiJson: unknown): Measured {
  const mon = parseMonitor(apiJson);
  const end = facts.healthzOkEpoch ?? facts.startLocalEpoch;
  const outages = findOutages(mon.logs, facts.stopLocalEpoch, end, facts.intervalSec);
  const oldest = mon.logs.length ? Math.min(...mon.logs.map((l) => l.datetime)) : null;
  const first = outages[0];
  let verdict: string;
  let detail: string;
  if (facts.healthzOkStatus !== 200) {
    verdict = 'FAIL';
    detail = `/healthz answered ${facts.healthzOkStatus} after the restart`;
  } else if (outages.length !== 1) {
    verdict = 'FAIL';
    detail = `the API lists ${outages.length} outages in the drill window, not 1`;
  } else if (first === undefined || !first.closed || first.durationSec === null) {
    verdict = 'FAIL';
    detail = 'no up log yet after the outage the API lists (re-read with: bash infra/drill/outage-drill.sh reread)';
  } else if (!durationInBand(first.durationSec, facts.stopSecs, facts.intervalSec)) {
    verdict = 'FAIL';
    detail = `the outage lasts ${first.durationSec} s, outside ${facts.stopSecs - facts.intervalSec} to ${facts.stopSecs + facts.intervalSec} s`;
  } else {
    verdict = 'PENDING-WEB';
    detail = 'API half passes; the web history half waits for a human look or a screenshot';
  }
  return {
    verdict,
    detail,
    facts,
    stoppedSecs: facts.healthzOkEpoch === null ? null : facts.healthzOkEpoch - facts.stopLocalEpoch,
    monitorId: mon.id,
    monitorStatus: mon.status,
    outages,
    oldestLogEpoch: oldest,
    createdEpoch: mon.createDatetime + 36000, // P1-MONITOR: create_datetime reads 36000 s behind true UTC
  };
}

export type F45 = {
  deployRc: number | null;
  statusUrl: string;
  statusHttp: number | null;
  statusFirstLine: string;
  statusOk: boolean;
  monitorId: number | null;
  created: boolean | null;
  firstCheckStatus: number | null;
  polls: number;
  verdict: 'PASS' | 'FAIL';
  detail: string;
};

// F-45: the 2nd monitor. A keyword monitor on the plain-http status file (port 80 needs no certificate, so it keeps working when the
// certificate is the problem). Alert rule: "keyword does NOT exist" for RENEWAL_OK, so a FAILED file, a 404 (file or nginx gone) and an
// unreachable server all alert. A stale file cannot be seen by a fixed keyword; the file is rewritten twice a day and a dead timer is not covered.
export const RENEWAL_MONITOR_NAME = 'Brightwater certificate renewal';
export const RENEWAL_KEYWORD = 'RENEWAL_OK';
export const KEYWORD_MONITOR_TYPE = '2';
export const KEYWORD_NOT_EXISTS = '2';
export const KEYWORD_CASE_SENSITIVE = '0';
export const UP = 2;
export const DOWN = 9;

export type Post = (action: string, params: Record<string, string>) => Promise<unknown>;

const monitorsOf = (json: unknown, what: string): Record<string, unknown>[] => {
  if (!isObj(json)) throw new Error(`${what}: answer is not a JSON object`);
  if (json.stat !== 'ok') {
    const err = isObj(json.error) ? String(json.error.message ?? json.error.type ?? 'unknown') : 'no error field';
    throw new Error(`${what}: UptimeRobot answered stat=${String(json.stat)} (${err})`);
  }
  return Array.isArray(json.monitors) ? json.monitors.filter(isObj) : [];
};

/** Finds the renewal monitor by name, or creates it wired to the contacts of the existing monitor. Idempotent: a second call finds it. */
export async function ensureRenewalMonitor(post: Post, o: { existingMonitorId: number; url: string; name?: string }): Promise<{ id: number; created: boolean }> {
  const name = o.name ?? RENEWAL_MONITOR_NAME;
  const found = monitorsOf(await post('getMonitors', { search: name }), 'find').find((m) => m.friendly_name === name);
  if (found) {
    if (found.url !== o.url) throw new Error(`monitor "${name}" exists with another URL; not touching it`);
    return { id: Number(found.id), created: false };
  }
  const existing = monitorsOf(await post('getMonitors', { monitors: String(o.existingMonitorId), alert_contacts: '1' }), 'contacts')[0];
  const contacts = existing && Array.isArray(existing.alert_contacts) ? existing.alert_contacts.filter(isObj) : [];
  if (contacts.length === 0) throw new Error(`monitor ${o.existingMonitorId} lists no alert contact to copy`);
  const created = await post('newMonitor', {
    friendly_name: name,
    url: o.url,
    type: KEYWORD_MONITOR_TYPE,
    keyword_type: KEYWORD_NOT_EXISTS,
    keyword_value: RENEWAL_KEYWORD,
    keyword_case_type: KEYWORD_CASE_SENSITIVE,
    interval: '300',
    alert_contacts: contacts.map((c) => `${String(c.id)}_0_0`).join('-'),
  });
  if (!isObj(created) || created.stat !== 'ok' || !isObj(created.monitor)) {
    const err = isObj(created) && isObj(created.error) ? String(created.error.message ?? created.error.type) : 'no monitor in the answer';
    throw new Error(`newMonitor failed (${err})`);
  }
  return { id: Number(created.monitor.id), created: true };
}

/** Polls the monitor until its first check lands (status 2 up or 9 down), up to waitSec. */
export async function firstCheck(post: Post, id: number, waitSec: number, pollSec: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<{ status: number | null; polls: number }> {
  let polls = 0;
  let status: number | null = null;
  for (let waited = 0; ; waited += pollSec) {
    polls += 1;
    const m = monitorsOf(await post('getMonitors', { monitors: String(id) }), 'first check')[0];
    status = m && typeof m.status === 'number' ? m.status : null;
    if (status === UP || status === DOWN || waited >= waitSec) return { status, polls };
    await sleep(pollSec * 1000);
  }
}

export type StatusRead = { http: number | null; body: string };

/** The whole certificate renewal alert check after the restart (F-45): the status file, the monitor, its first check. Never throws: a failure becomes a FAIL verdict with its reason. */
export async function runF45(post: Post, getStatus: () => Promise<StatusRead>, o: { existingMonitorId: number; statusUrl: string; deployRc: number | null; waitSec: number; pollSec: number }, sleep?: (ms: number) => Promise<void>): Promise<F45> {
  const r: F45 = { deployRc: o.deployRc, statusUrl: o.statusUrl, statusHttp: null, statusFirstLine: '', statusOk: false, monitorId: null, created: null, firstCheckStatus: null, polls: 0, verdict: 'FAIL', detail: '' };
  try {
    const s = await getStatus();
    r.statusHttp = s.http;
    r.statusFirstLine = s.body.split('\n')[0]?.trim().slice(0, 60) ?? '';
    r.statusOk = s.http === 200 && r.statusFirstLine === RENEWAL_KEYWORD;
    if (!r.statusOk) {
      r.detail = `the status file answers HTTP ${s.http ?? 'none'} with first line "${r.statusFirstLine}", not ${RENEWAL_KEYWORD}; no monitor created (it would alert at once)`;
      return r;
    }
    const e = await ensureRenewalMonitor(post, { existingMonitorId: o.existingMonitorId, url: o.statusUrl });
    r.monitorId = e.id;
    r.created = e.created;
    const c = await firstCheck(post, e.id, o.waitSec, o.pollSec, sleep);
    r.firstCheckStatus = c.status;
    r.polls = c.polls;
    if (c.status !== UP) r.detail = `the monitor's first check is status ${c.status ?? 'none'} (2 = up), not up`;
    else if (o.deployRc !== 0) r.detail = `the deploy step exited ${o.deployRc ?? 'not run'}, though the file and the monitor are good`;
    else {
      r.verdict = 'PASS';
      r.detail = 'status file served, monitor created and up';
    }
  } catch (e) {
    r.detail = (e as Error).message;
  }
  return r;
}

const f45Lines = (f: F45 | null): string[] =>
  f === null
    ? ['## F-45: certificate renewal alert', '', 'NOT RUN: no f45.json in the evidence folder.', '']
    : [
        '## F-45: certificate renewal alert',
        '',
        `F-45: ${f.verdict} - ${f.detail}`,
        '',
        '| Check | Result |',
        '|---|---|',
        `| server change deployed in the stop window (deploy.sh --host-files) | exit ${f.deployRc === null ? 'not run' : f.deployRc} |`,
        `| status file after the restart | ${f.statusUrl} -> HTTP ${f.statusHttp ?? 'none'}, first line "${f.statusFirstLine}" |`,
        `| 2nd monitor | id ${f.monitorId ?? 'none'}, ${f.created === null ? 'n/a' : f.created ? 'created by this run' : 'already existed (found by name)'}; keyword monitor, alerts when "${RENEWAL_KEYWORD}" is missing from the page |`,
        `| monitor's first check | status ${f.firstCheckStatus ?? 'none'} (2 = up), ${f.polls} read(s) |`,
        '',
        'A fixed keyword cannot see a stale file: a dead timer is not covered; a failed attempt, a missing file or a dead server is.',
        '',
      ];

/** F-1605: `evidence` is the evidence folder as the record names it (outage-drill.sh passes it repo-relative); no path is written in here. */
export function renderRecord(m: Measured, f45: F45 | null | undefined = undefined, look: OwnerLook | null = null, evidence: string | null = null): string {
  const f = m.facts;
  const o = m.outages[0];
  const apiLine = o
    ? `API outage: down log ${nyTime(o.downAt)}, up log ${o.upAt === null ? 'none yet' : nyTime(o.upAt)}, ${o.durationSec === null ? 'open' : minSec(o.durationSec)} (${o.reason})`
    : 'API outage: none found in the drill window';
  const measured = `app stopped ${nyTime(f.stopLocalEpoch)}, /healthz 200 again ${f.healthzOkEpoch === null ? 'never' : nyTime(f.healthzOkEpoch)} (${m.stoppedSecs === null ? 'n/a' : minSec(m.stoppedSecs)}); ${apiLine}; monitor status ${m.monitorStatus}`;
  const lines: string[] = [
    '# P8-OUTAGE-DRILL: planned 12-minute outage',
    '',
    `Verdict: ${m.verdict} - ${m.detail}`,
    `Measured: ${measured}`,
    ...(f45 === undefined ? [] : [`F-45: ${f45 === null ? 'NOT RUN' : `${f45.verdict} - ${f45.detail}`}`]),
    '',
    `Generated by \`bash infra/drill/outage-drill.sh run\` from the values it measured. Times are America/New_York with the zone label, then UTC and the epoch. Evidence: ${evidence === null ? 'the evidence folder the drill wrote' : `\`${evidence.replace(/\/?$/, '/')}\``} (kept there, not in git).`,
    '',
    '## The drill',
    '',
    '| Step | Time | Source |',
    '|---|---|---|',
    `| /healthz before the stop | HTTP ${f.preHealthz} | this Mac, curl |`,
    `| app stopped (the stop command returned) | ${both(f.stopLocalEpoch)} | this Mac clock; the server clock read ${f.stopServerEpoch} |`,
    `| app start issued | ${both(f.startLocalEpoch)} | this Mac clock; the server clock read ${f.startServerEpoch} |`,
    `| /healthz first 200 again | ${f.healthzOkEpoch === null ? 'never' : both(f.healthzOkEpoch)} | this Mac, curl |`,
    `| planned stop | ${minSec(f.stopSecs)} | measured stop to start issued: ${minSec(f.startLocalEpoch - f.stopLocalEpoch)} |`,
    `| outage as the app saw it (stop to first 200) | ${m.stoppedSecs === null ? 'n/a' : minSec(m.stoppedSecs)} | |`,
    '',
    '## UptimeRobot API',
    '',
    `Monitor ${m.monitorId}, interval ${f.intervalSec} s, status ${m.monitorStatus} (2 = up) at the last read, ${f.apiPolls} read(s). Outages whose down log falls in the drill window: ${m.outages.length}.`,
    '',
    '| Down log | Up log | Duration | Reason |',
    '|---|---|---|---|',
    ...m.outages.map((x) => `| ${both(x.downAt)} | ${x.upAt === null ? 'none yet' : both(x.upAt)} | ${x.durationSec === null ? 'open' : `${x.durationSec} s (${minSec(x.durationSec)})`} | ${x.reason} |`),
    '',
    `The monitor can see a ${minSec(f.stopSecs)} stop as ${f.stopSecs - f.intervalSec} to ${f.stopSecs + f.intervalSec} s: the down log lands at the first check after the stop and the up log at the first check after the restart, each later than the event by up to the ${f.intervalSec} s check interval plus the monitor's own confirmation delay. The drill's down log came ${m.outages[0] === undefined ? 'n/a' : `${minSec(m.outages[0].downAt - f.stopLocalEpoch)} after the stop${m.outages[0].downAt - f.stopLocalEpoch > f.intervalSec ? ', which is more than 1 interval' : ''}`}. The duration column is computed here from the down and up log times; the API's own duration field is not used (it read 0 on the closed outage).`,
    '',
    '## History retention (build-verified)',
    '',
    m.oldestLogEpoch === null
      ? 'No logs came back.'
      : `The API returned logs back to ${nyTime(m.oldestLogEpoch)}, which is ${Math.floor((f.stopLocalEpoch - m.oldestLogEpoch) / 86400)} days before the drill and the monitor's first day (created ${nyTime(m.createdEpoch)}); nothing was dropped inside that span. The 7-day window the plan reads after the drill fits inside what the API keeps.`,
    '',
    ...(f45 === undefined ? [] : [...f45Lines(f45)]),
    '## Web history (human look)',
    '',
    ...(look === null
      ? ['PENDING. The dashboard needs the owner\'s login. Proposed capture: a qa-tester step opens the monitor\'s page in the owner\'s signed-in browser, screenshots its event log showing 1 down and 1 up event at the times above, and saves it in the evidence folder; this record then changes its Verdict to PASS.']
      : [`PASS by the owner's look (dashboard answer ${look.answerId}, ${nyTime(look.answeredEpoch)}). The owner opened the monitor's web history in his own signed-in browser and answered "I see it": ${look.saw}. Read from \`owner-look.json\` in the evidence folder; the API half above is the machine check.`]),
    '',
  ];
  return lines.join('\n');
}

function arg(argv: string[], name: string): string {
  const i = argv.indexOf(name);
  if (i < 0 || !argv[i + 1]) throw new Error(`missing ${name}`);
  return argv[i + 1] as string;
}

export function main(argv: string[]): number {
  if (argv[0] !== 'finish') {
    console.error('usage: node infra/drill/uptimerobot.ts finish|f45 --dir <evidence folder> --out <record .md>');
    return 2;
  }
  const dir = arg(argv, '--dir');
  const out = arg(argv, '--out');
  const label = argv.includes('--evidence-label') ? arg(argv, '--evidence-label') : null;
  const facts = JSON.parse(readFileSync(path.join(dir, 'facts.json'), 'utf8')) as Facts;
  const lookFile = path.join(dir, 'owner-look.json');
  const look = existsSync(lookFile) ? parseOwnerLook(JSON.parse(readFileSync(lookFile, 'utf8'))) : null;
  const m = withOwnerLook(measure(facts, JSON.parse(readFileSync(path.join(dir, 'api-raw.json'), 'utf8'))), look);
  const f45File = path.join(dir, 'f45.json');
  const f45 = existsSync(f45File) ? (JSON.parse(readFileSync(f45File, 'utf8')) as F45) : null;
  writeFileSync(path.join(dir, 'measured.json'), `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(out, renderRecord(m, f45, look, label));
  console.log(`VERDICT ${m.verdict} ${m.detail}`);
  return m.verdict === 'FAIL' ? 1 : 0;
}

/**
 * F-1687: a count of seconds from the environment: the default when the variable is unset, else a plain positive number. An empty value
 * (Number('') is 0, a poll with no delay) or '30s' (NaN, a poll that never ends) is refused with an error, never passed on.
 */
export function envSeconds(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of seconds (got '${raw}')`);
  return n;
}

/** The F-45 step as a command: real fetch, key from the key file. Writes <dir>/f45.json; exit 1 on a FAIL verdict. */
export async function f45Main(argv: string[]): Promise<number> {
  const dir = arg(argv, '--dir');
  const key = readFileSync(arg(argv, '--key-file'), 'utf8').replace(/\s+/g, '');
  const base = process.env.BW_DRILL_API_BASE ?? 'https://api.uptimerobot.com/v2';
  const post: Post = async (action, params) => {
    const res = await fetch(`${base}/${action}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ api_key: key, format: 'json', ...params }), signal: AbortSignal.timeout(30_000) });
    return (await res.json()) as unknown;
  };
  const statusUrl = arg(argv, '--status-url');
  const getStatus = async (): Promise<StatusRead> => {
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(15_000) });
    return { http: res.status, body: await res.text() };
  };
  const rcArg = Number(arg(argv, '--deploy-rc'));
  const f = await runF45(post, getStatus, {
    existingMonitorId: Number(arg(argv, '--existing')),
    statusUrl,
    deployRc: Number.isFinite(rcArg) ? rcArg : null,
    waitSec: envSeconds('BW_DRILL_F45_WAIT', 600),
    pollSec: envSeconds('BW_DRILL_F45_POLL', 30),
  });
  writeFileSync(path.join(dir, 'f45.json'), `${JSON.stringify(f, null, 2)}\n`);
  console.log(`F-45 ${f.verdict} ${f.detail}`);
  return f.verdict === 'PASS' ? 0 : 1;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = process.argv[2] === 'f45' ? await f45Main(process.argv.slice(2)) : main(process.argv.slice(2));
  } catch (e) {
    console.error(`outage-drill: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
