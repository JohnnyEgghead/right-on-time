// SPDX-License-Identifier: AGPL-3.0-or-later
// F-471: the photo volume's folder entries are flushed after the rename and after a new month folder, before the rows commit.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const opened: string[] = [];
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return { ...real, open: (async (p: string, ...rest: unknown[]) => { opened.push(String(p)); return (real.open as (...a: unknown[]) => Promise<unknown>)(p, ...rest); }) as typeof real.open };
});
const { writeBlobFile } = await import('./blob.ts');

let dir = '';
beforeEach(async () => {
  opened.length = 0;
  dir = await mkdtemp(path.join(tmpdir(), 'bw-blob-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('writeBlobFile durability', () => {
  // why: F-471
  it('opens, to flush, the month folder after the rename and the volume folder above a new month', async () => {
    await writeBlobFile(dir, '2026-11/abc', new Uint8Array([1, 2, 3]));
    expect(opened).toContain(path.join(dir, '2026-11'));
    expect(opened.filter((p) => p === dir)).toHaveLength(1);
    opened.length = 0;
    await writeBlobFile(dir, '2026-11/def', new Uint8Array([4]));
    expect(opened).not.toContain(dir);
    expect(opened).toContain(path.join(dir, '2026-11'));
  });
});
