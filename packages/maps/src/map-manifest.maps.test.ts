// SPDX-License-Identifier: AGPL-3.0-or-later
// The real map files and track set (the gate map-manifest; vitest.maps.config.ts): FR-MAP-4 over the real files with a planted
// 1-byte change, and FR-MAP-5 over the real track set. Needs the verified files in $MAPS_DIR (default .build/data/maps):
// `pnpm run setup:maps`. A missing file fails the test; nothing here skips.
// P6-ROUTE-BAKE: the folder holds the routing files of SD-49 too (2.7 GB), so a planted copy is the real folder's files linked by name
// with only the planted file a real copy (cloned where the disk can), never the whole folder copied. The known-bad arm runs over every
// new file: the new tracks file and each routing file stop the check, and a planted routing file stops setup, named.
import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, mkdtempSync, readdirSync, openSync, readFileSync, readSync, rmSync, symlinkSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readVerifiedMaps } from '../../setup/src/pipeline.ts';
import { SetupError } from '../../setup/src/errors.ts';
import { checkCoverage } from './coverage.ts';
import { PAIR_DAY } from './legs.ts';
import { loadMapManifest, MAPS_DIR, SIZE_GATE_BYTES, verifyMapFile, verifyMaps, type MapAsset } from './manifest.ts';
import { seededLegs } from './seeded.ts';
import { parseTracks, trackKey } from './tracks.ts';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const dir = process.env['MAPS_DIR'] ?? MAPS_DIR;
const manifest = loadMapManifest();
const mapAssetTag = (id: string): string => manifest.assets.find((a) => a.id === id)!.tag;
const scratch: string[] = [];
afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A folder of the real files by symlink, with `planted` a real copy whose middle byte is flipped (1 changed byte, same size). */
function plantedFolder(planted: string, leaveOut: (a: MapAsset) => boolean = () => false): string {
  const copy = mkdtempSync(path.join(tmpdir(), 'bw-maps-planted-'));
  scratch.push(copy);
  for (const a of manifest.assets) {
    if (leaveOut(a)) continue;
    if (a.id !== planted) symlinkSync(path.join(dir, a.id), path.join(copy, a.id));
  }
  const f = path.join(copy, planted);
  copyFileSync(path.join(dir, planted), f, constants.COPYFILE_FICLONE);
  const fd = openSync(f, 'r+');
  try {
    const at = Math.floor(manifest.assets.find((a) => a.id === planted)!.bytes / 2);
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, at);
    b[0] = (b[0] as number) ^ 1;
    writeSync(fd, b, 0, 1, at);
  } finally {
    closeSync(fd);
  }
  return copy;
}

/** Setup's own check and the setup program itself both stop on a folder, naming the file (F-327: the stop is 1 JSON line). */
function expectSetupStops(copy: string, file: string): void {
  let stop: unknown;
  try {
    readVerifiedMaps(copy);
  } catch (e) {
    stop = e;
  }
  expect(stop).toBeInstanceOf(SetupError);
  expect((stop as SetupError).code).toBe('map_hash_mismatch');
  expect((stop as SetupError).message).toContain(`MAP_HASH_MISMATCH ${file}`);
  // The setup program itself: it stops before the database (the URL below points at nothing) and logs the named error.
  const r = spawnSync(process.execPath, ['packages/setup/src/cli.ts'], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
    env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', SAMPLE_PASSWORD_SEED: 'x'.repeat(20), MAPS_DIR: copy },
  });
  expect(r.status).toBe(1);
  expect(r.stdout).toContain('"errorCode":"map_hash_mismatch"');
  expect(r.stderr).not.toContain('setup: ');
  expect(r.stdout + r.stderr).not.toContain('migrated');
}

