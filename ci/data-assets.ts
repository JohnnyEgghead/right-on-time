// SPDX-License-Identifier: AGPL-3.0-or-later
// Release-asset data files for CI and tests (design rule D7; F-164). One shared fetch-and-verify step:
//   node ci/data-assets.ts ensure [--no-fetch] [--with-routing] [--dir <dir>] [--manifest <file>]
// Reads every asset's repo, tag, name, size and SHA-256 from packages/db/src/data-manifest.json (the one committed source).
// A copy in <dir> (default .build/data) that already verifies is kept: nothing is downloaded. Otherwise the asset is
// downloaded with `gh release download` when gh is on PATH, else through the GitHub REST API with GITHUB_TOKEN or
// GH_TOKEN (node fetch; the job image has node but neither gh nor curl), verified, and only then moved into place.
// F-1612: a copy with no gh and no token (a public copy) downloads from the public release URL
// (<BW_RELEASE_BASE_URL, default https://github.com>/<repo>/releases/download/<tag>/<asset>), which needs no login.
// A missing or mismatched file fails with a message that names the fix. A token is never printed.
// P6-ROUTE-BAKE: an asset of kind `routing` (the routing service's files, SPECIFICATIONS SD-49; 2.7 GB in all) is fetched only with
// --with-routing (`pnpm run setup:maps` passes it); without it each is skipped with 1 line, so a caller that starts no routing
// service (the push run) downloads none of it. The REST download streams to the file, so a file of up to the 2 GiB gate never
// sits in memory whole.
import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AssetMismatch, DATA_DIR, fixHint, isVerified, loadManifest, MANIFEST_FILE, verifyAssetFile, type DataAsset } from '../packages/db/src/data-asset.ts';
import { isMain } from './is-main.ts';

export const DEFAULT_MANIFEST = MANIFEST_FILE;
// The verify half (the manifest, readVerifiedAsset) lives in @bw/db, which production code imports (F-185); re-exported for the CI importers.
export { fixHint, isVerified, loadManifest, manifestAsset, readVerifiedAsset, verifyAssetFile, type DataAsset } from '../packages/db/src/data-asset.ts';
export const DEFAULT_DIR = DATA_DIR; // F-237: the 1 definition is in @bw/db's data-asset.ts (<tree root>/.build/data)
// F-186: wall-clock cap on one asset fetch (a measured green fetch of the 88 MB map set takes about 2 s). A stall fails RED naming the cap.
// F-1297: the cap grows with the asset's size, so the 672 MB routing file is not held to a rate of 18 Mbit/s: 5 minutes, or the time the
// asset's bytes take at MIN_FETCH_BYTES_PER_S (1 MiB/s, about 8 Mbit/s), whichever is longer. DATA_ASSETS_FETCH_CAP_MS sets it outright.
export const FETCH_CAP_MS = 5 * 60 * 1000;
export const MIN_FETCH_BYTES_PER_S = 1024 * 1024;
export const fetchCapMsFor = (a: Pick<DataAsset, 'bytes'>): number => Number(process.env['DATA_ASSETS_FETCH_CAP_MS']) || Math.max(FETCH_CAP_MS, Math.ceil(a.bytes / MIN_FETCH_BYTES_PER_S) * 1000);
const fetchCapMs = fetchCapMsFor;
const capMessage = (a: DataAsset, ms: number): string => `RED: fetching ${a.id} exceeded the ${ms / 1000} s fetch cap (DATA_ASSETS_FETCH_CAP_MS) and was stopped; check the network, then ${fixHint(a)}`;

async function downloadWithRest(a: DataAsset, token: string, dest: string): Promise<void> {
  const api = (p: string, accept: string) => fetch(`https://api.github.com/repos/${a.repo}/${p}`, { headers: { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'brightwater-ci' }, redirect: 'follow', signal: AbortSignal.timeout(fetchCapMs(a)) });
  const rel = await api(`releases/tags/${a.tag}`, 'application/vnd.github+json');
  if (!rel.ok) throw new Error(`GitHub API answered ${rel.status} for release ${a.tag} of ${a.repo}`);
  const found = ((await rel.json()) as { assets: { id: number; name: string }[] }).assets.find((x) => x.name === a.asset);
  if (!found) throw new Error(`release ${a.tag} of ${a.repo} has no asset ${a.asset}`);
  const bin = await api(`releases/assets/${found.id}`, 'application/octet-stream');
  if (!bin.ok || !bin.body) throw new Error(`GitHub API answered ${bin.status} for asset ${a.asset}`);
  await pipeline(Readable.fromWeb(bin.body as WebReadableStream<Uint8Array>), createWriteStream(dest));
}

async function downloadWithRestCapped(a: DataAsset, token: string, dest: string): Promise<void> {
  try {
    await downloadWithRest(a, token, dest);
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(capMessage(a, fetchCapMs(a)));
    throw e;
  }
}

/** F-1612: the public release download URL of an asset; BW_RELEASE_BASE_URL stands in for github.com in a test. */
export const publicReleaseUrl = (a: DataAsset): string => `${(process.env['BW_RELEASE_BASE_URL'] || 'https://github.com').replace(/\/+$/, '')}/${a.repo}/releases/download/${encodeURIComponent(a.tag)}/${encodeURIComponent(a.asset)}`;

