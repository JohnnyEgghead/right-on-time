// SPDX-License-Identifier: AGPL-3.0-or-later
// The web process (SPECIFICATIONS SD-3): 1 node:http server in front of the handler kernel and the Next.js pages (SD-2).
// Every request, in order:
//   1. the API base and the root routes of the policy table (the health check, API-171) -> the kernel
//      (createWebKernel().router: the policy table, sessions, the access-code gate, the database)
//   2. Next's own assets (/_next/...) -> Next
//   3. any other path is a page: a write is refused (405); the page gate (pages.verdict, UI-SPECIFICATION 2.4 and 4.2)
//      decides before Next renders anything: render -> Next; redirect -> 303 to the sign-in page; forbidden, not_found
//      and gate -> Next renders the shared page in place of the route (src/shell/page-verdict.ts, the root layout) with
//      the verdict's status. A client-side navigation request (RSC) that the gate refuses gets a plain answer with the
//      status, which makes the browser load the page as a document, so the gate answers it in full.
// Every answer carries the 11.5 headers. A page answer's CSP is the 11.5 policy with a per-request nonce in default-src,
// which Next puts on its own inline scripts (its streamed page data); the API answers carry the 11.5 policy unchanged
// (the kernel's). Settings are validated once at start (@bw/config): an invalid one stops the process with exit 78 and a
// ConfigError naming the setting, never its value, before Next loads or the port opens.
//
// Runs with Node's type stripping: node apps/web/src/server.ts. PORT (default 3000); BW_WEB_LISTEN_HOST (default all
// interfaces; the browser gates bind loopback); BW_WEB_PREVIEW=1 serves the harness build (.next-preview), whose shell
// preview routes (/shell-preview/...) are the only paths that skip the page gate, and only in that build.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { CONTENT_SECURITY_POLICY, createWebKernel, SECURITY_HEADERS, serveNode, type PageVerdict, type Router, type WebKernel } from '@bw/api-server';
import { ConfigError, configOrExit, databasePassword, exitWithMessage } from '@bw/config';
import { createLogger, type Logger } from '@bw/log';
import { configureRouting, ROUTING_SERVICE_URL } from '../../../packages/maps/src/route-source.ts';
import { MAP_ASSET_PREFIX, mapAsset, readMapAsset } from './map/map-assets.ts';
import { PAGE_VERDICT_HEADER } from './shell/page-verdict.ts';
import { embedsServerState, SERVER_STATE_HEADER } from './tech/server-state.ts';
import { techShellAsset } from './tech/shell-assets.ts';

export const WEB_DIR = path.resolve(import.meta.dirname, '..');
export const PREVIEW_PREFIX = '/shell-preview/';
const NEXT_STATIC = '/_next/static/';

/** The 11.5 policy with this answer's nonce added to default-src (Next reads it there for its inline scripts). */
export function pageCsp(nonce: string): string {
  return CONTENT_SECURITY_POLICY.replace("default-src 'self'", `default-src 'self' 'nonce-${nonce}'`);
}

export type NextHandler = (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;

export interface WebParts {
  router: Router;
  pageVerdict: WebKernel['pageVerdict'];
  next: NextHandler;
  log: Logger;
  /** Serving the harness build: its preview routes skip the page gate. Never true for the release build. */
  harness: boolean;
}

const OWN = { 'x-robots-tag': 'noindex, nofollow' };

/** Token pages whose answer the phone must never keep or replay (FR-TEXT-4: the live map link page, 200 or 410; its data is no-store from the kernel). */
const NO_STORE_SCREENS: ReadonlySet<string> = new Set(['SCR-CUS-04']);

/** Put the 11.5 headers on every answer this response writes, whoever writes it (Next, the kernel, this file). */
function guard(res: ServerResponse, csp: string, forceStatus?: number, noStore = false, serverState = false): void {
  const write = res.writeHead.bind(res) as (status: number, ...rest: unknown[]) => ServerResponse;
  // F-980: a /tech page whose HTML embeds an API read says so, and the service worker never keeps it (SD-47; src/tech/sw.js).
  const ours: Record<string, string> = { ...SECURITY_HEADERS, 'content-security-policy': csp, ...OWN, ...(noStore ? { 'cache-control': 'no-store' } : {}), ...(serverState ? { [SERVER_STATE_HEADER]: '1' } : {}) };
  res.writeHead = ((status: number, ...rest: unknown[]) => {
    const headers = rest.find((r) => typeof r === 'object' && r !== null) as OutgoingHttpHeaders | string[] | undefined;
    const reason = rest.find((r) => typeof r === 'string');
    for (const [k, v] of Object.entries(ours)) res.setHeader(k, v);
    let merged: OutgoingHttpHeaders | string[] | undefined;
    if (Array.isArray(headers)) {
      // The flat [name, value, ...] form: drop our names, keep the rest.
      merged = headers.flatMap((h, i) => (i % 2 === 0 && !(String(h).toLowerCase() in ours) ? [h, String(headers[i + 1])] : []));
    } else if (headers) {
      merged = { ...headers };
      for (const k of Object.keys(merged)) if (k.toLowerCase() in ours) delete merged[k];
    }
    const code = forceStatus ?? status;
    return reason !== undefined ? write(code, reason, merged) : write(code, merged);
  }) as ServerResponse['writeHead'];
}

function plain(req: IncomingMessage, res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(body)), ...extra });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function requestHeaders(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) h.append(k, x);
    else if (v !== undefined) h.set(k, v);
  }
  return h;
}

