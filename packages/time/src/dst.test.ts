// SPDX-License-Identifier: AGPL-3.0-or-later
// The daylight-saving suite (NFR-08; invariant 4). Gate G-CI4 runs this file under host zones UTC,
// America/New_York and America/Los_Angeles (TZ set per run, BW_EXPECT_TZ naming it) and requires the host-zone probe
// below to pass in each, so a run that never changed zone cannot count. The merge set runs it under the runner's zone.
// Every expected instant is written out as UTC, so a wrong offset shows up as a wrong hour, never as a match.
import { describe, expect, it } from 'vitest';
import { FixedClock, DbClock, type ClockRow } from './clock.ts';
import { formatTime, formatTimeWithZone, zoneAbbreviation, dateParts } from './format.ts';
import { Temporal } from 'temporal-polyfill';
import { addDays, atLocal, fromWire, inLocalWindow, nextLocalTime, toWire } from './zone.ts';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
const PHX = 'America/Phoenix';
const I = (s: string) => Temporal.Instant.from(s);
const hours = (a: Temporal.Instant, b: Temporal.Instant) => (b.epochMilliseconds - a.epochMilliseconds) / 3_600_000;
const QUIET = ['21:00', '08:00'] as const; // FR-TEXT-7: no text between 9 PM and 8 AM in the customer's zone

describe('host zone', () => {
  // @bw/time compiles without Node types (it runs in browsers too), so the run's env is read through globalThis.
  const want = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BW_EXPECT_TZ;
  const hourAt14Z: Record<string, number> = { UTC: 14, 'America/New_York': 9, 'America/Los_Angeles': 6 };
  // why: NFR-08
  it.skipIf(!want)('the host zone is the one this run was started under', () => {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(want);
    // The zone took effect in the host's own local-time functions, not only in its name.
    const hostHour = new Date(Date.UTC(2026, 10, 2, 14)).getHours();
    expect(hostHour).toBe(hourAt14Z[want!]);
  });
});

