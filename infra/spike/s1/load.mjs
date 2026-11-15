// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S1 (G-S1-SSE) load script: plain Node, built-ins only, run from the owner's Mac.
//
//   node infra/spike/s1/load.mjs --host <ip> --ca <spike.crt> --out <dir> [--control]
//
// Main session: opens 99 SSE streams through nginx (14 dispatcher plus 85 technician
// sessions, the NFR-01 load day), waits --warmup ms so every stream outlives nginx's 60 s
// default read timeout, then makes --runs writes, 1 every --interval ms. Each write is a POST
// whose transaction inserts a row and calls pg_notify (ids only). Write-to-client delay is
// measured on 1 monotonic clock (this process): from just before the POST is sent to the
// moment the event's bytes arrive on each stream. It therefore includes the Mac-to-server
// network path twice (POST up, event down), an upper bound on the server-side delay.
//
// A stream counts as dropped if it never opens, ends or errors before the session closes,
// misses any run's event within --timeout ms, or misses heartbeats.
//
// --control: 1 stream on the nginx location with buffering forced on, plus 1 normal stream,
// and 3 writes. The buffered stream is expected to stall, which shows the instrument detects
// nginx buffering.
import https from 'node:https';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);
const host = args.host;
const ca = readFileSync(args.ca);
const outDir = args.out;
const control = args.control === 'true';
const DISPATCHERS = Number(args.dispatchers ?? 14);
const TECHNICIANS = Number(args.technicians ?? 85);
const RUNS = Number(args.runs ?? (control ? 3 : 20));
const INTERVAL = Number(args.interval ?? 5000);
const WARMUP = Number(args.warmup ?? (control ? 2000 : 70_000));
const TIMEOUT = Number(args.timeout ?? 10_000);
const PORT = Number(args.port ?? 443);
const HEARTBEAT_MS = 15_000;
if (!host || !outDir) {
  console.error('usage: node load.mjs --host <ip> --ca <crt> --out <dir> [--control]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// The certificate is pinned by --ca; the instance has no domain, so the name check is skipped.
const tls = { ca, checkServerIdentity: () => undefined };
const streamAgent = new https.Agent({ ...tls, keepAlive: true, maxSockets: Infinity });
const writeAgent = new https.Agent({ ...tls, keepAlive: true, maxSockets: 4 });
const t = () => performance.now();
const wall = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openStream(id, role, route) {
  const s = { id, role, route, status: null, openAt: null, heartbeats: 0, lastByteAt: null, events: new Map(), endedAt: null, error: null };
  const req = https.get(
    { host, port: PORT, path: `${route}?branch=1&role=${role}&n=${id}`, agent: streamAgent, headers: { accept: 'text/event-stream' } },
    (res) => {
      s.status = res.statusCode;
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        const at = t();
        s.lastByteAt = at;
        buf += chunk;
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of block.split('\n')) {
            if (line === ': open') s.openAt ??= at;
            else if (line === ': hb') s.heartbeats += 1;
            else if (line.startsWith('data: ')) {
              const ev = JSON.parse(line.slice(6));
              if (!s.events.has(ev.ids.run)) s.events.set(ev.ids.run, at);
            }
          }
        }
      });
      res.on('end', () => (s.endedAt ??= t()));
      res.on('error', (e) => (s.error ??= e.message));
    },
  );
  req.on('error', (e) => {
    s.error ??= e.message;
    s.endedAt ??= t();
  });
  s.req = req;
  return s;
}

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = https.request(
      { host, port: PORT, path: route, method, agent: writeAgent, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`${method} ${route}: ${res.statusCode} ${text}`))));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

const rank = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
const ms = (x) => (x == null ? null : Math.round(x * 10) / 10);