describe('the real map files against the committed manifest', () => {
  // why: FR-MAP-4, FR-MAP-1, C6
  it('every file equals the manifest (size, SHA-256, bounding box, zoom 0 to 15) and is inside the 2 GiB gate', () => {
    expect(verifyMaps(dir, manifest)).toEqual(manifest.assets.map((a) => a.id));
    expect(manifest.assets.slice(0, 4).map((a) => a.id)).toEqual(['columbus.pmtiles', 'dayton.pmtiles', 'springfield.pmtiles', 'tracks.ndjson']);
    for (const a of manifest.assets) expect(a.bytes, a.id).toBeLessThanOrEqual(SIZE_GATE_BYTES);
  });

  // why: FR-MAP-4, C6
  it('names every routing file of the bake run (SD-49), each its own release file under the 2 GiB gate', () => {
    const routing = manifest.assets.filter((a) => a.kind === 'routing');
    expect(routing.length).toBeGreaterThan(10);
    for (const a of routing) {
      expect(a.id, a.id).toMatch(/^ohio\.osrm(\.[A-Za-z_]+)?$/);
      expect(a.asset).toBe(a.id);
      expect(a.tag).toBe(mapAssetTag('tracks.ndjson'));
    }
    expect(routing.map((a) => a.id)).toContain('ohio.osrm.mldgr'); // the file the routing service waits for (infra/compose.yaml)
  });

  // why: F-1290 the routing files in the verified folder are exactly the ones the manifest names, so a manifest that lost one is red here too
  it('the ohio.osrm files in the verified folder are the manifest routing files, no more and no fewer', () => {
    const inFolder = readdirSync(dir).filter((f) => f.startsWith('ohio.osrm')).sort();
    expect(inFolder).toEqual(manifest.assets.filter((a) => a.kind === 'routing').map((a) => a.id).sort());
  });

  // why: FR-MAP-4
  it('the new tracks file and every routing file with 1 changed byte stops the check, naming the file', () => {
    for (const a of manifest.assets.filter((x) => x.kind === 'tracks' || x.kind === 'routing')) {
      const copy = plantedFolder(a.id);
      expect(() => verifyMapFile(copy, a), a.id).toThrow(new RegExp(`^MAP_HASH_MISMATCH ${a.id.replace(/\./g, '\\.')}: sha256 `));
      rmSync(copy, { recursive: true, force: true });
    }
  });

  // why: FR-MAP-4
  it('a routing file with 1 changed byte stops setup, naming the file; with no routing files setup checks the rest and goes on', () => {
    const last = manifest.assets.filter((a) => a.kind === 'routing').pop()!;
    expectSetupStops(plantedFolder(last.id), last.id);
    const none = plantedFolder('tracks.ndjson', (a) => a.kind === 'routing');
    expectSetupStops(none, 'tracks.ndjson');
    const clean = mkdtempSync(path.join(tmpdir(), 'bw-maps-norouting-'));
    scratch.push(clean);
    for (const a of manifest.assets.filter((x) => x.kind !== 'routing')) symlinkSync(path.join(dir, a.id), path.join(clean, a.id));
    expect(readVerifiedMaps(clean).length).toBeGreaterThan(3000);
    expect(() => verifyMaps(clean, manifest)).toThrow(/^MAP_MISSING ohio\.osrm/);
  });

  // why: FR-MAP-4
  it('a map file with 1 changed byte stops the check, and setup, naming the file', () => {
    const copy = plantedFolder('columbus.pmtiles');
    expect(() => verifyMaps(copy, manifest)).toThrow(/^MAP_HASH_MISMATCH columbus\.pmtiles: sha256 /);
    expectSetupStops(copy, 'columbus.pmtiles');
  });
});

describe('the real track set against the seeded schedule', () => {
  const set = seededLegs();
  const tracks = parseTracks(readFileSync(path.join(dir, 'tracks.ndjson'), 'utf8'));
  const have = new Set(tracks.map((t) => trackKey(t.branch_id, t.from_ref, t.to_ref)));

  // why: FR-MAP-5
  it('has a track for every job leg of the demo week (depot legs included) and none outside the covered days', () => {
    const r = checkCoverage(set, tracks);
    expect(r.missing).toEqual([]);
    expect(r.outside).toEqual([]);
    expect(r.bad).toEqual([]);
    expect(Object.keys(set.jobsByDay).sort()).toEqual(['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']);
    for (const t of tracks) expect(t.build_id).toBe(manifest.trackBuildId);
  });

  // why: FR-MAP-5
  it('has a track for every ordered same-branch pair of the Sep 15 jobs', () => {
    const sep15 = new Set(set.jobsByDay[PAIR_DAY]);
    expect(sep15.size).toBeGreaterThan(0);
    const branchOf = new Map<number, string>();
    for (const l of set.legs) {
      if (sep15.has(Number(l.from_ref))) branchOf.set(Number(l.from_ref), l.branch_id);
      if (sep15.has(Number(l.to_ref))) branchOf.set(Number(l.to_ref), l.branch_id);
    }
    let pairs = 0;
    for (const a of sep15) for (const b of sep15) {
      if (a === b || branchOf.get(a) !== branchOf.get(b)) continue;
      pairs++;
      expect(have.has(trackKey(branchOf.get(a) as string, String(a), String(b))), `${a} to ${b}`).toBe(true);
    }
    expect(pairs).toBeGreaterThan(2000);
  });

  // why: FR-MAP-5
  it('bakes no track for a past visit: no job ref before the demo week, only job numbers of the covered days and depot', () => {
    const covered = new Set(Object.values(set.jobsByDay).flat().map(String));
    for (const t of tracks) {
      for (const ref of [t.from_ref, t.to_ref]) expect(ref === 'depot' || covered.has(ref), ref).toBe(true);
    }
  });
});
