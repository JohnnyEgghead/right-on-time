// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1797, F-1802 (owner answer 25550018, Nov 16, 2026: "Move 26 arrivals"), SD-25
// The fit of the past pilot visits over the real generated fixture (seed 20260915): what the owner's answer promised, measured.
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DATA_DIR } from '../../db/src/data-asset.ts';
import { generate, loadInputs } from '../../generator/src/index.ts';
import { parseFixture, type FixtureJob } from './fixture.ts';
import { doorMinute, FIT_DRIVE_MIN, FIT_WORK_MIN, fitPastVisitEnds } from './past-jobs.ts';

const STREET_LIST = process.env['BW_STREET_LIST'] ?? path.join(DATA_DIR, 'street-list.json');
const hm = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

let before: FixtureJob[];
let after: FixtureJob[];

beforeAll(() => {
  before = parseFixture(generate(loadInputs({ streetList: STREET_LIST }))['fixture.json']).pilotJobs;
  after = fitPastVisitEnds(before);
});

const lateStats = (jobs: FixtureJob[]): { late: number; total: number; avg: number; onTimePct: number } => {
  const arrived = jobs.filter((j) => j.arrivedAt !== null);
  const late = arrived.map((j) => hm(j.arrivedAt as string) - hm(j.windowEnd)).filter((m) => m > 0);
  const total = late.reduce((s, m) => s + m, 0);
  return { late: late.length, total, avg: Math.round((total / late.length) * 100) / 100, onTimePct: Math.round((1 - late.length / arrived.length) * 10000) / 100 };
};

const row = (over: Partial<FixtureJob>): FixtureJob => ({ ...(before[0] as FixtureJob), technician: 'tz', date: '2026-09-02', ...over });

describe('a done visit followed by a no-one-home door (F-1827)', () => {
  // why: F-1827 the done visit keeps 30 minutes of work and 10 before the moved knock; the knock is the end less knockMinutes, so
  // the no-one-home end and knock move by the same minutes
  it('moves the no-one-home end and knock by the same minutes and keeps the work', () => {
    const a = row({ jobNumber: 990_001, status: 'done', arrivedAt: '09:00', endedAt: '10:30' });
    const b = row({ jobNumber: 990_002, status: 'no_one_home', arrivedAt: null, endedAt: '09:45' });
    const [fa, fb] = fitPastVisitEnds([a, b]) as [FixtureJob, FixtureJob];
    expect(hm(fa.endedAt as string) - hm(fa.arrivedAt as string)).toBeGreaterThanOrEqual(FIT_WORK_MIN);
    expect(doorMinute(fb) - hm(fa.endedAt as string)).toBeGreaterThanOrEqual(FIT_DRIVE_MIN);
    const moved = hm(fb.endedAt as string) - hm(b.endedAt as string);
    expect(moved).toBeGreaterThan(0);
    expect(doorMinute(fb) - doorMinute(b)).toBe(moved);
    expect(fb.arrivedAt).toBeNull();
  });
});

describe('the past pilot visits as fitted (F-1797, F-1802)', () => {
  // why: F-1802, F-1827 every past done visit shows at least 30 minutes of work, with no exception: a no-one-home next visit moves too
  it('leaves no done visit under 30 minutes of work', () => {
    const under = after.filter((j) => j.status === 'done' && j.arrivedAt !== null && hm(j.endedAt as string) - hm(j.arrivedAt) < FIT_WORK_MIN);
    expect(under.map((j) => j.jobNumber)).toEqual([]);
  });

  // why: F-1797 a fitted end leaves at least the drive before the next door, and no 2 visits of a technician-day overlap
  it('leaves the drive between a fitted end and the next door, with no overlap', () => {
    const was = new Map(before.map((j) => [j.jobNumber, j]));
    const days = new Map<string, FixtureJob[]>();
    for (const j of after) if (j.endedAt !== null && (j.status === 'done' || j.status === 'no_one_home')) days.set(`${j.technician}|${j.date}`, [...(days.get(`${j.technician}|${j.date}`) ?? []), j]);
    for (const day of days.values()) {
      day.sort((x, y) => doorMinute(x) - doorMinute(y) || x.jobNumber - y.jobNumber);
      for (let i = 0; i < day.length - 1; i++) {
        const a = day[i] as FixtureJob;
        const gap = doorMinute(day[i + 1] as FixtureJob) - hm(a.endedAt as string);
        expect(gap, `job ${a.jobNumber}`).toBeGreaterThanOrEqual(0);
        if (a.endedAt !== (was.get(a.jobNumber) as FixtureJob).endedAt && a.arrivedAt !== null && hm(a.endedAt as string) - hm(a.arrivedAt) >= FIT_WORK_MIN) {
          expect(gap, `job ${a.jobNumber}`).toBeGreaterThanOrEqual(FIT_DRIVE_MIN);
        }
      }
    }
  });

  // why: F-1797 the owner's answer 25550018 priced the change at 26 moved arrivals: total late minutes 1729 to 1803, average late 37.59
  // to 39.2, on-time 92.87% unchanged, and no visit changes between on time and late
  it('moves 26 arrivals and shifts the late figures as the owner was told', () => {
    const moved = after.filter((j, i) => j.arrivedAt !== (before[i] as FixtureJob).arrivedAt);
    expect(moved).toHaveLength(26);
    expect(after.map((j) => j.jobNumber)).toEqual(before.map((j) => j.jobNumber));
    expect(lateStats(before)).toEqual({ late: 46, total: 1729, avg: 37.59, onTimePct: 92.87 });
    expect(lateStats(after)).toEqual({ late: 46, total: 1803, avg: 39.2, onTimePct: 92.87 });
    for (const j of moved) {
      const b = before.find((x) => x.jobNumber === j.jobNumber) as FixtureJob;
      expect(hm(j.arrivedAt as string) > hm(j.windowEnd), `job ${j.jobNumber}`).toBe(hm(b.arrivedAt as string) > hm(b.windowEnd));
      expect(j.status).toBe(b.status);
    }
  });
});
