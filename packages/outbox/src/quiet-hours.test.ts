// SPDX-License-Identifier: AGPL-3.0-or-later
// Quiet hours and the try schedule as pure rules (FR-TEXT-7, FR-TEXT-12, NFR-08; invariant 9). Every expected instant
// is written as UTC, so a wrong offset shows up as a wrong hour. The merge set runs this file under the runner's zone,
// G-CI4 under its 3 host zones, and G-CI9 under NFR-08's matrix with the database cases beside it.
import { describe, expect, it } from 'vitest';
import { Temporal } from '@bw/time';
import { isQuietHoursExempt, MAX_TRIES, QUIET_HOURS_EXEMPT_KINDS, TEXT_KINDS, TRY_OFFSETS_MINUTES } from './model.ts';
import { inQuietHours, plannedTries, plannedTryAt, releaseTime } from './quiet-hours.ts';

const I = (s: string) => Temporal.Instant.from(s);
const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
const PHX = 'America/Phoenix';

describe('quiet hours, 9:00 PM to 8:00 AM in the customer zone (FR-TEXT-7)', () => {
  // why: UC-14
  it('holds Deborah Lin\'s 10:29 AM EDT booking text (7:29 AM Pacific) to 8:00 AM Pacific, 11:00 AM EDT', () => {
    const due = I('2026-09-15T14:29:00Z');
    expect(inQuietHours(due, LA)).toBe(true);
    expect(inQuietHours(due, NY)).toBe(false);
    expect(releaseTime(due, LA).toString()).toBe('2026-09-15T15:00:00Z');
  });

  // why: FR-TEXT-7
  it('is quiet from 9:00 PM exactly and not quiet from 8:00 AM exactly', () => {
    expect(inQuietHours(I('2026-09-16T00:59:59Z'), NY)).toBe(false); // 8:59:59 PM EDT
    expect(inQuietHours(I('2026-09-16T01:00:00Z'), NY)).toBe(true); // 9:00 PM EDT
    expect(inQuietHours(I('2026-09-16T11:59:59Z'), NY)).toBe(true); // 7:59:59 AM EDT
    expect(inQuietHours(I('2026-09-16T12:00:00Z'), NY)).toBe(false); // 8:00 AM EDT
    expect(releaseTime(I('2026-09-16T01:00:00Z'), NY).toString()).toBe('2026-09-16T12:00:00Z');
    expect(releaseTime(I('2026-09-16T12:00:00Z'), NY).toString()).toBe('2026-09-16T12:00:00Z');
  });

  // why: NFR-08
  it('holds a 7:30 AM EST text on Mon, Nov 2, 2026 to 8:00 AM EST', () => {
    expect(releaseTime(I('2026-11-02T12:30:00Z'), NY).toString()).toBe('2026-11-02T13:00:00Z');
  });

  // why: NFR-08
  it('releases a 10:00 PM EDT text of Sat, Oct 31 at 8:00 AM EST on Sun, Nov 1 (the fall-back night is 25 hours)', () => {
    expect(releaseTime(I('2026-11-01T02:00:00Z'), NY).toString()).toBe('2026-11-01T13:00:00Z');
  });

  // why: NFR-08
  it('releases a 10:00 PM EST text of Sat, Mar 13, 2027 at 8:00 AM EDT on Sun, Mar 14 (the spring-forward night is 23 hours)', () => {
    expect(releaseTime(I('2027-03-14T03:00:00Z'), NY).toString()).toBe('2027-03-14T12:00:00Z');
  });

  // why: NFR-08
  it('keeps America/Phoenix at UTC-7 on both sides of the change (the control)', () => {
    expect(releaseTime(I('2026-11-01T05:00:00Z'), PHX).toString()).toBe('2026-11-01T15:00:00Z'); // 10 PM Oct 31 MST
    expect(releaseTime(I('2027-03-14T05:00:00Z'), PHX).toString()).toBe('2027-03-14T15:00:00Z');
  });
});

