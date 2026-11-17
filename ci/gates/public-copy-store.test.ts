// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readStoreDir } from './public-copy-store.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'bw-store-dir-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const put = (name: string, body: string): string => {
  const f = path.join(dir, name);
  writeFileSync(f, body);
  return f;
};

describe('public-copy-tests store folder reader', () => {
  // why: F-1876 a good file gives its storeDir
  it('reads storeDir from the JSON pnpm writes', () => {
    expect(readStoreDir(put('good.yaml', '{"storeDir":"/root/.pnpm-store/v11","layoutVersion":5}'))).toEqual({ ok: true, storeDir: '/root/.pnpm-store/v11' });
  });

  // why: F-1876 the 3 failures say different, true things: a missing file asks for an install, a parse failure does not, a missing key asks for an install
  it('says a different thing for a missing file, a parse failure and a missing key', () => {
    const missing = readStoreDir(path.join(dir, 'none.yaml'));
    const broken = readStoreDir(put('yaml.yaml', 'storeDir: /x\nlayoutVersion: 5\n'));
    const keyless = readStoreDir(put('keyless.yaml', '{"layoutVersion":5}'));
    expect([missing.ok, broken.ok, keyless.ok]).toEqual([false, false, false]);
    if (missing.ok || broken.ok || keyless.ok) return;
    expect([missing.code, broken.code, keyless.code]).toEqual([1, 3, 4]);
    expect(missing.message).toContain('pnpm install first');
    expect(broken.message).toContain('is not JSON');
    expect(broken.message).not.toContain('pnpm install first');
    expect(keyless.message).toContain('no storeDir key');
    expect(keyless.message).not.toContain('is not JSON');
  });

  // why: F-1876 the command line keeps stderr and the exit code the shell gate reads
  it('prints the parse failure on stderr with exit 3 from the command line', () => {
    const f = put('cli.yaml', 'not json');
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, 'public-copy-store.ts'), f], { encoding: 'utf8' });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('is not JSON');
    const ok = execFileSync(process.execPath, [path.join(import.meta.dirname, 'public-copy-store.ts'), put('cli-ok.yaml', '{"storeDir":"/s"}')], { encoding: 'utf8' });
    expect(ok).toBe('/s');
  });
});
