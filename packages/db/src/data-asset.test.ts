// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Count how many times the checked file is opened or read whole, to show the bytes returned are the bytes hashed.
const reads: string[] = [];
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: ((f: string, ...rest: unknown[]) => { reads.push(`read ${String(f)}`); return (fs.readFileSync as (...a: unknown[]) => unknown)(f, ...rest); }) as typeof fs.readFileSync,
    openSync: ((f: string, ...rest: unknown[]) => { reads.push(`open ${String(f)}`); return (fs.openSync as (...a: unknown[]) => unknown)(f, ...rest); }) as typeof fs.openSync,
  };
});

const { readVerifiedAsset } = await import('./data-asset.ts');

describe('readVerifiedAsset', () => {
  // why: F-497 the bytes returned are the bytes hashed: the file is read once, not hashed in steps and then read again
  it('reads the file once and returns the bytes it verified', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-asset-'));
    const file = path.join(dir, 'asset.bin');
    const body = Buffer.from('the bytes of a pinned asset');
    writeFileSync(file, body);
    const asset = { id: 'asset.bin', sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length } as unknown as Parameters<typeof readVerifiedAsset>[0];
    reads.length = 0;
    expect(readVerifiedAsset(asset, file).equals(body)).toBe(true);
    expect(reads.filter((r) => r.endsWith(file))).toEqual([`read ${file}`]);
    // a file whose bytes differ from the pin is refused, whatever its size
    writeFileSync(file, Buffer.from('another file, the same size!'));
    expect(() => readVerifiedAsset({ ...asset, bytes: 28 } as typeof asset, file)).toThrow(/sha256 mismatch/);
  });
});