describe('the try schedule (FR-TEXT-12)', () => {
  // why: FR-TEXT-12
  it('plans tries 1 to 5 at about 0, 2, 4, 9 and 19 minutes and has no 6th', () => {
    const first = I('2026-09-15T14:00:00Z');
    expect([1, 2, 3, 4, 5].map((n) => plannedTryAt(first, n, NY).toString())).toEqual([
      '2026-09-15T14:00:00Z', '2026-09-15T14:02:00Z', '2026-09-15T14:04:00Z', '2026-09-15T14:09:00Z', '2026-09-15T14:19:00Z',
    ]);
    expect(MAX_TRIES).toBe(5);
    expect(TRY_OFFSETS_MINUTES).toEqual([0, 2, 4, 9, 19]);
    expect(() => plannedTryAt(first, 6, NY)).toThrow(RangeError);
  });

  // why: FR-TEXT-7
  it('pushes a retry that lands in quiet hours to 8:00 AM in the customer zone', () => {
    const first = I('2026-09-16T00:50:00Z'); // 8:50 PM EDT
    expect(plannedTries(first, 1, NY).map((t) => [t.number, t.at.toString()])).toEqual([
      [2, '2026-09-16T00:52:00Z'],
      [3, '2026-09-16T00:54:00Z'],
      [4, '2026-09-16T00:59:00Z'],
      [5, '2026-09-16T12:00:00Z'], // 9:09 PM would be quiet
    ]);
    expect(plannedTries(first, 5, NY)).toEqual([]);
  });

  // why: FR-TEXT-7, FR-TEXT-12, F-371
  it('keeps the spacing of tries pushed out of quiet hours: from 8:00 AM, not all at once', () => {
    const first = I('2026-09-16T00:52:00Z'); // 8:52 PM EDT: try 4 would be 9:01 PM and try 5 9:11 PM
    expect(plannedTries(first, 3, NY).map((t) => [t.number, t.at.toString()])).toEqual([
      [4, '2026-09-16T12:00:00Z'],
      [5, '2026-09-16T12:10:00Z'],
    ]);
    // A first try already held to 8:00 AM plans from there, as before.
    expect([1, 2, 3, 4, 5].map((n) => plannedTryAt(I('2026-09-16T12:00:00Z'), n, NY).toString())).toEqual([
      '2026-09-16T12:00:00Z', '2026-09-16T12:02:00Z', '2026-09-16T12:04:00Z', '2026-09-16T12:09:00Z', '2026-09-16T12:19:00Z',
    ]);
  });
});

describe('kinds exempt from quiet hours (F-1545)', () => {
  // why: FR-TEXT-7, F-1545
  it('exempts only the on-the-way and late kinds, from the one constant', () => {
    expect([...QUIET_HOURS_EXEMPT_KINDS]).toEqual(['on_the_way', 'late']);
    expect(TEXT_KINDS.filter((k) => isQuietHoursExempt(k))).toEqual(['on_the_way', 'late']);
  });

  // why: FR-TEXT-7, F-1545
  it('never holds an on-the-way text: 9:30 PM is not quiet, and the release time is the time itself', () => {
    const due = I('2026-09-16T01:30:00Z'); // 9:30 PM EDT
    expect(inQuietHours(due, NY)).toBe(true);
    expect(inQuietHours(due, NY, 'on_the_way')).toBe(false);
    expect(releaseTime(due, NY, 'on_the_way').toString()).toBe('2026-09-16T01:30:00Z');
    expect(inQuietHours(due, NY, 'late')).toBe(false);
    expect(releaseTime(due, NY, 'late').toString()).toBe('2026-09-16T01:30:00Z');
    for (const kind of ['confirmation', 'reminder', 'r_reply', 'office']) {
      expect(inQuietHours(due, NY, kind)).toBe(true);
      expect(releaseTime(due, NY, kind).toString()).toBe('2026-09-16T12:00:00Z');
    }
  });

  // why: FR-TEXT-7, F-1545
  it('plans an on-the-way text first tried at 8:55 PM at +2, +4, +9 and +19 minutes, not at 8:00 AM', () => {
    const first = I('2026-09-16T00:55:00Z'); // 8:55 PM EDT
    expect(plannedTries(first, 1, NY, 'on_the_way').map((t) => [t.number, t.at.toString()])).toEqual([
      [2, '2026-09-16T00:57:00Z'], [3, '2026-09-16T00:59:00Z'], [4, '2026-09-16T01:04:00Z'], [5, '2026-09-16T01:14:00Z'],
    ]);
    // A confirmation first tried at the same time keeps the push to 8:00 AM.
    expect(plannedTryAt(first, 4, NY, 'confirmation').toString()).toBe('2026-09-16T12:00:00Z');
    expect(plannedTryAt(first, 4, NY).toString()).toBe('2026-09-16T12:00:00Z');
  });
});
