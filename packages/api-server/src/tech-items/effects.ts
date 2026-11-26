// SPDX-License-Identifier: AGPL-3.0-or-later
// The derived effects of an applied status item (SPECIFICATIONS section 5.1 step 7): the ETA an
// applied On my way hands to the on-the-way text trigger (SD-15), and the end of the visit's live map with the cancel
// of any unsent on-the-way text at an arrival or an ending (section 5.2 step 5, FR-TEXT-4, FR-TEXT-19). Both run in the
// item's transaction. A history-only On my way (section 5.1 step 9) never reaches here.
//
// The on-the-way text itself, its live map token and `texted_arrival` are made by sendOnTheWay (@bw/outbox, FR-TEXT-3,
// F-470): applyStatus calls it with the ETA below, so there is exactly 1 on-the-way trigger.
import type { Queryable } from '@bw/db';
import { cancelOnTheWayText, REASON } from '@bw/outbox';
import type { Instant } from '@bw/time';
import { legFor } from '../../../maps/src/route-source.ts';
import { readPreviousStop } from '../office-writes/day.ts';

/**
 * The ETA of a visit while on the way (SD-15): the start + the leg's drive from the previous stop (the last ended job that day, else the
 * depot) from the route source (SD-49): the track's (baked, else live) last cumulative second / 60 rounded up, else SD-22's approximate
 * minutes (F-380). Whole minutes,
 * as the planner's, so a van that leaves when the plan says arrives when the plan says.
 */
export async function onTheWayEta(tx: Queryable, job: { jobNumber: number }, at: Instant): Promise<Instant> {
  const j = (await tx.query<{ branch_id: string; technician_id: string | null; date: string; to_lon: number; to_lat: number; depot_lon: number; depot_lat: number }>(
    `SELECT j.branch_id, j.technician_id, j.date::text AS date, c.lon AS to_lon, c.lat AS to_lat, b.depot_lon, b.depot_lat
       FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.branch b ON b.id = j.branch_id
      WHERE j.job_number = $1`, [job.jobNumber])).rows[0];
  if (!j || j.technician_id === null) return at;
  const prev = await readPreviousStop(tx, j.technician_id, j.date, job.jobNumber);
  const from = prev ? { lon: prev.lon, lat: prev.lat } : { lon: j.depot_lon, lat: j.depot_lat };
  const { minutes } = await legFor(tx, j.branch_id, { job: prev?.jobNumber ?? null, ...from }, { job: job.jobNumber, lon: j.to_lon, lat: j.to_lat });
  return at.add({ minutes });
}

/**
 * An arrival or an ending recorded: the live map ends and an on-the-way text not yet delivered is canceled. The office's
 * cancel, reassign or reschedule of a job On the way or On site takes the same end (owner rulings 2142ce69 and 7ccb76ec
 * call 8; office-writes/service.ts), with reason visitChanged.
 */
export async function endOnTheWay(tx: Queryable, input: { jobNumber: number; at: Instant; reason?: string }): Promise<void> {
  await tx.query(
    `UPDATE world.link_token SET ended_at = GREATEST(created_at, $2::timestamptz)
      WHERE job_number = $1 AND kind = 'live_map' AND ended_at IS NULL`, [input.jobNumber, input.at.toString()]);
  await cancelOnTheWayText(tx, input.jobNumber, input.reason ?? REASON.arrivedFirst);
}
