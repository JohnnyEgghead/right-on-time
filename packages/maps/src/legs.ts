// SPDX-License-Identifier: AGPL-3.0-or-later
// The legs the bake routes (FR-MAP-5, SPECIFICATIONS section 6.10 and SD-22), computed from the seeded schedule: the world
// seed's fixture (packages/generator, seed 20260915), the verified street list and the committed technician roster. Nothing
// here is a model: a technician count or a jobs-per-day figure comes from the fixture, never from a document's story count (F-18).
//
// A job's point is its customer's street point, points[(house number - 1) mod point count] (SD-23). A technician's day runs
// depot -> job 1 -> ... -> job k -> depot, jobs in window order (then job number); a leg is keyed by (branch, from_ref, to_ref)
// where a ref is a job number or `depot` (the van_track entity). The covered days are the demo week, Mon Sep 14 to Fri Sep 18,
// 2026, and every clock preset day (FR-DEMO-5) that has jobs; on Sep 15 every ordered pair of that branch's jobs is also a leg.
// No job before Sep 14 (the past) gets a leg.
import { BRANCHES } from '../../db/src/seed/reference-data.ts';
import type { StreetListRow } from '../../db/src/street-list.ts';
import type { WorldFixture } from '../../setup/src/fixture.ts';

/** The demo week (FR-MAP-5): Mon, Sep 14 to Fri, Sep 18, 2026. */
export const DEMO_WEEK = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'] as const;
/** FR-DEMO-5's preset days: "6:00 PM reminder" (Sep 15), "Tomorrow 8:00 AM" (Sep 16), Sat Oct 31, Sun Nov 1, Sat Mar 13 2027, Sun Mar 14 2027. */
export const PRESET_DAYS = ['2026-09-15', '2026-09-16', '2026-10-31', '2026-11-01', '2027-03-13', '2027-03-14'] as const;
/** The day whose every same-branch job pair is baked. */
export const PAIR_DAY = '2026-09-15';

export interface RosterTechnician { employeeNumber: string; branch: string }

export interface Leg {
  branch_id: string;
  from_ref: string;
  to_ref: string;
  /** [lon, lat] */
  from: [number, number];
  to: [number, number];
}

export interface LegSet {
  legs: Leg[];
  /** Job numbers on a covered day, by day. */
  jobsByDay: Record<string, number[]>;
  counts: { days: number; jobs: number; technicianDays: number; techLegs: number; pairLegs: number; legs: number };
}

export const legKey = (l: { branch_id: string; from_ref: string; to_ref: string }): string => `${l.branch_id}|${l.from_ref}|${l.to_ref}`;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function buildLegs(fixture: WorldFixture, streets: readonly StreetListRow[], roster: readonly RosterTechnician[]): LegSet {
  const covered = new Set<string>([...DEMO_WEEK, ...PRESET_DAYS]);
  const street = new Map<string, StreetListRow>();
  for (const s of streets) street.set(`${s.name}|${s.city}|${s.zip}`, s);
  const customer = new Map(fixture.customers.map((c) => [c.ref, c]));
  const branchOf = new Map(roster.map((t) => [t.employeeNumber, t.branch]));
  const depot = new Map<string, [number, number]>(BRANCHES.map((b) => [b.id, [b.lon, b.lat]]));

  // tech is null for an Unassigned job (F-292): it is in no technician's day, but its branch's Sep 15 pairs and its depot legs
  // are baked, so the job an office person assigns has its drive.
  interface Stop { ref: string; branch: string; point: [number, number]; tech: string | null; day: string; start: string }
  const stops: Stop[] = [];
  for (const j of [...fixture.pilotJobs, ...fixture.demoWeekJobs]) {
    if (!covered.has(j.date)) continue;
    const c = customer.get(j.customer);
    if (!c) throw new Error(`job ${j.jobNumber}: customer ${j.customer} or technician ${j.technician} is not in the fixture or roster`);
    const s = street.get(`${c.street}|${c.city}|${c.zip}`);
    // F-1691: the street is tested before the branch, so an Unassigned job (no technician) with a missing street gets the street message.
    if (!s) throw new Error(`job ${j.jobNumber}: street ${c.street}, ${c.city} ${c.zip} is not in the street list`);
    const branch = j.technician === null ? s.branch : branchOf.get(j.technician);
    if (!branch) throw new Error(`job ${j.jobNumber}: customer ${j.customer} or technician ${j.technician} is not in the fixture or roster`);
    if (s.branch !== branch) throw new Error(`job ${j.jobNumber}: the street is in branch ${s.branch}, the technician in ${branch}`);
    const p = s.points[(c.houseNumber - 1) % s.points.length] as [number, number];
    stops.push({ ref: String(j.jobNumber), branch, point: p, tech: j.technician, day: j.date, start: j.windowStart });
  }

  const legs = new Map<string, Leg>();
  const add = (branch: string, from: Stop | null, to: Stop | null): void => {
    const d = depot.get(branch) as [number, number];
    const l: Leg = { branch_id: branch, from_ref: from ? from.ref : 'depot', to_ref: to ? to.ref : 'depot', from: from ? from.point : d, to: to ? to.point : d };
    legs.set(legKey(l), l);
  };

  const byTechDay = new Map<string, Stop[]>();
  for (const s of stops) {
    if (s.tech === null) {
      add(s.branch, null, s);
      add(s.branch, s, null);
      continue;
    }
    const k = `${s.tech}|${s.day}`;
    byTechDay.set(k, [...(byTechDay.get(k) ?? []), s]);
  }
  let techLegs = 0;
  for (const day of [...byTechDay.values()]) {
    day.sort((a, b) => cmp(a.start, b.start) || Number(a.ref) - Number(b.ref));
    const before = legs.size;
    add(day[0]!.branch, null, day[0]!);
    for (let i = 1; i < day.length; i++) add(day[0]!.branch, day[i - 1]!, day[i]!);
    add(day[0]!.branch, day[day.length - 1]!, null);
    techLegs += legs.size - before;
  }
  const afterTech = legs.size;
  const pairJobs = stops.filter((s) => s.day === PAIR_DAY);
  for (const a of pairJobs) for (const b of pairJobs) if (a !== b && a.branch === b.branch) add(a.branch, a, b);

  const jobsByDay: Record<string, number[]> = {};
  for (const s of stops) (jobsByDay[s.day] ??= []).push(Number(s.ref));
  const sorted = [...legs.values()].sort((x, y) => cmp(x.branch_id, y.branch_id) || cmp(x.from_ref, y.from_ref) || cmp(x.to_ref, y.to_ref));
  return {
    legs: sorted,
    jobsByDay,
    counts: { days: Object.keys(jobsByDay).length, jobs: stops.length, technicianDays: byTechDay.size, techLegs, pairLegs: legs.size - afterTech, legs: sorted.length },
  };
}
