// SPDX-License-Identifier: AGPL-3.0-or-later
// The pure capacity model and day planner (SPECIFICATIONS section 6.1, SD-15, SD-27). The database writes that use
// them are tested on PostgreSQL in packages/api-server/src/office-writes/office-writes.db.test.ts.
import { describe, expect, it } from 'vitest';
import {
  approximateDriveMinutes, dayKind, dayRoom, firstOverlap, isoWeek, offeredWindows, planDay, technicianDayCapacity, technicianHasRoom,
  timingOf, windowRoom, worksOn, type TechnicianFacts,
} from './index.ts';

const tech = (over: Partial<TechnicianFacts> = {}): TechnicianFacts => ({
  id: 't', installer: false, workingDays: [1, 2, 3, 4, 5], saturdays: 'none', timeOff: [], ...over,
});
const MIN = 60_000;

describe('the calendar of a technician day', () => {
  // why: FR-BOOK-10
  it('reads ISO weekdays and weeks: Tue Sep 15, 2026 is weekday 2 of week 38; Sat Sep 19 is weekday 6', () => {
    expect(isoWeek('2026-09-15')).toEqual({ weekday: 2, week: 38 });
    expect(isoWeek('2026-09-19')).toEqual({ weekday: 6, week: 38 });
    expect(isoWeek('2026-01-01')).toEqual({ weekday: 4, week: 1 });
    expect(isoWeek('2027-01-01')).toEqual({ weekday: 5, week: 53 });
  });

  // why: FR-BOOK-10
  it('makes a Sunday closed, a Saturday a half-day, and a weekday follow its day mode', () => {
    expect(dayKind('2026-09-20', 'two_hour')).toBe('sunday');
    expect(dayKind('2026-09-19', 'four_hour')).toBe('saturday');
    expect(dayKind('2026-09-16', 'four_hour')).toBe('four_hour');
    expect(dayKind('2026-09-15', 'two_hour')).toBe('two_hour');
  });

  // why: FR-BOOK-10, FR-DISP-33
  it('works a technician on their weekdays and their Saturday weeks, never on time off', () => {
    expect(worksOn(tech(), '2026-09-15')).toBe(true);
    expect(worksOn(tech({ workingDays: [1, 3] }), '2026-09-15')).toBe(false);
    expect(worksOn(tech({ saturdays: 'even_weeks' }), '2026-09-19')).toBe(true); // week 38
    expect(worksOn(tech({ saturdays: 'odd_weeks' }), '2026-09-19')).toBe(false);
    expect(worksOn(tech(), '2026-09-20')).toBe(false);
    expect(worksOn(tech({ timeOff: [{ from: '2026-09-14', to: '2026-09-15' }] }), '2026-09-15')).toBe(false);
    expect(worksOn(tech({ timeOff: [{ from: '2026-09-14', to: '2026-09-15' }] }), '2026-09-16')).toBe(true);
  });

  // why: FR-BOOK-7, FR-BOOK-10
  it('offers the 2 morning 2-hour windows on a Saturday, the mode windows on a weekday and none on a Sunday', () => {
    const w = [
      ...['08:00', '10:00', '12:00', '14:00', '16:00'].map((s) => ({ id: `2h-${s}`, mode: 'two_hour' as const, startLocal: `${s}:00` })),
      ...['08:00', '10:00', '12:00', '14:00'].map((s) => ({ id: `4h-${s}`, mode: 'four_hour' as const, startLocal: `${s}:00` })),
    ];
    expect(offeredWindows(w, 'saturday').map((x) => x.id)).toEqual(['2h-08:00', '2h-10:00']);
    expect(offeredWindows(w, 'four_hour')).toHaveLength(4);
    expect(offeredWindows(w, 'two_hour')).toHaveLength(5);
    expect(offeredWindows(w, 'sunday')).toEqual([]);
  });
});

