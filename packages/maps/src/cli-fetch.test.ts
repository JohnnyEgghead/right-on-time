// SPDX-License-Identifier: AGPL-3.0-or-later
// The `fetch` command where nothing can be fetched (the wave CI container: no gh, no token; F-361), on small planted files.
// A verified folder passes without fetching; a changed byte is a named MAP_HASH_MISMATCH stop, never "no way to fetch".
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { plantMaps } from './testing.ts';

const cli = path.resolve(import.meta.dirname, 'cli.ts');
let dir = '';
let manifestFile = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-maps-fetch-'));
  manifestFile = path.join(dir, 'manifest.json');
  writeFileSync(manifestFile, JSON.stringify(plantMaps(path.join(dir, 'maps'))));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fetchWithoutGh(): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [cli, 'fetch', '--dir', path.join(dir, 'maps'), '--manifest', manifestFile], {
    encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env['PATH'] ?? '', BW_GH: 'no-such-gh-binary' },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe('fetch that downloads the wrong bytes', () => {
  // why: F-365, F-493 the consumer of data-assets' MISMATCH line: a fake gh writes a wrong file, and the stop names it as MAP_HASH_MISMATCH from that line
  it('stops with MAP_HASH_MISMATCH naming the file the download got wrong', () => {
    const gh = path.join(dir, 'fake-gh');
    writeFileSync(gh, `#!/bin/sh
[ "$1" = "--version" ] && exit 0
while [ $# -gt 0 ]; do
  case "$1" in
    -p) asset="$2"; shift ;;
    -D) out="$2"; shift ;;
  esac
  shift
done
printf 'not the file' > "$out/$asset"
`);
    chmodSync(gh, 0o755);
    rmSync(path.join(dir, 'maps', 'columbus.pmtiles'));
    const r = spawnSync(process.execPath, [cli, 'fetch', '--dir', path.join(dir, 'maps'), '--manifest', manifestFile], {
      encoding: 'utf8', timeout: 60_000, env: { PATH: process.env['PATH'] ?? '', BW_GH: gh },
    });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('MAP_HASH_MISMATCH columbus.pmtiles');
    expect(r.stdout + r.stderr).toContain('the downloaded release asset differs from the committed manifest');
  });
});

describe('fetch with no gh and no token', () => {
  // why: F-361
  it('passes verified files without fetching anything', () => {
    const r = fetchWithoutGh();
    expect(r.out).toContain('already verified');
    expect(r.status).toBe(0);
  });

  // why: F-361
  it('stops on 1 changed byte with MAP_HASH_MISMATCH naming the file, exit 1', () => {
    const f = path.join(dir, 'maps', 'columbus.pmtiles');
    const b = readFileSync(f);
    b[b.length - 1] = (b[b.length - 1] as number) ^ 1;
    writeFileSync(f, b);
    const r = fetchWithoutGh();
    expect(r.status).toBe(1);
    expect(r.out).toContain('MAP_HASH_MISMATCH columbus.pmtiles');
  });

  // why: F-375
  it('keeps the real cause (no way to fetch) in front of the MAP_MISSING stop on an empty folder', () => {
    rmSync(path.join(dir, 'maps', 'columbus.pmtiles'));
    const r = fetchWithoutGh();
    expect(r.status).toBe(1);
    expect(r.out).toContain('no way to fetch it here');
    expect(r.out).toContain('MAP_MISSING columbus.pmtiles');
  });
});
