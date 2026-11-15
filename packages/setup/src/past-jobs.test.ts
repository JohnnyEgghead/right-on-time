// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1541 (owner ruling 9796c392, Nov 13, 2026: "Fill them in"), SD-25, FR-BILL-3
// The pure half of the past pilot jobs' records (past-jobs.ts planPastJob): the steps a job's outcome takes, their times against the
// fixture's outcome columns, the finish the validator accepts, the notes, and that every choice is a function of the job alone.
import { describe, expect, it } from 'vitest';
import { finishLines } from '@bw/domain';
import { SERVICES } from '../../db/src/seed/reference-data.ts';
import type { FixtureJob } from './fixture.ts';
import { NOTE_EVERY, pastJobItems, pastJobVersion, pick, planPastJob, seedUuid, WORK_DONE } from './past-jobs.ts';

const at = (date: string, time: string): Date => new Date(`${date}T${time}:00-04:00`);
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
