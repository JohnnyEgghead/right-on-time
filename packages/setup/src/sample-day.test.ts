// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: SD-21, SD-15, FR-DEMO-8 (owner answer 36d87aec "Chain each visit"; F-513, F-356)
// The census over the real generated demo week: the fixture the generator writes for seed 20260915, the verified street list
// and, where the release download is present, the baked tracks. The world seed runs the same sampleDay (world-seed.ts).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DATA_DIR } from '../../db/src/data-asset.ts';
import { BRANCHES, planTechnicians, readRoster, SERVICES } from '../../db/src/seed/reference-data.ts';
import { readStreetList } from '../../db/src/street-list.ts';
import { approximateDriveMinutes, LATE_TEXT_MINUTES, trackedDriveMinutes, type DriveMinutes, type Point } from '../../domain/src/planner.ts';
import { chainVisits } from '../../generator/src/chain.ts';
import { generate, loadInputs } from '../../generator/src/index.ts';
import { parseTracks } from '../../maps/src/tracks.ts';
import { parseFixture, type FixtureJob, type WorldFixture } from './fixture.ts';
import { sampleDay, type SampleDayJob } from './sample-day.ts';
import { bakedDrive, demoMoment, storyTracksSkip } from './testing/demo-moment.ts';

const STREET_LIST = process.env['BW_STREET_LIST'] ?? path.join(DATA_DIR, 'street-list.json');
const TRACKS = path.join(DATA_DIR, 'maps', 'tracks.ndjson');
/**
 * SHA-256 of the script rows as main wrote them before the chain (13a70c01): the chain changes when a step runs, never a row.
 * F-292 changed the rows once, on purpose: the Jobs page's story visits (STORY_JOBS script) and the 3 Unassigned Sep 15 jobs,
 * which no technician visits; F-1651 once more: the visits before 24805, 24797 and 24819 (24810, 24815, 24809, 24814, 24803,
 * 24804), so the page's Late and At risk jobs run late at 10:28 AM; every other row is the drawn row.
 */
const OLD_SCRIPT_SHA256 = '47284c525d16bfc490dab7e307ee13354a1145efabec86372bedec0a0cd728d0';

const local = (date: string, time: string): number => new Date(`${date}T${time}:00-04:00`).getTime();
const MINUTE = 60_000;
/** The 10:28 AM ETAs the approved Jobs page tells (F-1651). */
const PAGE_ETA: Readonly<Record<number, string>> = { 24_805: '12:25', 24_797: '11:50', 24_819: '13:45' };

interface Day { technician: string; date: string; jobs: FixtureJob[] }

let fixture: WorldFixture;
let days: Day[];
let points: Map<string, Point>;

beforeAll(() => {
  fixture = parseFixture(generate(loadInputs({ streetList: STREET_LIST }))['fixture.json']);
  const streets = new Map(readStreetList(STREET_LIST).map((s) => [`${s.name}|${s.city}|${s.zip}`, s]));
  points = new Map(fixture.customers.map((c) => {
    const s = streets.get(`${c.street}|${c.city}|${c.zip}`);
    if (!s) throw new Error(`no street for ${c.ref}`);
    const p = s.points[(c.houseNumber - 1) % s.points.length] as [number, number];
    return [c.ref, { lon: p[0], lat: p[1] }];
  }));
  const byDay = new Map<string, Day>();
  for (const j of fixture.demoWeekJobs) {
    if (j.technician === null) continue; // Unassigned (F-292): in no technician-day, as the world seed plans it
    const key = `${j.technician}|${j.date}`;
    const day: Day = byDay.get(key) ?? { technician: j.technician, date: j.date, jobs: [] };
    day.jobs.push(j);
    byDay.set(key, day);
  }
  days = [...byDay.values()];
});