async function main() {
  const startedAt = wall();
  const streams = [];
  if (control) {
    streams.push(openStream(1, 'control-buffered', '/control/buffered-events'));
    streams.push(openStream(2, 'control-normal', '/api/v1/events'));
  } else {
    for (let i = 0; i < DISPATCHERS; i += 1) streams.push(openStream(i + 1, 'dispatcher', '/api/v1/events'));
    for (let i = 0; i < TECHNICIANS; i += 1) streams.push(openStream(DISPATCHERS + i + 1, 'technician', '/api/v1/events'));
  }
  const openedBy = t() + 15_000;
  while (t() < openedBy && streams.some((s) => s.openAt == null && s.role !== 'control-buffered')) await sleep(50);
  const openCount = streams.filter((s) => s.openAt != null).length;
  console.log(`${wall()} streams opened: ${openCount} of ${streams.length}`);
  await sleep(WARMUP);
  const serverBefore = await request('GET', '/api/v1/spike/write');
  console.log(`${wall()} server-side stream count after warmup: ${serverBefore.streams}`);

  const runs = [];
  const deliveries = [];
  for (let run = 1; run <= RUNS; run += 1) {
    const live = streams.filter((s) => s.endedAt == null && !s.error);
    const t0 = t();
    const res = await request('POST', '/api/v1/spike/write', { run, branchId: 1 });
    const postRtt = t() - t0;
    const deadline = t0 + TIMEOUT;
    while (t() < deadline && live.some((s) => !s.events.has(run))) await sleep(5);
    const delays = [];
    for (const s of streams) {
      const at = s.events.get(run);
      const delay = at == null ? null : at - t0;
      deliveries.push({ run, stream: s.id, role: s.role, delayMs: ms(delay) });
      if (delay != null) delays.push(delay);
    }
    delays.sort((a, b) => a - b);
    const r = { run, writeId: res.writeId, postRttMs: ms(postRtt), delivered: delays.length, missing: streams.length - delays.length, p50Ms: ms(rank(delays, 50)), p95Ms: ms(rank(delays, 95)), maxMs: ms(delays.at(-1)) };
    runs.push(r);
    console.log(`${wall()} run ${run}: delivered ${r.delivered}/${streams.length} p95 ${r.p95Ms} ms max ${r.maxMs} ms post ${r.postRttMs} ms`);
    const next = t0 + INTERVAL;
    if (run < RUNS) await sleep(Math.max(0, next - t()));
  }
  // Hold past 1 more heartbeat so a stream cut late is still caught.
  await sleep(HEARTBEAT_MS + 1000);
  const serverAfter = await request('GET', '/api/v1/spike/write');
  const sessionEnd = t();

  const perStream = streams.map((s) => {
    const openFor = s.openAt == null ? 0 : (s.endedAt ?? sessionEnd) - s.openAt;
    const expectedHb = Math.floor(openFor / HEARTBEAT_MS) - 1;
    const missed = RUNS - [...s.events.keys()].filter((k) => k >= 1 && k <= RUNS).length;
    const dropped = s.openAt == null || s.endedAt != null || Boolean(s.error) || missed > 0 || s.heartbeats < expectedHb;
    return { id: s.id, role: s.role, route: s.route, status: s.status, openForS: Math.round(openFor / 100) / 10, heartbeats: s.heartbeats, expectedHeartbeatsAtLeast: expectedHb, eventsMissed: missed, ended: s.endedAt != null, error: s.error, dropped };
  });
  for (const s of streams) s.req.destroy();

  const all = deliveries.filter((d) => d.delayMs != null).map((d) => d.delayMs).sort((a, b) => a - b);
  const posts = runs.map((r) => r.postRttMs).sort((a, b) => a - b);
  const summary = {
    mode: control ? 'control' : 'main',
    startedAt,
    finishedAt: wall(),
    host,
    streams: streams.length,
    dispatchers: control ? 0 : DISPATCHERS,
    technicians: control ? 0 : TECHNICIANS,
    runs: RUNS,
    intervalMs: INTERVAL,
    warmupMs: WARMUP,
    timeoutMs: TIMEOUT,
    serverStreamsAfterWarmup: serverBefore.streams,
    serverStreamsAtEnd: serverAfter.streams,
    deliveriesExpected: streams.length * RUNS,
    deliveriesReceived: all.length,
    delayMs: { p50: rank(all, 50), p95: rank(all, 95), p99: rank(all, 99), max: all.at(-1) ?? null, min: all[0] ?? null },
    postRttMs: { p50: rank(posts, 50), p95: rank(posts, 95), max: posts.at(-1) ?? null },
    droppedStreams: perStream.filter((s) => s.dropped).map((s) => s.id),
    runsDetail: runs,
    perStream,
  };
  const tag = control ? 'control' : 'main';
  writeFileSync(path.join(outDir, `${tag}-deliveries.jsonl`), deliveries.map((d) => JSON.stringify(d)).join('\n') + '\n');
  writeFileSync(path.join(outDir, `${tag}-summary.json`), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ mode: summary.mode, streams: summary.streams, runs: RUNS, received: summary.deliveriesReceived, expected: summary.deliveriesExpected, delayMs: summary.delayMs, postRttMs: summary.postRttMs, dropped: summary.droppedStreams }));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
