// SPDX-License-Identifier: AGPL-3.0-or-later
// F-97: an upstream error on a token route leaves neither the token nor the query string in the proxy's log (SPECIFICATIONS 11.4).
// The real nginx image of infra/compose.yaml and the real infra/nginx files (local.conf and the open routes, as an own copy and the
// hosted server after P8-UNLOCK serve them), in 1 container named bw-p8-proxy-log-<pid> with no web container: every proxied request
// is an upstream error ("no live upstreams" or a failed lookup), which nginx writes at [error] with the raw request line. The test
// reads the container's whole log (stdout and stderr: the access log and the error log both go there).
// The .maps. suffix puts it in the map-manifest wave gate (packages/maps/vitest.maps.config.ts), the gate that runs the real nginx
// image (maps-nginx.maps.test.ts); it needs docker, not the map files. Files are copied in with docker cp, so any docker context works.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..');
const compose = readFileSync(path.join(root, 'infra/compose.yaml'), 'utf8');
const image = /image: (nginx:[^\s]+@sha256:[0-9a-f]{64})/.exec(compose)?.[1] as string;
const name = `bw-p8-proxy-log-${process.pid}`;
// A token and a query value no config file holds, so a match in the log can only come from the request.
const TOKEN = 'T'.repeat(43);
const QUERY = 'qF97planted';
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

beforeAll(async () => {
  must('create', '--name', name, '-p', '127.0.0.1::80', image, '/bin/sh', '-c',
    'ln -sf /etc/nginx/bw/local.conf /etc/nginx/conf.d/default.conf && ln -sf /etc/nginx/bw/routes-open.conf /etc/nginx/bw-routes.conf && exec nginx -g "daemon off;"');
  must('cp', path.join(root, 'infra/nginx/.'), `${name}:/etc/nginx/bw`);
  must('start', name);
  const port = /:(\d+)$/m.exec(must('port', name, '80/tcp'))?.[1];
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/healthz`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`nginx did not answer: ${docker('logs', name).out}`);
}, 120_000);

afterAll(() => {
  spawnSync('docker', ['rm', '-fv', name], { stdio: 'ignore' });
});

describe('the proxy log after an upstream error on a token route (F-97, 11.4)', () => {
  // why: F-97 (SPECIFICATIONS 11.4: nginx never logs a token or a query string; the error log wrote both on every upstream error)
  it('holds neither the token nor the query of a /m/<token>?<query> request that failed upstream', async () => {
    const res = await fetch(`${base}/m/${TOKEN}?q=${QUERY}`);
    await res.arrayBuffer();
    // The planted upstream error: no web container, so the proxy answers 502 (or 504 when the lookup itself times out).
    expect([502, 504]).toContain(res.status);
    // nginx writes the access line when the request ends; give the log a moment to reach docker.
    let log = '';
    for (let i = 0; i < 20 && !log.includes('"uri":"/m/:token"'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      log = docker('logs', name).out;
    }
    // The access line is there (so the log was read), with the mapped URI and the upstream status.
    expect(log).toMatch(new RegExp(`"uri":"/m/:token","status":${res.status}`));
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(QUERY);
    // The class: no request line of any proxied request, and no client address (README "Logging").
    expect(log).not.toMatch(/request: "/);
    expect(log).not.toMatch(/client: /);
  });
});
