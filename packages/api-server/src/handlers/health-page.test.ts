// SPDX-License-Identifier: AGPL-3.0-or-later
// The next backup and restore times of the System health page on the 2 DST days of 2026 (K-09.9; F-2009; invariant 4).
import { describe, expect, it } from 'vitest';
import { Temporal } from '@bw/time';
import { nextDaily, nextSunday } from './health-page.ts';

const at = (s: string) => Temporal.Instant.from(s);
const wall = (i: Temporal.Instant) => i.toZonedDateTimeISO('America/New_York').toString({ smallestUnit: 'minute' });

describe('the scheduled times on the DST days of 2026', () => {
  // why: F-2009 the restore test reads Sunday 4:00 AM New York on Mar 8 (spring forward) and Nov 1 (fall back), not an hour off (K-09.9)
  it('puts the weekly restore at 4:00 AM on Mar 8 and Nov 1, 2026', () => {
    expect(wall(nextSunday(at('2026-03-07T12:00:00Z')))).toBe('2026-03-08T04:00-04:00[America/New_York]');
    expect(wall(nextSunday(at('2026-10-31T12:00:00Z')))).toBe('2026-11-01T04:00-05:00[America/New_York]');
  });

  // why: F-2009 the nightly backup reads 2:30 AM New York on Nov 1, 2026 (the fall-back day) and on a plain day (K-09.9)
  it('puts the nightly backup at 2:30 AM on Nov 1, 2026 and on a plain day', () => {
    expect(wall(nextDaily(at('2026-11-01T03:00:00Z'), { hour: 2, minute: 30 }))).toBe('2026-11-01T02:30-05:00[America/New_York]');
    expect(wall(nextDaily(at('2026-09-15T12:00:00Z'), { hour: 2, minute: 30 }))).toBe('2026-09-16T02:30-04:00[America/New_York]');
  });
});