describe('capacity (FR-BOOK-5, FR-BOOK-6, SD-27)', () => {
  // why: FR-BOOK-5
  it('gives each technician 5 visits on a 2-hour day, 6 on a 4-hour day, 3 on a Saturday, and an installer 1', () => {
    expect(technicianDayCapacity(tech(), 'two_hour')).toBe(5);
    expect(technicianDayCapacity(tech(), 'four_hour')).toBe(6);
    expect(technicianDayCapacity(tech(), 'saturday')).toBe(3);
    expect(technicianDayCapacity(tech(), 'sunday')).toBe(0);
    expect(technicianDayCapacity(tech({ installer: true }), 'two_hour')).toBe(1);
  });

  // why: FR-BOOK-5
  it('sums the working technicians of the service pool and subtracts the live jobs of that pool, never below 0', () => {
    const working = [tech(), tech(), tech({ installer: true })];
    const jobs = [{ install: false }, { install: false }, { install: true }];
    expect(dayRoom({ kind: 'two_hour', working, serviceIsInstall: false, liveJobs: jobs })).toBe(8);
    expect(dayRoom({ kind: 'two_hour', working, serviceIsInstall: true, liveJobs: jobs })).toBe(0);
    expect(dayRoom({ kind: 'four_hour', working, serviceIsInstall: false, liveJobs: [] })).toBe(12);
    expect(dayRoom({ kind: 'two_hour', working: [tech()], serviceIsInstall: false, liveJobs: Array(7).fill({ install: false }) })).toBe(0);
  });

  // why: FR-BOOK-6
  it('takes the smaller of the window capacity left and the day room on a 2-hour day, and the day room on a 4-hour window', () => {
    expect(windowRoom({ windowCapacity: 12, windowLiveJobs: 11, dayRoom: 30 })).toBe(1);
    expect(windowRoom({ windowCapacity: 12, windowLiveJobs: 12, dayRoom: 30 })).toBe(0);
    expect(windowRoom({ windowCapacity: 12, windowLiveJobs: 3, dayRoom: 2 })).toBe(2);
    expect(windowRoom({ windowCapacity: null, windowLiveJobs: 40, dayRoom: 5 })).toBe(5);
    expect(windowRoom({ windowCapacity: 10, windowLiveJobs: 14, dayRoom: 5 })).toBe(0);
  });

  // why: FR-DISP-2, FR-BOOK-5
  it('gives a technician room only under the daily capacity and under 2 (2-hour) or 3 (4-hour) jobs in the window', () => {
    expect(technicianHasRoom({ capacity: 5, jobsThatDay: 4, jobsInWindow: 1, windowMode: 'two_hour' })).toBe(true);
    expect(technicianHasRoom({ capacity: 5, jobsThatDay: 5, jobsInWindow: 0, windowMode: 'two_hour' })).toBe(false);
    expect(technicianHasRoom({ capacity: 5, jobsThatDay: 2, jobsInWindow: 2, windowMode: 'two_hour' })).toBe(false);
    expect(technicianHasRoom({ capacity: 6, jobsThatDay: 2, jobsInWindow: 2, windowMode: 'four_hour' })).toBe(true);
  });
});

describe('the day planner (SD-15) and block overlap (FR-DISP-34)', () => {
  const depot = { lon: -82.9988, lat: 39.9612 };
  const t0 = Date.UTC(2026, 8, 15, 12); // 8:00 AM EDT
  const stop = (jobNumber: number, startHours: number, bookedAt: number, minutes = 60) => ({
    jobNumber, windowStart: t0 + startHours * 60 * MIN, bookedAt, expectedMinutes: minutes, point: depot,
  });

  // why: SD-15
  it('orders stops by window start then booked-at and chains each arrival after the previous job and the drive', () => {
    const plan = planDay({ shiftStart: t0, depot, stops: [stop(3, 2, 1), stop(2, 0, 9), stop(1, 0, 5)], drive: () => 10 });
    expect(plan.map((p) => p.jobNumber)).toEqual([1, 2, 3]);
    expect(plan.map((p) => (p.plannedArrival - t0) / MIN)).toEqual([10, 80, 150]);
    expect((plan[0]!.plannedEnd - plan[0]!.plannedArrival) / MIN).toBe(60);
    // A later window start waits for it: the third stop's window opens at 10:00 (minute 120) but the chain reaches 150.
    expect(planDay({ shiftStart: t0, depot, stops: [stop(1, 0, 1), stop(2, 4, 2)], drive: () => 10 }).map((p) => (p.plannedArrival - t0) / MIN)).toEqual([10, 240]);
  });

  // why: SD-22
  it('drives a leg with no baked track in about ceil(km x 1.4 / 35 km per h x 60) + 2 minutes', () => {
    expect(approximateDriveMinutes(depot, depot)).toBe(2);
    // About 10 km due north: 10 x 1.4 / 35 x 60 = 24 minutes, plus 2.
    expect(approximateDriveMinutes(depot, { lon: depot.lon, lat: depot.lat + 10 / 111.195 })).toBe(26);
  });

  // why: FR-DISP-34
  it('finds a job whose planned time overlaps a block, and lets touching ends pass', () => {
    const jobs = [{ jobNumber: 1, plannedArrival: t0, plannedEnd: t0 + 60 * MIN }];
    expect(firstOverlap(jobs, [{ start: t0 + 60 * MIN, end: t0 + 90 * MIN }])).toBeNull();
    expect(firstOverlap(jobs, [{ start: t0 + 59 * MIN, end: t0 + 90 * MIN }])?.job.jobNumber).toBe(1);
  });

  // why: SD-15, FR-DISP-4
  it('calls an ETA after the window end late, within 15 minutes of it at risk, else on time', () => {
    const end = t0 + 120 * MIN;
    expect(timingOf(end + MIN, end)).toBe('late');
    expect(timingOf(end, end)).toBe('at_risk');
    expect(timingOf(end - 15 * MIN, end)).toBe('at_risk');
    expect(timingOf(end - 16 * MIN, end)).toBe('on_time');
  });
});
