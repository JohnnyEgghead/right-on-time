// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { cancelJob } from './dispatch.ts';
import { markFixed, retryNow, sendAgain } from './billing.ts';
import { queuedItem, uploadBlob } from './tech.ts';
import { bookingSettings, setDayMode } from './windows.ts';
import { reports } from './report.ts';
import { callList } from './text.ts';
import { addTechnician, addTimeOff, editTechnician, workingHours } from './technicians.ts';
import { fewWindowsLeft } from './booking.ts';
import { isRealDate, localDate, localTime } from './shapes.ts';

// F-260: an untrusted value that PostgreSQL would refuse (an integer past int4, a NUL in text) is a validation_failed at the
// contract, not a 500 from the database.
describe('inputs a PostgreSQL column cannot hold', () => {
  // why: F-260 job_number is an integer column: 3000000000 answered 500 on API-61 and API-156
  it('refuses a job number past the integer column on the billing and cancel rows', () => {
    for (const row of [sendAgain, retryNow, markFixed, cancelJob]) {
      const base = row === markFixed ? { reason: 'Entered by hand' } : row === cancelJob ? { baseVersion: 1 } : {};
      expect(row.request.safeParse({ ...base, jobNumber: '3000000000' }).success, row.id).toBe(false);
      expect(row.request.safeParse({ ...base, jobNumber: '2147483647' }).success, row.id).toBe(true);
    }
  });

  // why: F-559 (recurrence of F-260) the technician contracts left jobNumber uncapped, so 2147483648 reached job_number and answered 500
  it('refuses a job number past the integer column on the technician item and upload rows', () => {
    const time = '2026-09-21T08:00:00-04:00[America/New_York]';
    const key = '00000000-0000-4000-8000-000000000000';
    const item = { key, kind: 'arrived', baseVersion: 1, worldEpoch: 0, deviceTime: time, offsetSavedReal: time, sinceSaveMs: 0, demoTime: time };
    expect(queuedItem.safeParse({ ...item, jobNumber: 2147483648 }).success).toBe(false);
    expect(queuedItem.safeParse({ ...item, jobNumber: 2147483647 }).success).toBe(true);
    const blob = { key, kind: 'photo', worldEpoch: '0', deviceTime: time, offsetSavedReal: time, sinceSaveMs: '0', demoTime: time };
    expect(uploadBlob.request.safeParse({ ...blob, jobNumber: '2147483648' }).success).toBe(false);
    expect(uploadBlob.request.safeParse({ ...blob, jobNumber: '2147483647' }).success).toBe(true);
  });

  // why: F-260 PostgreSQL text cannot hold a NUL: a NUL in API-158's reason answered 500 (F-469 fixed the same on API-162)
  it('refuses a NUL in the Mark fixed reason', () => {
    expect(markFixed.request.safeParse({ jobNumber: '24688', reason: 'Entered\u0000 by hand' }).success).toBe(false);
    expect(markFixed.request.safeParse({ jobNumber: '24688', reason: 'Entered by hand' }).success).toBe(true);
  });
});

