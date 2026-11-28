// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: SD-40 (forward-only migrations: how the runner reads its files; the database behavior is migrate.db.test.ts)
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations } from './migrate.ts';

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
const tmp = (files: Record<string, string>) => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'bw-load-'));
  for (const [n, s] of Object.entries(files)) writeFileSync(path.join(dir, n), s);
  return dir;
};

describe('loadMigrations', () => {
  it('reads the committed files in version order, each with its sha-256', () => {
    const m = loadMigrations();
    expect(m.map((x) => x.version)).toEqual(['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008', '0009', '0010', '0011', '0012', '0013', '0014', '0015', '0016', '0017', '0018', '0019', '0020', '0021', '0022', '0023', '0024', '0025']);
    expect(m.every((x) => x.sha256.length === 32 && x.sql.includes('Forward-only'))).toBe(true);
  });

  it('refuses a misnamed file and 2 files of 1 version', () => {
    expect(() => loadMigrations(tmp({ '1_bad.sql': '' }))).toThrow(/not named NNNN_lower_snake.sql/);
    expect(() => loadMigrations(tmp({ '0001_a.sql': '', '0001_b.sql': '' }))).toThrow(/share version 0001/);
  });

  it('ignores files that are not .sql', () => {
    expect(loadMigrations(tmp({ '0001_a.sql': 'SELECT 1;', 'README.md': 'x' })).map((x) => x.name)).toEqual(['a']);
  });
});
