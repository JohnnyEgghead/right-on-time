// SPDX-License-Identifier: AGPL-3.0-or-later
// The verify half of the release-asset data files (design rule D7; F-164, F-185): the pinned manifest and the check that a
// file's size and SHA-256 equal it. Production code (the street-list loader, which setup calls) imports this module; it
// reads only its own manifest next to it, so it works wherever packages/db is shipped, with no ci/ file. The fetch half
// (gh and the REST API, the CLI) is ci/data-assets.ts, which imports from here.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

export interface DataAsset {
  id: string;
  repo: string;
  tag: string;
  asset: string;
  bytes: number;
  sha256: string;
  /**
   * The map manifest's kind (packages/maps/MANIFEST.json: pmtiles, tracks or routing). `routing` marks the routing service's files
   * (SPECIFICATIONS SD-49, 2.7 GB): ci/data-assets.ts fetches them only when asked (--with-routing), as `pnpm run setup:maps` does.
   */
  kind?: string;
}

/** The one committed source of each asset's repo, tag, name, size and SHA-256 (a new asset is a new entry). */
export const MANIFEST_FILE = path.join(import.meta.dirname, 'data-manifest.json');
/**
 * Where the verified copies live: .build/data at the tree's root (git-ignored), in a checkout and in the image alike
 * (the image's /app is the tree's root). F-237: the generator and setup read this default from here, never from ci/,
 * which the image does not ship; ci/data-assets.ts re-exports it as DEFAULT_DIR.
 */
export const DATA_DIR = path.resolve(import.meta.dirname, '..', '..', '..', '.build', 'data');
const ENSURE_CMD = 'node ci/data-assets.ts ensure';

export function loadManifest(file = MANIFEST_FILE): DataAsset[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { assets: DataAsset[] }).assets;
}

export function manifestAsset(id: string, file = MANIFEST_FILE): DataAsset {
  const a = loadManifest(file).find((x) => x.id === id);
  if (!a) throw new Error(`data asset ${id} is not in ${file}`);
  return a;
}

/**
 * The commands that fix a missing or bad file; named in every failure message. A copy kept outside the default folder
 * (the maps' folder) names that folder and manifest, so the hint clears the stop it was printed for (F-365).
 */
export function fixHint(a: DataAsset, where: { dir?: string; manifest?: string } = {}): string {
  const dir = where.dir && path.resolve(where.dir) !== path.resolve(DATA_DIR) ? where.dir : undefined;
  const flags = `${dir ? ` --dir ${JSON.stringify(dir)}` : ''}${where.manifest ? ` --manifest ${JSON.stringify(where.manifest)}` : ''}`;
  return `run \`${ENSURE_CMD}${flags}\` (it fetches and verifies), or by hand: gh release download ${a.tag} -R ${a.repo} -p ${a.asset} -D ${dir ? JSON.stringify(dir) : '.build/data'} --clobber`;
}

/** A hash mismatch, with the asset named for a caller to read (never scraped from the message; F-365). */
export class AssetMismatch extends Error {
  readonly assetId: string;
  constructor(assetId: string, message: string) {
    super(message);
    this.assetId = assetId;
  }
}

/** SHA-256 of a file, read in 1 MiB steps: a file past Node's 2 GiB readFileSync limit still hashes (F-365). */
function sha256OfFile(file: string): string {
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

/** Check size and SHA-256 of a file against the manifest entry, reading it in steps. Throws with the fix named. */
export function verifyAssetFile(a: DataAsset, file: string, where: { manifest?: string } = {}): void {
  const hint = fixHint(a, { dir: path.dirname(file), ...where });
  if (!existsSync(file)) throw new Error(`${a.id} not found at ${file}: ${hint}`);
  checkAsset(a, file, statSync(file).size, sha256OfFile(file), hint);
}

function checkAsset(a: DataAsset, file: string, bytes: number, got: string, hint: string): void {
  if (got !== a.sha256 || bytes !== a.bytes) {
    throw new AssetMismatch(a.id, `${a.id} at ${file} does not match the pinned release asset: sha256 mismatch (got ${got} with ${bytes} bytes, want ${a.sha256} with ${a.bytes} bytes); ${hint}`);
  }
}

/** The bytes of a file after checking size and SHA-256 against the manifest entry. Throws with the fix named. */
export function readVerifiedAsset(a: DataAsset, file: string): Buffer {
  // F-497: read once and hash those bytes, so the bytes returned are the bytes verified (a file replaced between 2 reads cannot slip through).
  const hint = fixHint(a, { dir: path.dirname(file) });
  if (!existsSync(file)) throw new Error(`${a.id} not found at ${file}: ${hint}`);
  const bytes = readFileSync(file);
  checkAsset(a, file, bytes.length, createHash('sha256').update(bytes).digest('hex'), hint);
  return bytes;
}

export function isVerified(a: DataAsset, file: string): boolean {
  try {
    verifyAssetFile(a, file);
    return true;
  } catch {
    return false;
  }
}