describe('NFR-08: times stay right across the daylight-saving changes', () => {
  // why: NFR-08
  it('a Mon, Nov 2, 2026 visit booked in EDT is at 9:00 AM EST', async () => {
    const clock = new FixedClock({ demo: '2026-10-30T14:00:00Z' }); // Fri, Oct 30, 10:00 AM EDT
    const bookedAt = await clock.demoNow();
    expect(toWire(bookedAt, NY)).toBe('2026-10-30T10:00:00-04:00[America/New_York]');
    const visit = atLocal('2026-11-02', '09:00', NY, 'reject');
    expect(visit.toString()).toBe('2026-11-02T14:00:00Z'); // EST, not the booking day's EDT offset (13:00Z)
    expect(toWire(visit, NY)).toBe('2026-11-02T09:00:00-05:00[America/New_York]');
    expect(formatTimeWithZone(visit, NY)).toBe('9:00 AM EST');
    expect(dateParts(visit, NY)).toEqual({ year: 2026, month: 11, day: 2, weekday: 1 });
    expect(hours(bookedAt, visit)).toBe(72); // 71 wall-clock hours plus the repeated hour
  });

  // why: NFR-08
  it('its reminder is Sun, Nov 1 at 6:00 PM EST', () => {
    const reminder = atLocal(addDays('2026-11-02', -1), '18:00', NY, 'reject');
    expect(reminder.toString()).toBe('2026-11-01T23:00:00Z');
    expect(toWire(reminder, NY)).toBe('2026-11-01T18:00:00-05:00[America/New_York]');
    expect(formatTimeWithZone(reminder, NY)).toBe('6:00 PM EST');
    expect(dateParts(reminder, NY).weekday).toBe(7);
    expect(hours(reminder, atLocal('2026-11-02', '09:00', NY, 'reject'))).toBe(15);
  });

  // why: NFR-08
  it('a 7:30 AM EST text is held to 8:00 AM EST', () => {
    const due = atLocal('2026-11-02', '07:30', NY, 'reject');
    expect(inLocalWindow(due, NY, ...QUIET)).toBe(true);
    const release = nextLocalTime(due, NY, '08:00');
    expect(release.toString()).toBe('2026-11-02T13:00:00Z');
    expect(formatTimeWithZone(release, NY)).toBe('8:00 AM EST');
    expect(inLocalWindow(release, NY, ...QUIET)).toBe(false);
    // Held across the change itself: due Sat 9:30 PM EDT, released Sun 8:00 AM EST, 11.5 real hours later.
    const lateSat = atLocal('2026-10-31', '21:30', NY, 'reject');
    const sunday = nextLocalTime(lateSat, NY, '08:00');
    expect(sunday.toString()).toBe('2026-11-01T13:00:00Z');
    expect(hours(lateSat, sunday)).toBe(11.5);
    expect(inLocalWindow(atLocal('2026-11-02', '20:59', NY, 'reject'), NY, ...QUIET)).toBe(false);
    expect(inLocalWindow(atLocal('2026-11-02', '21:00', NY, 'reject'), NY, ...QUIET)).toBe(true);
  });

  // why: NFR-08
  it('a Sat, Oct 31 visit is unaffected and stays EDT', () => {
    const visit = atLocal('2026-10-31', '09:00', NY, 'reject');
    expect(visit.toString()).toBe('2026-10-31T13:00:00Z');
    expect(formatTimeWithZone(visit, NY)).toBe('9:00 AM EDT');
    const wire = '2026-10-31T17:59:00-04:00[America/New_York]';
    expect(toWire(fromWire(wire).toInstant(), NY)).toBe(wire);
  });

  // why: NFR-08
  it('the fall-back day is 25 hours and 1:30 AM happens twice; the caller chooses which', () => {
    expect(hours(atLocal('2026-11-01', '00:00', NY, 'reject'), atLocal('2026-11-02', '00:00', NY, 'reject'))).toBe(25);
    expect(() => atLocal('2026-11-01', '01:30', NY, 'reject')).toThrow(RangeError);
    expect(atLocal('2026-11-01', '01:30', NY, 'earlier').toString()).toBe('2026-11-01T05:30:00Z');
    expect(atLocal('2026-11-01', '01:30', NY, 'later').toString()).toBe('2026-11-01T06:30:00Z');
    // A stale EDT offset on an EST date is refused, never silently moved an hour.
    expect(() => fromWire('2026-11-02T09:00:00-04:00[America/New_York]')).toThrow(RangeError);
    expect(() => fromWire('2026-11-02T09:00:00-05:00')).toThrow(RangeError); // no zone
  });

  // why: NFR-08, F-182 a wire time with no offset is refused: Temporal's default would move it or pick an instant
  it('refuses a wire time with no offset, so no gap time is moved and no repeated time is picked', () => {
    expect(() => fromWire('2027-03-14T02:30[America/New_York]')).toThrow(RangeError); // would become 03:30-04:00
    expect(() => fromWire('2026-11-01T01:30[America/New_York]')).toThrow(RangeError); // would take the earlier of 2
    expect(() => fromWire('2026-11-02[America/New_York]')).toThrow(RangeError); // a date alone, not midnight
    expect(() => fromWire('2026-11-02T09:00:00[America/New_York]')).toThrow(RangeError);
    // A full wire time with its offset still parses, including both 1:30 AMs of the fall-back hour.
    expect(fromWire('2026-11-01T01:30:00-04:00[America/New_York]').toInstant().toString()).toBe('2026-11-01T05:30:00Z');
    expect(fromWire('2026-11-01T01:30:00-05:00[America/New_York]').toInstant().toString()).toBe('2026-11-01T06:30:00Z');
    expect(fromWire('2026-11-01T06:30:00Z[America/New_York]').toInstant().toString()).toBe('2026-11-01T06:30:00Z');
  });

  // why: NFR-08
  it('the Mar 14 and 15, 2027 change: 2:30 AM never exists, the day is 23 hours, and both days keep their times', () => {
    expect(() => atLocal('2027-03-14', '02:30', NY, 'reject')).toThrow(RangeError);
    expect(atLocal('2027-03-14', '02:30', NY, 'compatible').toString()).toBe('2027-03-14T07:30:00Z'); // 3:30 AM EDT
    const wire = '2027-03-14T03:00:00-04:00[America/New_York]';
    expect(toWire(fromWire(wire).toInstant(), NY)).toBe(wire);
    expect(hours(atLocal('2027-03-14', '00:00', NY, 'reject'), atLocal('2027-03-15', '00:00', NY, 'reject'))).toBe(23);
    expect(atLocal('2027-03-13', '09:00', NY, 'reject').toString()).toBe('2027-03-13T14:00:00Z'); // Sat, EST
    const visit = atLocal('2027-03-15', '09:00', NY, 'reject');
    expect(visit.toString()).toBe('2027-03-15T13:00:00Z'); // Mon, EDT
    expect(formatTimeWithZone(visit, NY)).toBe('9:00 AM EDT');
    const reminder = atLocal(addDays('2027-03-15', -1), '18:00', NY, 'reject');
    expect(reminder.toString()).toBe('2027-03-14T22:00:00Z');
    expect(formatTimeWithZone(reminder, NY)).toBe('6:00 PM EDT');
    // A quiet-hours release on the short night lands on 8:00 AM EDT.
    expect(nextLocalTime(atLocal('2027-03-14', '01:30', NY, 'reject'), NY, '08:00').toString()).toBe('2027-03-14T12:00:00Z');
  });

  // why: NFR-08
  it('Deborah Lin in America/Los_Angeles: her booking at 10:29 AM Eastern is held to 8:00 AM in her own zone', () => {
    const due = atLocal('2026-10-30', '10:29', NY, 'reject'); // 7:29 AM PDT
    expect(formatTimeWithZone(due, LA)).toBe('7:29 AM PDT');
    expect(inLocalWindow(due, LA, ...QUIET)).toBe(true);
    expect(inLocalWindow(due, NY, ...QUIET)).toBe(false); // the branch zone would have sent it: the zone matters
    const release = nextLocalTime(due, LA, '08:00');
    expect(release.toString()).toBe('2026-10-30T15:00:00Z');
    expect(formatTimeWithZone(release, LA)).toBe('8:00 AM PDT');
    expect(formatTimeWithZone(release, NY)).toBe('11:00 AM EDT');
    // After the change both zones moved: 10:29 AM EST is 7:29 AM PST, held to 8:00 AM PST, 11:00 AM EST.
    const after = nextLocalTime(atLocal('2026-11-02', '10:29', NY, 'reject'), LA, '08:00');
    expect(after.toString()).toBe('2026-11-02T16:00:00Z');
    expect(formatTimeWithZone(after, NY)).toBe('11:00 AM EST');
    // Her page shows her zone; the office shows the branch zone (UD-15).
    const visit = atLocal('2026-11-02', '10:00', LA, 'reject');
    expect(visit.toString()).toBe('2026-11-02T18:00:00Z');
    expect(formatTimeWithZone(visit, LA)).toBe('10:00 AM PST');
    expect(formatTimeWithZone(visit, NY)).toBe('1:00 PM EST');
  });

  // why: NFR-08
  it('America/Phoenix control: no change, the same offset on both sides, and 2:30 AM on Mar 14 exists', () => {
    expect(atLocal('2026-10-31', '09:00', PHX, 'reject').toString()).toBe('2026-10-31T16:00:00Z');
    expect(atLocal('2026-11-02', '09:00', PHX, 'reject').toString()).toBe('2026-11-02T16:00:00Z');
    expect(hours(atLocal('2026-11-01', '00:00', PHX, 'reject'), atLocal('2026-11-02', '00:00', PHX, 'reject'))).toBe(24);
    expect(atLocal('2027-03-14', '02:30', PHX, 'reject').toString()).toBe('2027-03-14T09:30:00Z');
    expect(zoneAbbreviation(I('2026-10-31T16:00:00Z'), PHX)).toBe('MST');
    expect(zoneAbbreviation(I('2027-03-15T16:00:00Z'), PHX)).toBe('MST');
    expect(toWire(I('2026-11-02T16:00:00Z'), PHX)).toBe('2026-11-02T09:00:00-07:00[America/Phoenix]');
  });

  // why: NFR-08
  it('the demo clock read from its row keeps the right offset on both sides of the November and March changes', async () => {
    // the 4 readings, in process: the clock row's anchors plus elapsed real time (rate 1).
    let real = I('2026-06-01T12:00:00Z');
    const row: ClockRow = {
      demo_anchor: new Date('2026-10-31T21:59:00Z'), real_anchor: new Date('2026-06-01T12:00:00Z'),
      rate: '1.0', paused: false, world_epoch: 1,
    };
    const db = { query: async <R>() => ({ rows: [row] as R[] }) };
    const clock = new DbClock(db, { real: () => real, cacheMs: 0 });
    const read = async () => toWire(await clock.demoNow(), NY);
    expect(await read()).toBe('2026-10-31T17:59:00-04:00[America/New_York]');
    real = real.add({ hours: 25, minutes: 1 }); // across the repeated hour
    expect(await read()).toBe('2026-11-01T18:00:00-05:00[America/New_York]');
    real = real.add({ hours: 13, minutes: 30 });
    expect(await read()).toBe('2026-11-02T07:30:00-05:00[America/New_York]');
    row.demo_anchor = new Date('2027-03-14T06:59:00Z'); // 1:59 AM EST
    real = I('2026-06-01T12:00:00Z').add({ minutes: 1 });
    expect(await read()).toBe('2027-03-14T03:00:00-04:00[America/New_York]'); // 1 minute later, 2:00 never shows
  });
});

describe('SD-47: the shared formatter', () => {
  // why: SD-47
  it('says AM and PM in English and in Spanish, with 12 for midnight and noon', () => {
    const at = (s: string) => atLocal('2026-11-02', s, NY, 'reject');
    for (const lang of ['en', 'es'] as const) {
      expect(formatTime(at('18:00'), NY, lang)).toBe('6:00 PM');
      expect(formatTime(at('07:05'), NY, lang)).toBe('7:05 AM');
      expect(formatTime(at('00:00'), NY, lang)).toBe('12:00 AM');
      expect(formatTime(at('12:00'), NY, lang)).toBe('12:00 PM');
      expect(formatTime(at('23:59'), NY, lang)).not.toMatch(/a\. ?m\.|p\. ?m\./);
    }
    expect(formatTimeWithZone(at('18:00'), NY, 'es')).toBe('6:00 PM EST');
  });
});
