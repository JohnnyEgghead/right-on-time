// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { safeReturn } from './return-path.ts';

describe('the page a person returns to after signing in', () => {
  // why: FR-AUTH-1 the sign-in never sends a person to another origin: only a path on this origin is kept
  it('keeps a path on this origin and drops anything else', () => {
    expect(safeReturn('/office/board')).toBe('/office/board');
    expect(safeReturn('/office/jobs?branch=columbus&date=2026-09-15')).toBe('/office/jobs?branch=columbus&date=2026-09-15');
    for (const bad of [null, undefined, '', 'office/board', '//evil.example/x', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '/a b']) {
      expect(safeReturn(bad), String(bad)).toBeNull();
    }
  });
});
