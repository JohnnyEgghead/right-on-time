// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-17 (the reschedule page names the branch zone after a window, UD-15)
import { describe, expect, it } from 'vitest';
import { visitText, windowLabel, windowWords } from './api.ts';

const Z = '[America/New_York]';
const wire = (day: string, off: string, hhmm: string) => `${day}T${hhmm}:00${off}${Z}`;

describe('the reschedule page window label', () => {
  // why: FR-TEXT-17
  it('prints the zone after the window, and a window that spans noon keeps both meridiems', () => {
    expect(windowLabel(wire('2026-10-21', '-04:00', '10:00'), wire('2026-10-21', '-04:00', '14:00'))).toBe('10 AM-2 PM EDT');
    expect(windowLabel(wire('2026-10-21', '-04:00', '08:00'), wire('2026-10-21', '-04:00', '10:00'))).toBe('8-10 AM EDT');
    expect(windowLabel(wire('2026-11-10', '-05:00', '12:00'), wire('2026-11-10', '-05:00', '16:00'))).toBe('12-4 PM EST');
  });

  // why: FR-TEXT-17
  it('names the zone in the visit as the page prints it', () => {
    const t = ((key: string, v?: Record<string, string | number>) => (key === 'inbox.date' ? `${v!.weekday} ${v!.month} ${v!.day}` : key)) as never;
    expect(visitText('2026-10-20', wire('2026-10-20', '-04:00', '08:00'), wire('2026-10-20', '-04:00', '10:00'), t)).toMatch(/, 8-10 AM EDT$/);
  });
});

describe('the technician Today window words', () => {
  // why: F-1345 the Today frames (DK-107 to DK-109) draw a window with no zone; the zone belongs to the customer pages
  it('prints the window with no zone', () => {
    expect(windowWords(wire('2026-10-21', '-04:00', '10:00'), wire('2026-10-21', '-04:00', '14:00'))).toBe('10 AM-2 PM');
    expect(windowWords(wire('2026-11-10', '-05:00', '08:00'), wire('2026-11-10', '-05:00', '10:00'))).toBe('8-10 AM');
  });
});