function census(drive: DriveMinutes) {
  const script = new Map(fixture.sampleDayScript.map((s) => [s.jobNumber, s]));
  const roster = new Map(planTechnicians(readRoster()).map((t) => [t.employeeNumber, t]));
  const minutes = new Map(SERVICES.map((s) => [s.id, s.minutes]));
  let pairs = 0;
  let leftDuringVisit = 0;
  let onSiteAtTwo = 0;
  let tooSoon = 0;
  let wrongArrival = 0;
  for (const d of days) {
    const t = roster.get(d.technician);
    const depot = BRANCHES.find((b) => b.id === t?.branch);
    if (!t || !depot) throw new Error(`no technician ${d.technician}`);
    const jobs: SampleDayJob[] = d.jobs.map((j) => ({
      jobNumber: j.jobNumber, windowStart: local(j.date, j.windowStart), bookedAt: new Date(`${j.bookedAt}:00-04:00`).getTime(),
      expectedMinutes: minutes.get(j.service) as number, point: points.get(j.customer) as Point,
    }));
    const { planned, steps } = sampleDay({ shiftStart: local(d.date, t.shiftStart), depot, jobs, drive, script });
    expect(steps.map((s) => s.jobNumber)).toEqual(planned.map((p) => p.jobNumber).filter((n) => script.has(n)));
    const byNumber = new Map(jobs.map((j) => [j.jobNumber, j]));
    steps.forEach((v, i) => {
      const s = script.get(v.jobNumber) as { onMyWayLeadMinutes: number; arrivalDelayMinutes: number; workMinutes: number };
      // The script's minutes stand: the lead and the work exactly, the delay never lost to a later start.
      if (v.arrived - v.onMyWay !== s.onMyWayLeadMinutes * MINUTE || v.ended - v.arrived !== s.workMinutes * MINUTE) wrongArrival++;
      if (v.onMyWay < local(d.date, t.shiftStart)) leftDuringVisit++;
      const before = steps[i - 1];
      if (!before) return;
      pairs++;
      if (v.onMyWay < before.ended) leftDuringVisit++;
      if (v.arrived < before.ended) onSiteAtTwo++;
      const leg = drive(byNumber.get(before.jobNumber)?.point as Point, byNumber.get(v.jobNumber)?.point as Point, before.jobNumber, v.jobNumber);
      if (v.arrived < before.ended + leg * MINUTE) tooSoon++;
    });
  }
  return { pairs, leftDuringVisit, onSiteAtTwo, tooSoon, wrongArrival };
}

/** Every scripted Sep 15 visit's chained times, by job number. */
function storySteps(drive: DriveMinutes): Map<number, { arrived: number; ended: number }> {
  const script = new Map(fixture.sampleDayScript.map((s) => [s.jobNumber, s]));
  const roster = new Map(planTechnicians(readRoster()).map((t) => [t.employeeNumber, t]));
  const minutes = new Map(SERVICES.map((s) => [s.id, s.minutes]));
  const out = new Map<number, { arrived: number; ended: number }>();
  for (const d of days.filter((x) => x.date === '2026-09-15')) {
    const t = roster.get(d.technician);
    const depot = BRANCHES.find((b) => b.id === t?.branch);
    if (!t || !depot) throw new Error(`no technician ${d.technician}`);
    const jobs: SampleDayJob[] = d.jobs.map((j) => ({
      jobNumber: j.jobNumber, windowStart: local(j.date, j.windowStart), bookedAt: new Date(`${j.bookedAt}:00-04:00`).getTime(),
      expectedMinutes: minutes.get(j.service) as number, point: points.get(j.customer) as Point,
    }));
    for (const s of sampleDay({ shiftStart: local(d.date, t.shiftStart), depot, jobs, drive, script }).steps) out.set(s.jobNumber, s);
  }
  return out;
}

