// SPDX-License-Identifier: AGPL-3.0-or-later
// The map manifest check on small planted files (FR-MAP-4, C6). The same check over the real files, with the planted
// 1-byte change, runs in map-manifest.maps.test.ts (the gate map-manifest).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMapManifest, mapAsset, MapError, SIZE_GATE_BYTES, verifyMapFile, verifyMaps, type MapManifest } from './manifest.ts';
import { parsePmtilesHeader } from './pmtiles.ts';
import { BOXES, plantMaps, pmtilesBytes } from './testing.ts';

let dir = '';
let manifest: MapManifest;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-maps-'));
  manifest = plantMaps(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stop = (fn: () => void): MapError => {
  try {
    fn();
  } catch (e) {
    return e as MapError;
  }
  throw new Error('expected a stop');
};

describe('the map manifest check', () => {
  // why: FR-MAP-4
  it('passes files that equal the manifest (size, SHA-256, bounding box, zoom range)', () => {
    expect(verifyMaps(dir, manifest)).toEqual(['columbus.pmtiles', 'dayton.pmtiles', 'springfield.pmtiles', 'tracks.ndjson']);
  });

  // why: FR-MAP-4
  it('stops with MAP_HASH_MISMATCH <file> when 1 byte of a map file changes', () => {
    const f = path.join(dir, 'dayton.pmtiles');
    const b = readFileSync(f);
    b[b.length - 1] = (b[b.length - 1] as number) ^ 1;
    writeFileSync(f, b);
    const e = stop(() => verifyMaps(dir, manifest));
    expect(e.code).toBe('MAP_HASH_MISMATCH');
    expect(e.file).toBe('dayton.pmtiles');
    expect(e.message).toMatch(/^MAP_HASH_MISMATCH dayton\.pmtiles: sha256 /);
  });

  // why: FR-MAP-4
  it('stops on a changed size, and on a changed byte in the track set', () => {
    writeFileSync(path.join(dir, 'springfield.pmtiles'), Buffer.concat([readFileSync(path.join(dir, 'springfield.pmtiles')), Buffer.from([0])]));
    expect(stop(() => verifyMaps(dir, manifest)).message).toMatch(/^MAP_HASH_MISMATCH springfield\.pmtiles: size /);
    plantMaps(dir);
    writeFileSync(path.join(dir, 'tracks.ndjson'), '{"a":2}\n');
    expect(stop(() => verifyMaps(dir, manifest)).message).toMatch(/^MAP_HASH_MISMATCH tracks\.ndjson: sha256 /);
  });

  // why: FR-MAP-4
  it('stops when the header bounding box or zoom range differs from the manifest, even if the hash matches', () => {
    const other = manifest.assets.map((a) => (a.id === 'columbus.pmtiles' ? { ...a, bbox: [-83.45, 39.65, -82.55, 40.36] as [number, number, number, number] } : a));
    expect(stop(() => verifyMaps(dir, { ...manifest, assets: other })).message).toMatch(/^MAP_HASH_MISMATCH columbus\.pmtiles: bounding box /);
    const zoom = manifest.assets.map((a) => (a.id === 'columbus.pmtiles' ? { ...a, maxZoom: 14 } : a));
    expect(stop(() => verifyMaps(dir, { ...manifest, assets: zoom })).message).toMatch(/^MAP_HASH_MISMATCH columbus\.pmtiles: zoom /);
  });

  // why: FR-MAP-4
  it('stops on a missing file and on a file that is not a PMTiles v3 file', () => {
    rmSync(path.join(dir, 'dayton.pmtiles'));
    const e = stop(() => verifyMaps(dir, manifest));
    expect([e.code, e.file]).toEqual(['MAP_MISSING', 'dayton.pmtiles']);
    expect(() => parsePmtilesHeader(Buffer.from('PMTilez'.padEnd(127, ' ')))).toThrow(/magic/);
    const v2 = pmtilesBytes(BOXES['columbus.pmtiles'] as [number, number, number, number]);
    v2.writeUInt8(2, 7);
    expect(() => parsePmtilesHeader(v2)).toThrow(/version 2/);
  });

  // why: FR-MAP-1, C6
  it('applies the size gate to each file on its own: 2 GiB passes, 1 byte more stops', () => {
    expect(SIZE_GATE_BYTES).toBe(2147483648);
    const a = manifest.assets[0]!;
    expect(stop(() => verifyMapFile(dir, { ...a, bytes: SIZE_GATE_BYTES + 1 })).code).toBe('MAP_SIZE_GATE');
    expect(stop(() => verifyMapFile(dir, a, a.bytes - 1)).code).toBe('MAP_SIZE_GATE');
    expect(() => verifyMapFile(dir, a, a.bytes)).not.toThrow();
  });

  // why: FR-MAP-4, C6
  it('the committed manifest names 3 branch files, the track set and the routing files, each inside the gate; tracks and routing files in 1 release', () => {
    const m = loadMapManifest();
    expect(m.sizeGateBytes).toBe(SIZE_GATE_BYTES);
    expect(m.assets.slice(0, 4).map((a) => a.id)).toEqual(['columbus.pmtiles', 'dayton.pmtiles', 'springfield.pmtiles', 'tracks.ndjson']);
    for (const a of m.assets) {
      expect(a.sha256, a.id).toMatch(/^[0-9a-f]{64}$/);
      expect(a.bytes, a.id).toBeGreaterThan(0);
      expect(a.bytes, a.id).toBeLessThanOrEqual(SIZE_GATE_BYTES);
      expect(a.asset).toBe(a.id);
    }
    expect(new Set(m.assets.filter((a) => a.kind === 'pmtiles').map((a) => a.tag)).size).toBe(1);
    // P6-ROUTE-BAKE (SD-49): the routing files come from the same OSRM run as the tracks, so they share its release
    const routing = m.assets.filter((a) => a.kind === 'routing');
    expect(routing.length).toBeGreaterThan(10);
    expect(new Set([...routing, mapAsset(m, 'tracks.ndjson')].map((a) => a.tag)).size).toBe(1);
    expect(m.assets.slice(4).every((a) => a.kind === 'routing' && a.id.startsWith('ohio.osrm'))).toBe(true);
    for (const a of m.assets.filter((x) => x.kind === 'pmtiles')) {
      expect(a.bbox, a.id).toEqual(BOXES[a.id]);
      expect([a.minZoom, a.maxZoom]).toEqual([0, 15]);
    }
  });
});

// The 26 files of the bake's OSRM run (ohio.osrm and ohio.osrm.*; P6-ROUTE-BAKE, docs/build/spikes/P6-ROUTE-BAKE.md). osrm-routed --mmap
// opens each of these, so a manifest that loses one passes every check on the files it still names while a clean setup:maps leaves the
// routing service without it. The list is pinned here, not derived from the manifest the test checks (F-1290).
const OSRM_FILES = [
  'ohio.osrm.cell_metrics', 'ohio.osrm.cells', 'ohio.osrm.cnbg', 'ohio.osrm.cnbg_to_ebg', 'ohio.osrm.datasource_names', 'ohio.osrm.ebg',
  'ohio.osrm.ebg_nodes', 'ohio.osrm.edges', 'ohio.osrm.enw', 'ohio.osrm.fileIndex', 'ohio.osrm.geometry', 'ohio.osrm.icd',
  'ohio.osrm.maneuver_overrides', 'ohio.osrm.mldgr', 'ohio.osrm.names', 'ohio.osrm.nbg_nodes', 'ohio.osrm.partition', 'ohio.osrm.properties',
  'ohio.osrm.ramIndex', 'ohio.osrm.restrictions', 'ohio.osrm.timestamp', 'ohio.osrm.tld', 'ohio.osrm.tls', 'ohio.osrm.turn_duration_penalties',
  'ohio.osrm.turn_penalties_index', 'ohio.osrm.turn_weight_penalties',
];

describe('the committed manifest names every routing file (F-1290)', () => {
  // why: F-1290 GATE-ACCEPTANCE items 4 and 5: removing ohio.osrm.ramIndex from the manifest left all 117 lane tests green
  it('lists exactly the 26 files of the OSRM run, no more and no fewer', () => {
    const real = loadMapManifest();
    expect(real.assets.filter((a) => a.kind === 'routing').map((a) => a.id).sort()).toEqual([...OSRM_FILES].sort());
  });
});
