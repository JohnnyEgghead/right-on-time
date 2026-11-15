// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S2 (G-S2-TWA-OFFLINE): THROWAWAY. Nothing here ships; teardown removes it from the server.
// One process, Node built-ins only (no dependencies): serves the offline web shell under /spike/s2/
// and receives queued items. Each item is stored once by its Idempotency-Key: the first request
// claims the key with an exclusive create (flag "wx"), so retries and concurrent duplicates can
// never store twice. Every receive writes 1 JSON log line (stdout and DATA_DIR/receive.log).
//   PORT (default 8080), DATA_DIR (default ./data), PUBLIC_DIR (default ./public next to this file)
import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || join(HERE, 'data');
const PUBLIC_DIR = process.env.PUBLIC_DIR || join(HERE, 'public');
const ITEMS_DIR = join(DATA_DIR, 'items');
const LOG_FILE = join(DATA_DIR, 'receive.log');
const BASE = '/spike/s2/';
const MAX_BYTES = 30 * 1024 * 1024; // nginx client_max_body_size is 30m too
const KEY_RE = /^[A-Za-z0-9-]{8,80}$/;
const KINDS = new Set(['note', 'photo']);

// Static files: an explicit list, so no path from the request ever reaches the file system.
const STATIC = {
  '': ['index.html', 'text/html; charset=utf-8'],
  'index.html': ['index.html', 'text/html; charset=utf-8'],
  'app.js': ['app.js', 'text/javascript; charset=utf-8'],
  'sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  'manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  'icon-192.png': ['icon-192.png', 'image/png'],
  'icon-512.png': ['icon-512.png', 'image/png'],
};

async function log(entry) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry });
  process.stdout.write(line + '\n');
  await appendFile(LOG_FILE, line + '\n');
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Returns 'first-store' or 'duplicate'. The meta file is the claim: writeFile with flag "wx" fails
// with EEXIST when the key was stored before, atomically, even for 2 requests in the same instant.
export async function storeOnce(dir, key, kind, type, body) {
  const sha256 = createHash('sha256').update(body).digest('hex');
  const meta = { key, kind, type, bytes: body.length, sha256, storedAt: new Date().toISOString() };
  try {
    await writeFile(join(dir, `${key}.json`), JSON.stringify(meta), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // The first writer may still be writing its meta (concurrent duplicate): sameBody is then null.
    let sameBody = null;
    try {
      sameBody = JSON.parse(await readFile(join(dir, `${key}.json`), 'utf8')).sha256 === sha256;
    } catch {
      /* first write still in flight */
    }
    return { result: 'duplicate', sha256, sameBody };
  }
  await writeFile(join(dir, `${key}.bin`), body);
  return { result: 'first-store', sha256, sameBody: true };
}

async function listItems() {
  const names = (await readdir(ITEMS_DIR)).filter((n) => n.endsWith('.json'));
  const items = [];
  for (const n of names) items.push(JSON.parse(await readFile(join(ITEMS_DIR, n), 'utf8')));
  items.sort((a, b) => a.storedAt.localeCompare(b.storedAt));
  return items;
}

async function handleItem(req, res) {
  const key = String(req.headers['idempotency-key'] || '');
  const kind = String(req.headers['x-item-kind'] || '');
  const type = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100);
  if (!KEY_RE.test(key)) return send(res, 400, { error: 'bad Idempotency-Key' });
  if (!KINDS.has(kind)) return send(res, 400, { error: 'bad X-Item-Kind' });
  const body = await readBody(req);
  if (body.length === 0) return send(res, 400, { error: 'empty body' });
  const r = await storeOnce(ITEMS_DIR, key, kind, type, body);
  await log({
    event: 'receive', key, kind, bytes: body.length, result: r.result, sameBody: r.sameBody,
    sha256: r.sha256.slice(0, 16), ua: String(req.headers['user-agent'] || '').slice(0, 160),
  });
  return send(res, r.result === 'first-store' ? 201 : 200, { key, kind, bytes: body.length, result: r.result });
}

// The app's status beacon (OQ-18: what iOS does to home-screen storage). Logged, not stored.
async function handleStatus(req, res) {
  const body = await readBody(req);
  let status;
  try {
    status = JSON.parse(body.toString('utf8') || '{}');
  } catch {
    return send(res, 400, { error: 'bad json' });
  }
  await log({ event: 'status', ua: String(req.headers['user-agent'] || '').slice(0, 160), status });
  return send(res, 204, '');
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  if (!path.startsWith(BASE)) return send(res, 404, 'not found\n');
  const rest = path.slice(BASE.length);
  if (rest === 'api/health' && req.method === 'GET') return send(res, 200, { ok: true });
  if (rest === 'api/items' && req.method === 'GET') return send(res, 200, { items: await listItems() });
  if (rest === 'api/items' && req.method === 'POST') return handleItem(req, res);
  if (rest === 'api/status' && req.method === 'POST') return handleStatus(req, res);
  const file = Object.hasOwn(STATIC, rest) ? STATIC[rest] : null;
  if (file && (req.method === 'GET' || req.method === 'HEAD')) {
    const buf = await readFile(join(PUBLIC_DIR, file[0]));
    // no-cache: the service worker is the offline copy; the network copy is always revalidated.
    return send(res, 200, req.method === 'HEAD' ? '' : buf, { 'content-type': file[1], 'cache-control': 'no-cache' });
  }
  return send(res, 404, 'not found\n');
}

export async function start() {
  await mkdir(ITEMS_DIR, { recursive: true });
  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = e.status || 500;
      log({ event: 'error', status, message: String(e.message).slice(0, 200) }).catch(() => {});
      if (!res.headersSent) send(res, status, { error: status === 413 ? 'too large' : 'server error' });
      else res.destroy();
    });
  });
  await new Promise((r) => server.listen(PORT, r));
  await log({ event: 'start', port: PORT });
  return server;
}

// F-196: real paths on both sides (this spike ships alone, so it cannot import ci/is-main.ts).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  start();
}
