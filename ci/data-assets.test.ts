// SPDX-License-Identifier: AGPL-3.0-or-later
// F-164: the shared fetch-and-verify step for release-asset data files (ci/data-assets.ts). Small stand-in assets in a temp dir.
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureAssets, FETCH_CAP_MS, fetchCapMsFor, fixHint, MIN_FETCH_BYTES_PER_S, readVerifiedAsset, verifyAssetFile, type DataAsset } from './data-assets.ts';

const SCRIPT = path.join(import.meta.dirname, 'data-assets.ts');
// F-1612: a base URL nothing listens on, so a test with no gh and no token never reaches the real github.com.
const DEAD_URL = 'http://127.0.0.1:1';
const BODY = Buffer.from('[{"name":"Abbey Church Road"}]\n');

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dataassets-'));
  const asset: DataAsset = { id: 'demo.json', repo: 'owner/repo', tag: 'demo-v1', asset: 'demo.json', bytes: BODY.length, sha256: createHash('sha256').update(BODY).digest('hex') };
  const manifest = path.join(dir, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ assets: [asset] }));
  return { dir, asset, manifest, file: path.join(dir, 'demo.json') };
}

// A child with no gh and no token: nothing can be fetched. BW_GH names a binary that does not exist, so the premise holds
// even where node and gh share a bin directory (Homebrew) and PATH holds node's own directory (F-187).
function runEnsure(f: ReturnType<typeof fixture>) {
  const env = { PATH: path.dirname(process.execPath), HOME: f.dir, BW_GH: 'no-such-gh-binary', BW_RELEASE_BASE_URL: DEAD_URL };
  return spawnSync(process.execPath, [SCRIPT, 'ensure', '--dir', f.dir, '--manifest', f.manifest], { encoding: 'utf8', env });
}

