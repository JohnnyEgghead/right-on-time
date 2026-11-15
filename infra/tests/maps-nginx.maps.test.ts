// SPDX-License-Identifier: AGPL-3.0-or-later
// nginx serves /maps/{branch}.pmtiles from the map volume with range requests (API-106, FR-MAP-1): the real nginx image of
// infra/compose.yaml, the real infra/nginx files and the real map files, in one container named bw-w16-maps-nginx-<pid> on a
// free loopback port. Files are copied in with docker cp, not bind-mounted, so it works on any docker context. Run by the gate
// map-manifest (infra/tests/**/*.maps.test.ts is outside the merge-set run). Docker must be up; a missing docker fails.
// P6-ROUTE-BAKE: the folder also holds the routing files of SD-49 (2.7 GB), which only the routing service reads, over the Compose
// network; nginx serves none of them. The container gets the map files, the tracks file and the smallest routing file (not the
// whole folder), and the test asks nginx for every routing file the manifest names: none answers with its bytes.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMapManifest, MAPS_DIR } from '../../packages/maps/src/manifest.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const dir = process.env['MAPS_DIR'] ?? MAPS_DIR;
const compose = readFileSync(path.join(root, 'infra/compose.yaml'), 'utf8');
const image = /image: (nginx:[^\s]+@sha256:[0-9a-f]{64})/.exec(compose)?.[1] as string; // the 1 pin of the proxy
const name = `bw-w16-maps-nginx-${process.pid}`;
let base = '';
const routingFiles = loadMapManifest().assets.filter((a) => a.kind === 'routing');
const smallestRouting = [...routingFiles].sort((a, b) => a.bytes - b.bytes)[0]!;

const docker = (...a: string[]): string => {
  const r = spawnSync('docker', a, { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`docker ${a.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
};

beforeAll(async () => {
  // The same start as the proxy service: the site file and the open routes are picked by symlink, then nginx runs in front.
  // /data/maps is an anonymous volume so the directory exists for docker cp before the start; rm -fv below removes it.
  docker('create', '--name', name, '-v', '/data/maps', '-p', '127.0.0.1::80', image, '/bin/sh', '-c',
    'ln -sf /etc/nginx/bw/local.conf /etc/nginx/conf.d/default.conf && ln -sf /etc/nginx/bw/routes-open.conf /etc/nginx/bw-routes.conf && exec nginx -g "daemon off;"');
  docker('cp', path.join(root, 'infra/nginx/.'), `${name}:/etc/nginx/bw`);
  for (const f of [...loadMapManifest().assets.filter((a) => a.kind !== 'routing').map((a) => a.id), smallestRouting.id]) {
    docker('cp', path.join(dir, f), `${name}:/data/maps/${f}`);
  }
  docker('start', name);
  const port = /:(\d+)$/m.exec(docker('port', name, '80/tcp'))?.[1];
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/maps/columbus.pmtiles`, { headers: { Range: 'bytes=0-0' } });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`nginx did not answer: ${docker('logs', name)}`);
}, 120_000);

afterAll(() => {
  spawnSync('docker', ['rm', '-fv', name], { stdio: 'ignore' });
});

describe('nginx serves /maps/*.pmtiles with range requests', () => {
  const files = loadMapManifest().assets.filter((a) => a.kind === 'pmtiles');

  for (const a of files) {
    // why: API-106, FR-MAP-1
    it(`answers 206 with the asked bytes and a cacheable header for ${a.id}`, async () => {
      const head = await fetch(`${base}/maps/${a.id}`, { headers: { Range: 'bytes=0-126' } });
      expect(head.status).toBe(206);
      expect(head.headers.get('content-range')).toBe(`bytes 0-126/${a.bytes}`);
      expect(head.headers.get('accept-ranges')).toBe('bytes');
      expect(head.headers.get('cache-control')).toBe('public, max-age=86400');
      expect(head.headers.get('content-type')).toBe('application/octet-stream');
      const body = Buffer.from(await head.arrayBuffer());
      expect(body.length).toBe(127);
      expect(body.toString('latin1', 0, 7)).toBe('PMTiles');
      const mid = Math.floor(a.bytes / 2);
      const part = await fetch(`${base}/maps/${a.id}`, { headers: { Range: `bytes=${mid}-${mid + 4095}` } });
      expect(part.status).toBe(206);
      expect(part.headers.get('content-range')).toBe(`bytes ${mid}-${mid + 4095}/${a.bytes}`);
      expect(Buffer.from(await part.arrayBuffer()).length).toBe(4096);
    });
  }

  // why: API-106, FR-MAP-1
  it('answers a range past the end with 416, a plain GET with 200 and the whole size, and serves only the 3 branch names', async () => {
    const f = files[0]!;
    expect((await fetch(`${base}/maps/${f.id}`, { headers: { Range: `bytes=${f.bytes + 10}-` } })).status).toBe(416);
    const whole = await fetch(`${base}/maps/${f.id}`, { headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'gzip' } });
    expect(whole.headers.get('content-encoding')).toBeNull();
    const all = await fetch(`${base}/maps/${files[2]!.id}`);
    expect(all.status).toBe(200);
    expect(Number(all.headers.get('content-length'))).toBe(files[2]!.bytes);
    await all.arrayBuffer();
    for (const bad of ['/maps/tracks.ndjson', '/maps/../etc/passwd', '/maps/other.pmtiles', '/maps/columbus.pmtiles.bak']) {
      expect((await fetch(`${base}${bad}`, { headers: { Range: 'bytes=0-9' } })).status, bad).not.toBe(206);
    }
  });

  // why: NFR-12, FR-MAP-3
  it('serves no routing file (SD-49: only the routing service reads them, over the Compose network), the 1 on its disk included', async () => {
    expect(routingFiles.length).toBeGreaterThan(10);
    docker('exec', name, 'test', '-s', `/data/maps/${smallestRouting.id}`);
    for (const a of routingFiles) {
      for (const p of [`/maps/${a.id}`, `/maps/ohio.osrm`, `/data/maps/${a.id}`]) {
        const r = await fetch(`${base}${p}`, { headers: { Range: 'bytes=0-9' } });
        expect(r.status, p).not.toBe(206);
        expect(r.status, p).not.toBe(200);
        await r.arrayBuffer();
      }
    }
  });
});
