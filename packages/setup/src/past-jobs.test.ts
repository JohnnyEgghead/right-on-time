// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1541 (owner ruling 9796c392, Nov 13, 2026: "Fill them in"), SD-25, FR-BILL-3
// The pure half of the past pilot jobs' records (past-jobs.ts planPastJob): the steps a job's outcome takes, their times against the
// fixture's outcome columns, the finish the validator accepts, the notes, and that every choice is a function of the job alone.
import { describe, expect, it } from 'vitest';
import { finishLines } from '@bw/domain';
import { SERVICES } from '../../db/src/seed/reference-data.ts';
import type { FixtureJob } from './fixture.ts';
import { doorMinute, FIT_DRIVE_MIN, FIT_GAP_MAX, FIT_WORK_MIN, fitPastVisitEnds, knockMinutes, NOTE_EVERY, pastJobItems, pastJobVersion, pick, planPastJob, seedUuid, WORK_DONE } from './past-jobs.ts';

const at = (date: string, time: string): Date => new Date(`${date}T${time}:00-04:00`);
const hm = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const job = (over: Partial<FixtureJob>): FixtureJob => ({
  jobNumber: 24_700, customer: 'c1', technician: '40701', service: 'furnace_tune_up', date: '2026-09-02', windowStart: '08:00', windowEnd: '10:00',
  status: 'done', arrivedAt: '08:40', endedAt: '09:35', bookedVia: 'office', bookedAt: '2026-08-28T14:00', ...over,
});
const MINUTE = 60_000;
const range = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + i);

describe('the steps a past job takes (F-1541)', () => {
  // why: F-1541, SD-25 a done job went On my way, Arrived, Finished; no one home went On my way, No one home; the arrival and the end are the fixture's
  it('done: 3 steps at drive-before-arrival, the arrival and the end; versions 1 to 4', () => {
    const p = planPastJob(job({}), { at, drive: 25, prevEnd: null });
    expect(p.steps.map((s) => [s.item, s.from, s.to, s.fromVersion, s.toVersion])).toEqual([
      ['on_my_way', 'scheduled', 'on_the_way', 1, 2], ['arrived', 'on_the_way', 'on_site', 2, 3], ['finished', 'on_site', 'done', 3, 4],
    ]);
    expect(p.steps.map((s) => s.at.getTime())).toEqual([at('2026-09-02', '08:15').getTime(), at('2026-09-02', '08:40').getTime(), at('2026-09-02', '09:35').getTime()]);
    expect(p.onTheWayAt).toEqual(p.steps[0]?.at);
    expect(pastJobVersion(job({}))).toBe(4);
  });

  // why: F-1541, SD-25 a no-one-home job never arrived (its arrived_at stays null for the reports); No one home is a forward move from on the way
  it('no one home: On my way then No one home at the end, 10 to 20 minutes at the door, no finish', () => {
    const j = job({ status: 'no_one_home', arrivedAt: null, endedAt: '09:00' });
    const p = planPastJob(j, { at, drive: 15, prevEnd: null });
    expect(p.steps.map((s) => [s.item, s.to])).toEqual([['on_my_way', 'on_the_way'], ['no_one_home', 'no_one_home']]);
    expect(p.steps[1]?.at).toEqual(at('2026-09-02', '09:00'));
    const door = (p.steps[1]!.at.getTime() - p.steps[0]!.at.getTime()) / MINUTE - 15;
    expect(door).toBeGreaterThanOrEqual(10);
    expect(door).toBeLessThanOrEqual(20);
    expect(p.finish).toBeNull();
    expect(pastJobVersion(j)).toBe(3);
  });

  // why: F-1541 On my way never comes before the visit before it ended, and always before the next step
  it('On my way waits for the previous visit to end, and stays a minute before the arrival', () => {
    expect(planPastJob(job({}), { at, drive: 60, prevEnd: at('2026-09-02', '08:20') }).onTheWayAt).toEqual(at('2026-09-02', '08:20'));
    expect(planPastJob(job({}), { at, drive: 20, prevEnd: at('2026-09-02', '08:45') }).onTheWayAt).toEqual(at('2026-09-02', '08:39'));
    expect(planPastJob(job({}), { at, drive: 0, prevEnd: null }).onTheWayAt).toEqual(at('2026-09-02', '08:39'));
  });

  it('refuses a job that has not ended', () => {
    expect(() => planPastJob(job({ status: 'scheduled', arrivedAt: null, endedAt: null }), { at, drive: 10, prevEnd: null })).toThrow(/not an ended pilot job/);
    expect(pastJobItems(job({ status: 'scheduled' }))).toEqual([]);
  });
});

