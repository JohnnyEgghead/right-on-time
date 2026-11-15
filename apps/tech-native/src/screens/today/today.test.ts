// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-1, FR-TECH-2, FR-TECH-12, FR-TECH-15, FR-AUTH-7
// The native Today stack's rules (model.ts, person.ts) on node (the day's read is the app's one read, mapme/reads.ts, tested there): the same code the phone runs, with the platform services as
// doubles. The real-path proof is the XCUITest suite on the simulator against the Compose stack (xcuitest/TodayUITests.swift).
import { describe, expect, it } from 'vitest';
import { nodeDir } from '../../testing.ts';
import { applyWaiting, arrivalSmall, canStartWay, dayLabel, directionsMinutes, leaveNowLine, nextJob, progress, showsNoSaved, surname, todayState, windowLabel } from './model.ts';
import { PersonFile, waitingPerson } from './person.ts';

const time = (hh: number, mm = 0) => `2026-09-15T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-04:00[America/New_York]`;
const job = (jobNumber: number, position: number, status: string, hour: number) => ({
  jobNumber, version: 2, position, status, window: { start: time(hour), end: time(hour + 2) }, customer: { name: `Cust Name${jobNumber}`, language: 'en' },
  address: '1 Main St', area: 'Westerville', serviceLabelKey: 'x', equipment: null, lastVisit: null, customerNote: null, plannedArrival: null,
  textedArrival: null, endedAt: null, lateText: null, onMyWayPreview: null,
});
const item = (kind: string, jobNumber: number, enteredRealMs: number) => ({ key: `k${enteredRealMs}`, kind, jobNumber, enteredRealMs, baseVersion: 2, userId: 'u', demoTime: '' }) as never;

