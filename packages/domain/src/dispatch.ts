// SPDX-License-Identifier: AGPL-3.0-or-later
// The dispatch rules (SPECIFICATIONS SD-26, SD-28, SD-45). Pure: facts in, a decision out. The office write service
// (api-server/src/office-writes) reads the facts under the locks of section 5.3 and acts on what these return.

export type SkillMatch = 'primary' | 'secondary' | 'none';

/** How a technician holds a service's skill: as the primary skill, as a secondary skill, or not at all (SD-26 order 1). */
export function skillMatch(t: { primarySkill: string; skills: readonly string[] }, skill: string): SkillMatch {
  if (t.primarySkill === skill) return 'primary';
  return t.skills.includes(skill) ? 'secondary' : 'none';
}

export interface RankFacts {
  id: string;
  name: string;
  skill: SkillMatch;
  /** Whether the technician has room: live jobs that day under their daily capacity, and live jobs in the job's window under the window's limit (SD-27). */
  room: boolean;
  /** Drive minutes from the stop before the window that day (the previous job in the plan, else the depot). */
  driveMinutes: number;
  jobsThatDay: number;
  capacity: number;
}

export interface Ranked {
  technicianId: string;
  name: string;
  suggested: boolean;
  reason: 'skill_missing' | null;
  room: boolean;
  driveMinutes: number;
  loadRatio: number;
}

const loadRatio = (t: RankFacts): number => (t.capacity > 0 ? t.jobsThatDay / t.capacity : 1);
const SKILL_ORDER: Readonly<Record<SkillMatch, number>> = { primary: 0, secondary: 1, none: 2 };
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * SD-26: the branch's technicians who work the date with no time off, ordered by (1) skill match, primary before
 * secondary, (2) drive minutes from the stop before, lowest first, (3) load ratio, lowest first, (4) name. A technician
 * without the skill comes after the candidates with `suggested = false` and reason `skill_missing`; one without room is
 * returned with `room = false`. Reading of the spec (reported with P3-DISPATCH-RULES): the groups run candidates (skill
 * and room), then skilled without room, then without the skill, each group in the 4-key order above.
 */
export function rankTechnicians(candidates: readonly RankFacts[]): Ranked[] {
  const group = (t: RankFacts): number => (t.skill === 'none' ? 2 : t.room ? 0 : 1);
  return [...candidates]
    .sort((a, b) =>
      group(a) - group(b)
      || SKILL_ORDER[a.skill] - SKILL_ORDER[b.skill]
      || a.driveMinutes - b.driveMinutes
      || loadRatio(a) - loadRatio(b)
      || byName(a.name, b.name)
      || byName(a.id, b.id))
    .map((t) => ({
      technicianId: t.id, name: t.name, suggested: t.skill !== 'none', reason: t.skill === 'none' ? 'skill_missing' : null,
      room: t.room, driveMinutes: t.driveMinutes, loadRatio: loadRatio(t),
    }));
}

/** SD-28: statuses that make time off over a job refused (the technician is out on it). */
export const TIME_OFF_REFUSING_STATUSES: readonly string[] = ['on_the_way', 'on_site'];

export interface SpanJob {
  jobNumber: number;
  status: string;
}

/**
 * SD-28: how time off over a technician's jobs in the span resolves. Refused (with the job numbers in the way) while
 * any job is on the way or on site; otherwise the scheduled jobs come off the technician. A done, no-one-home or
 * canceled job stays where it is.
 */
export function timeOffOutcome(jobs: readonly SpanJob[]): { refused: number[]; unassign: number[] } {
  const refused = jobs.filter((j) => TIME_OFF_REFUSING_STATUSES.includes(j.status)).map((j) => j.jobNumber);
  if (refused.length > 0) return { refused, unassign: [] };
  return { refused: [], unassign: jobs.filter((j) => j.status === 'scheduled').map((j) => j.jobNumber) };
}

/**
 * SD-45: a reschedule keeps the technician when they work the new date (time off counts as not working), have room in
 * the new window and no block overlap with the new day's plan; otherwise the job becomes Unassigned. A job with no
 * technician stays Unassigned.
 */
export function keepTechnicianOnReschedule(input: {
  assigned: boolean; worksNewDate: boolean; hasRoom: boolean; blockOverlap: boolean;
}): boolean {
  return input.assigned && input.worksNewDate && input.hasRoom && !input.blockOverlap;
}