// F-753, F-740 and F-766 (the class of F-260): the shared date and time shapes refuse a value the handler's Temporal or the column cannot hold.
describe('the shared date, time and text shapes', () => {
  // why: F-753 2026-02-30 and 2026-13-45 matched the regex and reached Temporal.PlainDate.from, answering 500 on API-90 and API-91
  it('refuses a day the calendar lacks and takes a leap day', () => {
    for (const d of ['2026-02-30', '2026-13-45', '2026-04-31', '2027-02-29', '0000-00-00']) expect(localDate.safeParse(d).success, d).toBe(false);
    for (const d of ['2026-02-28', '2028-02-29', '2026-12-31']) expect(localDate.safeParse(d).success, d).toBe(true);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(bookingSettings.request.safeParse({ branchId: 'columbus', from: '2026-02-30', to: '2026-03-02' }).success).toBe(false);
    expect(setDayMode.request.safeParse({ branchId: 'columbus', date: '2026-13-45', mode: 'two_hour' }).success).toBe(false);
  });

  // why: F-740 a fromWeek of 2026-02-30 rolled to Monday, Mar 2 in a JS Date, so the Monday check passed and Temporal threw
  it('refuses a week that only rolls to a Monday', () => {
    expect(reports.request.safeParse({ fromWeek: '2026-02-30' }).success).toBe(false);
    expect(reports.request.safeParse({ toWeek: '2026-02-30' }).success).toBe(false);
    expect(reports.request.safeParse({ fromWeek: '2026-03-02' }).success).toBe(true);
  });

  // why: F-766 the technician contract's localTime was digits only: 25:00 reached the time column and answered 500
  it('refuses an hour past 23 and a minute past 59', () => {
    for (const t of ['25:00', '24:00', '08:60', '8:00']) expect(localTime.safeParse(t).success, t).toBe(false);
    for (const t of ['00:00', '08:30', '23:59']) expect(localTime.safeParse(t).success, t).toBe(true);
    expect(workingHours.safeParse({ start: '08:00', end: '25:00', days: [1], saturdays: 'none' }).success).toBe(false);
  });

  // why: F-766 a NUL in a technician's name or a time off note reached a text column and answered 500
  it('refuses a NUL in a technician name, an email and a time off note', () => {
    const hours = { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5], saturdays: 'none' };
    const add = { name: 'Derek Lindgren', email: 'dl@example.test', branch: 'columbus', vanId: null, skills: ['plumbing'], workingHours: hours };
    expect(addTechnician.request.safeParse(add).success).toBe(true);
    expect(addTechnician.request.safeParse({ ...add, name: 'Der\u0000ek' }).success).toBe(false);
    expect(addTechnician.request.safeParse({ ...add, email: 'd\u0000l@example.test' }).success).toBe(false);
    const off = { technicianId: '00000000-0000-4000-8000-000000000000', from: '2026-09-21', to: '2026-09-21', note: 'Dentist' };
    expect(addTimeOff.request.safeParse(off).success).toBe(true);
    expect(addTimeOff.request.safeParse({ ...off, note: 'Den\u0000tist' }).success).toBe(false);
    expect(addTimeOff.request.safeParse({ ...off, from: '2026-02-30' }).success).toBe(false);
    expect(editTechnician.request.safeParse({ technicianId: off.technicianId, nameInTexts: 'Ma\u0000ria' }).success).toBe(false);
  });
});


describe('the call list date', () => {
  // why: F-860 GET /call-list?date=2026-02-30 matched the regex and reached Temporal.PlainDate.from, answering 500
  it('refuses a date the calendar does not have and takes one it does', () => {
    expect(callList.request.safeParse({ branch: 'columbus', date: '2026-02-30' }).success).toBe(false);
    expect(callList.request.safeParse({ branch: 'columbus', date: '2026-02-27' }).success).toBe(true);
  });
});

describe('the few-windows-left rule', () => {
  // why: FR-BOOK-15, SD-27 v0.12, F-1136 at most half of the day's windows have room, at least 1, for any day length; none is Full, not few
  it('marks a day when at least 1 and at most half of its windows have room, for a 2-hour, 4-hour or Saturday day', () => {
    // 2-hour weekday of 5 windows, a Saturday of 3, a 4-hour day of 4
    expect([0, 1, 2, 3, 4, 5].map((open) => fewWindowsLeft(open, 5))).toEqual([false, true, true, false, false, false]);
    expect([0, 1, 2, 3].map((open) => fewWindowsLeft(open, 3))).toEqual([false, true, false, false]);
    expect([0, 1, 2, 3, 4].map((open) => fewWindowsLeft(open, 4))).toEqual([false, true, true, false, false]);
    expect(fewWindowsLeft(3, 6)).toBe(true);
    expect(fewWindowsLeft(4, 6)).toBe(false);
  });
});
