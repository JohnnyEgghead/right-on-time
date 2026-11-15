// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S3 (G-S3-MAP-SAFARI): THROWAWAY capture of every request URL that iPhone Safari makes, over USB,
// for the "0 requests to any other host" clause. UNPROVEN on the owner's phone: it was written without
// the phone attached over USB (see the prep notes), so the first live run is also its test.
//
// Needs: the iPhone plugged in by USB and unlocked, Settings > Safari > Advanced > Web Inspector ON, the
// spike page open in Safari, and ios_webkit_debug_proxy running:   ios_webkit_debug_proxy -c null:9221,:9222-9322
//   node infra/spike/s3/ios-capture.mjs <out-dir> [proxy-port=9222]
// Writes <out-dir>/ios-requests.ndjson (1 line per request, UTC time and URL) and, on Ctrl-C or after 10
// minutes, <out-dir>/ios-summary.json (hosts and counts). Uses Node's built-in WebSocket; no packages.
import { appendFileSync, writeFileSync } from 'node:fs';

const out = process.argv[2];
const port = process.argv[3] || '9222';
if (!out) throw new Error('usage: ios-capture.mjs <out-dir> [proxy-port]');
const ndjson = `${out}/ios-requests.ndjson`;
writeFileSync(ndjson, '');

const pages = await (await fetch(`http://localhost:${port}/json`)).json();
const page = pages.find((p) => (p.url || '').startsWith('https://bw.j7l.io/spike/s3/')) || pages[0];
if (!page) throw new Error('no Safari page listed by the proxy (is Web Inspector on, and a page open?)');
console.log('capturing page:', page.url);

const seen = [];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
ws.onopen = () => {
  send('Network.enable');
  console.log('capture running; use the map now. Ctrl-C to stop.');
};
ws.onmessage = (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  const url = m.method === 'Network.requestWillBeSent' ? m.params?.request?.url
    : m.method === 'Network.webSocketCreated' ? m.params?.url
    : null;
  if (!url) return;
  const line = { t: new Date().toISOString(), method: m.method, url, range: m.params?.request?.headers?.Range || null };
  seen.push(line);
  appendFileSync(ndjson, JSON.stringify(line) + '\n');
};
ws.onerror = (e) => console.error('websocket error', e.message || e);

function finish() {
  const hosts = {};
  for (const s of seen) {
    let h;
    try { h = new URL(s.url).host || new URL(s.url).protocol; } catch { h = 'unparsed'; }
    hosts[h] = (hosts[h] || 0) + 1;
  }
  const other = Object.keys(hosts).filter((h) => h !== 'bw.j7l.io' && !/^(blob|data):$/.test(h));
  const summary = { page: page.url, requests: seen.length, hosts, otherHosts: other, pass: seen.length > 0 && other.length === 0 };
  writeFileSync(`${out}/ios-summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 1));
  process.exit(summary.pass ? 0 : 1);
}
process.on('SIGINT', finish);
setTimeout(finish, 10 * 60 * 1000);
