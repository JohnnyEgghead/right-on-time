// SPDX-License-Identifier: AGPL-3.0-or-later
// node:http adapter: an IncomingMessage to a Fetch-API Request, and a Response back onto the ServerResponse.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Router } from './kernel/mount.ts';

export function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else headers.set(k, v);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
  } as RequestInit);
}

export async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((v, k) => {
    if (k !== 'set-cookie') headers[k] = v;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  // A stream (API-09) is piped as it is written, with no length; the client going away cancels the source.
  if (response.body && (response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    res.writeHead(response.status, headers);
    const reader = response.body.getReader();
    const cancel = () => void reader.cancel().catch(() => undefined);
    res.on('close', cancel);
    // F-345: a client that left before the answer was ready (its 'close' already fired) cancels the source now.
    if (res.destroyed || res.closed || res.socket === null || res.socket.destroyed) cancel();
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      res.write(value);
    }
    res.end();
    return;
  }
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : undefined;
  if (body) headers['content-length'] = String(body.length);
  res.writeHead(response.status, headers);
  res.end(body);
}

/** Serve 1 node:http request through the kernel. `origin` only completes the URL; it is never trusted for checks. */
export async function serveNode(router: Router, req: IncomingMessage, res: ServerResponse, origin: string): Promise<void> {
  const response = await router.handle(toRequest(req, origin), { address: req.socket.remoteAddress ?? 'unknown' });
  await sendResponse(res, response);
}
