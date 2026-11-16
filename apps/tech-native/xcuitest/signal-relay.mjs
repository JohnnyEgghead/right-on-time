// SPDX-License-Identifier: AGPL-3.0-or-later
// The phone's signal for the native XCUITest suite (P6-NATIVE-SHELL; xcuitest/run.sh). The iOS Simulator has no airplane mode, so the
// app's server address is this relay, and the test cuts its only network path here: "off" stops listening and destroys every open
// connection, so each call the app makes fails as it does with no signal (a connection error, no HTTP answer), the background upload
// tasks included; "on" listens again. Every request is forwarded to the Compose stack unchanged and logged: 1 RELAY line per request,
// and for API-102 a RELAY-ITEMS line naming the item keys in the batch, so the log shows each send the server received.
//   node xcuitest/signal-relay.mjs <relay-port> <control-port> <upstream-origin> <log-file>
// Control (the test runner calls it over HTTP): GET /signal/on, GET /signal/off, GET /mark?name=<word> (a RELAY-MARK line, so a run can slice the log by phase), GET /delay?ms=<n> (the next request waits n ms before
// it is forwarded: the Checking state stays on screen long enough to be read), GET /probe/credentials (the sample sign-in, for the app's
// probe: apps/tech-native/src/screens/Probe.tsx), GET /office/note?job=<n>&text=<words> (P6-NATIVE-JOB: the dispatcher saves an office
// note with Add note, API-140, by the web session run.sh gave this process; answers API-140's answer). GET /api/v1/server-info on the control port answers
// as another product would (404, JSON): the address of a server that is not Right On Time.
// P6-NATIVE-TODAY adds: GET /probe/credentials?who=maria|reviewer|off (the rig's other sample sign-ins, from the environment), GET /items/count
// (how many API-102 sends the relay forwarded, counted when each is forwarded, after any rule's delay), GET /items/arrived (how many API-102
// requests reached the relay, counted on arrival, before any delay: "nothing is sent before the confirm"), and one-shot rules per path, consumed in order by the
// next requests of that path: GET /rule?path=<p>&n=<count>&do=delay&ms=<n> | drop (destroy the connection) | hold (keep the connection, never answer: F-1368) | unauth (forward without the bearer token: the server answers 401) |
// nextday (answer the day with its date 1 day later) | dropjob (answer the day without its last job) | firstdone (answer the day's route, API-163, with its
// first stop done and the second Next: the Map frame's Done row, F-1075).
// Fix pass 1 adds: do=late (answer the day with a late text on its next job, as FR-TEXT-5's worker would have sent one: CTL-TEC-02-07 and
// -02-15), do=accesscode (answer the server's own access_code_required Problem, as a server with the access code on refuses a signed-out
// call: SCR-EML-03 Not available), and GET /seen?prefix=<path> (how many requests with that path the relay forwarded, answered: the
// in-app browser's GET of a one-time email link), and GET /signins (the Stay signed in flag of each API-03 sign-in the relay forwarded, in
// order, comma separated: CTL-TEC-01-08 "its value rides on API-03"; the password is never read or logged).
// P6-XCUITEST adds: do=noparts on /api/v1/tech/items (the batch goes on to the server with each finish's parts emptied and No parts used
// off, so the server itself refuses the finish with parts_required: F-1095 (c), the server-refused finish), and GET /items/age?hours=<h>&n=<k>
// (the k oldest waiting items in the app's own item files, bw-items in the simulator's app container, made h hours older by their entered
// real time, enteredRealMs: FR-TECH-7's "moving the device clock 25 hours" for the waiting-item banner, read by the app at its next open;
// the demo clock is the server's and is not touched). It needs BW_SIM_UDID and BW_APP_BUNDLE in the environment; the app must be closed.
// P6-NATIVE-STEPS adds a RELAY-FILE line per stored file read (API-175) naming the size it asked for (thumb, or full for none).
// Each line carries its order (seq) and the relay's own uptime in seconds (up): no wall clock is read (FR-DEMO-2's lint covers apps/).
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const [relayPort, controlPort, upstream, logFile] = process.argv.slice(2);
if (!relayPort || !controlPort || !upstream || !logFile) {
  console.error('usage: signal-relay.mjs <relay-port> <control-port> <upstream-origin> <log-file>');
  process.exit(2);
}
const up = new URL(upstream);
// The upstream is http (the Compose stack) or https (xcuitest/reviewer-hosted.sh: the hosted site).
const request = up.protocol === 'https:' ? httpsRequest : httpRequest;
let seq = 0;
const iso = () => `${++seq} up=${process.uptime().toFixed(3)}`;
const log = (line) => appendFileSync(logFile, `${line}\n`);
const sockets = new Set();
let delayNext = 0;
let itemSends = 0;
/** The API-102 requests that reached the relay, counted on arrival, before a rule's delay (F-1112). */
let itemArrivals = 0;
/** The paths the relay forwarded (the last 5000), for /seen. */
const forwarded = [];
/** keepSignedIn of each API-03 sign-in forwarded, for /signins. */
const signins = [];
/** path -> queue of one-shot rules (P6-NATIVE-TODAY). */
const rules = new Map();

