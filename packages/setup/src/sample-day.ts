// SPDX-License-Identifier: AGPL-3.0-or-later
// 1 seeded technician-day of the demo week: SD-15's plan, then the script chained on it (SD-21; owner answer 36d87aec "Chain
// each visit"). The world seed runs this with the real points and drive minutes, and the census test runs it over the
// generated fixture, so both read the same rule. Pure: times are epoch milliseconds.
import { planDay, type DriveMinutes, type PlannedStop, type Point } from '@bw/domain';
import { chainVisits, type ChainedVisit, type ChainVisit, type VisitScript } from '@bw/generator';

export interface SampleDayJob {
  jobNumber: number;
  windowStart: number;
  bookedAt: number;
  expectedMinutes: number;
  point: Point;
}

export interface SampleDayInput {
  shiftStart: number;
  depot: Point;
  /** The technician's jobs that day, in any order. */
  jobs: readonly SampleDayJob[];
  drive: DriveMinutes;
  /** The script rows by job number; a job with none waits for a visitor (SD-21). */
  script: ReadonlyMap<number, VisitScript>;
}

export function sampleDay(d: SampleDayInput): { planned: PlannedStop[]; steps: ChainedVisit[] } {
  const planned = planDay({ shiftStart: d.shiftStart, depot: d.depot, stops: d.jobs, drive: d.drive });
  const byNumber = new Map(d.jobs.map((j) => [j.jobNumber, j]));
  const visits: ChainVisit[] = [];
  let at = d.depot;
  let from: number | null = null;
  for (const p of planned) {
    const point = (byNumber.get(p.jobNumber) as SampleDayJob).point;
    const script = d.script.get(p.jobNumber);
    if (script) visits.push({ jobNumber: p.jobNumber, plannedArrival: p.plannedArrival, driveMinutes: d.drive(at, point, from, p.jobNumber), script });
    at = point;
    from = p.jobNumber;
  }
  return { planned, steps: chainVisits(d.shiftStart, visits) };
}
