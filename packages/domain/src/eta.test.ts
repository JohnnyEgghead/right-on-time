// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: SD-15 (the ETA, timing and drive minutes of the planner and the sweep)
import { describe, expect, it } from 'vitest';
import { approximateDriveMinutes, etaDay, isLateEnoughToText, legRef, planDay, trackedDriveMinutes, type EtaStop } from './index.ts';

const MIN = 60_000;
const t0 = Date.UTC(2026, 8, 15, 11); // 7:00 AM EDT
const at = (minutes: number) => t0 + minutes * MIN;
const depot = { lon: -83, lat: 39.96 };
const far = { lon: -83.1, lat: 40.05 };

const stop = (jobNumber: number, windowStart: number, status: EtaStop['status'] = 'scheduled', over: Partial<EtaStop> = {}): EtaStop => ({
  jobNumber, status, windowStart: at(windowStart), windowEnd: at(windowStart + 120), bookedAt: jobNumber, expectedMinutes: 60, point: far,
  onTheWayAt: null, arrivedAt: null, endedAt: null, ...over,
});

describe('trackedDriveMinutes (F-380)', () => {
  // why: SD-15
  it('uses the baked leg: last cumulative second / 60 rounded up, else SD-22 approximate minutes', () => {
    const drive = trackedDriveMinutes(new Map([[legRef(null, 7), 601], [legRef(7, 8), 600]]));
    expect(drive(depot, far, null, 7)).toBe(11);
    expect(drive(far, far, 7, 8)).toBe(10);
    expect(drive(far, far, 8, 7)).toBe(approximateDriveMinutes(far, far));
    expect(drive(depot, far)).toBe(approximateDriveMinutes(depot, far));
  });

  // why: SD-15
  it('plans arrivals from the track minutes where a track exists and from SD-22 where it does not', () => {
    const stops = [1, 2].map((n) => ({ jobNumber: n, windowStart: at(60), bookedAt: n, expectedMinutes: 60, point: far }));
    const tracked = planDay({ shiftStart: at(0), depot, stops, drive: trackedDriveMinutes(new Map([[legRef(1, 2), 1500]])) });
    expect((tracked[1]!.plannedArrival - tracked[0]!.plannedEnd) / MIN).toBe(25);
    const without = planDay({ shiftStart: at(0), depot, stops, drive: trackedDriveMinutes(new Map()) });
    expect((without[1]!.plannedArrival - without[0]!.plannedEnd) / MIN).toBe(approximateDriveMinutes(far, far));
  });
});

describe('the on-the-way leg (F-515)', () => {
  // why: SD-15, SD-22 the sweep's ETA measures the leg the van drives: the probe's 2 cases, skipped and out of order
  it('measures from the last ended job, not the job before in window order', () => {
    const seen: (number | null | undefined)[] = [];
    const legs = (from: unknown, to: unknown, fromJob?: number | null) => {
      seen.push(fromJob);
      return 10;
    };
    etaDay({ now: at(65), shiftStart: at(0), depot, drive: legs, stops: [stop(1, 60, 'scheduled'), stop(2, 60, 'on_the_way', { onTheWayAt: at(60) })] });
    expect(seen.at(-1)).toBeNull();
    etaDay({ now: at(65), shiftStart: at(0), depot, drive: legs, stops: [stop(1, 60, 'on_the_way', { onTheWayAt: at(60) }), stop(2, 60, 'done', { arrivedAt: at(30), endedAt: at(50) })] });
    expect(seen).toContain(2);
  });
});

describe('etaDay (SD-15)', () => {
  const drive = () => 10;

  // why: SD-15
  it('is the arrival time for a job on site or ended', () => {
    const r = etaDay({
      now: at(200), shiftStart: at(0), depot, drive,
      stops: [stop(1, 60, 'done', { arrivedAt: at(70), endedAt: at(130) }), stop(2, 60, 'on_site', { arrivedAt: at(190) })],
    });
    expect(r.map((x) => [x.jobNumber, (x.eta - t0) / MIN, x.timing])).toEqual([[1, 70, 'on_time'], [2, 190, 'late']]);
  });

  // why: SD-15
  it('is on_the_way_at plus the leg for a job on the way, and now + 2 minutes once that has passed', () => {
    const s = [stop(1, 60, 'on_the_way', { onTheWayAt: at(60) })];
    expect((etaDay({ now: at(65), shiftStart: at(0), depot, drive, stops: s })[0]!.eta - t0) / MIN).toBe(70);
    expect((etaDay({ now: at(75), shiftStart: at(0), depot, drive, stops: s })[0]!.eta - t0) / MIN).toBe(77);
  });

  // why: SD-15
  it('is the later of the window start and ready + drive, ready being demo now (not before shift start) with no open job before', () => {
    const early = etaDay({ now: at(-30), shiftStart: at(0), depot, drive, stops: [stop(1, 60)] });
    expect((early[0]!.eta - t0) / MIN).toBe(60);
    const late = etaDay({ now: at(100), shiftStart: at(0), depot, drive, stops: [stop(1, 60)] });
    expect((late[0]!.eta - t0) / MIN).toBe(110);
    const shiftBound = etaDay({ now: at(-30), shiftStart: at(0), depot, drive, stops: [stop(1, 0)] });
    expect((shiftBound[0]!.eta - t0) / MIN).toBe(10);
  });

  // why: SD-15, F-516
  it('never puts ready before demo now: an on-site job past its expected minutes ends no earlier than now', () => {
    // Job 1 on site since minute 75 with 60 expected minutes (ends at 135); now is minute 250, so job 2 cannot be on time at minute 145.
    const r = etaDay({ now: at(250), shiftStart: at(0), depot, drive, stops: [stop(1, 60, 'on_site', { arrivedAt: at(75) }), stop(2, 120)] });
    expect((r[1]!.eta - t0) / MIN).toBe(260);
    expect(r[1]!.timing).toBe('late');
  });

  // why: SD-15
  it('chains each next open job on the previous job ETA plus its expected minutes', () => {
    const r = etaDay({ now: at(100), shiftStart: at(0), depot, drive, stops: [stop(1, 60), stop(2, 60)] });
    expect(r.map((x) => (x.eta - t0) / MIN)).toEqual([110, 180]);
  });

  // why: SD-15
  it('is late after the window end, at risk within 15 minutes before it, else on time', () => {
    const w = (eta: number) => etaDay({ now: at(0), shiftStart: at(0), depot, drive: () => 0, stops: [stop(1, eta)] });
    // window 60 to 180 for a job at 60: eta 60 is on time; push the ETA by moving now.
    const timing = (now: number) => etaDay({ now: at(now), shiftStart: at(0), depot, drive: () => 0, stops: [stop(1, 60)] })[0]!.timing;
    expect(w(60)[0]!.timing).toBe('on_time');
    expect(timing(164)).toBe('on_time');
    expect(timing(165)).toBe('at_risk');
    expect(timing(180)).toBe('at_risk');
    expect(timing(181)).toBe('late');
  });
});

describe('isLateEnoughToText (FR-TEXT-5)', () => {
  // why: FR-TEXT-5
  it('is 20 or more minutes after the baseline', () => {
    expect(isLateEnoughToText(at(119), at(100))).toBe(false);
    expect(isLateEnoughToText(at(120), at(100))).toBe(true);
    expect(isLateEnoughToText(at(121), at(100))).toBe(true);
  });
});
