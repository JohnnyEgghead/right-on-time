// SPDX-License-Identifier: AGPL-3.0-or-later
// Van positions (SPECIFICATIONS SD-22; REQUIREMENTS FR-DEMO-8): a van's position is COMPUTED ON READ from its baked track
// and the clock, never stored (there is no position table). Pure: the technician's day in, a point out.
//
// positionAt(technician, now): with a job on the way, the point along the leg's track (the previous stop to the job) at
// `now - on_the_way_at` seconds, held at the track's end; with a job on site, the job's customer point. Those 2 hold at any
// time, inside the shift or outside it (F-811): a van at work is where the live map draws it (FR-DEMO-8, "at any demo time"),
// and the chained week sends vans out past the shift end. With neither, before the shift start no position; after the
// shift end, the last ended job's point or the depot while the technician still has a job left that day (the gap between 2
// jobs, so a van between them does not vanish and come back), and no position once none is left; inside the shift, the
// same point. The previous stop is the technician's last ended job that day, else the depot. A leg with no baked track is
// a straight line between the 2 points, taking SD-22's approximate minutes.
//
// Invariant 5's server half (G-CI5): the customer-facing live map shows a position only while the visit's job is
// `on_the_way`; visitPosition answers null before On my way and from arrival on, and never reads a coordinate then.
import { approximateDriveMinutes, previousStop } from '../../domain/src/planner.ts';
import { stepVertexIndexes, type TrackStep } from './steps.ts';
import { decodePolyline, type TrackRow } from './tracks.ts';

export interface Point {
  lon: number;
  lat: number;
}

/** A baked leg: the polyline and the cumulative drive seconds per vertex (a `world.van_track` row's useful part). */
export type LegTrack = Pick<TrackRow, 'polyline' | 'seconds'>;

/** The track's drive seconds: its last cumulative second. */
export const trackSeconds = (t: Pick<LegTrack, 'seconds'>): number => t.seconds[t.seconds.length - 1] ?? 0;

/** SD-15's drive minutes of a baked leg: the last cumulative second / 60, rounded up. */
export const trackMinutes = (t: Pick<LegTrack, 'seconds'>): number => Math.ceil(trackSeconds(t) / 60);

/** The part of a baked track still to drive after `elapsedSeconds`: the van's point first, then the vertices after it, and the seconds left. */
interface TrackRemainder {
  vertices: [number, number][];
  seconds: number;
}

/**
 * The track left after `elapsedSeconds` (SD-22): the whole track for 0 or less, only its end once it is driven (held, not past it).
 * Its first vertex is the van's point, so {@link pointAlongTrack} and the route from the van (F-1003) cannot disagree.
 */
function trackRemainder(t: LegTrack, elapsedSeconds: number): TrackRemainder {
  const vertices = decodePolyline(t.polyline);
  const v = vanOnTrack(t, vertices, elapsedSeconds);
  return { vertices: [v.point, ...vertices.slice(v.next)], seconds: v.secondsLeft };
}

/**
 * Where the van is on a track after `elapsedSeconds` (SD-22), as an index: `point`, the vertex index `at` of the last vertex at or
 * before it, and `next`, the first vertex after it. The 1 walk {@link trackRemainder} (the route from the van) and
 * {@link stepsFromVan} (its steps) both read, so the leg's line and its first step start at the same point.
 */
export function vanOnTrack(t: Pick<LegTrack, 'seconds'>, vertices: readonly (readonly [number, number])[], elapsedSeconds: number): { point: [number, number]; at: number; next: number; secondsLeft: number } {
  const lastIdx = vertices.length - 1;
  const last = vertices[lastIdx];
  if (!last) throw new Error('a track with no vertices has no position');
  const total = trackSeconds(t);
  const end = { point: [last[0], last[1]] as [number, number], at: lastIdx, next: lastIdx + 1, secondsLeft: 0 };
  if (elapsedSeconds <= 0) return { point: [vertices[0]![0], vertices[0]![1]], at: 0, next: 1, secondsLeft: total };
  if (elapsedSeconds >= total) return end;
  for (let i = 0; i < lastIdx; i++) {
    const s0 = t.seconds[i] as number;
    const s1 = t.seconds[i + 1] as number;
    if (elapsedSeconds >= s0 && elapsedSeconds <= s1) {
      const f = s1 === s0 ? 0 : (elapsedSeconds - s0) / (s1 - s0);
      const [a, b] = [vertices[i] as [number, number], vertices[i + 1] as [number, number]];
      const point: [number, number] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      return f === 1 ? { point, at: i + 1, next: i + 2, secondsLeft: total - elapsedSeconds } : { point, at: i, next: i + 1, secondsLeft: total - elapsedSeconds };
    }
  }
  return end;
}

/**
 * The steps left from the van's position on a track (SPECIFICATIONS 6.3 Directions; UI-SPECIFICATION API-104, 12.4): from the step
 * whose span holds the van's point (the last step whose `at` vertex is at or before that point along the polyline), with that step's
 * `distanceMeters` the length left from the van's point to the next step's `at`, summed along the polyline as API-104's
 * `distanceMeters` from the van is (the haversine of SD-22); the steps after it as stored. On the last step (arrive) the list is that
 * step alone, with 0 left.
 */
