// SPDX-License-Identifier: AGPL-3.0-or-later
// Test helpers: a small valid-header PMTiles file and a manifest for it, so the manifest check runs without the real files.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MapAsset, MapManifest } from './manifest.ts';
import { haversineMeters } from './position.ts';
import { trackFromOsrm, type OsrmRoute, type RouteTrack, type RoutingService } from './route-source.ts';

export function pmtilesBytes(bbox: [number, number, number, number], minZoom = 0, maxZoom = 15, payload = 4096): Buffer {
  const b = Buffer.alloc(127 + payload, 7);
  b.fill(0, 0, 127);
  b.write('PMTiles', 0, 'latin1');
  b.writeUInt8(3, 7);
  b.writeUInt8(minZoom, 100);
  b.writeUInt8(maxZoom, 101);
  bbox.forEach((v, i) => b.writeInt32LE(Math.round(v * 1e7), 102 + i * 4));
  return b;
}

export const BOXES: Record<string, [number, number, number, number]> = {
  'columbus.pmtiles': [-83.45, 39.65, -82.55, 40.35],
  'dayton.pmtiles': [-84.4, 39.55, -83.95, 39.95],
  'springfield.pmtiles': [-83.95, 39.85, -83.55, 40.1],
};

/** Write the 3 map files and a tracks file into dir and return the manifest that matches them. */
export function plantMaps(dir: string): MapManifest {
  mkdirSync(dir, { recursive: true });
  const assets: MapAsset[] = [];
  const base = { repo: 'x/y', tag: 't' };
  for (const [id, bbox] of Object.entries(BOXES)) {
    const buf = pmtilesBytes(bbox, 0, 15, 1000 + id.length);
    writeFileSync(path.join(dir, id), buf);
    assets.push({ ...base, id, asset: id, kind: 'pmtiles', bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), bbox, minZoom: 0, maxZoom: 15 });
  }
  const tracks = Buffer.from('{"a":1}\n');
  writeFileSync(path.join(dir, 'tracks.ndjson'), tracks);
  assets.push({ ...base, id: 'tracks.ndjson', asset: 'tracks.ndjson', kind: 'tracks', bytes: tracks.length, sha256: createHash('sha256').update(tracks).digest('hex') });
  return { protomapsBuild: 'test', sizeGateBytes: 2147483648, trackBuildId: 'test', assets };
}

/**
 * A 3-vertex OSRM route answer from `a` to `b` (P6-LIVE-ROUTING tests): depart east on Test Rd, turn left at the midpoint onto Second St,
 * arrive. 60 s then 90 s of driving; the lengths are the vertices' haversine, so the mapping's sums hold. Coordinates at 5 decimals, as
 * OSRM answers them.
 */
export function osrmRouteBetween(a: { lon: number; lat: number }, b: { lon: number; lat: number }): OsrmRoute {
  const r5 = (v: number): number => Math.round(v * 1e5) / 1e5;
  const p0: [number, number] = [r5(a.lon), r5(a.lat)];
  const p2: [number, number] = [r5(b.lon), r5(b.lat)];
  const p1: [number, number] = [r5((p0[0] + p2[0]) / 2), r5((p0[1] + p2[1]) / 2)];
  const d1 = haversineMeters(p0, p1);
  const d2 = haversineMeters(p1, p2);
  return {
    distance: d1 + d2, duration: 150,
    geometry: { coordinates: [p0, p1, p2] },
    legs: [{
      annotation: { duration: [60, 90] },
      steps: [
        { distance: d1, name: 'Test Rd', geometry: { coordinates: [p0, p1] }, maneuver: { type: 'depart', bearing_after: 90 } },
        { distance: d2, name: 'Second St', geometry: { coordinates: [p1, p2] }, maneuver: { type: 'turn', modifier: 'left' } },
        { distance: 0, name: 'Second St', geometry: { coordinates: [p2, p2] }, maneuver: { type: 'arrive', modifier: 'right' } },
      ],
    }],
  };
}

/**
 * A routing service a test drives (P6-LIVE-ROUTING): `up` answers {@link osrmRouteBetween} through the live mapping, `down` answers no
 * route, `stall` never answers; `gate`, when set, holds every answer until the test opens it. `calls` counts the requests.
 */
export class FakeRouting implements RoutingService {
  mode: 'up' | 'down' | 'stall' = 'up';
  calls = 0;
  gate: Promise<void> | null = null;
  async route(from: { lon: number; lat: number }, to: { lon: number; lat: number }): Promise<RouteTrack | null> {
    this.calls += 1;
    if (this.gate) await this.gate;
    if (this.mode === 'stall') return new Promise<never>(() => undefined);
    return this.mode === 'down' ? null : trackFromOsrm(osrmRouteBetween(from, to));
  }
}
