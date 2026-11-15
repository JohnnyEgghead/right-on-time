// SPDX-License-Identifier: AGPL-3.0-or-later
// The sample day's chain (owner answer 36d87aec "Chain each visit", SD-21, SD-15): each scripted visit starts after the
// previous one ends, keeping every scripted delay. The generator's fixture holds the script's minutes; the drive minutes
// exist only once setup has the customers' points and the baked tracks, so the world seed calls this with them, in step 5.
// Pure: 1 technician-day's plan and script in, the 3 step times out. Times are epoch milliseconds.

const MINUTE = 60_000;

/** A fixture script row's minutes (the old script's values, unchanged). */
export interface VisitScript {
  onMyWayLeadMinutes: number;
  arrivalDelayMinutes: number;
  workMinutes: number;
}

export interface ChainVisit {
  jobNumber: number;
  /** SD-15's planned arrival. */
  plannedArrival: number;
  /** SD-15's drive minutes of the leg from the stop before (the depot for the first visit). */
  driveMinutes: number;
  script: VisitScript;
}

export interface ChainedVisit {
  jobNumber: number;
  onMyWay: number;
  arrived: number;
  ended: number;
}

/**
 * The step times of 1 technician-day's scripted visits, in SD-15's order. `ready` is when the technician can first leave:
 * the shift start (the only value any caller passes; sample-day.ts passes `shiftStart`).
 *
 * A visit starts at the later of its planned arrival and what the stop before leaves room for, and arrives its scripted
 * delay after that start. The room is the drive, and the On my way lead, which counts from the arrival: the technician
 * leaves at or after `ready`, never during the visit before. A positive delay is added on top of the drive, so a chained
 * visit runs as late as the script says; an early one comes off the start, never below the drive.
 */
export function chainVisits(ready: number, visits: readonly ChainVisit[]): ChainedVisit[] {
  const out: ChainedVisit[] = [];
  let free = ready;
  for (const v of visits) {
    const { onMyWayLeadMinutes: lead, arrivalDelayMinutes: delay, workMinutes: work } = v.script;
    const arrived = Math.max(
      v.plannedArrival + delay * MINUTE,
      free + (v.driveMinutes + Math.max(delay, 0)) * MINUTE,
      free + lead * MINUTE,
    );
    const ended = arrived + work * MINUTE;
    out.push({ jobNumber: v.jobNumber, onMyWay: arrived - lead * MINUTE, arrived, ended });
    free = ended;
  }
  return out;
}