describe('the demo week chained (owner answer 36d87aec)', () => {
  // why: SD-21 the old rule measured over the same 329 pairs (332 before F-292 took 3 Sep 15 jobs off their technicians): the census finds what F-513 filed, so its 0s below mean something; 124 and 56 before F-1651's shorter story visits (24809, 24810, 24814, 24815)
  it('finds the script\'s 121 and 55 overlaps with the old rule, so the count can fail', () => {
    const script = new Map(fixture.sampleDayScript.map((s) => [s.jobNumber, s]));
    let pairs = 0;
    let left = 0;
    let both = 0;
    for (const d of days) {
      const old = d.jobs.filter((j) => script.has(j.jobNumber)).sort((a, b) => a.windowStart.localeCompare(b.windowStart)).map((j) => {
        const s = script.get(j.jobNumber) as { onMyWayLeadMinutes: number; arrivalDelayMinutes: number; workMinutes: number };
        const arrived = local(j.date, j.windowStart) + (15 + s.arrivalDelayMinutes) * MINUTE;
        return { omw: arrived - s.onMyWayLeadMinutes * MINUTE, arrived, ended: arrived + s.workMinutes * MINUTE };
      });
      old.forEach((v, i) => {
        const before = old[i - 1];
        if (!before) return;
        pairs++;
        if (v.omw < before.ended) left++;
        if (v.arrived < before.ended) both++;
      });
    }
    expect({ pairs, left, both }).toEqual({ pairs: 329, left: 121, both: 55 });
  });

  // why: SD-21, FR-DEMO-8 no On my way before the previous visit's last step, no technician at 2 jobs, every lead and work minute kept
  it('has 0 of 329 pairs out of order on SD-22\'s approximate minutes', () => {
    expect(census(approximateDriveMinutes)).toEqual({ pairs: 329, leftDuringVisit: 0, onSiteAtTwo: 0, tooSoon: 0, wrongArrival: 0 });
  });

  // why: SD-21, SD-15 the same census on the drive minutes setup really uses, wherever the track set is present (the stack suite always has it)
  it('has 0 of 329 pairs out of order on the baked tracks', (ctx) => {
    const skip = storyTracksSkip(TRACKS); // F-1668: a missing track file skips with its reason printed
    if (skip) ctx.skip(skip);
    const seconds = new Map(parseTracks(readFileSync(TRACKS, 'utf8')).map((t) => [`${t.from_ref}|${t.to_ref}`, t.seconds[t.seconds.length - 1] as number]));
    expect(census(trackedDriveMinutes(seconds))).toEqual({ pairs: 329, leftDuringVisit: 0, onSiteAtTwo: 0, tooSoon: 0, wrongArrival: 0 });
  });

  // why: F-292 the approved Jobs page at 10:28 AM: 24790 done 9:30, 24800 done 9:50, 24791 on site since 9:55, 24825 done, on the drive minutes setup uses
  it('chains the Jobs page story visits to the times the page tells', (ctx) => {
    const skip = storyTracksSkip(TRACKS);
    if (skip) ctx.skip(skip);
    const seconds = new Map(parseTracks(readFileSync(TRACKS, 'utf8')).map((t) => [`${t.from_ref}|${t.to_ref}`, t.seconds[t.seconds.length - 1] as number]));
    const at = storySteps(trackedDriveMinutes(seconds));
    const t = (n: number, k: 'arrived' | 'ended'): number => at.get(n)?.[k] ?? NaN;
    expect([t(24_790, 'ended'), t(24_800, 'ended'), t(24_791, 'arrived')]).toEqual([local('2026-09-15', '09:30'), local('2026-09-15', '09:50'), local('2026-09-15', '09:55')]);
    expect(t(24_791, 'ended')).toBeGreaterThan(local('2026-09-15', '10:28'));
    expect(t(24_825, 'ended')).toBeLessThanOrEqual(local('2026-09-15', '10:28'));
  });

  // why: F-1651 the approved Jobs page at 10:28 AM (owner ruling b23b26d9 "Match the page"): Columbus Late is 24805 only, ETA
  // 12:25 PM, late text sent; At risk is 24797, ETA 11:50 AM, and 24819, ETA 1:45 PM, with no late text; on the manifest's tracks (F-1665)
  it('is the Jobs page\'s Late and At risk story at 10:28 AM on the baked tracks', (ctx) => {
    const skip = storyTracksSkip(TRACKS);
    if (skip) ctx.skip(skip);
    const m = demoMoment({ fixture, points, drive: bakedDrive(TRACKS), date: '2026-09-15', at: '10:28' });
    const open = (n: number): boolean => ['scheduled', 'on_the_way', 'on_site'].includes(m.get(n)?.status ?? '');
    const columbus = [...m.values()].filter((j) => j.branch === 'columbus' && open(j.jobNumber));
    expect(columbus.filter((j) => j.timing === 'late').map((j) => j.jobNumber)).toEqual([24_805]);
    expect(columbus.filter((j) => j.timing === 'at_risk').map((j) => j.jobNumber).sort()).toEqual([24_797, 24_819]);
    for (const n of [24_805, 24_797, 24_819]) expect(m.get(n)?.eta, `${n} ETA, the page's ${PAGE_ETA[n]}`).toBe(local('2026-09-15', PAGE_ETA[n] as string));
    expect(m.get(24_805)?.lateTextAt).toBeLessThanOrEqual(local('2026-09-15', '10:28'));
    expect(m.get(24_797)?.lateTextAt).toBeNull();
    expect(m.get(24_819)?.lateTextAt).toBeNull();
  });

  // why: F-1651 (review 767: a late text is sent at 20 minutes past the plan, and 24797 sat 2 minutes under it, so a 4-minute
  // drift in a visit before it flips the page's "no late text"): each story job's widest gap over the sweeps to 10:28 AM, pinned
  it('keeps each story job\'s late-text margin at 10:28 AM on the baked tracks', (ctx) => {
    const skip = storyTracksSkip(TRACKS);
    if (skip) ctx.skip(skip);
    const m = demoMoment({ fixture, points, drive: bakedDrive(TRACKS), date: '2026-09-15', at: '10:28' });
    const gaps = Object.fromEntries([24_805, 24_797, 24_819].map((n) => [n, m.get(n)?.lateGapMinutes]));
    expect(gaps).toEqual({ 24805: 58, 24797: 18, 24819: 19 });
    expect(LATE_TEXT_MINUTES).toBe(20);
  });

  // why: SD-21 "every scripted delay kept": the rows are byte for byte the old script's, and only the chain moves a step
  it('leaves every script row as the old script wrote it', () => {
    expect(createHash('sha256').update(JSON.stringify(fixture.sampleDayScript)).digest('hex')).toBe(OLD_SCRIPT_SHA256);
    expect(fixture.sampleDayScript.filter((s) => s.arrivalDelayMinutes >= 20).length).toBeGreaterThan(20);
  });
});

