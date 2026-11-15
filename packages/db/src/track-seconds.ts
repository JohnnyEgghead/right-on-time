// SPDX-License-Identifier: AGPL-3.0-or-later
// The baked tracks' drive times (SPECIFICATIONS SD-15): the last cumulative second of the van_track row of each leg, so
// the planner, the ETA and the sweep measure drive from the track and fall back to SD-22's approximate minutes only for
// a leg with no row. A leg is keyed `<from job number or depot>|<to job number>` (the planner's legRef).
// P6-LIVE-ROUTING (SD-49): the readers and writes of the running app take their legs from the route source (packages/maps
// route-source.ts: legFor, routedDrive), which routes a leg with no row live and stores it. This stored-rows-only read is setup's
// world seed's (packages/setup/src/world-seed.ts): setup routes nothing live, so the seeded world and its snapshot hold baked rows only.
import type { Queryable } from './client.ts';

export interface LegWanted {
  /** A job number, or null for the depot. */
  from: number | null;
  to: number;
}

const ref = (from: number | null, to: number): string => `${from ?? 'depot'}|${to}`;

/** The last cumulative second of each wanted leg that has a baked track in `branch`. Legs with no row are absent from the map. */
export async function legTrackSeconds(tx: Queryable, branch: string, legs: readonly LegWanted[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (legs.length === 0) return out;
  const wanted = new Set(legs.map((l) => ref(l.from, l.to)));
  const r = await tx.query<{ from_ref: string; to_ref: string; last: number | null }>(
    `SELECT from_ref, to_ref, seconds[cardinality(seconds)] AS last FROM world.van_track
      WHERE branch_id = $1 AND from_ref = ANY($2::text[]) AND to_ref = ANY($3::text[])`,
    [branch, [...new Set(legs.map((l) => (l.from === null ? 'depot' : String(l.from))))], [...new Set(legs.map((l) => String(l.to)))]]);
  for (const row of r.rows) {
    const key = `${row.from_ref}|${row.to_ref}`;
    if (row.last !== null && wanted.has(key)) out.set(key, row.last);
  }
  return out;
}