describe('SCR-TEC-02 rules', () => {
  const jobs = [job(1, 1, 'done', 8), job(2, 2, 'scheduled', 10), job(3, 3, 'scheduled', 12)] as never;

  // why: FR-TECH-12 the header counts the jobs done of the day's jobs, and a job finished offline counts at once
  it('counts the day\'s progress with the phone\'s waiting items applied', () => {
    expect(progress(applyWaiting(jobs, []))).toEqual({ done: 1, total: 3 });
    expect(progress(applyWaiting(jobs, [item('finished', 2, 1)]))).toEqual({ done: 2, total: 3 });
  });

  // why: FR-TECH-2 each waiting status item moves its job at once in the order entered, and On my way is enabled only while no other job is under way
  it('applies waiting items in order and gates On my way on the other jobs', () => {
    const moved = applyWaiting(jobs, [item('arrived', 2, 2), item('on_my_way', 2, 1)]);
    expect(moved[1]).toMatchObject({ status: 'on_site', pending: true });
    expect(nextJob(moved)?.jobNumber).toBe(2);
    expect(canStartWay(moved, moved[2]!)).toBe(false);
    expect(canStartWay(applyWaiting(jobs, []), applyWaiting(jobs, [])[1]!)).toBe(true);
  });

  // why: FR-TECH-1 the labels the rows print: the surname, the window, the date
  it('prints the surname, the window and the date as the frames do', () => {
    expect(surname('Harold Jenkins')).toBe('Jenkins');
    expect(windowLabel(time(10), time(12))).toBe('10 AM-12 PM');
    expect(windowLabel(time(8), time(10))).toBe('8-10 AM');
    expect(dayLabel('2026-09-15', (k, v) => `${k}${JSON.stringify(v)}`)).toContain('"day":15');
  });

  // why: F-252 item 7 the reviewer (a technician-role user with no technician row) reads an empty day, and Today answers it as No jobs, not an error
  it('shows an empty day as No jobs and a failed first read as Offline, nothing saved', () => {
    expect(todayState({ hasDay: true, settled: true, online: true, jobs: [], newDay: false })).toBe('no_jobs');
    expect(todayState({ hasDay: false, settled: false, online: true, jobs: [], newDay: false })).toBe('loading');
    expect(todayState({ hasDay: false, settled: true, online: false, jobs: [], newDay: false })).toBe('offline_none');
  });

  // why: F-1109 (b) a first read that failed with signal (a 5xx, a refusal, an answer that does not parse) is no "No signal" line; CMP-12 stands alone, as on the web
  it('draws No signal and no saved list only for a lost connection', () => {
    const state = todayState({ hasDay: false, settled: true, online: true, jobs: [], newDay: false });
    expect([showsNoSaved(state, true), showsNoSaved(todayState({ hasDay: false, settled: true, online: false, jobs: [], newDay: false }), false)]).toEqual([false, true]);
  });

  // why: FR-TECH-1 every state of SCR-TEC-02 is told apart: success, offline with a saved list, all done, a new day
  it('names the other states of the screen', () => {
    const open = [{ status: 'scheduled' as const }];
    expect(todayState({ hasDay: true, settled: true, online: true, jobs: open, newDay: false })).toBe('success');
    expect(todayState({ hasDay: true, settled: true, online: false, jobs: open, newDay: false })).toBe('offline_saved');
    expect(todayState({ hasDay: true, settled: true, online: true, jobs: [{ status: 'done' }, { status: 'no_one_home' }], newDay: false })).toBe('all_done');
    expect(todayState({ hasDay: true, settled: true, online: true, jobs: open, newDay: true })).toBe('new_day');
  });

  // why: FR-TECH-13 the Directions minutes are the next job's drive time with signal, none offline, none on an approximate route
  it('reads the drive minutes only with signal and a baked route', async () => {
    const read = async () => ({ leg: { track: [], minutes: 12 } });
    expect(await directionsMinutes(read, 2, true)).toEqual({ job: 2, minutes: 12, distanceMeters: null });
    expect(await directionsMinutes(read, 2, false)).toBeNull();
    expect(await directionsMinutes(async () => ({ leg: { track: null, minutes: 9 } }), 2, true)).toEqual({ job: 2, minutes: null, distanceMeters: null });
    expect(await directionsMinutes(async () => { throw new Error('x'); }, 2, true)).toBeNull();
  });

  // F-1106: the drive estimate API-104 answers reaches the card and the On my way sheet, in the words the frames print.
  const words = (k: string, v?: Record<string, string | number>) => `${k}${v ? JSON.stringify(v) : ''}`;

  // why: FR-TECH-13, FR-TECH-2 the sheet's arrival line adds API-104's drive minutes and miles from the van to the job, and leaves both out when the drive time is not known (an approximate route, no signal)
  it('reads the drive minutes and miles of a baked route for the sheet, none for an approximate one', async () => {
    const baked = await directionsMinutes(async () => ({ leg: { track: [], minutes: 12, distanceMeters: 9335 } }), 2, true);
    expect(baked).toEqual({ job: 2, minutes: 12, distanceMeters: 9335 });
    const approx = await directionsMinutes(async () => ({ leg: { track: null, minutes: 9, distanceMeters: null } }), 2, true);
    expect(approx).toEqual({ job: 2, minutes: null, distanceMeters: null });
    expect(arrivalSmall({ minutes: 12, distanceMeters: 9335 }, true, '10 AM-12 PM', words)).toBe('tech.omw.driveInside{"n":12,"mi":"5.8","window":"10 AM-12 PM"}');
    expect(arrivalSmall({ minutes: 12, distanceMeters: 9335 }, false, '10 AM-12 PM', words)).toBe('tech.omw.driveOutside{"n":12,"mi":"5.8","window":"10 AM-12 PM"}');
    expect(arrivalSmall({ minutes: null, distanceMeters: null }, true, '10 AM-12 PM', words)).toBe('tech.omw.inside{"window":"10 AM-12 PM"}');
    expect(arrivalSmall(null, false, '10 AM-12 PM', words)).toBe('tech.omw.outside{"window":"10 AM-12 PM"}');
  });

  // why: FR-TECH-1, FR-TECH-8 the next job card shows its arrival estimate when online (CTL-TEC-02-02, "Arrive about 10:40 AM if you leave now"), API-100's estimate for a job not yet on the way, and none offline
  it('prints the card\'s arrival estimate for a scheduled job online only', () => {
    const preview = { language: 'en', text: 'x', arrival: time(10, 40) };
    const next = { ...job(2, 2, 'scheduled', 10), onMyWayPreview: preview };
    expect(leaveNowLine(next as never, true, 'America/New_York', 'en', words)).toBe('tech.today.leaveNow{"time":"10:40 AM"}');
    expect(leaveNowLine(next as never, false, 'America/New_York', 'en', words)).toBeNull();
    expect(leaveNowLine({ ...next, status: 'on_the_way' } as never, true, 'America/New_York', 'en', words)).toBeNull();
    expect(leaveNowLine({ ...next, onMyWayPreview: null } as never, true, 'America/New_York', 'en', words)).toBeNull();
  });
});

describe('SCR-TEC-01 Items waiting (person.ts)', () => {
  // why: FR-AUTH-7 when the session ended with items waiting, the sign-in name is the waiting technician's and the sign-in typed for that person is kept
  it('finds the waiting technician from the phone\'s last sign-in and the items\' user id', () => {
    const file = new PersonFile(nodeDir());
    expect(file.read()).toBeNull();
    file.write({ userId: 'u1', name: 'Maria Santos', login: '40712' });
    expect(file.read()).toEqual({ userId: 'u1', name: 'Maria Santos', login: '40712' });
    expect(waitingPerson([{ userId: 'u1' }, { userId: 'u1' }, { userId: 'u2' }], file.read())).toEqual({ person: { userId: 'u1', name: 'Maria Santos', login: '40712' }, count: 2 });
    expect(waitingPerson([{ userId: 'u2' }], file.read())).toBeNull();
    expect(waitingPerson([], null)).toBeNull();
  });
});
