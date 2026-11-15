// SPDX-License-Identifier: AGPL-3.0-or-later
// The Today screen's rules (src/tech/today/model.ts): the day with the phone's waiting items applied, the header's progress, the next job.
import { describe, expect, it } from 'vitest';
import { previewState } from './preview-data.ts';
import { applyWaiting, askedSheet, canStartWay, directionsMinutes, nextJob, NO_NEW_DAY, progress, surname, trackNewDay } from './model.ts';

const day = previewState('success').day!;
const item = (kind: 'on_my_way' | 'arrived' | 'finished' | 'no_one_home', jobNumber: number, enteredRealMs: number) =>
  ({ key: `k${enteredRealMs}`, kind, jobNumber, enteredRealMs, baseVersion: 2, userId: 'u' }) as never;

describe('Today rules', () => {
  // why: FR-TECH-12
  it('counts the jobs done of the day\'s jobs, and a job finished offline counts at once', () => {
    expect(progress(applyWaiting(day.jobs, []))).toEqual({ done: 1, total: 5 });
    const harold = day.jobs[1]!.jobNumber;
    expect(progress(applyWaiting(day.jobs, [item('finished', harold, 1)]))).toEqual({ done: 2, total: 5 });
  });
  // why: FR-TECH-1
  it('applies waiting status items in the order entered and marks the job as waiting to send', () => {
    const harold = day.jobs[1]!.jobNumber;
    const jobs = applyWaiting(day.jobs, [item('arrived', harold, 2), item('on_my_way', harold, 1)]);
    expect(jobs[1]).toMatchObject({ status: 'on_site', pending: true });
    expect(jobs[2]).toMatchObject({ status: 'scheduled', pending: false });
    expect(nextJob(jobs)?.jobNumber).toBe(harold);
  });
  // why: FR-BILL-3, F-1025 a finish the server refused for parts leaves the job On site with its Finish link, not Done
  it('keeps a job On site while its finish is refused for parts, and Done while it merely waits', () => {
    const harold = day.jobs[1]!.jobNumber;
    const refused = { ...(item('finished', harold, 2) as object), lastTry: { atRealMs: 1, outcome: 'refused', code: 'parts_required' } } as never;
    const jobs = applyWaiting(day.jobs, [item('arrived', harold, 1), refused]);
    expect(jobs[1]).toMatchObject({ status: 'on_site' });
    expect(progress(jobs).done).toBe(1);
    expect(applyWaiting(day.jobs, [item('arrived', harold, 1), item('finished', harold, 2)])[1]!.status).toBe('done');
  });
  // why: FR-BILL-3, F-1045 a refused finish still waits on the phone: the job reads Waiting to send beside On site and never the Sent badge, even when an earlier item of the job was just answered
  it('counts a refused finish as waiting, so the Sent badge is not drawn beside On site', () => {
    const harold = day.jobs[1]!.jobNumber;
    const refused = { ...(item('finished', harold, 2) as object), lastTry: { atRealMs: 1, outcome: 'refused', code: 'parts_required' } } as never;
    const jobs = applyWaiting(day.jobs, [refused], [{ kind: 'arrived', jobNumber: harold }]);
    expect(jobs[1]).toMatchObject({ status: day.jobs[1]!.status, pending: true, sent: false });
  });
  // why: FR-TECH-9
  it('shows a No one home visit as over and moves the next job on', () => {
    const harold = day.jobs[1]!.jobNumber;
    const jobs = applyWaiting(day.jobs, [item('no_one_home', harold, 1)]);
    expect(jobs[1]!.status).toBe('no_one_home');
    expect(nextJob(jobs)?.jobNumber).toBe(day.jobs[2]!.jobNumber);
  });
  // why: FR-TECH-2
  it('allows On my way only for a scheduled job while no other job is on the way or on site', () => {
    const jobs = applyWaiting(day.jobs, []);
    expect(canStartWay(jobs, jobs[1]!)).toBe(true);
    expect(canStartWay(applyWaiting(day.jobs, [item('on_my_way', day.jobs[2]!.jobNumber, 1)]), jobs[1]!)).toBe(false);
  });
  // why: FR-TECH-1
  it('names a customer by the family name for the compact rows', () => {
    expect(surname('Harold Jenkins')).toBe('Jenkins');
  });
});

describe('a sheet the job screen asks for', () => {
  // why: FR-TECH-2 the job screen's On my way, Arrived and No one home open Today's confirm sheet for that job (CTL-TEC-04-13, -14, -17)
  it('reads the sheet and the job from the address, and nothing else', () => {
    expect(askedSheet('?sheet=omw&job=24830')).toEqual({ kind: 'omw', jobNumber: 24830 });
    expect(askedSheet('?sheet=arrived&job=24830')).toEqual({ kind: 'arrived', jobNumber: 24830 });
    expect(askedSheet('?sheet=noh&job=24830')).toEqual({ kind: 'noh', jobNumber: 24830 });
    expect([askedSheet(''), askedSheet('?sheet=finish&job=24830'), askedSheet('?sheet=omw&job=x'), askedSheet('?sheet=omw&job=-1')]).toEqual([null, null, null, null]);
  });
});

describe('the Directions button\'s minutes on live Today (F-1027 a)', () => {
  const leg = (track: unknown, minutes: number) => async () => ({ leg: { track, minutes } });
  // why: FR-TECH-13 (CTL-TEC-08-03) Today shows API-104's drive minutes for the next job when the leg has a baked track, and none for an approximate route
  it('shows the leg\'s minutes online with a track, and none when the track is null', async () => {
    expect(await directionsMinutes(leg([[0, 0]], 17), 24830, true)).toEqual({ job: 24830, minutes: 17 });
    expect(await directionsMinutes(leg(null, 17), 24830, true)).toEqual({ job: 24830, minutes: null });
  });
  // why: FR-TECH-13 offline there is no read and no minutes; a failed read leaves none
  it('reads nothing offline or with no next job, and shows none after a failed read', async () => {
    let calls = 0;
    const counted = async () => { calls += 1; return { leg: { track: [[0, 0]], minutes: 5 } }; };
    expect(await directionsMinutes(counted, 24830, false)).toBeNull();
    expect(await directionsMinutes(counted, null, true)).toBeNull();
    expect(calls).toBe(0);
    expect(await directionsMinutes(async () => { throw new Error('down'); }, 24830, true)).toBeNull();
  });
});

describe('New day (SCR-TEC-02, F-1135)', () => {
  // why: UI-SPECIFICATION 8 New day: the clock passed midnight, so a read answers a later date than the list shown; the next read of that date ends it
  it('starts on a later date than the list shown and ends with the next read', () => {
    const first = trackNewDay(NO_NEW_DAY, '2026-09-15', '2026-09-15T23:58:00Z');
    expect(first.newDayAt).toBeNull();
    const again = trackNewDay(first, '2026-09-15', '2026-09-15T23:59:00Z');
    expect(again.newDayAt).toBeNull();
    const midnight = trackNewDay(again, '2026-09-16', '2026-09-16T00:00:10Z');
    expect(midnight.newDayAt).toBe('2026-09-16T00:00:10Z');
    // the same read again keeps it; a later read of the new date ends it
    expect(trackNewDay(midnight, '2026-09-16', '2026-09-16T00:00:10Z').newDayAt).toBe('2026-09-16T00:00:10Z');
    expect(trackNewDay(midnight, '2026-09-16', '2026-09-16T00:01:10Z').newDayAt).toBeNull();
    // no answer yet changes nothing
    expect(trackNewDay(midnight, null, null)).toBe(midnight);
  });
});
