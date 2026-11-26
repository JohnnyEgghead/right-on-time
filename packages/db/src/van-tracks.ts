// SPDX-License-Identifier: AGPL-3.0-or-later
// The track repository of the route source (SPECIFICATIONS v0.13 SD-49, section 3 `van_track`; P6-LIVE-ROUTING): the stored rows a leg is
// answered from, the live row a routed leg becomes, and the delete a point change makes. world.van_track has no unique key on its stop
// pair (setup loads the baked set once); a live row is kept to 1 per pair by the write protocol of {@link storeLiveTrack}, not by a
// constraint. @bw/maps's route source (packages/maps/src/route-source.ts) is the only caller of the read and the write; the point-change
// writes call {@link deleteTracksNaming}.
import type { Queryable } from './client.ts';

/** The `build_id` of a row the routing service answered (SD-49 step 2); a baked row carries its bake's id. */
export const LIVE_BUILD_ID = 'live';

/** pg_try_advisory_xact_lock class of a stop pair's live write ('vt'); the item keys use 0x7469, the billing link 0x6269. */
export const TRACK_LOCK_CLASS = 0x7674;

/** A stop's reference on a track: a job number, or `depot` (section 3 `van_track.from_ref`, `to_ref`). */
export type StopRef = string;

/** 1 stored track: the parts a reader answers from. */
export interface StoredTrack {
  polyline: string;
  seconds: number[];
  distance_m: number;
  /** The route steps of the leg, as stored (packages/maps/src/steps.ts TrackStep; SD-49). */
  steps: unknown[];
  build_id: string;
}

export interface Point {
  lon: number;
  lat: number;
}

const pairKey = (from: StopRef, to: StopRef): string => `${from}|${to}`;

/** The stored track of each wanted pair in `branch`, keyed `<from_ref>|<to_ref>`; a pair with no row is absent. A baked row wins over a live one. */
export async function readTracks(tx: Queryable, branch: string, pairs: readonly { from: StopRef; to: StopRef }[]): Promise<Map<string, StoredTrack>> {
  const out = new Map<string, StoredTrack>();
  if (pairs.length === 0) return out;
  const r = await tx.query<StoredTrack & { from_ref: string; to_ref: string }>(
    `SELECT DISTINCT ON (w.from_ref, w.to_ref) w.from_ref, w.to_ref, t.polyline, t.seconds, t.distance_m, t.steps, t.build_id
       FROM unnest($2::text[], $3::text[]) AS w(from_ref, to_ref)
       JOIN world.van_track t ON t.branch_id = $1 AND t.from_ref = w.from_ref AND t.to_ref = w.to_ref
      ORDER BY w.from_ref, w.to_ref, t.build_id = $4, t.id`,
    [branch, pairs.map((p) => p.from), pairs.map((p) => p.to), LIVE_BUILD_ID]);
  for (const { from_ref, to_ref, ...t } of r.rows) out.set(pairKey(from_ref, to_ref), t);
  return out;
}

/** What {@link storeLiveTrack} did. */
export type StoreOutcome =
  /** The row is written, in the caller's transaction. */
  | { kind: 'stored'; track: StoredTrack }
  /** Another reader stored the pair first; its row is the answer. */
  | { kind: 'present'; track: StoredTrack }
  /** Another transaction holds the pair's lock: it is storing the same route now. Nothing written. */
  | { kind: 'busy' }
  /** A stop's point is not the one routed, or a write holds its job or customer row (it may be changing the point). Nothing written. */
  | { kind: 'moved' };