/**
 * The path Next will route, decided once for every branch below (F-227): decoded until nothing more decodes (so a
 * double-encoded dot segment cannot hide), a backslash read as a slash, empty and dot segments resolved the way a URL
 * parser does, then written back with each segment encoded once (a trailing slash is dropped). The page gate and Next both get this path, so what the
 * gate judges is what Next renders. Null when the path cannot be read at all (bad percent-encoding, a control character).
 */
export function canonicalPath(raw: string): string | null {
  let text = raw;
  for (let i = 0; i < 8; i++) {
    let next: string;
    try {
      next = decodeURIComponent(text);
    } catch {
      if (i === 0) return null;
      break;
    }
    if (next === text) break;
    text = next;
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  const out: string[] = [];
  for (const seg of text.replaceAll('\\', '/').split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '' && seg !== '.') out.push(seg);
  }
  return '/' + out.map(encodeURIComponent).join('/');
}

const isRsc = (req: IncomingMessage) => req.headers.rsc === '1' || req.headers['next-router-prefetch'] !== undefined;

export function createHandler(p: WebParts): (req: IncomingMessage, res: ServerResponse) => void {
  const fail = (req: IncomingMessage, res: ServerResponse) => {
    p.log.error({ status: 'unhandled error', errorCode: 'server_error' });
    if (!res.headersSent) plain(req, res, 500, 'server error\n');
    else res.destroy();
  };
  return (req, res) => {
    const url = req.url ?? '/';
    const rawPath = url.split('?', 1)[0] ?? '/';
    // Only this process sets the verdict header; one a client sends is dropped.
    delete req.headers[PAGE_VERDICT_HEADER];
    if (p.router.owns(rawPath, req.method)) {
      guard(res, CONTENT_SECURITY_POLICY);
      serveNode(p.router, req, res, 'http://web').catch(() => fail(req, res));
      return;
    }
    const nonce = randomBytes(16).toString('base64');
    const csp = pageCsp(nonce);
    const pathname = canonicalPath(rawPath);
    if (pathname === null || p.router.owns(pathname, req.method)) {
      guard(res, csp);
      plain(req, res, 400, 'bad request\n');
      return;
    }
    // From here on, Next routes the path the checks below judge.
    if (pathname !== rawPath) req.url = pathname + url.slice(rawPath.length);
    // Only real static assets skip the page gate; every other path under /_next/ is judged like any page.
    // A static asset is no page: it carries the 11.5 policy unchanged, with no nonce (F-774).
    if (pathname.startsWith(NEXT_STATIC)) {
      guard(res, CONTENT_SECURITY_POLICY);
      p.next(req, res).catch(() => fail(req, res));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      guard(res, csp);
      plain(req, res, 405, 'method not allowed\n', { allow: 'GET, HEAD' });
      return;
    }
    // The web technician app's manifest and service worker (SD-47; src/tech/shell-assets.ts): no data, answered before the page gate.
    const shellAsset = (() => {
      try {
        return techShellAsset(pathname);
      } catch {
        return undefined;
      }
    })();
    if (shellAsset === undefined) {
      guard(res, CONTENT_SECURITY_POLICY);
      return fail(req, res);
    }
    if (shellAsset) {
      guard(res, CONTENT_SECURITY_POLICY);
      res.writeHead(200, { ...shellAsset.headers, 'content-length': String(shellAsset.body.length) });
      res.end(req.method === 'HEAD' ? undefined : shellAsset.body);
      return;
    }
    // The map's bundled glyph and sprite files (F-452): public files of the app, answered before the page gate.
    if (pathname.startsWith(MAP_ASSET_PREFIX)) {
      guard(res, CONTENT_SECURITY_POLICY);
      const asset = mapAsset(pathname);
      if (!asset) return plain(req, res, 404, 'not found\n');
      let body: Buffer;
      try {
        body = readMapAsset(asset.file);
      } catch {
        // F-529: a read error (a permission, a file that vanished after the stat) is this request's 500, not the process's end.
        return fail(req, res);
      }
      res.writeHead(200, { 'content-type': asset.type, 'content-length': String(body.length), 'cache-control': 'public, max-age=86400' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    const render = (verdict?: PageVerdict) => {
      guard(res, csp, verdict?.status === 200 ? undefined : verdict?.status, verdict?.kind === 'render' && NO_STORE_SCREENS.has(verdict.screen),
        verdict?.kind === 'render' && embedsServerState(verdict.screen, req.url ?? '/'));
      // Next takes the nonce from the request's policy and puts it on its inline scripts.
      req.headers['content-security-policy'] = csp;
      if (verdict && verdict.kind !== 'render') req.headers[PAGE_VERDICT_HEADER] = verdict.kind;
      return p.next(req, res);
    };
    if (p.harness && pathname.startsWith(PREVIEW_PREFIX)) {
      render().catch(() => fail(req, res));
      return;
    }
    void (async () => {
      const verdict = await p.pageVerdict(pathname, requestHeaders(req));
      if (verdict.kind === 'render') return render(verdict);
      if (verdict.kind === 'redirect') {
        guard(res, csp);
        return plain(req, res, 303, 'see other\n', { location: verdict.to });
      }
      if (isRsc(req)) {
        guard(res, csp);
        return plain(req, res, verdict.status, `${verdict.kind}\n`);
      }
      return render(verdict);
    })().catch(() => fail(req, res));
  };
}

/**
 * How long the web process keeps an idle connection open (F-884). nginx keeps its upstream connections to this process open and reuses them;
 * Node's default is 5 s, so nginx could send a request on a connection Node had just closed and answer 502 (upstream prematurely closed
 * connection). This is longer than nginx's own upstream keepalive_timeout (infra/nginx/http.conf, 55 s), so nginx always closes first.
 */
export const KEEP_ALIVE_MS = 65_000;

export function start(port: number, parts: WebParts, host?: string): Server {
  const server = createServer(createHandler(parts));
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = KEEP_ALIVE_MS + 5_000; // Node needs headersTimeout above keepAliveTimeout
  if (host) server.listen(port, host);
  else server.listen(port);
  return server;
}

/** The built pages of apps/web, served through Next's request handler (the build's own config: no next.config load). */
export async function loadNext(preview: boolean, dir = WEB_DIR): Promise<{ handler: NextHandler; close(): Promise<void> }> {
  const distDir = preview ? '.next-preview' : '.next';
  const manifest = path.join(dir, distDir, 'required-server-files.json');
  if (!existsSync(manifest)) throw new Error(`web: no Next.js build at ${path.join(dir, distDir)} (run next build${preview ? ' with BW_WEB_PREVIEW=1' : ''})`);
  const conf = (JSON.parse(readFileSync(manifest, 'utf8')) as { config: Record<string, unknown> }).config;
  // As Next's own standalone server does: the build's resolved config, so the server never compiles next.config.ts.
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(conf);
  const { default: next } = await import('next');
  const app = next({ dev: false, dir, conf, customServer: true, quiet: true });
  await app.prepare();
  return { handler: app.getRequestHandler() as NextHandler, close: () => app.close() };
}

if (import.meta.main) {
  const settings = configOrExit();
  let password: string | undefined;
  try {
    password = databasePassword(settings);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    exitWithMessage(`${e.name}: ${e.message}`, 78);
  }
  const log = createLogger({ process: 'web', level: settings.LOG_LEVEL });
  // SD-49: a leg no stored track covers is asked of the routing service on the Compose network (P6-LIVE-ROUTING).
  configureRouting({ url: ROUTING_SERVICE_URL, log });
  let kernel: WebKernel;
  try {
    kernel = createWebKernel({ settings, databasePassword: password, log });
  } catch (e) {
    exitWithMessage((e as Error).message, 78);
  }
  const harness = process.env.BW_WEB_PREVIEW === '1';
  const pages = await loadNext(harness).catch((e: unknown) => {
    return exitWithMessage((e as Error).message, 1);
  });
  const server = start(Number(process.env.PORT ?? 3000), { router: kernel.router, pageVerdict: kernel.pageVerdict, next: pages.handler, log, harness }, process.env.BW_WEB_LISTEN_HOST || undefined);
  server.once('listening', () => log.info({ status: 'listening' }));
  const stop = () => {
    log.info({ status: 'stopping' });
    server.close(() => void Promise.allSettled([pages.close(), kernel.close()]).finally(() => process.exit(0)));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
