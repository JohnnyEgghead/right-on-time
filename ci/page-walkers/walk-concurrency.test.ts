// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: ruling Nov 10, 2026 item 4a (the page walk's concurrency is one named setting the pre-set rule can drop to 2)
import { describe, expect, it } from 'vitest';
import { WALK_CONCURRENCY, WALK_CONCURRENCY_MAX, walkConcurrency } from './walk-concurrency.ts';

describe('walkConcurrency', () => {
  // why: F-1358 (ruling Nov 10, 2026 item 4a) the walk runs 4 at a time by one named setting, so the pre-set rule has 1 number to change
  it('is the named setting, 4, when no override is given', () => {
    expect(WALK_CONCURRENCY).toBe(4);
    expect(walkConcurrency(undefined)).toBe(WALK_CONCURRENCY);
    expect(walkConcurrency('')).toBe(WALK_CONCURRENCY);
  });
  // why: F-1358 (ruling Nov 10, 2026 item 4a) a probe override outside 1 to 5 must be an error, never a silent default
  it('takes a probe override from 1 to the vitest default of 5, and refuses anything else', () => {
    expect(walkConcurrency('2')).toBe(2);
    expect(walkConcurrency(String(WALK_CONCURRENCY_MAX))).toBe(WALK_CONCURRENCY_MAX);
    for (const bad of ['0', '6', '2.5', 'four', '-1']) expect(() => walkConcurrency(bad)).toThrow(/BW_WALK_CONCURRENCY/);
  });
});