/**
 * Store a routed leg as a live row (SD-49 step 2), in the caller's transaction. The protocol, so 2 readers of 1 new pair store 1 row
 * and no row outlives the point it was routed to:
 *   1. pg_try_advisory_xact_lock on the pair. A try, never a wait: a reader never blocks on another reader's routing, and a transaction
 *      that stores several pairs cannot deadlock on their order. Not taken: another transaction is storing the pair (`busy`).
 *   2. Read the pair again after the lock: a row another transaction committed since this one first read is the answer (`present`).
 *   3. Read each job stop's point FOR SHARE SKIP LOCKED (the job row and its customer row): a write that moves a job (merge,
 *      F-510) or its customer (an address edit) holds one of those rows until it commits, so a row it holds is skipped and nothing is
 *      stored (`moved`); a point that differs from the routed one is `moved` too. Once read, the share lock keeps either write waiting
 *      until this transaction commits, and that write's delete (deleteTracksNaming) then sees this row and removes it.
 *   4. Insert with `build_id` `live`.
 * A refused or rolled-back caller writes nothing, and the next read routes again. Live rows are world data (SD-12): the reset drops them.
 */
export async function storeLiveTrack(
  tx: Queryable, branch: string, leg: { from: StopRef; to: StopRef; fromPoint: Point; toPoint: Point }, track: Omit<StoredTrack, 'build_id'>,
): Promise<StoreOutcome> {
  const locked = await tx.query<{ ok: boolean }>(
    `SELECT pg_try_advisory_xact_lock($1, hashtext($2 || '|' || $3 || '|' || $4)) AS ok`, [TRACK_LOCK_CLASS, branch, leg.from, leg.to]);
  if (!locked.rows[0]?.ok) return { kind: 'busy' };
  const again = (await readTracks(tx, branch, [{ from: leg.from, to: leg.to }])).get(pairKey(leg.from, leg.to));
  if (again) return { kind: 'present', track: again };
  const wanted = new Map<number, Point>();
  for (const [ref, p] of [[leg.from, leg.fromPoint], [leg.to, leg.toPoint]] as const) if (ref !== 'depot') wanted.set(Number(ref), p);
  if (wanted.size > 0) {
    const rows = (await tx.query<{ job_number: number; lon: number; lat: number }>(
      `SELECT j.job_number, c.lon, c.lat FROM world.job j JOIN world.customer c ON c.id = j.customer_id
        WHERE j.job_number = ANY($1::int[]) FOR SHARE OF j, c SKIP LOCKED`, [[...wanted.keys()]])).rows;
    if (rows.length !== wanted.size) return { kind: 'moved' };
    for (const r of rows) {
      const p = wanted.get(r.job_number);
      if (!p || p.lon !== r.lon || p.lat !== r.lat) return { kind: 'moved' };
    }
  }
  if (leg.from === 'depot' || leg.to === 'depot') {
    const d = (await tx.query<{ lon: number; lat: number }>('SELECT depot_lon AS lon, depot_lat AS lat FROM world.branch WHERE id = $1', [branch])).rows[0];
    const p = leg.from === 'depot' ? leg.fromPoint : leg.toPoint;
    if (!d || d.lon !== p.lon || d.lat !== p.lat) return { kind: 'moved' };
  }
  const stored: StoredTrack = { ...track, build_id: LIVE_BUILD_ID };
  await tx.query(
    `INSERT INTO world.van_track (branch_id, from_ref, to_ref, polyline, seconds, distance_m, build_id, steps)
     VALUES ($1, $2, $3, $4, $5::int[], $6, $7, $8::jsonb)`,
    [branch, leg.from, leg.to, stored.polyline, stored.seconds, stored.distance_m, stored.build_id, JSON.stringify(stored.steps)]);
  return { kind: 'stored', track: stored };
}

/**
 * SD-49: a write that changes the point a job is driven to deletes every row naming that job, baked or live (the merge's move of a job
 * to a customer at another point, F-510; an address edit of the job's customer). Returns the rows deleted. Called after the write's
 * own update, in its transaction, so a reader storing the old point concurrently is either refused by step 3 of storeLiveTrack or
 * committed first and deleted here.
 */
export async function deleteTracksNaming(tx: Queryable, jobNumbers: readonly number[]): Promise<number> {
  if (jobNumbers.length === 0) return 0;
  const refs = [...new Set(jobNumbers.map(String))];
  const r = await tx.query('DELETE FROM world.van_track WHERE from_ref = ANY($1::text[]) OR to_ref = ANY($1::text[])', [refs]);
  return r.rowCount ?? 0;
}
