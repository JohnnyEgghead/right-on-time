// SPDX-License-Identifier: AGPL-3.0-or-later
// The auth stack suites' https front (F-290). bw_access is Secure over https only, as the product sets it (SPECIFICATIONS 6.8 FR-AUTH-6, SD-8), and
// WebKit neither stores a Secure cookie a plain-http answer sets nor sends one over plain http, at 127.0.0.1 or at
// localhost (measured on the wave run's WebKit, .build/evidence/F-290/rig-probe-secure-cookie.log); Chromium does both.
// So each suite reaches the stack's proxy through this TLS front: https://127.0.0.1:<free port> in this process,
// forwarding every request to the proxy's plain-http port with X-Forwarded-Proto: https (F-304: how the stack learns the
// request was https; nginx keeps that claim from a private peer, infra/nginx/http.conf). The stack itself stays at its default settings
// (no TLS site file, no setting changed); the front is the rig's, like the browser. Its key and self-signed certificate
// are made fresh for each run by ci/auth-stack.sh (BW_AUTH_STACK_TLS names the directory); the browsers take the
// certificate by ignoreHTTPSErrors, which only these suites set.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export interface TlsFront {
  /** The origin the browsers use: https://127.0.0.1:<port>. */
  origin: string;
  close: () => Promise<void>;
}

export async function tlsFront(upstream: string, dir: string): Promise<TlsFront> {
  const up = new URL(upstream);
  if (up.protocol !== 'http:') throw new Error(`tls-front: the upstream must be the proxy's plain-http URL, not ${upstream}`);
  const agent = new http.Agent({ keepAlive: true });
  const server = https.createServer(
    { key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')) },
    (req, res) => {
      const fwd = http.request(
        { host: up.hostname, port: up.port, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-proto': 'https' }, agent },
        (r) => {
          // rawHeaders keeps every Set-Cookie line and its exact attributes.
          res.writeHead(r.statusCode ?? 502, r.statusMessage, r.rawHeaders);
          r.pipe(res);
        },
      );
      fwd.on('error', (e) => res.destroy(e));
      req.pipe(fwd);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `https://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        agent.destroy();
        server.close(() => resolve());
      }),
  };
}
