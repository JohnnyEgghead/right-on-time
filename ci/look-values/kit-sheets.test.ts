// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: tooling
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareKitSheets } from './compare.ts';

// Browser-free: stays in the merge set (the unit-tests gate). The browser tests are compare.pw.test.ts.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'look-values-kit-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('compareKitSheets', () => {
  it('passes identical bytes and fails a 1-byte difference', () => {
    // reason: kit sheets are compared byte for byte, not by computed value
    const a = path.join(dir, 'a.css');
    const b = path.join(dir, 'b.css');
    const c = path.join(dir, 'c.css');
    writeFileSync(a, 'x{color:#000}\n');
    writeFileSync(b, 'x{color:#000}\n');
    writeFileSync(c, 'x{color:#001}\n');
    expect(compareKitSheets([{ app: a, kit: b }])).toEqual([]);
    expect(compareKitSheets([{ app: a, kit: c }])).toHaveLength(1);
    expect(compareKitSheets([{ app: a, kit: path.join(dir, 'missing.css') }])).toHaveLength(1);
  });
});