describe('the finish and the notes (F-1541)', () => {
  const jobs = range(24_000, 1500).map((n, i) => job({ jobNumber: n, service: (SERVICES[i % SERVICES.length] as { id: string }).id }));
  const plans = jobs.map((j) => planPastJob(j, { at, drive: 20, prevEnd: null }));

  // why: F-1541, FR-BILL-3 every finish is one the finish validator accepts: parts xor No parts used, whole labor minutes
  it('every finish passes finishLines, with labor from arrival to end and 1 or 2 work-done lines from its service', () => {
    for (const p of plans) {
      const f = p.finish!;
      const q = new Map<string, number>();
      for (const c of f.partCodes) q.set(c, (q.get(c) ?? 0) + 1);
      expect(finishLines({ parts: [...q].map(([partId, quantity]) => ({ partId, quantity })), noPartsUsed: f.noPartsUsed, laborMinutes: f.laborMinutes }, () => true).ok).toBe(true);
      expect(f.laborMinutes).toBe(55);
      expect(f.workDone.length === 1 || f.workDone.length === 2).toBe(true);
      expect(new Set(f.workDone).size).toBe(f.workDone.length);
    }
  });

  // why: F-1541 every service has work-done lines; a finish with parts says it used them and one without never does
  it('has work-done lines for every service, and a finish without parts uses only the lines that name none', () => {
    for (const s of SERVICES) expect(WORK_DONE[s.id]?.checks.length, s.id).toBeGreaterThan(0);
    for (const p of plans) {
      const j = jobs.find((x) => x.jobNumber === p.jobNumber)!;
      const pool = WORK_DONE[j.service]!;
      if (p.finish!.noPartsUsed) expect(p.finish!.workDone.every((t) => pool.checks.includes(t))).toBe(true);
      else expect(pool.repairs).toContain(p.finish!.workDone[0]);
    }
    const none = plans.filter((p) => p.finish!.noPartsUsed).length;
    expect(none / plans.length).toBeGreaterThan(0.2);
    expect(none / plans.length).toBeLessThan(0.45);
    expect(plans.filter((p) => j0(p.jobNumber).service === 'sump_pump_install').every((p) => !p.finish!.noPartsUsed)).toBe(true);
  });
  const j0 = (n: number): FixtureJob => jobs.find((x) => x.jobNumber === n)!;

  // why: F-1541 about 1 job in 5 has a note; an office one before the window, a technician's during the visit at a step's version
  it('notes about 1 job in 5: office before the window opens, the technician during the visit', () => {
    const noted = plans.filter((p) => p.note);
    expect(noted.length / plans.length).toBeGreaterThan(1 / NOTE_EVERY - 0.04);
    expect(noted.length / plans.length).toBeLessThan(1 / NOTE_EVERY + 0.04);
    for (const p of noted) {
      const n = p.note!;
      if (n.kind === 'office') {
        expect(n.at.getTime()).toBeLessThan(at('2026-09-02', '08:00').getTime());
        expect([n.key, n.version]).toEqual([null, 1]);
      } else {
        expect(n.at.getTime()).toBeGreaterThan(at('2026-09-02', '08:40').getTime());
        expect(n.at.getTime()).toBeLessThan(at('2026-09-02', '09:35').getTime());
        expect(n.version).toBe(3);
        expect(n.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
    }
    expect(new Set(noted.map((p) => p.note!.kind)).size).toBe(2);
  });

  // why: F-1541, D-3 every choice and every id is a function of the job: the same job plans the same record, whatever came before it
  it('is deterministic: the same job gives the same plan, ids are valid version 8 uuids and differ by name', () => {
    expect(planPastJob(job({}), { at, drive: 20, prevEnd: null })).toEqual(planPastJob(job({}), { at, drive: 20, prevEnd: null }));
    expect(seedUuid('a')).toBe(seedUuid('a'));
    expect(seedUuid('a')).not.toBe(seedUuid('b'));
    expect(seedUuid('item:1:on_my_way')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(plans.flatMap((p) => p.steps.map((s) => s.key))).size).toBe(plans.reduce((s, p) => s + p.steps.length, 0));
    expect(pick('x', 7)).toBe(pick('x', 7));
  });
});

describe('a pilot visit ends before the same technician reaches the next door (F-1546)', () => {
  // why: F-1546 a visit that ran past the next arrival ends FIT_GAP_MAX minutes before it, or halfway when the 2 doors are closer; its
  // arrival, outcome and technician stay, and a visit that already ended before the next door is the same object
  it('moves only an overlapping end, to before the next door, and keeps every arrival', () => {
    const a = job({ jobNumber: 1, arrivedAt: '09:00', endedAt: '10:30' });
    const b = job({ jobNumber: 2, arrivedAt: '10:00', endedAt: '11:00' });
    const c = job({ jobNumber: 3, arrivedAt: '10:10', endedAt: '12:00' });
    const d = job({ jobNumber: 4, arrivedAt: '12:30', endedAt: '13:00' });
    const other = job({ jobNumber: 5, technician: '40702', arrivedAt: '09:30', endedAt: '10:30' });
    const out = fitPastVisitEnds([c, a, d, b, other]);
    expect(out.map((j) => [j.jobNumber, j.arrivedAt, j.endedAt])).toEqual([
      [3, '10:40', '12:10'], [1, '09:00', '09:40'], [4, '12:30', '13:00'], [2, '10:00', '10:30'], [5, '09:30', '10:30'],
    ]);
    expect(out[0]).not.toBe(c); // F-1797: b's end now reaches c's door, so c's arrival moves to 40 minutes after b's
    expect(out[2]).toBe(d);
    expect(out[4]).toBe(other);
    expect(FIT_GAP_MAX).toBe(20);
  });

  // why: F-1546 a no-one-home visit is at the door its knock minutes before its end, so a done visit before it fits to that knock
  it("fits a visit's end to the next visit's knock when no one was home there", () => {
    const a = job({ jobNumber: 24_700, arrivedAt: '09:00', endedAt: '10:30' });
    const b = job({ jobNumber: 24_701, status: 'no_one_home', arrivedAt: null, endedAt: '10:20' });
    const knock = 10 * 60 + 20 - knockMinutes(24_701);
    expect(doorMinute(b)).toBe(knock);
    const [fa, fb] = fitPastVisitEnds([a, b]);
    const end = knock - Math.min(FIT_GAP_MAX, Math.floor((knock - 9 * 60) / 2));
    expect(fa?.endedAt).toBe(`${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`);
    expect(fb).toBe(b);
  });

  // why: F-1546 2 visits under 2 minutes apart at the door leave no minute for the first one, and a no-one-home end that overlaps
  // would move its own knock; both are refused rather than written out of order
  it('refuses a day it cannot fit', () => {
    const nine = (m: number): string => `${String(9 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    // a no-one-home visit whose knock is 09:00, then a visit arriving 1 minute later (a done visit there would now move the next one)
    expect(() => fitPastVisitEnds([job({ jobNumber: 1, status: 'no_one_home', arrivedAt: null, endedAt: nine(knockMinutes(1)) }), job({ jobNumber: 2, arrivedAt: '09:01' })]))
      .toThrow(/1 minute\(s\) apart/);
    expect(() => fitPastVisitEnds([job({ jobNumber: 1, status: 'no_one_home', arrivedAt: null, endedAt: '09:55' }), job({ jobNumber: 2, arrivedAt: '09:50' })]))
      .toThrow(/no-one-home visit ends after the next door/);
  });

  // why: F-1802 a fitted done visit keeps at least FIT_WORK_MIN minutes of work: when the next door is too near, that arrival moves
  // later (the smallest move) and its end by the same minutes, so the next visit keeps its own work too
  it('keeps 30 minutes of work: the next arrival moves later and carries its end', () => {
    const a = job({ jobNumber: 1, arrivedAt: '09:00', endedAt: '10:30' });
    const b = job({ jobNumber: 2, arrivedAt: '09:20', endedAt: '10:00' });
    const [fa, fb] = fitPastVisitEnds([a, b]) as [FixtureJob, FixtureJob];
    expect([fb.arrivedAt, fb.endedAt]).toEqual(['09:40', '10:20']);
    expect(fa.arrivedAt).toBe('09:00');
    expect(fa.endedAt).toBe('09:30');
    expect(FIT_WORK_MIN).toBe(30);
  });

  // why: F-1797 the fitted end leaves at least the drive before the next door, and a visit with room to spare keeps the old fit
  // (20 minutes), no arrival moved
  it('leaves at least the drive before the next door, and moves no arrival when there is room', () => {
    const tight = fitPastVisitEnds([job({ jobNumber: 1, arrivedAt: '09:00', endedAt: '10:30' }), job({ jobNumber: 2, arrivedAt: '09:42', endedAt: '10:30' })]) as FixtureJob[];
    expect(tight.map((j) => [j.arrivedAt, j.endedAt])).toEqual([['09:00', '09:30'], ['09:42', '10:30']]); // 12 minutes of drive, 30 of work
    const roomy = [job({ jobNumber: 1, arrivedAt: '09:00', endedAt: '10:30' }), job({ jobNumber: 2, arrivedAt: '10:00', endedAt: '10:50' })];
    const out = fitPastVisitEnds(roomy);
    expect(out.map((j) => [j.arrivedAt, j.endedAt])).toEqual([['09:00', '09:40'], ['10:00', '10:50']]);
    expect(out[1]).toBe(roomy[1]);
    expect(FIT_DRIVE_MIN).toBe(10);
  });

  // why: F-1797 a visit moved later can reach the door after it: that one moves in turn, down the day, so no visits overlap
  it('cascades: a moved visit that now reaches the next door moves that one too', () => {
    const a = job({ jobNumber: 1, arrivedAt: '09:00', endedAt: '10:30' });
    const b = job({ jobNumber: 2, arrivedAt: '09:10', endedAt: '10:40' });
    const c = job({ jobNumber: 3, arrivedAt: '10:00', endedAt: '11:00' });
    const out = fitPastVisitEnds([a, b, c]);
    expect(out.map((j) => [j.jobNumber, j.arrivedAt, j.endedAt])).toEqual([[1, '09:00', '09:30'], [2, '09:40', '10:10'], [3, '10:20', '11:20']]);
  });

  // why: F-1827 a no-one-home next visit moves too (its knock is its end less knockMinutes, so its end moves the knock by the same
  // minutes): the done visit before it keeps 30 minutes of work, and a no-one-home visit that is not reached stays the same object
  it('moves a no-one-home next visit by the same minutes, its knock with it', () => {
    const a = job({ jobNumber: 1, arrivedAt: '09:00', endedAt: '10:30' });
    const b = job({ jobNumber: 24_702, status: 'no_one_home', arrivedAt: null, endedAt: '09:50' });
    const [fa, fb] = fitPastVisitEnds([a, b]) as [FixtureJob, FixtureJob];
    const delta = 9 * 60 + FIT_WORK_MIN + FIT_DRIVE_MIN - doorMinute(b);
    expect(delta).toBeGreaterThan(0);
    expect(doorMinute(fb) - doorMinute(b)).toBe(delta);
    expect(hm(fb.endedAt as string) - hm(b.endedAt as string)).toBe(delta);
    expect(fb.arrivedAt).toBeNull();
    expect(hm(fa.endedAt as string) - 9 * 60).toBeGreaterThanOrEqual(FIT_WORK_MIN);
    expect(doorMinute(fb) - hm(fa.endedAt as string)).toBeGreaterThanOrEqual(FIT_DRIVE_MIN);
  });

  // why: F-1802 a move that would carry the next visit's end past the day's end is refused, never written out of range
  it('refuses a move past the end of the day', () => {
    expect(() => fitPastVisitEnds([job({ jobNumber: 1, arrivedAt: '23:00', endedAt: '23:50' }), job({ jobNumber: 2, arrivedAt: '23:10', endedAt: '23:40' })]))
      .toThrow(/past the day/);
  });

  // why: F-1546 a job that did not run (scheduled, no end) has no visit to fit and comes back as it went in
  it('leaves a job that did not run alone', () => {
    const s = job({ jobNumber: 9, status: 'scheduled', arrivedAt: null, endedAt: null });
    expect(fitPastVisitEnds([s])[0]).toBe(s);
  });
});