describe('chainVisits', () => {
  const visit = (jobNumber: number, plannedArrival: number, driveMinutes: number, lead: number, delay: number, work: number) => ({
    jobNumber, plannedArrival, driveMinutes, script: { onMyWayLeadMinutes: lead, arrivalDelayMinutes: delay, workMinutes: work },
  });

  // why: SD-21 a late visit keeps its delay on a chained start: the delay that makes a job late is not absorbed by the push
  it('adds a positive delay on top of the drive when the previous visit ran over', () => {
    const [a, b] = chainVisits(0, [visit(1, 30 * MINUTE, 10, 20, 0, 100), visit(2, 90 * MINUTE, 15, 20, 30, 60)]);
    expect(a).toEqual({ jobNumber: 1, onMyWay: 10 * MINUTE, arrived: 30 * MINUTE, ended: 130 * MINUTE });
    expect(b?.arrived).toBe((130 + 15 + 30) * MINUTE);
    expect(b?.onMyWay).toBe((130 + 25) * MINUTE);
  });

  // why: SD-21 an early visit cannot arrive sooner than the drive from the stop before allows
  it('never lets a negative delay beat the drive', () => {
    const [, b] = chainVisits(0, [visit(1, 0, 0, 0, 0, 100), visit(2, 90 * MINUTE, 30, 15, -10, 60)]);
    expect(b?.arrived).toBe(130 * MINUTE);
  });

  // why: SD-21 a lead longer than the gap moves the arrival, so the technician still leaves after the visit before
  it('takes the On my way lead from the previous end', () => {
    const [, b] = chainVisits(0, [visit(1, 0, 0, 0, 0, 100), visit(2, 105 * MINUTE, 5, 30, 0, 60)]);
    expect(b).toEqual({ jobNumber: 2, onMyWay: 100 * MINUTE, arrived: 130 * MINUTE, ended: 190 * MINUTE });
  });

  // why: F-819 SD-21 "every scripted delay kept": when the plan is the binding term, the arrival is the planned arrival plus the delay, a late one (+15) and an early one (-10), not the planned arrival alone
  it('binds the first term, planned arrival plus delay, when the stop before leaves more room than the plan needs', () => {
    const [late] = chainVisits(0, [visit(1, 60 * MINUTE, 10, 20, 15, 30)]);
    expect(late).toEqual({ jobNumber: 1, onMyWay: 55 * MINUTE, arrived: 75 * MINUTE, ended: 105 * MINUTE });
    const [early] = chainVisits(0, [visit(1, 60 * MINUTE, 10, 20, -10, 30)]);
    expect(early).toEqual({ jobNumber: 1, onMyWay: 30 * MINUTE, arrived: 50 * MINUTE, ended: 80 * MINUTE });
  });

  // why: FR-DEMO-8 before the shift start a van has no position, so the first On my way is at or after it
  it('starts the first visit at or after the shift start', () => {
    const [a] = chainVisits(60 * MINUTE, [visit(1, 70 * MINUTE, 10, 35, -10, 60)]);
    expect(a?.onMyWay).toBe(60 * MINUTE);
  });
});
