// SPDX-License-Identifier: AGPL-3.0-or-later
// The finish-lines validator (FR-BILL-3, D9; invariant 10): every finish path's 1 rule, pure.
import { describe, expect, it } from 'vitest';
import { finishLines, MAX_LABOR_MINUTES, MAX_PART_QUANTITY, storedFinishHasLines } from './finishLines.ts';

const SEEDED = new Set(['p-cap', 'p-filter']);
const seeded = (id: string) => SEEDED.has(id);

describe('finishLines', () => {
  // why: FR-BILL-3
  it('refuses a finish with neither parts nor No parts used, as parts_required', () => {
    expect(finishLines({ parts: [], noPartsUsed: false, laborMinutes: 65 }, seeded)).toEqual({
      ok: false, code: 'parts_required', field: 'parts', problem: 'neither_parts_nor_no_parts_used',
    });
  });

  // why: FR-BILL-3, FR-BILL-1
  it('accepts parts with quantities, and accepts No parts used with no parts', () => {
    expect(finishLines({ parts: [{ partId: 'p-cap', quantity: 1 }, { partId: 'p-filter', quantity: 2 }], noPartsUsed: false, laborMinutes: 129 }, seeded))
      .toEqual({ ok: true, lines: { parts: [{ partId: 'p-cap', quantity: 1 }, { partId: 'p-filter', quantity: 2 }], noPartsUsed: false, laborMinutes: 129 } });
    expect(finishLines({ parts: [], noPartsUsed: true, laborMinutes: 90 }, seeded))
      .toEqual({ ok: true, lines: { parts: [], noPartsUsed: true, laborMinutes: 90 } });
  });

  // why: FR-BILL-3
  it('refuses a part not on the seeded list, so a part not on the list cannot be entered', () => {
    const r = finishLines({ parts: [{ partId: 'typed-by-hand', quantity: 1 }], noPartsUsed: false, laborMinutes: 60 }, seeded);
    expect(r).toMatchObject({ ok: false, code: 'validation_failed', problem: 'part_not_on_list' });
  });

  // why: FR-BILL-3
  it('refuses parts together with No parts used, a part twice, a quantity below 1 or not whole, and bad labor', () => {
    const p = (quantity: number) => [{ partId: 'p-cap', quantity }];
    expect(finishLines({ parts: p(1), noPartsUsed: true, laborMinutes: 1 }, seeded)).toMatchObject({ code: 'validation_failed', problem: 'parts_and_no_parts_used' });
    expect(finishLines({ parts: [...p(1), ...p(2)], noPartsUsed: false, laborMinutes: 1 }, seeded)).toMatchObject({ problem: 'part_listed_twice' });
    for (const q of [0, -1, 1.5, Number.NaN, MAX_PART_QUANTITY + 1, 3_000_000_000]) {
      expect(finishLines({ parts: p(q), noPartsUsed: false, laborMinutes: 1 }, seeded)).toMatchObject({ problem: 'quantity_not_whole_at_least_1' });
    }
    for (const m of [-1, 2.5, MAX_LABOR_MINUTES + 1]) {
      expect(finishLines({ parts: p(1), noPartsUsed: false, laborMinutes: m }, seeded)).toMatchObject({ field: 'laborMinutes', problem: 'labor_not_whole_minutes' });
    }
  });

  // why: FR-BILL-3, invariant 10
  it('holds a stored finish to the same rule: parts rows or No parts used', () => {
    expect(storedFinishHasLines(0, false)).toBe(false);
    expect(storedFinishHasLines(0, true)).toBe(true);
    expect(storedFinishHasLines(2, false)).toBe(true);
  });
});
