// SPDX-License-Identifier: AGPL-3.0-or-later
// The setup stack suite's number check without a stack: the range FR-IMP-7 sets and the branch office exception.
import { describe, expect, it } from 'vitest';
import { outsideRange } from './check.ts';

const OFFICES = new Set(['(614) 555-0100', '(937) 555-0101', '(937) 555-0102']);

describe('setup-stack number check (FR-DISP-20, FR-IMP-7)', () => {
  // why: FR-DISP-20, FR-IMP-7
  it('passes numbers in 555-0100 to 555-0199 in either stored form, and a branch office number', () => {
    expect(outsideRange(['+16145550132', '+19375550199', '(614) 555-0121', '(937) 555-0101'], OFFICES)).toEqual([]);
  });

  // why: FR-DISP-20, FR-IMP-7
  it('fails a planted 555-0200, a real-looking number and another area code (known-bads)', () => {
    expect(outsideRange(['+16145550200', '(614) 867-5309', '+12125550150', '(614) 555-0150'], OFFICES)).toEqual(['+16145550200', '(614) 867-5309', '+12125550150']);
  });
});
