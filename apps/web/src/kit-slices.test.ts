// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { anchors, cut, KIT_DIR, NATIVE_ONLY, SLICES, slices } from './kit-slices.ts';

const kit = readFileSync(path.join(KIT_DIR, 'kit.css'), 'utf8');
const repo = path.resolve(import.meta.dirname, '../../..');
// F-1852: docs/design/ is a private path (scripts/private-paths.txt), so in a public copy the byte-identity test skips with a note
// naming it; the private checkout has it and the test runs. The slice tests read only the copied sheets.
const noKit = existsSync(path.join(repo, 'docs/design/kit.css')) ? '' : 'docs/design/kit.css is not in this copy (a private path the public export leaves out)';

describe('the copied kit sheets', () => {
  // why: FR-DEMO-1 the shell renders from the kit sheets copied byte-identical (P2-SHELL look clause)
  it('are byte-identical to docs/design', (ctx) => {
    if (noKit) ctx.skip(noKit);
    expect(readFileSync(path.join(KIT_DIR, 'kit.css')).equals(readFileSync(path.join(repo, 'docs/design/kit.css')))).toBe(true);
    expect(readFileSync(path.join(KIT_DIR, 'tokens/brand.css')).equals(readFileSync(path.join(repo, 'docs/design/tokens/brand.css')))).toBe(true);
  });

  // why: FR-DEMO-1 a page loads only the kit sections its frames load (UI-DESIGN-KIT 0.1), never a re-derived value
  it('are cut into slices that are exact byte ranges of kit.css, covering every section once', () => {
    for (const s of SLICES) expect(readFileSync(path.join(KIT_DIR, s.file), 'utf8'), s.file).toBe(cut(kit, s.from, s.to));
    const all = [...SLICES.map((s) => [s.from, s.to] as const), [NATIVE_ONLY.from, NATIVE_ONLY.to] as const].sort((a, b) => a[0] - b[0]);
    expect(all.map(([a, b]) => cut(kit, a, b)).join('')).toBe(kit);
    expect(anchors(kit).map((a) => a.dk)).toEqual(Array.from({ length: 62 }, (_, i) => i + 7));
  });

  // why: FR-DEMO-1 the slice check is not vacuous
  it('a 1-byte edit to a slice is caught', () => {
    const want = slices(kit)['kit.r1-shr.css']!;
    expect(want.replace('600px', '602px')).not.toBe(cut(kit, 48, 48));
  });
});