const relay = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const wait = delayNext;
    delayNext = 0;
    if (req.method === 'POST' && (req.url ?? '/').split('?')[0] === '/api/v1/tech/items') itemArrivals += 1;
    const queue = rules.get((req.url ?? '/').split('?')[0]);
    const rule = queue?.[0];
    if (rule) {
      rule.n -= 1; // a rule applies to its next n requests (default 1)
      if (rule.n <= 0) queue?.shift();
    }
    if (rule) log(`RELAY-RULE seq=${iso()} ${rule.do} ${(req.url ?? '/').split('?')[0]}`);
    if (rule?.do === 'drop') return void req.socket.destroy();
    if (rule?.do === 'hold') return; // F-1368: accepted and never answered (the socket stays open), as a deleted copy behind a live address
    setTimeout(() => forward(req, res, body, rule?.do), wait + (rule?.do === 'delay' ? rule.ms : 0));
  });
});
relay.on('connection', (s) => {
  sockets.add(s);
  s.on('close', () => sockets.delete(s));
});

/** A wire time moved by `min` minutes inside its day ("2026-09-15T10:00:00-04:00[America/New_York]"); the offset and zone are kept. */
const later = (wire, min) => {
  const m = /^(\d{4}-\d{2}-\d{2}T)(\d{2}):(\d{2})(.*)$/.exec(wire ?? '');
  if (!m) return wire;
  const t = Number(m[2]) * 60 + Number(m[3]) + min;
  return `${m[1]}${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}${m[4].replace(/^:\d{2}/, ':00')}`;
};

const nextDay = (d) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

/** do=noparts: the batch with every finish's parts emptied and No parts used off (the server's own parts_required refusal follows). */
const withoutParts = (body) => {
  try {
    const j = JSON.parse(body.toString('utf8'));
    let n = 0;
    for (const i of j.items ?? []) {
      if (i.kind === 'finished' && i.payload) {
        i.payload.parts = [];
        i.payload.noPartsUsed = false;
        n += 1;
      }
    }
    log(`RELAY-NOPARTS seq=${iso()} finishes=${n}`);
    return Buffer.from(JSON.stringify(j), 'utf8');
  } catch {
    return body;
  }
};

