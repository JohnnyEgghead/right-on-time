// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { capitalFirst, clockText, money, sameDay, shortName } from './format.ts';

describe('the billing pages\' text', () => {
  // why: FR-BILL-4
  it('writes the sample invoice total, a discount and zero as dollars and cents (SD-20)', () => {
    expect(money(13265)).toBe('$132.65');
    expect(money(-1335)).toBe('-$13.35');
    expect(money(0)).toBe('$0.00');
    expect(money(100000)).toBe('$1,000.00');
  });

  // why: FR-BILL-12
  it('names who sent a job again as first name and last initial', () => {
    expect(shortName('Keisha Thompson')).toBe('Keisha T.');
    expect(shortName('Dana')).toBe('Dana');
    expect(capitalFirst('boiler repair')).toBe('Boiler repair');
  });

  // why: FR-BILL-2
  it('writes a time in its own zone with AM and PM, and knows what "Today" is', () => {
    const doneAt = '2026-09-15T09:50:00-04:00[America/New_York]';
    expect(clockText(doneAt, 'en')).toBe('9:50 AM');
    expect(clockText(doneAt, 'es')).toBe('9:50 AM');
    expect(sameDay(doneAt, '2026-09-15T23:30:00-04:00[America/New_York]')).toBe(true);
    expect(sameDay(doneAt, '2026-09-16T00:10:00-04:00[America/New_York]')).toBe(false);
  });
});
