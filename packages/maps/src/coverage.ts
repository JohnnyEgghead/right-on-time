// SPDX-License-Identifier: AGPL-3.0-or-later
// FR-MAP-5's coverage check: every leg of the seeded demo week (each technician's depot and job-to-job legs) and every
// same-branch job pair of Sep 15 has a baked track, and no track names a job outside the covered days (no past visits).
import { legKey, type LegSet } from './legs.ts';
import { decodePolyline, trackKey, type TrackRow } from './tracks.ts';

export interface CoverageResult {
  legs: number;
  tracks: number;
  /** Required legs with no track (keys). */
  missing: string[];
  /** Tracks naming a ref that is not `depot` or a covered job. */
  outside: string[];
  /** Tracks whose polyline, seconds or distance cannot be drawn. */
  bad: string[];
}

export function checkCoverage(set: LegSet, tracks: readonly TrackRow[]): CoverageResult {
  const have = new Map(tracks.map((t) => [trackKey(t.branch_id, t.from_ref, t.to_ref), t]));
  const missing = set.legs.map(legKey).filter((k) => !have.has(k));
  const covered = new Set(Object.values(set.jobsByDay).flat().map(String));
  const outside = tracks
    .filter((t) => (t.from_ref !== 'depot' && !covered.has(t.from_ref)) || (t.to_ref !== 'depot' && !covered.has(t.to_ref)))
    .map((t) => trackKey(t.branch_id, t.from_ref, t.to_ref));
  const bad: string[] = [];
  for (const t of tracks) {
    const pts = decodePolyline(t.polyline).length;
    const s = t.seconds;
    const ok = pts >= 2 && s.length === pts && s[0] === 0 && s.every((v, i) => Number.isInteger(v) && (i === 0 || v >= (s[i - 1] as number))) && t.distance_m >= 0;
    if (!ok) bad.push(trackKey(t.branch_id, t.from_ref, t.to_ref));
  }
  return { legs: set.legs.length, tracks: tracks.length, missing, outside, bad };
}
