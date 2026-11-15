// SPDX-License-Identifier: AGPL-3.0-or-later
// The web technician app's own no-signal page (apps/web/src/tech/sw.js noSignalPage; F-1083, F-1100), as the service worker answers a
// /tech page it does not hold with no signal: sw.js runs as written in a Node vm with an empty Cache Storage and the network down, and
// its answer is served from a local HTTP server, so the look comparator can open it as the app page of DK-110's "Offline, screen not
// saved" tile (kit 0.9, F-1144). A browser would need the worker installed and the page unheld to show it; the bytes are the same.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import vm from 'node:vm';

const SW = path.resolve(import.meta.dirname, '../../apps/web/src/tech/sw.js');

/** The worker's answer, with no signal and nothing kept, to a navigation to `pathname` (a same-origin /tech page). */
export async function noSignalHtml(pathname: string, origin = 'https://bw.example'): Promise<{ status: number; html: string }> {
  const handlers = new Map<string, (e: unknown) => void>();
  const empty = { match: async () => undefined, put: async () => undefined, keys: async () => [], delete: async () => false };
  const ctx = vm.createContext({
    self: { location: new URL(`${origin}/tech/sw.js`), addEventListener: (t: string, h: (e: unknown) => void) => handlers.set(t, h), skipWaiting: () => undefined, clients: { claim: async () => undefined } },
    fetch: async () => { throw new TypeError('offline'); },
    URL, Response, Request, Promise, Array, Set, setTimeout: () => 0,
    caches: { open: async () => empty, keys: async () => [], delete: async () => false },
  });
  vm.runInContext(readFileSync(SW, 'utf8'), ctx);
  let answered: Promise<Response> | null = null;
  handlers.get('fetch')!({ request: { url: `${origin}${pathname}`, mode: 'navigate', method: 'GET' }, respondWith: (p: Promise<Response>) => { answered = p; }, waitUntil: () => undefined });
  if (!answered) throw new Error(`sw.js left ${pathname} to the browser: no no-signal page`);
  const res: Response = await answered;
  return { status: res.status, html: await res.text() };
}

/** Serve 1 page of HTML at every path; `origin` for the comparator, `stop` to close. */
export async function serveHtml(html: string): Promise<{ origin: string; stop: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, stop: () => new Promise((resolve) => server.close(() => resolve())) };
}
