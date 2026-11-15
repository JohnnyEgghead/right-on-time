// SPDX-License-Identifier: AGPL-3.0-or-later
// node packages/maps/src/cli.ts <command> [--dir <dir>] [--manifest <file>]      (pnpm run setup:maps = fetch)
//   fetch           download every file the manifest names from its release (gh, else GITHUB_TOKEN, else the public release URL, which needs no login) into <dir>, then verify (FR-MAP-4),
//                   the routing files of SD-49 included; --no-routing leaves them out (a copy that runs no routing service)
//   verify          check every file in <dir> against the manifest: size gate, size, SHA-256, bounding box. MAP_HASH_MISMATCH <file> on a difference
//                   (--no-routing: the map files and tracks only)
//   legs --out <f>  write the legs the track bake routes (from the seeded schedule; legs.ts) to <f>, and print the counts
//   coverage        every leg of the demo week and every Sep 15 same-branch pair has a track in <dir>/tracks.ndjson (FR-MAP-5)
//   write-manifest  rewrite the manifest's size, SHA-256 and bounding box from the files in <dir> (after an intended re-bake); the
//                   routing entries become exactly the ohio.osrm* files in <dir>. --tag <tag>: the release tag of every file that
//                   changed or is new (the files go up on a new tag; an unchanged file keeps its tag)
// <dir> defaults to $MAPS_DIR, else .build/data/maps. Exit 0 ok; 1 a named stop; 2 usage.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkCoverage } from './coverage.ts';
import { seededLegs } from './seeded.ts';
import { loadMapManifest, MANIFEST_FILE, MapError, MAPS_DIR, sha256File, SIZE_GATE_BYTES, verifyMaps, type MapAsset, type MapManifest } from './manifest.ts';
import { readPmtilesHeader } from './pmtiles.ts';
import { parseTracks } from './tracks.ts';

const args = process.argv.slice(2);
const val = (flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const dir = val('--dir') ?? process.env['MAPS_DIR'] ?? MAPS_DIR;
const manifestFile = val('--manifest') ?? MANIFEST_FILE;
const routing = args.includes('--no-routing') ? 'skip' : 'required';
/** The routing files of 1 OSRM run in a folder (SD-49): the bake's base name `ohio.osrm` and its extensions. */
const routingFiles = (d: string): string[] => readdirSync(d).filter((f) => f.startsWith('ohio.osrm')).sort();

async function main(): Promise<void> {
  const cmd = args[0];
  if (cmd === 'fetch') {
    // The fetch half is ci/data-assets.ts (gh, else the REST API with GITHUB_TOKEN, else the public release URL with no login); the manifest keeps its `assets` shape.
    // It runs as its own program (a checkout has ci/; the shipped image does not, and product code never imports ci/).
    const ensure = ['ensure', '--dir', dir, '--manifest', manifestFile, ...(routing === 'required' ? ['--with-routing'] : [])];
    const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '..', '..', '..', 'ci', 'data-assets.ts'), ...ensure], { encoding: 'utf8' });
    process.stdout.write(r.stdout.replace(/^data-assets:/gm, 'setup:maps:'));
    if (r.status !== 0) {
      const m = /^data-assets: MISMATCH (\S+)$/m.exec(r.stderr);
      if (m) throw new MapError('MAP_HASH_MISMATCH', m[1] as string, 'the downloaded release asset differs from the committed manifest');
      // F-375: the cause stays visible; the re-check below throws its own MapError, which names only the file.
      process.stderr.write(r.stderr);
      // F-361: where nothing can be fetched (the wave container: no gh, no token) a bad file on disk is a named stop, not "cannot fetch".
      verifyMaps(dir, loadMapManifest(manifestFile), routing);
      throw new Error(r.stderr.trim() || 'ci/data-assets.ts ensure failed');
    }
    console.log(`setup:maps: verified ${verifyMaps(dir, loadMapManifest(manifestFile), routing).join(', ')}`);
  } else if (cmd === 'verify') {
    console.log(`map-manifest: verified ${verifyMaps(dir, loadMapManifest(manifestFile), routing).join(', ')} in ${dir}`);
  } else if (cmd === 'legs') {
    const out = val('--out');
    if (!out) throw new Error('usage: legs --out <file>');
    const set = seededLegs();
    writeFileSync(out, JSON.stringify({ counts: set.counts, legs: set.legs }));
    console.log(`maps: wrote ${set.legs.length} legs to ${out} ${JSON.stringify(set.counts)}`);
  } else if (cmd === 'coverage') {
    verifyMaps(dir, loadMapManifest(manifestFile), 'skip'); // the tracks are what coverage reads; fetch checked the routing files
    const set = seededLegs();
    const r = checkCoverage(set, parseTracks(readFileSync(path.join(dir, 'tracks.ndjson'), 'utf8')));
    console.log(`map-coverage: ${r.legs} required legs, ${r.tracks} tracks, ${r.missing.length} missing, ${r.outside.length} outside the covered days, ${r.bad.length} undrawable ${JSON.stringify(set.counts)}`);
    if (r.missing.length + r.outside.length + r.bad.length > 0) {
      console.error(`map-coverage: FAIL first missing ${r.missing.slice(0, 3).join('; ')} first outside ${r.outside.slice(0, 3).join('; ')} first undrawable ${r.bad.slice(0, 3).join('; ')}`);
      process.exitCode = 1;
    }
  } else if (cmd === 'write-manifest') {
    const m: MapManifest = loadMapManifest(manifestFile);
    const tag = val('--tag');
    const first = m.assets.find((a) => a.kind === 'tracks') ?? m.assets[0];
    const files = routingFiles(dir);
    if (files.length > 0) {
      const old = new Map(m.assets.filter((a) => a.kind === 'routing').map((a) => [a.id, a]));
      const added = files.filter((f) => !old.has(f));
      if (added.length > 0 && !tag) throw new Error(`write-manifest: new routing files ${added.join(', ')} need --tag <release tag>`);
      m.assets = [...m.assets.filter((a) => a.kind !== 'routing'), ...files.map((f): MapAsset => old.get(f) ?? { id: f, repo: first?.repo ?? '', tag: tag as string, asset: f, kind: 'routing', bytes: -1, sha256: '' })];
    }
    for (const a of m.assets) {
      const f = path.join(dir, a.id);
      const bytes = statSync(f).size;
      if (bytes > SIZE_GATE_BYTES) throw new MapError('MAP_SIZE_GATE', a.id, `${bytes} bytes is over the ${SIZE_GATE_BYTES} byte gate (C6)`);
      const sha = sha256File(f);
      if (tag && (bytes !== a.bytes || sha !== a.sha256)) a.tag = tag;
      a.bytes = bytes;
      a.sha256 = sha;
      if (a.kind === 'pmtiles') {
        const h = readPmtilesHeader(f);
        a.bbox = h.bbox;
        a.minZoom = h.minZoom;
        a.maxZoom = h.maxZoom;
      }
    }
    writeFileSync(manifestFile, `${JSON.stringify(m, null, 2)}\n`);
    console.log(`maps: rewrote ${manifestFile} from ${dir}`);
  } else {
    console.error('usage: node packages/maps/src/cli.ts fetch|verify|legs|coverage|write-manifest [--dir <dir>] [--manifest <file>] [--no-routing] [--tag <tag>]');
    process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof MapError ? `map-manifest: STOP ${e.message}` : `maps: FAIL ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