function forward(req, res, rawBody, mode) {
  const path = req.url ?? '/';
  const body = mode === 'noparts' && req.method === 'POST' && path.split('?')[0] === '/api/v1/tech/items' ? withoutParts(rawBody) : rawBody;
  if (req.method === 'POST' && path.split('?')[0] === '/api/v1/tech/items') {
    if (mode !== 'unauth') itemSends += 1; // an attempt the server refuses as signed out is not a send
    try {
      const keys = JSON.parse(body.toString('utf8')).items.map((i) => i.key);
      log(`RELAY-ITEMS seq=${iso()} keys=${keys.join(',')}`);
    } catch {
      log(`RELAY-ITEMS seq=${iso()} keys=unreadable`);
    }
  }
  if (mode === 'accesscode') {
    // the Problem a server with the access code on answers a signed-out call (packages/api errors.ts: access_code_required, 403)
    const problem = JSON.stringify({ type: 'https://bw.j7l.io/errors/access_code_required', title: 'error.access_code_required', status: 403, code: 'access_code_required',
      meta: { contract: 'relay', worldEpoch: 0, demoNow: '' } });
    res.writeHead(403, { 'content-type': 'application/problem+json', 'content-length': Buffer.byteLength(problem) });
    res.end(problem);
    log(`RELAY seq=${iso()} ${req.method} ${path.split('?')[0]} 403 auth=${req.headers.authorization ? 'bearer' : 'none'} accesscode`);
    return;
  }
  if (req.method === 'POST' && path.split('?')[0] === '/api/v1/sessions') {
    let keep = 'unreadable';
    try {
      keep = String(JSON.parse(body.toString('utf8')).keepSignedIn === true);
    } catch {
      // not JSON: kept as unreadable
    }
    signins.push(keep);
    log(`RELAY-SIGNIN seq=${iso()} keep=${keep}`);
  }
  // P6-NATIVE-STEPS: a stored file read (API-175) with the size it asked for, so run.sh can tell that every photo tile asked for the small
  // copy and only the viewer for the whole file (UD-55, F-1235). The key is not logged.
  if (req.method === 'GET' && path.startsWith('/api/v1/files/')) log(`RELAY-FILE seq=${iso()} size=${new URL(path, 'http://x').searchParams.get('size') ?? 'full'}`);
  forwarded.push(path.split('?')[0]);
  if (forwarded.length > 5000) forwarded.shift();
  const rewrite = mode === 'nextday' || mode === 'dropjob' || mode === 'late' || mode === 'firstdone';
  const headers = { ...req.headers, host: up.host, ...(rewrite ? { 'accept-encoding': 'identity' } : {}), ...(body !== rawBody ? { 'content-length': String(body.length) } : {}) };
  if (mode === 'unauth') delete headers.authorization; // the server's own 401 answer (a signed-out session)
  const out = request({ hostname: up.hostname, port: up.port || (up.protocol === 'https:' ? 443 : 80), method: req.method, path, headers }, (r) => {
    if (rewrite) {
      // the day read, changed on its way back: another date, one job fewer, or a late text on the next job (the app's New day,
      // day-changed and late states)
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        let text = Buffer.concat(chunks).toString('utf8');
        try {
          const j = JSON.parse(text);
          const d = j.data ?? j;
          if (mode === 'firstdone') {
            // the day's route (API-163) with its first stop done and the next one Next: the Map frame's Done row (F-1075)
            const stops = d.stops ?? [];
            // whatever the stack's own state (another suite may have ended jobs before this one): the first stop done, the second Next, the rest Later
            if (stops.length > 1) {
              stops.forEach((x, i) => { x.state = i === 0 ? 'done' : i === 1 ? 'next' : 'later'; });
              d.next = stops[1].jobNumber;
            }
          } else if (mode === 'nextday') d.date = nextDay(d.date);
          else if (mode === 'late') {
            const next = (d.jobs ?? []).find((x) => x.status !== 'done' && x.status !== 'no_one_home');
            if (next) {
              // texted 5 minutes after the window opened: the new time 25 minutes past the time texted before (or planned)
              const was = next.textedArrival ?? next.plannedArrival ?? next.window.start;
              next.lateText = { sentAt: later(next.window.start, 5), eta: later(was, 25), wasEta: was };
            }
          } else if (Array.isArray(d.jobs)) d.jobs.pop();
          text = JSON.stringify(j);
        } catch {
          // not a day: forwarded as it came
        }
        const h = { ...r.headers, 'content-length': Buffer.byteLength(text) };
        delete h['content-encoding'];
        res.writeHead(r.statusCode ?? 502, h);
        res.end(text);
        log(`RELAY seq=${iso()} ${req.method} ${path.split('?')[0]} ${r.statusCode} auth=${req.headers.authorization ? 'bearer' : 'none'} ${mode}`);
      });
      return;
    }
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
    r.on('end', () => log(`RELAY seq=${iso()} ${req.method} ${path.split('?')[0]} ${r.statusCode} auth=${req.headers.authorization ? 'bearer' : 'none'}`));
  });
  out.on('error', (e) => {
    log(`RELAY seq=${iso()} ${req.method} ${path.split('?')[0]} upstream-error ${e.code ?? e.message}`);
    res.destroy();
  });
  out.end(body);
}

