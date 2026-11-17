// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1876: the pnpm store folder public-copy-tests installs the export from, read out of a checkout's node_modules/.modules.yaml
// (pnpm writes it as JSON). Each way it can fail says its own true remedy; a parse failure is no longer reported as a missing key.
//   node ci/gates/public-copy-store.ts <path to .modules.yaml>
// Prints the storeDir and exits 0; on a failure it prints 1 line to stderr and exits 1 (no file), 3 (unreadable or not JSON) or 4 (no storeDir).
import { readFileSync } from 'node:fs';

export type StoreDir = { ok: true; storeDir: string } | { ok: false; code: 1 | 3 | 4; message: string };

export function readStoreDir(file: string): StoreDir {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { ok: false, code: 1, message: `no ${file} (install this checkout with pnpm install first)` };
    return { ok: false, code: 3, message: `could not read ${file} (${err.message})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: 3, message: `${file} is not JSON (${(e as Error).message}); pnpm may have changed its format, so this gate's reader needs updating, not a reinstall` };
  }
  const storeDir = (parsed as { storeDir?: unknown } | null)?.storeDir;
  if (typeof storeDir !== 'string' || storeDir === '') return { ok: false, code: 4, message: `no storeDir key in ${file} (install this checkout with pnpm install first)` };
  return { ok: true, storeDir };
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node ci/gates/public-copy-store.ts <path to .modules.yaml>');
    process.exit(2);
  }
  const r = readStoreDir(file);
  if (!r.ok) {
    console.error(r.message);
    process.exit(r.code);
  }
  process.stdout.write(r.storeDir);
}
