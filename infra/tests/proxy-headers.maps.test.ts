// SPDX-License-Identifier: AGPL-3.0-or-later
// F-214: the SPECIFICATIONS 11.5 headers on the answers nginx makes itself in the open routes (a 502 or 504 when the web
// container is down, a 413 for a body over the limit, a 405 for a write to a map file), and a web answer passed through
// with its own headers, each sent once. The real nginx image of infra/compose.yaml and the real infra/nginx files
// (local.conf and the open routes, as an own copy and the hosted server after P8-UNLOCK serve them), on a docker network
// of its own. First no web container is on it (every proxied request is an upstream error); then a stand-in web joins
// under the name "web" (a 2nd container of the same nginx image) that answers with a page CSP holding a nonce, as the
// page guard does (apps/web/src/server.ts). Like proxy-error-log.maps.test.ts, the .maps. suffix puts it in the
// map-manifest wave gate, the gate that runs the real nginx image; it needs docker, not the map files.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from '../../packages/api-server/src/kernel/headers.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const compose = readFileSync(path.join(root, 'infra/compose.yaml'), 'utf8');
const image = /image: (nginx:[^\s]+@sha256:[0-9a-f]{64})/.exec(compose)?.[1] as string;
// Lane-unique names, so stacks of other lanes and runs never collide.
const tag = `bw-lane-hosting-headers-${process.pid}`;
const net = tag;
const proxy = `${tag}-proxy`;
const web = `${tag}-web`;
const PAGE_CSP = "default-src 'self' 'nonce-c3RhbmQtaW4'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'";
let base = '';

const docker = (...a: string[]): { status: number; out: string } => {
  const r = spawnSync('docker', a, { encoding: 'utf8', timeout: 120_000 });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const must = (...a: string[]): string => {
  const r = docker(...a);
  if (r.status !== 0) throw new Error(`docker ${a.slice(0, 2).join(' ')} failed: ${r.out.trim()}`);
  return r.out.trim();
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The 11.5 headers nginx itself sends (HSTS is the hosted 443 server's, never on this plain-HTTP own-copy site). */
function expectOwnHeaders(r: Response, where: string): void {
  expect(r.headers.get('content-security-policy'), where).toBe(CONTENT_SECURITY_POLICY);
  expect(r.headers.get('x-content-type-options'), where).toBe('nosniff');
  expect(r.headers.get('referrer-policy'), where).toBe('no-referrer');
  expect(r.headers.get('strict-transport-security'), where).toBeNull();
}

beforeAll(async () => {
  must('network', 'create', net);
  must('create', '--name', proxy, '--network', net, '-p', '127.0.0.1::80', image, '/bin/sh', '-c',
    'ln -sf /etc/nginx/bw/local.conf /etc/nginx/conf.d/default.conf && ln -sf /etc/nginx/bw/routes-open.conf /etc/nginx/bw-routes.conf && exec nginx -g "daemon off;"');
  must('cp', path.join(root, 'infra/nginx/.'), `${proxy}:/etc/nginx/bw`);
  // A map file for the static location (its 405 needs a file to refuse the write to).
  const dir = mkdtempSync(path.join(tmpdir(), 'bw-hosting-headers-'));
  mkdirSync(path.join(dir, 'data', 'maps'), { recursive: true });
  writeFileSync(path.join(dir, 'data', 'maps', 'columbus.pmtiles'), 'not a real map\n');
  must('cp', path.join(dir, 'data'), `${proxy}:/`);
  // The stand-in web: its own headers on every answer, a page CSP with a nonce, and a 405 of its own.
  const own = `add_header Content-Security-Policy "${PAGE_CSP}" always; add_header X-Content-Type-Options nosniff always; add_header Referrer-Policy no-referrer always;`;
  writeFileSync(path.join(dir, 'web.conf'), `server { listen 3000; location = /refused { ${own} return 405; } location / { ${own} return 200 "page\\n"; } }\n`);
  must('create', '--name', web, '--network', net, '--network-alias', 'web', image);
  must('cp', path.join(dir, 'web.conf'), `${web}:/etc/nginx/conf.d/default.conf`);
  must('start', proxy);
  const port = /:(\d+)$/m.exec(must('port', proxy, '80/tcp'))?.[1];
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/healthz`);
      return;
    } catch {
      await wait(200);
    }
  }
  throw new Error(`nginx did not answer: ${docker('logs', proxy).out}`);
}, 120_000);

afterAll(() => {
  spawnSync('docker', ['rm', '-fv', proxy, web], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', net], { stdio: 'ignore' });
});

describe("the 11.5 headers on nginx's own answers in the open routes (F-214)", () => {
  // why: F-214 (nginx's 502 answers carried HSTS only: no CSP, nosniff or referrer policy while the web container is down)
  it('sends them on the 502 or 504 of every proxied location while no web container answers', async () => {
    for (const p of ['/office/board', '/healthz', '/api/v1/events', '/api/v1/session']) {
      const r = await fetch(`${base}${p}`);
      await r.arrayBuffer();
      expect([502, 504], p).toContain(r.status);
      expectOwnHeaders(r, `${p} ${r.status}`);
    }
  });

  // why: F-214 (the 11.5 header tests covered only 200 answers: an nginx 405 and 413 are its own answers too)
  it("sends them on nginx's own 405 (a write to a map file) and 413 (a body over the limit)", async () => {
    const refused = await fetch(`${base}/maps/columbus.pmtiles`, { method: 'POST', body: 'x' });
    await refused.arrayBuffer();
    expect(refused.status).toBe(405);
    expectOwnHeaders(refused, 'POST /maps/columbus.pmtiles 405');
    const big = await fetch(`${base}/api/v1/jobs`, { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024) });
    await big.arrayBuffer();
    expect(big.status).toBe(413);
    expectOwnHeaders(big, 'POST /api/v1/jobs 413');
  });

  // why: F-214 (the fix adds headers in the proxied locations; a page's nonce CSP must reach the browser alone, never beside a 2nd policy)
  it("passes a web answer's own headers through once, unchanged, on its 200 and its 405", async () => {
    must('start', web);
    let page: Response | undefined;
    for (let i = 0; i < 60; i++) {
      page = await fetch(`${base}/office/board`);
      await page.arrayBuffer();
      if (page.status === 200) break;
      await wait(250);
    }
    expect(page?.status).toBe(200);
    const refused = await fetch(`${base}/refused`, { method: 'POST', body: 'x' });
    await refused.arrayBuffer();
    expect(refused.status).toBe(405);
    for (const [r, where] of [[page!, 'GET /office/board 200'], [refused, 'POST /refused 405']] as const) {
      // fetch joins a repeated header with ", ", so equality also says each header came once.
      expect(r.headers.get('content-security-policy'), where).toBe(PAGE_CSP);
      expect(r.headers.get('x-content-type-options'), where).toBe('nosniff');
      expect(r.headers.get('referrer-policy'), where).toBe('no-referrer');
    }
  }, 60_000);
});