let listening = false;
const on = () =>
  new Promise((resolve) => {
    if (listening) return resolve();
    relay.listen(Number(relayPort), '127.0.0.1', () => {
      listening = true;
      log(`RELAY-SIGNAL seq=${iso()} on`);
      resolve();
    });
  });
const off = () =>
  new Promise((resolve) => {
    if (!listening) return resolve();
    relay.close(() => resolve());
    for (const s of sockets) s.destroy();
    listening = false;
    log(`RELAY-SIGNAL seq=${iso()} off`);
  });

const control = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/signal/on') await on();
  else if (u.pathname === '/signal/off') await off();
  else if (u.pathname === '/mark') log(`RELAY-MARK seq=${iso()} ${(u.searchParams.get('name') ?? '').replace(/[^A-Za-z0-9_-]/g, '')}`);
  else if (u.pathname === '/textsize') {
    // F-1627 (P8-A11Y-TOOLS): the simulator's text size, changed while the app is open (the largest-text walk); only the 2 sizes the walk uses.
    const to = u.searchParams.get('to') ?? '';
    if (!['large', 'accessibility-extra-extra-extra-large'].includes(to)) { res.writeHead(400).end('size'); return; }
    // F-1689: a simctl failure answers 500 and the relay stays up (an uncaught throw in this async handler ended the process).
    try {
      execFileSync('xcrun', ['simctl', 'ui', process.env.BW_SIM_UDID ?? '', 'content_size', to]);
    } catch (e) {
      log(`RELAY-TEXTSIZE seq=${iso()} failed ${String(e?.message ?? e).split('\n')[0]}`);
      res.writeHead(500).end('simctl');
      return;
    }
  } else if (u.pathname === '/delay') delayNext = Math.min(Number(u.searchParams.get('ms') ?? 0), 10_000);
  else if (u.pathname === '/office/note') {
    // API-140 as the dispatcher's web page sends it: the session cookie and the app's own origin (a write). The token is never logged.
    const payload = JSON.stringify({ jobNumber: Number(u.searchParams.get('job')), body: u.searchParams.get('text') ?? '' });
    const answer = await new Promise((resolve) => {
      const out = request({
        hostname: up.hostname, port: up.port, method: 'POST', path: '/api/v1/notes',
        headers: { host: up.host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), accept: 'application/json',
          cookie: `bw_session=${process.env.BW_OFFICE_TOKEN ?? ''}`, origin: process.env.BW_OFFICE_ORIGIN ?? '' },
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode ?? 502, body: Buffer.concat(chunks).toString('utf8') }));
      });
      out.on('error', (e) => resolve({ status: 502, body: JSON.stringify({ error: e.code ?? e.message }) }));
      out.end(payload);
    });
    log(`RELAY-OFFICE-NOTE seq=${iso()} job=${u.searchParams.get('job')} ${answer.status}`);
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    return void res.end(answer.body);
  }
  else if (u.pathname === '/probe/credentials') {
    // The sample sign-in the app's probe uses (run.sh passes it in this process's environment; it is never logged).
    const which = u.searchParams.get('who') ?? '';
    const who = { reviewer: 'REVIEWER', off: 'OFF' }[which] ?? 'PROBE';
    if (which === 'wrong') {
      // the right sign-in with a password that is not right (Wrong details)
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ login: process.env.BW_PROBE_LOGIN ?? '', password: 'x'.repeat(16) }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return void res.end(JSON.stringify({ login: process.env[`BW_${who}_LOGIN`] ?? '', password: process.env[`BW_${who}_PASSWORD`] ?? '', email: process.env[`BW_${who}_EMAIL`] ?? '' }));
  }
  else if (u.pathname === '/items/arrived') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return void res.end(`${itemArrivals}\n`);
  }
  else if (u.pathname === '/items/count') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return void res.end(`${itemSends}\n`);
  }
  else if (u.pathname === '/seen') {
    const prefix = u.searchParams.get('prefix') ?? '\u0000';
    res.writeHead(200, { 'content-type': 'text/plain' });
    return void res.end(`${forwarded.filter((x) => x.startsWith(prefix)).length}\n`);
  }
  else if (u.pathname === '/signins') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return void res.end(`${signins.join(',')}\n`);
  }
  else if (u.pathname === '/items/age') {
    // FR-TECH-7: the k oldest waiting items' entered real time moved back by h hours, in the app's own files (the app is closed).
    const hours = Math.min(Math.max(Number(u.searchParams.get('hours') ?? 0), 0), 240);
    const k = Math.max(Number(u.searchParams.get('n') ?? 1), 1);
    let aged = [];
    try {
      const data = execFileSync('xcrun', ['simctl', 'get_app_container', process.env.BW_SIM_UDID ?? '', process.env.BW_APP_BUNDLE ?? '', 'data'], { encoding: 'utf8' }).trim();
      const dir = join(data, 'Documents', 'bw-items');
      const items = readdirSync(dir).filter((f) => /^i-\d{12,}-.+-\d{6,}\.json$/.test(f)).sort().slice(0, k);
      for (const f of items) {
        const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        j.enteredRealMs -= hours * 3_600_000;
        writeFileSync(join(dir, `tmp-age-${f}`), JSON.stringify(j));
        renameSync(join(dir, `tmp-age-${f}`), join(dir, f)); // 1 rename: the file is whole whenever it is named (the store's own rule)
        aged.push(j.key);
      }
    } catch (e) {
      aged = [];
      log(`RELAY-AGE seq=${iso()} failed ${String(e?.message ?? e).split('\n')[0]}`);
    }
    log(`RELAY-AGE seq=${iso()} hours=${hours} keys=${aged.join(',')}`);
    res.writeHead(aged.length > 0 ? 200 : 500, { 'content-type': 'text/plain' });
    return void res.end(`${aged.join(',')}\n`);
  }
  else if (u.pathname === '/rule/clear') rules.clear();
  else if (u.pathname === '/rules/clear') rules.clear();
  else if (u.pathname === '/rule') {
    const path = u.searchParams.get('path') ?? '';
    const rule = { do: u.searchParams.get('do') ?? '', ms: Math.min(Number(u.searchParams.get('ms') ?? 0), 20_000), n: Math.max(Number(u.searchParams.get('n') ?? 1), 1) };
    if (!path || !['delay', 'drop', 'hold', 'unauth', 'nextday', 'dropjob', 'late', 'accesscode', 'firstdone', 'noparts'].includes(rule.do)) {
      res.writeHead(400);
      return void res.end();
    }
    rules.set(path, [...(rules.get(path) ?? []), rule]);
  }
  else if (u.pathname === '/api/v1/server-info') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return void res.end('{"error":"no such route"}');
  } else {
    res.writeHead(404);
    return void res.end();
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`${listening ? 'on' : 'off'}\n`);
});

await on();
control.listen(Number(controlPort), '127.0.0.1', () => log(`RELAY-START seq=${iso()} relay=${relayPort} control=${controlPort} upstream=${upstream} pid=${process.pid}`));
const stop = () => {
  log(`RELAY-STOP seq=${iso()}`);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
