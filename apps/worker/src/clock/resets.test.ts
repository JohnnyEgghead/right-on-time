// SPDX-License-Identifier: AGPL-3.0-or-later
// The nightly reset's real-time rule (FR-DEMO-7: 3:00 AM Eastern time, every night) and the idle rule (FR-DEMO-6), with
// no database: 3:00 AM is computed in America/New_York with Temporal, so both daylight-saving nights are exact under
// any host zone (NFR-08).
import { describe, expect, it } from 'vitest';
import { Temporal } from '@bw/time';
import { idleDue, nightlyDue, nightlyInstant, NIGHTLY_WINDOW_MINUTES } from './resets.ts';

const I = (s: string) => Temporal.Instant.from(s);

describe('the nightly reset (FR-DEMO-7)', () => {
  // why: FR-DEMO-7, NFR-08
  it('falls at 3:00 AM America/New_York on ordinary nights and on both daylight-saving nights', () => {
    expect(nightlyInstant(I('2026-09-16T08:00:00Z')).toString()).toBe('2026-09-16T07:00:00Z'); // EDT
    expect(nightlyInstant(I('2026-11-01T12:00:00Z')).toString()).toBe('2026-11-01T08:00:00Z'); // the fall-back night: 3:00 AM EST
    expect(nightlyInstant(I('2027-03-14T12:00:00Z')).toString()).toBe('2027-03-14T07:00:00Z'); // the spring-forward night: 3:00 AM EDT
    // Before 3:00 AM the night is the previous date's.
    expect(nightlyInstant(I('2026-11-03T07:59:00Z')).toString()).toBe('2026-11-02T08:00:00Z');
  });

  // why: FR-DEMO-7
  it('is due from 3:00 AM for its window unless a reset already ran since that 3:00 AM', () => {
    const night = I('2026-11-03T08:00:00Z');
    const before = I('2026-11-02T20:00:00Z');
    expect(nightlyDue(before, night)).toBe(true);
    expect(nightlyDue(before, night.add({ minutes: NIGHTLY_WINDOW_MINUTES - 1 }))).toBe(true);
    expect(nightlyDue(before, night.add({ minutes: NIGHTLY_WINDOW_MINUTES }))).toBe(false); // a worker down all night does not reset at 9 AM
    expect(nightlyDue(before, night.subtract({ seconds: 1 }))).toBe(false);
    expect(nightlyDue(night.add({ minutes: 1 }), night.add({ minutes: 2 }))).toBe(false); // already reset tonight
  });
});

describe('the idle reset rule (FR-DEMO-6)', () => {
  // why: FR-DEMO-6
  it('is due 120 real minutes after the last write, only when a write came after the last reset', () => {
    const reset = new Date('2026-11-02T10:00:00Z');
    const write = new Date('2026-11-02T10:30:00Z');
    expect(idleDue({ lastResetReal: reset, lastWriteReal: write }, I('2026-11-02T12:29:59Z'), 120)).toBe(false);
    expect(idleDue({ lastResetReal: reset, lastWriteReal: write }, I('2026-11-02T12:30:00Z'), 120)).toBe(true);
    expect(idleDue({ lastResetReal: reset, lastWriteReal: reset }, I('2026-11-03T12:00:00Z'), 120)).toBe(false);
  });
});
