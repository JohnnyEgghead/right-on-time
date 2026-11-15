// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-409
// The content key of the wave run's prebuilt CI image (owner ruling ffd9f9ff, F-409), and the build context for it.
//   node ci/wave-image-key.ts key   <root> --base <image> --apt <pins> --pnpm <version>   print the key
//   node ci/wave-image-key.ts stage <root> <dest>                                          copy the build context
// <root> is the clean export of the sha being checked. The key is a sha256 over every input that shapes the image:
//   base image reference (carries its digest), the apt package list, the pnpm version, the Playwright version
//   (root package.json), pnpm-lock.yaml, pnpm-workspace.yaml, .node-version, every workspace package.json, and the
//   image recipe (ci/wave-image/Dockerfile and this script). Any one changing yields a new key, so a stale image is
//   never selected: the image tag IS the key. `stage` copies exactly the files the key covers (plus the Dockerfile),
//   so the build context cannot hold an input the key does not hash.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isMain } from './is-main.ts';

export interface KeyInputs {
  base: string;
  apt: string;
  pnpm: string;
}

const RECIPE = ['ci/wave-image/Dockerfile', 'ci/wave-image-key.ts'];
const FIXED = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.node-version', 'package.json'];

/** The workspace package.json files, from the 'dir/*' globs of pnpm-workspace.yaml (sorted, relative). */
export function workspacePackageJsons(root: string): string[] {
  const ws = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  const dirs: string[] = [];
  for (const m of ws.matchAll(/^\s*-\s*['"]?([\w.-]+)\/\*['"]?\s*$/gm)) dirs.push(m[1]!);
  if (dirs.length === 0) throw new Error('pnpm-workspace.yaml names no dir/* package glob');
  const out: string[] = [];
  for (const d of dirs) {
    const base = path.join(root, d);
    if (!existsSync(base)) continue;
    for (const e of readdirSync(base).sort()) {
      const rel = `${d}/${e}/package.json`;
      if (statSync(path.join(base, e)).isDirectory() && existsSync(path.join(root, rel))) out.push(rel);
    }
  }
  return out;
}

/** Every file the key hashes and the build copies, relative to root. */
export function keyFiles(root: string): string[] {
  return [...FIXED, ...workspacePackageJsons(root), ...RECIPE];
}

export function playwrightVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const v = pkg.devDependencies?.playwright ?? pkg.dependencies?.playwright;
  if (!v) throw new Error('root package.json does not pin playwright');
  return v;
}

export function computeKey(root: string, inputs: KeyInputs): string {
  const h = createHash('sha256');
  const put = (label: string, body: string | Buffer) => {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
    h.update(`${label}\0${b.length}\0`);
    h.update(b);
    h.update('\0');
  };
  put('base', inputs.base);
  put('apt', inputs.apt);
  put('pnpm', inputs.pnpm);
  put('playwright', playwrightVersion(root));
  for (const rel of keyFiles(root)) put(`file:${rel}`, readFileSync(path.join(root, rel)));
  return h.digest('hex').slice(0, 20);
}

export function stage(root: string, dest: string): void {
  for (const rel of keyFiles(root)) {
    const to = path.join(dest, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(path.join(root, rel), to);
  }
}

function flag(args: string[], name: string): string {
  const i = args.indexOf(name);
  const v = i >= 0 ? args[i + 1] : undefined;
  if (v === undefined) throw new Error(`missing ${name}`);
  return v;
}

if (isMain(import.meta.url)) {
  const [cmd, root, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'key' && root) {
      console.log(computeKey(root, { base: flag(rest, '--base'), apt: flag(rest, '--apt'), pnpm: flag(rest, '--pnpm') }));
    } else if (cmd === 'stage' && root && rest[0]) {
      stage(root, rest[0]);
    } else {
      console.error('usage: wave-image-key.ts key <root> --base <image> --apt <pins> --pnpm <ver> | stage <root> <dest>');
      process.exit(2);
    }
  } catch (e) {
    console.error(`wave-image-key: ${(e as Error).message}`);
    process.exit(1);
  }
}