describe('data-assets verification', () => {
  // why: F-164 - a verified file passes and is not downloaded again
  it('passes a verified file and downloads nothing (exit 0, says already verified)', async () => {
    const f = fixture();
    writeFileSync(f.file, BODY);
    expect(readVerifiedAsset(f.asset, f.file).equals(BODY)).toBe(true);
    const run = runEnsure(f);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('already verified');
    expect(run.stdout).toContain('not downloading');
    const lines: string[] = [];
    await ensureAssets({ dir: f.dir, manifest: f.manifest, log: (s) => lines.push(s) });
    expect(lines.join('\n')).toContain('not downloading');
  });

  // why: F-195 - run through a symlinked path (macOS TMPDIR), the CLI must still run and print, never exit 0 silently
  it('runs when invoked through a symlinked script path', () => {
    const f = fixture();
    writeFileSync(f.file, BODY);
    const link = path.join(mkdtempSync(path.join(tmpdir(), 'dataassets-link-')), 'ci');
    symlinkSync(path.dirname(SCRIPT), link);
    const env = { PATH: path.dirname(process.execPath), HOME: f.dir };
    const run = spawnSync(process.execPath, [path.join(link, 'data-assets.ts'), 'ensure', '--dir', f.dir, '--manifest', f.manifest], { encoding: 'utf8', env });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('already verified');
  });

  // why: F-164 - a file with 1 byte changed must fail loudly, never be trusted
  it('fails a file with 1 byte changed, naming the sha256 mismatch and the fix command', () => {
    const f = fixture();
    const bad = Buffer.from(BODY);
    bad[3] = bad[3]! ^ 1;
    writeFileSync(f.file, bad);
    expect(() => readVerifiedAsset(f.asset, f.file)).toThrow(/sha256 mismatch.*node ci\/data-assets\.ts ensure/s);
    const run = runEnsure(f);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('no way to fetch');
    expect(readFileSync(f.file).equals(bad)).toBe(true);
  });

  // why: F-164 - an absent file with no gh and no token must fail, not skip, and name the command
  it('fails an absent file with no way to fetch it, naming the gh release download command', () => {
    const f = fixture();
    expect(() => readVerifiedAsset(f.asset, f.file)).toThrow(/not found.*node ci\/data-assets\.ts ensure/s);
    const run = runEnsure(f);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('FAIL');
    expect(run.stderr).toContain('gh release download demo-v1 -R owner/repo -p demo.json');
  });

  // why: FR-MAP-4 - the routing files (SD-49, 2.7 GB) are fetched only when asked, so a caller that starts no routing service downloads none
  it('passes over an absent routing file without --with-routing, and fetches it (here: fails, nothing to fetch with) with it', () => {
    const f = fixture();
    writeFileSync(f.file, BODY);
    const routing: DataAsset = { ...f.asset, id: 'ohio.osrm.mldgr', asset: 'ohio.osrm.mldgr', kind: 'routing' };
    writeFileSync(f.manifest, JSON.stringify({ assets: [f.asset, routing] }));
    const skip = runEnsure(f);
    expect(skip.status, skip.stderr).toBe(0);
    expect(skip.stdout).toContain('ohio.osrm.mldgr is a routing file (SD-49), not fetched or checked here (--with-routing fetches it)');
    const env = { PATH: path.dirname(process.execPath), HOME: f.dir, BW_GH: 'no-such-gh-binary', BW_RELEASE_BASE_URL: DEAD_URL };
    const asked = spawnSync(process.execPath, [SCRIPT, 'ensure', '--with-routing', '--dir', f.dir, '--manifest', f.manifest], { encoding: 'utf8', env });
    expect(asked.status).toBe(1);
    expect(asked.stderr).toContain('ohio.osrm.mldgr is missing or bad');
  });

  // why: F-1297 - the 672 MB routing file is not held to the 5-minute cap of the 88 MB set (it needed about 18 Mbit/s); the cap follows the bytes
  it('sizes the fetch cap by the asset bytes: 5 minutes for a small file, the time at 1 MiB/s for the 672 MB routing file', () => {
    const was = process.env['DATA_ASSETS_FETCH_CAP_MS'];
    delete process.env['DATA_ASSETS_FETCH_CAP_MS'];
    try {
      expect(fetchCapMsFor({ bytes: 88_000_000 })).toBe(FETCH_CAP_MS);
      const big = fetchCapMsFor({ bytes: 672_279_552 });
      expect(big).toBe(Math.ceil(672_279_552 / MIN_FETCH_BYTES_PER_S) * 1000);
      expect(big).toBeGreaterThan(2 * FETCH_CAP_MS);
      process.env['DATA_ASSETS_FETCH_CAP_MS'] = '1000';
      expect(fetchCapMsFor({ bytes: 672_279_552 })).toBe(1000);
    } finally {
      if (was === undefined) delete process.env['DATA_ASSETS_FETCH_CAP_MS'];
      else process.env['DATA_ASSETS_FETCH_CAP_MS'] = was;
    }
  });

  // why: F-186 - a stalled download must end RED under the cap, naming the cap, not hang the gate
  it('stops a stalled gh download at the cap and fails naming the cap', () => {
    const f = fixture();
    const bin = mkdtempSync(path.join(tmpdir(), 'fakegh-'));
    writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nexec sleep 30\n');
    chmodSync(path.join(bin, 'gh'), 0o755);
    const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/bin:/usr/bin`, HOME: f.dir, DATA_ASSETS_FETCH_CAP_MS: '1000' };
    const t0 = Date.now();
    const run = spawnSync(process.execPath, [SCRIPT, 'ensure', '--dir', f.dir, '--manifest', f.manifest], { encoding: 'utf8', env });
    expect(Date.now() - t0).toBeLessThan(20000);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/RED: fetching demo\.json exceeded the 1 s fetch cap/);
  });

  // why: F-365
  it('names the failing asset on a fixed MISMATCH line even when its path has a space, and the hint names that folder and manifest', () => {
    const f = fixture();
    const spaced = path.join(f.dir, 'my maps');
    mkdirSync(spaced);
    writeFileSync(path.join(spaced, 'demo.json'), Buffer.from('not the pinned bytes'));
    const env = { PATH: path.dirname(process.execPath), HOME: f.dir };
    const run = spawnSync(process.execPath, [SCRIPT, 'ensure', '--no-fetch', '--dir', spaced, '--manifest', f.manifest], { encoding: 'utf8', env });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^data-assets: MISMATCH demo\.json$/m);
    expect(run.stderr).toContain(`ensure --dir ${JSON.stringify(spaced)} --manifest ${JSON.stringify(f.manifest)}`);
    expect(fixHint(f.asset)).toContain('node ci/data-assets.ts ensure` (it fetches');
  });

  // why: F-365 a file is hashed in steps, so a size past readFileSync's limit is not a different code path
  it('verifies a file through the stepped hash (the same answer as the whole-file read)', () => {
    const f = fixture();
    writeFileSync(f.file, BODY);
    expect(() => verifyAssetFile(f.asset, f.file)).not.toThrow();
  });
});

describe('a public copy with no gh and no GitHub token (F-1612)', () => {
  const servers: Server[] = [];
  afterAll(() => { for (const x of servers) x.close(); });
  // A stand-in release host: the asset path answers a redirect to a storage path, as github.com does, and the storage path the bytes.
  const standIn = async (bytes: Buffer): Promise<string> => {
    const srv = createServer((req, res) => {
      if (req.url === '/owner/repo/releases/download/demo-v1/demo.json') { res.writeHead(302, { location: '/storage/abc' }).end(); return; }
      if (req.url === '/storage/abc') { res.writeHead(200).end(bytes); return; }
      res.writeHead(404).end();
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  };
  // Async, so this process's stand-in server answers while the child runs (spawnSync would block it).
  const tokenless = (f: ReturnType<typeof fixture>, base: string) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [SCRIPT, 'ensure', '--dir', f.dir, '--manifest', f.manifest], {
      encoding: 'utf8', env: { PATH: path.dirname(process.execPath), HOME: f.dir, BW_GH: 'no-such-gh-binary', BW_RELEASE_BASE_URL: base },
    }, (err, stdout, stderr) => resolve({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });

  // why: F-1612 (a copy with no gh and no token downloads from the public release URL and verifies the bytes)
  it('fetches the asset from the release URL with no token and keeps it verified', async () => {
    const f = fixture();
    const run = await tokenless(f, await standIn(BODY));
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('fetched with public release URL and verified');
    expect(readFileSync(f.file).equals(BODY)).toBe(true);
  });

  // why: F-1612 (the public download is checked against the manifest hash like every other way: wrong bytes are never kept)
  it('refuses bytes that do not match the manifest from the release URL and keeps no copy', async () => {
    const f = fixture();
    const run = await tokenless(f, await standIn(Buffer.from('some other bytes entirely')));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('FAIL');
    expect(existsSync(f.file)).toBe(false);
  });
});
