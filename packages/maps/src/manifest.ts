// SPDX-License-Identifier: AGPL-3.0-or-later
// The map manifest (FR-MAP-4, SPECIFICATIONS section 6.10): packages/maps/MANIFEST.json is the one committed source of
// each map file's release, size, SHA-256 and bounding box, and of the baked track set's size and SHA-256 (D7: data files
// are release downloads, never git). verifyMaps checks every file: present, within the size gate (C6), the committed
// size, the committed SHA-256 and, for a PMTiles file, the committed bounding box and zoom range. A difference stops with
// MAP_HASH_MISMATCH <file> (setup passes it on as a stop).
//
// P6-ROUTE-BAKE (SPECIFICATIONS v0.13 SD-49, section 6.10): the routing files of the bake's OSRM run (kind `routing`, ohio.osrm.*) are
// manifest files too, each under the same per-file gate, fetched and checked by `pnpm run setup:maps`. Only the routing service reads
// them, so setup checks one only when it is present (a wrong file stops setup, named; an absent one leaves legs approximate, SD-49
// step 3); `pnpm run setup:maps` and `verify` require every one.
//
// The file shape keeps the `assets` list of packages/db/src/data-manifest.json (id, repo, tag, asset, bytes, sha256), so
// ci/data-assets.ts can fetch it with `--manifest packages/maps/MANIFEST.json --dir <dir>`.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { readPmtilesHeader } from './pmtiles.ts';

/** The owner's size gate (C6; ruling be2d3f8a, Oct 31, 2026): GitHub's 2 GiB per file, each file on its own. */
export const SIZE_GATE_BYTES = 2147483648;
export const MANIFEST_FILE = path.join(import.meta.dirname, '..', 'MANIFEST.json');
/** Where the verified copies live: .build/data/maps at the tree's root (git-ignored); MAPS_DIR overrides it. */
export const MAPS_DIR = path.resolve(import.meta.dirname, '..', '..', '..', '.build', 'data', 'maps');

export interface MapAsset {
  id: string;
  repo: string;
  tag: string;
  asset: string;
  bytes: number;
  sha256: string;
  kind: 'pmtiles' | 'tracks' | 'routing';
  /** PMTiles only: the header's bounding box [minLon, minLat, maxLon, maxLat], degrees. */
  bbox?: [number, number, number, number];
  minZoom?: number;
  maxZoom?: number;
}

export interface MapManifest {
  protomapsBuild: string;
  sizeGateBytes: number;
  trackBuildId: string;
  assets: MapAsset[];
}

export type MapErrorCode = 'MAP_HASH_MISMATCH' | 'MAP_MISSING' | 'MAP_SIZE_GATE';

/** A named stop. The message starts with the code and the file: `MAP_HASH_MISMATCH columbus.pmtiles: ...`. */
export class MapError extends Error {
  readonly code: MapErrorCode;
  readonly file: string;
  constructor(code: MapErrorCode, file: string, detail: string) {
    super(`${code} ${file}: ${detail}`);
    this.name = 'MapError';
    this.code = code;
    this.file = file;
  }
}

export function loadMapManifest(file = MANIFEST_FILE): MapManifest {
  return JSON.parse(readFileSync(file, 'utf8')) as MapManifest;
}

export function mapAsset(m: MapManifest, id: string): MapAsset {
  const a = m.assets.find((x) => x.id === id);
  if (!a) throw new Error(`map asset ${id} is not in the manifest`);
  return a;
}

/** SHA-256 of a file, read in 1 MiB steps (a map file may be up to the 2 GiB gate, past a Buffer's comfortable size). */
export function sha256File(file: string): string {
  const h = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 5e-8;

/** Check 1 file against its manifest entry. Throws a MapError naming the file. */
export function verifyMapFile(dir: string, a: MapAsset, gate = SIZE_GATE_BYTES): void {
  const file = path.join(dir, a.id);
  if (a.bytes > gate) throw new MapError('MAP_SIZE_GATE', a.id, `the manifest size ${a.bytes} bytes is over the ${gate} byte gate (C6)`);
  if (!existsSync(file)) throw new MapError('MAP_MISSING', a.id, `not found at ${file}; run pnpm run setup:maps`);
  const size = statSync(file).size;
  if (size > gate) throw new MapError('MAP_SIZE_GATE', a.id, `${size} bytes is over the ${gate} byte gate (C6)`);
  if (size !== a.bytes) throw new MapError('MAP_HASH_MISMATCH', a.id, `size ${size} bytes, want ${a.bytes}`);
  const sha = sha256File(file);
  if (sha !== a.sha256) throw new MapError('MAP_HASH_MISMATCH', a.id, `sha256 ${sha}, want ${a.sha256}`);
  if (a.kind !== 'pmtiles') return;
  let h;
  try {
    h = readPmtilesHeader(file);
  } catch (e) {
    throw new MapError('MAP_HASH_MISMATCH', a.id, `bad PMTiles header: ${(e as Error).message}`);
  }
  if (!a.bbox || !a.bbox.every((v, i) => near(v, h.bbox[i] as number))) {
    throw new MapError('MAP_HASH_MISMATCH', a.id, `bounding box [${h.bbox.join(', ')}], want [${(a.bbox ?? []).join(', ')}]`);
  }
  if (a.minZoom !== h.minZoom || a.maxZoom !== h.maxZoom) {
    throw new MapError('MAP_HASH_MISMATCH', a.id, `zoom ${h.minZoom} to ${h.maxZoom}, want ${a.minZoom} to ${a.maxZoom}`);
  }
}

/**
 * How a check treats the routing files (kind `routing`): `required`, every one present and right (setup:maps, verify); `if-present`,
 * a present one must be right and an absent one is passed over (setup, which does not read them); `skip`, none is looked at.
 */
export type RoutingCheck = 'required' | 'if-present' | 'skip';

/** Check every file of the manifest in order; the first difference throws. Returns the ids checked. */
export function verifyMaps(dir: string = MAPS_DIR, manifest: MapManifest = loadMapManifest(), routing: RoutingCheck = 'required'): string[] {
  const gate = Math.min(manifest.sizeGateBytes, SIZE_GATE_BYTES);
  const checked: string[] = [];
  for (const a of manifest.assets) {
    if (a.kind === 'routing' && (routing === 'skip' || (routing === 'if-present' && !existsSync(path.join(dir, a.id))))) continue;
    verifyMapFile(dir, a, gate);
    checked.push(a.id);
  }
  return checked;
}
