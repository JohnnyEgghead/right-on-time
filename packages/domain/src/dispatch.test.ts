// SPDX-License-Identifier: AGPL-3.0-or-later
// The pure dispatch rules (SPECIFICATIONS SD-26, SD-28, SD-45). The database writes that use them are tested on
// PostgreSQL in packages/api-server/src/office-writes/dispatch-rules.db.test.ts.
import { describe, expect, it } from 'vitest';
import { keepTechnicianOnReschedule, rankTechnicians, skillMatch, timeOffOutcome, type RankFacts } from './index.ts';

const t = (over: Partial<RankFacts> & { id: string }): RankFacts => ({
  name: over.id, skill: 'primary', room: true, driveMinutes: 10, jobsThatDay: 2, capacity: 5, ...over,
});
const order = (facts: RankFacts[]): string[] => rankTechnicians(facts).map((r) => r.technicianId);

describe('suggested technician ranking (SD-26)', () => {
  // why: SD-26
  it('finds the primary skill before a secondary one, then fewer drive minutes, then lighter load, then name', () => {
    expect(order([
      t({ id: 'd-second', skill: 'secondary', driveMinutes: 1 }),
      t({ id: 'c-far', driveMinutes: 20 }),
      t({ id: 'b-near-busy', driveMinutes: 5, jobsThatDay: 4 }),
      t({ id: 'a-near-light', driveMinutes: 5, jobsThatDay: 1 }),
    ])).toEqual(['a-near-light', 'b-near-busy', 'c-far', 'd-second']);
    expect(order([t({ id: 'zed', name: 'Zed' }), t({ id: 'amy', name: 'Amy' })])).toEqual(['amy', 'zed']);
  });

  // why: SD-26
  it('orders by load ratio, not job count, when capacities differ', () => {
    expect(order([
      t({ id: 'installer', jobsThatDay: 1, capacity: 1 }),
      t({ id: 'regular', jobsThatDay: 2, capacity: 5 }),
    ])).toEqual(['regular', 'installer']);
  });

  // why: SD-26
  it('returns a technician without the skill last with suggested false and reason skill_missing, and one without room with room false', () => {
    const ranked = rankTechnicians([
      t({ id: 'no-skill', skill: 'none', driveMinutes: 0 }),
      t({ id: 'full', room: false, driveMinutes: 1 }),
      t({ id: 'ok', driveMinutes: 30 }),
    ]);
    expect(ranked.map((r) => r.technicianId)).toEqual(['ok', 'full', 'no-skill']);
    expect(ranked[2]).toMatchObject({ suggested: false, reason: 'skill_missing' });
    expect(ranked[1]).toMatchObject({ suggested: true, room: false, reason: null });
    expect(ranked[0]).toMatchObject({ suggested: true, room: true });
  });

  // why: SD-26
  it('reads a technician skill as primary, secondary or none', () => {
    const tech = { primarySkill: 'furnace', skills: ['furnace', 'ac'] };
    expect([skillMatch(tech, 'furnace'), skillMatch(tech, 'ac'), skillMatch(tech, 'install')]).toEqual(['primary', 'secondary', 'none']);
  });
});

describe('time off over booked jobs (SD-28)', () => {
  // why: SD-28
  it('refuses while a job is on the way or on site, naming the jobs', () => {
    expect(timeOffOutcome([{ jobNumber: 1, status: 'scheduled' }, { jobNumber: 2, status: 'on_the_way' }, { jobNumber: 3, status: 'on_site' }]))
      .toEqual({ refused: [2, 3], unassign: [] });
  });

  // why: SD-28
  it('unassigns only the scheduled jobs and leaves finished and canceled ones where they are', () => {
    expect(timeOffOutcome([
      { jobNumber: 1, status: 'scheduled' }, { jobNumber: 2, status: 'done' }, { jobNumber: 3, status: 'canceled' },
      { jobNumber: 4, status: 'no_one_home' }, { jobNumber: 5, status: 'scheduled' },
    ])).toEqual({ refused: [], unassign: [1, 5] });
    expect(timeOffOutcome([])).toEqual({ refused: [], unassign: [] });
  });
});

describe('reschedule keeps the technician or unassigns (SD-45)', () => {
  const ok = { assigned: true, worksNewDate: true, hasRoom: true, blockOverlap: false };

  // why: SD-45
  it('keeps the technician who works the new date, has room and no block overlap', () => {
    expect(keepTechnicianOnReschedule(ok)).toBe(true);
  });

  // why: SD-45
  it.each([
    ['does not work the new date or has time off', { worksNewDate: false }],
    ['has no room in the new window', { hasRoom: false }],
    ['has a block overlapping the new plan', { blockOverlap: true }],
    ['was Unassigned already', { assigned: false }],
  ])('unassigns when the technician %s', (_name, over) => {
    expect(keepTechnicianOnReschedule({ ...ok, ...over })).toBe(false);
  });
});