export function stepsFromVan(t: LegTrack & { steps: readonly TrackStep[] }, elapsedSeconds: number): TrackStep[] {
  if (t.steps.length === 0) return [];
  const vertices = decodePolyline(t.polyline);
  const v = vanOnTrack(t, vertices, elapsedSeconds);
  const idx = stepVertexIndexes(t.steps, vertices);
  let k = 0;
  for (let j = 0; j < idx.length; j++) if ((idx[j] as number) <= v.at) k = j;
  const rest = t.steps.slice(k).map((s) => ({ ...s, at: [s.at[0], s.at[1]] as [number, number] }));
  let meters = 0;
  const to = idx[k + 1];
  if (to !== undefined) {
    let prev: readonly [number, number] = v.point;
    for (let j = v.next; j <= to; j++) {
      meters += haversineMeters(prev, vertices[j] as [number, number]);
      prev = vertices[j] as [number, number];
    }
  }
  (rest[0] as TrackStep).distanceMeters = Math.round(meters);
  return rest;
}

/** The point `elapsedSeconds` along a baked track: the start for 0 or less, the end once the track is driven (held, not past it). */
export function pointAlongTrack(t: LegTrack, elapsedSeconds: number): Point {
  const [lon, lat] = trackRemainder(t, elapsedSeconds).vertices[0] as [number, number];
  return { lon, lat };
}

/** Great-circle meters between 2 [lon, lat] points (the haversine of SD-22, on a 6371 km earth). */
export function haversineMeters(a: readonly [number, number], b: readonly [number, number]): number {
  const rad = Math.PI / 180;
  const h = Math.sin(((b[1] - a[1]) * rad) / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(((b[0] - a[0]) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A route from the van (the shape of API-104's leg): where it starts, the line left, its minutes and its length (null on an approximate line). */
export interface VanLeg {
  from: Point;
  track: [number, number][] | null;
  minutes: number;
  distanceMeters: number | null;
}

/**
 * The route from the van's computed position to the job it is on the way to (UI-SPECIFICATION API-104 "fromJob absent: from the van's
 * position", 12.4; SPECIFICATIONS 6.3 Drive time): on a baked track, the track left from the van's point, its seconds left / 60 rounded
 * up, and the summed haversine length of that polyline; with no track, the straight line from the van's point on it, SD-22's minutes
 * from there and no length. `from` and `to` are the leg's ends (the previous stop, else the depot, and the job), as positionAt has them.
 */
export function legFromVan(track: LegTrack | null, from: Point, to: Point, elapsedSeconds: number): VanLeg {
  if (!track) {
    const at = pointAlongLine(from, to, elapsedSeconds);
    return { from: at, track: null, minutes: approximateDriveMinutes(at, to), distanceMeters: null };
  }
  const left = trackRemainder(track, elapsedSeconds);
  let meters = 0;
  for (let i = 1; i < left.vertices.length; i++) meters += haversineMeters(left.vertices[i - 1]!, left.vertices[i]!);
  const [lon, lat] = left.vertices[0]!;
  return { from: { lon, lat }, track: left.vertices, minutes: Math.ceil(left.seconds / 60), distanceMeters: Math.round(meters) };
}

/** The point on the straight line `a` to `b` after `elapsedSeconds` of the approximate drive (SD-22), held at `b`. */
export function pointAlongLine(a: Point, b: Point, elapsedSeconds: number): Point {
  const total = approximateDriveMinutes(a, b) * 60;
  const f = Math.min(1, Math.max(0, elapsedSeconds / total));
  return { lon: a.lon + (b.lon - a.lon) * f, lat: a.lat + (b.lat - a.lat) * f };
}

export interface DayStop {
  jobNumber: number;
  status: string;
  /** The customer's point. */
  point: Point;
  /** Epoch milliseconds, null while not yet set. */
  onTheWayAt: number | null;
  endedAt: number | null;
}

export interface PositionInput {
  /** Demo now, epoch milliseconds. */
  now: number;
  shiftStart: number;
  shiftEnd: number;
  depot: Point;
  /** The technician's jobs that day. */
  stops: readonly DayStop[];
  /** The baked track from the previous stop (a job number, or null for the depot) to the job, or null where none was baked. */
  track(from: number | null, to: number): LegTrack | null;
}

/** SD-22 positionAt for 1 technician at demo `now`: a point, or null outside the shift for a van with no job in hand (F-811). */
export function positionAt(i: PositionInput): Point | null {
  const onWay = i.stops.filter((s) => s.status === 'on_the_way')
    .sort((x, y) => (y.onTheWayAt ?? 0) - (x.onTheWayAt ?? 0) || y.jobNumber - x.jobNumber)[0];
  if (onWay) {
    const prev = previousStop(i.stops, onWay.jobNumber);
    const elapsed = (i.now - (onWay.onTheWayAt ?? i.now)) / 1000;
    const track = i.track(prev?.jobNumber ?? null, onWay.jobNumber);
    return track ? pointAlongTrack(track, elapsed) : pointAlongLine(prev?.point ?? i.depot, onWay.point, elapsed);
  }
  const onSite = i.stops.find((s) => s.status === 'on_site');
  if (onSite) return onSite.point;
  if (i.now < i.shiftStart) return null;
  if (i.now > i.shiftEnd && !i.stops.some((s) => s.status === 'scheduled')) return null;
  return previousStop(i.stops, null)?.point ?? i.depot;
}

export interface VisitPositionInput {
  /** The visit's job status now. */
  status: string;
  onTheWayAt: number | null;
  now: number;
  /** The leg from the technician's previous stop to this job, with its endpoints, as {@link positionAt} resolves it. */
  from: Point;
  to: Point;
  track: LegTrack | null;
}

/**
 * What the customer's live map may show (invariant 5; FR-TEXT-4): the van's point only while the job is `on_the_way`, else
 * null. The point is computed here from the track and the clock; nothing is read or returned for any other status.
 */
export function visitPosition(i: VisitPositionInput): Point | null {
  if (i.status !== 'on_the_way') return null;
  const elapsed = (i.now - (i.onTheWayAt ?? i.now)) / 1000;
  return i.track ? pointAlongTrack(i.track, elapsed) : pointAlongLine(i.from, i.to, elapsed);
}
