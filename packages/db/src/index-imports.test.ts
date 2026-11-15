// SPDX-License-Identifier: AGPL-3.0-or-later
// F-216: the @bw/db index is imported at run time by the web process (the kernel, the handlers), from the app image,
// which carries packages/*/src but no ci/ file. So every module the index reaches must stay inside packages/: this test
// walks the relative imports from src/index.ts and fails on one that leaves them (the street-list loader's
// ci/data-assets.ts import was such a path).
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGES = path.resolve(import.meta.dirname, '..', '..');
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'";]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g;

function reachable(entry: string): { files: Set<string>; outside: string[] } {
  const files = new Set<string>();
  const outside: string[] = [];
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const target = path.resolve(path.dirname(file), m[1]!);
      if (!target.startsWith(PACKAGES + path.sep)) {
        outside.push(`${path.relative(PACKAGES, file)} -> ${m[1]}`);
        continue;
      }
      if (existsSync(target) && target.endsWith('.ts')) visit(target);
    }
  };
  visit(entry);
  return { files, outside };
}

describe('@bw/db index', () => {
  // why: F-216 a run-time import of @bw/db must not need a file the image lacks
  it('reaches no module outside packages/ through its relative imports', () => {
    const { files, outside } = reachable(path.join(import.meta.dirname, 'index.ts'));
    expect(outside).toEqual([]);
    expect(files.size).toBeGreaterThan(5); // the walk really followed the index
    expect([...files].some((f) => f.endsWith(`${path.sep}street-list.ts`))).toBe(false);
  });

  // why: F-185 the street-list loader (setup calls it) reaches no ci/ file: its verify half is packages/db/src/data-asset.ts
  it('walks the street-list loader and reaches no module outside packages/', () => {
    const { files, outside } = reachable(path.join(import.meta.dirname, 'street-list.ts'));
    expect(outside).toEqual([]);
    expect([...files].some((f) => f.endsWith(`${path.sep}data-asset.ts`))).toBe(true);
  });

  // why: F-216 the walk sees the path it guards against (a module importing a ci/ file)
  it('reports a module that imports a file outside packages/', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'idx-walk-'));
    const entry = path.join(dir, 'loader.ts');
    writeFileSync(entry, "import { x } from '../../../ci/data-assets.ts';\n");
    expect(reachable(entry).outside).toEqual([`${path.relative(PACKAGES, entry)} -> ../../../ci/data-assets.ts`]);
  });
});
