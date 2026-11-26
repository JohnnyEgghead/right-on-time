// SPDX-License-Identifier: AGPL-3.0-or-later
// The one install path of gitleaks (P7-SCANS; NFR-14; SPECIFICATIONS section 3 tool table pins 8.30.1).
//   node ci/gitleaks/install.ts ensure [--dir <dir>]   prints the absolute path of a verified gitleaks 8.30.1 binary
//   node ci/gitleaks/install.ts pin                    prints the pinned version
// Every run of the scan (this Mac, the CI job container, the wave-run container) gets its binary here, from ci/gitleaks/pin.json:
// the release archive for this platform, accepted only when its SHA-256 equals the pinned value and when the unpacked binary
// answers `gitleaks version` with exactly the pinned version. A copy on PATH (a brew formula, a floating latest) is never used.
// The archive is fetched with node's fetch (the job image has node but neither gh nor curl) and unpacked with tar.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMain } from '../is-main.ts';

export interface Pin {
  version: string;
  urlBase: string;
  assets: Record<string, { name: string; sha256: string }>;
}

const here = import.meta.dirname;
const PIN_FILE = path.join(here, 'pin.json');
export const DEFAULT_DIR = path.resolve(here, '..', '..', '.build', 'tools');

export function loadPin(file = PIN_FILE): Pin {
  const p = JSON.parse(readFileSync(file, 'utf8')) as Pin;
  if (!/^\d+\.\d+\.\d+$/.test(p.version)) throw new Error(`gitleaks pin: version "${p.version}" is not an exact x.y.z`);
  for (const [k, a] of Object.entries(p.assets)) {
    if (!/^[0-9a-f]{64}$/.test(a.sha256)) throw new Error(`gitleaks pin: ${k} has no SHA-256`);
    if (!a.name.includes(p.version)) throw new Error(`gitleaks pin: ${k} names a file that is not version ${p.version}`);
  }
  return p;
}

/** The pin's key for this machine: darwin-arm64, darwin-x64, linux-arm64 or linux-x64. */
export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** Throws unless the bytes hash to the pinned value; the archive is never unpacked before this passes. */
export function verifyArchive(bytes: Uint8Array, want: string, name: string): void {
  const got = sha256Hex(bytes);
  if (got !== want) throw new Error(`gitleaks install: ${name} has SHA-256 ${got}, the pin says ${want}; nothing was installed`);
}

function versionOf(bin: string): string {
  const r = spawnSync(bin, ['version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

export async function ensure(opts: { dir?: string; pin?: Pin; key?: string; fetchBytes?: (url: string) => Promise<Uint8Array> } = {}): Promise<string> {
  const pin = opts.pin ?? loadPin();
  const key = opts.key ?? platformKey();
  const asset = pin.assets[key];
  if (!asset) throw new Error(`gitleaks install: no pinned archive for ${key} (pinned: ${Object.keys(pin.assets).join(', ')})`);
  const dir = path.join(opts.dir ?? DEFAULT_DIR, `gitleaks-${pin.version}-${key}`);
  const bin = path.join(dir, 'gitleaks');
  // A kept copy is trusted only after it answers the pinned version; the archive's hash was checked when it was put here.
  if (existsSync(bin) && versionOf(bin) === pin.version) return bin;
  const fetchBytes =
    opts.fetchBytes ??
    (async (url: string) => {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`gitleaks install: ${url} answered ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    });
  const bytes = await fetchBytes(pin.urlBase + asset.name);
  verifyArchive(bytes, asset.sha256, asset.name);
  mkdirSync(path.dirname(dir), { recursive: true });
  const stage = mkdtempSync(path.join(path.dirname(dir), '.stage-'));
  try {
    const tgz = path.join(stage, asset.name);
    writeFileSync(tgz, bytes);
    const x = spawnSync('tar', ['-xzf', tgz, '-C', stage, 'gitleaks'], { encoding: 'utf8' });
    if (x.status !== 0) throw new Error(`gitleaks install: tar failed: ${x.stderr.trim()}`);
    chmodSync(path.join(stage, 'gitleaks'), 0o755);
    const v = versionOf(path.join(stage, 'gitleaks'));
    if (v !== pin.version) throw new Error(`gitleaks install: the unpacked binary says "${v}", the pin says ${pin.version}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    renameSync(path.join(stage, 'gitleaks'), bin);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return bin;
}

if (isMain(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'pin') {
      console.log(loadPin().version);
    } else if (cmd === 'ensure') {
      const i = rest.indexOf('--dir');
      console.log(await ensure(i >= 0 ? { dir: path.resolve(rest[i + 1] ?? '') } : {}));
    } else {
      console.error('usage: node ci/gitleaks/install.ts ensure [--dir <dir>] | pin');
      process.exit(2);
    }
  } catch (e) {
    console.error(String((e as Error).message));
    process.exit(1);
  }
}