async function downloadPublic(a: DataAsset, dest: string): Promise<void> {
  try {
    const res = await fetch(publicReleaseUrl(a), { headers: { 'User-Agent': 'brightwater-ci' }, redirect: 'follow', signal: AbortSignal.timeout(fetchCapMs(a)) });
    if (!res.ok || !res.body) throw new Error(`the public release URL answered ${res.status} for ${a.asset} of ${a.repo} ${a.tag}`);
    await pipeline(Readable.fromWeb(res.body as WebReadableStream<Uint8Array>), createWriteStream(dest));
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(capMessage(a, fetchCapMs(a)));
    throw e;
  }
}

// F-187: BW_GH names the gh binary (default gh). A test sets it to a missing name to prove the no-gh path on a machine
// where node and gh share a bin directory (Homebrew).
const ghBin = (): string => process.env['BW_GH'] || 'gh';

function ghOnPath(): boolean {
  return spawnSync(ghBin(), ['--version'], { stdio: 'ignore' }).status === 0;
}

/** The public download; a failure says there is no way to fetch it here and names the fix. */
async function downloadPublicOrExplain(a: DataAsset, dest: string, dir: string, manifest: string | undefined, why: string): Promise<void> {
  try {
    await downloadPublic(a, dest);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith('RED:')) throw e;
    throw new Error(`${a.id} is missing or bad and there is no way to fetch it here (${why}; ${msg}): on a machine with gh, ${fixHint(a, { dir, ...(manifest ? { manifest } : {}) })}`);
  }
}

/** Download the asset into a scratch dir, verify, then move it into dir. Returns which way it was fetched. */
async function fetchAsset(a: DataAsset, dir: string, manifest?: string): Promise<string> {
  const token = process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN'];
  const useGh = ghOnPath();
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(path.join(dir, '.fetch-'));
  try {
    const part = path.join(tmp, a.asset);
    let how = 'GitHub REST API';
    if (useGh) {
      const r = spawnSync(ghBin(), ['release', 'download', a.tag, '-R', a.repo, '-p', a.asset, '-D', tmp, '--clobber'], { encoding: 'utf8', timeout: fetchCapMs(a), killSignal: 'SIGKILL' });
      if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new Error(capMessage(a, fetchCapMs(a)));
      how = 'gh release download';
      // gh without a login cannot download; with no token to try, the public URL is the way left.
      if (r.status !== 0 && !token) {
        how = 'public release URL';
        await downloadPublicOrExplain(a, part, dir, manifest, `gh release download failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
      } else if (r.status !== 0) throw new Error(`gh release download failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
    } else if (token) {
      await downloadWithRestCapped(a, token, part);
    } else {
      how = 'public release URL';
      await downloadPublicOrExplain(a, part, dir, manifest, 'gh is not on PATH; GITHUB_TOKEN and GH_TOKEN are not set');
    }
    verifyAssetFile(a, part, manifest ? { manifest } : {});
    renameSync(part, path.join(dir, a.id));
    return how;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Make sure dir holds a verified copy of every asset. Logs one line per asset. Throws on the first failure. */
export async function ensureAssets(opts: { dir?: string; manifest?: string; noFetch?: boolean; withRouting?: boolean; log?: (s: string) => void } = {}): Promise<void> {
  const dir = opts.dir ?? DEFAULT_DIR;
  const log = opts.log ?? ((s: string) => console.log(s));
  for (const a of loadManifest(opts.manifest)) {
    const file = path.join(dir, a.id);
    if (a.kind === 'routing' && !opts.withRouting) {
      log(`data-assets: ${a.id} is a routing file (SD-49), not fetched or checked here (--with-routing fetches it)`);
      continue;
    }
    if (isVerified(a, file)) {
      log(`data-assets: ${a.id} already verified at ${file} (sha256 ${a.sha256.slice(0, 12)}), not downloading`);
      continue;
    }
    if (opts.noFetch) verifyAssetFile(a, file, opts.manifest ? { manifest: opts.manifest } : {});
    if (existsSync(file)) log(`data-assets: ${a.id} at ${file} failed verification, fetching a fresh copy`);
    const how = await fetchAsset(a, dir, opts.manifest);
    log(`data-assets: ${a.id} fetched with ${how} and verified (sha256 ${a.sha256.slice(0, 12)}, ${a.bytes} bytes) into ${file}`);
  }
}

// F-195, F-196: isMain compares real paths, so a symlinked argv[1] still runs the CLI.
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  if (args[0] !== 'ensure') {
    console.error('usage: node ci/data-assets.ts ensure [--no-fetch] [--with-routing] [--dir <dir>] [--manifest <file>]');
    process.exit(2);
  }
  const dir = val('--dir');
  const manifest = val('--manifest');
  ensureAssets({ ...(dir ? { dir } : {}), ...(manifest ? { manifest } : {}), noFetch: args.includes('--no-fetch'), withRouting: args.includes('--with-routing') }).catch((e: unknown) => {
    console.error(`data-assets: FAIL ${e instanceof Error ? e.message : String(e)}`);
    // One fixed line for a caller to read (packages/maps names MAP_HASH_MISMATCH from it), not a scraped message (F-365).
    if (e instanceof AssetMismatch) console.error(`data-assets: MISMATCH ${e.assetId}`);
    process.exit(1);
  });
}
