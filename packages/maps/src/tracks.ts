// SPDX-License-Identifier: AGPL-3.0-or-later
// The baked track set (FR-MAP-5, SPECIFICATIONS section 6.10 and the van_track entity): tracks.ndjson holds 1 JSON object per
// line, one per leg: { branch_id, from_ref, to_ref, polyline, seconds, distance_m, build_id, steps }. The polyline is a precision-5
// encoded polyline; `seconds` is the cumulative drive seconds per vertex (D7); `steps` is the turn-by-turn steps of SD-49's step
// mapping (steps.ts; P6-ROUTE-BAKE). Setup loads each line as a world.van_track row, its steps included.
//
// This file imports types only, so the bake ships it into its node container as is (the polyline decoder; infra/data/maps/run.sh).
import type { TrackStep } from './steps.ts';

export interface TrackRow {
  branch_id: string;
  from_ref: string;
  to_ref: string;
  polyline: string;
  seconds: number[];
  distance_m: number;
  build_id: string;
  steps: TrackStep[];
}

/** The structural slice of a database client the loader needs (@bw/db's Queryable satisfies it). */
export interface TrackDb {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** Decode a precision-5 polyline to [lon, lat] pairs. */
export function decodePolyline(s: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = (): number => {
    let shift = 0;
    let result = 0;
    let b: number;
    do {
      if (i >= s.length) throw new Error('polyline ends inside a value');
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) {
    lat += next();
    lon += next();
    out.push([lon / 1e5, lat / 1e5]);
  }
  return out;
}

/**
 * Encode [lon, lat] pairs as a precision-5 polyline: the bake's encoder (infra/data/maps/bake.mjs `encode`), byte for byte, so a live
 * row's polyline is the one the bake would have written for the same route (SD-49 step 2). The inverse of {@link decodePolyline}.
 */
export function encodePolyline(coords: readonly (readonly [number, number])[]): string {
  const one = (n: number): string => {
    let v = n < 0 ? ~(n << 1) : n << 1;
    let out = '';
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return out + String.fromCharCode(v + 63);
  };
  let plat = 0;
  let plon = 0;
  let out = '';
  for (const [lon, lat] of coords) {
    const la = Math.round(lat * 1e5);
    const lo = Math.round(lon * 1e5);
    out += one(la - plat) + one(lo - plon);
    plat = la;
    plon = lo;
  }
  return out;
}

/** Parse tracks.ndjson. A malformed line throws with its line number. */
export function parseTracks(text: string): TrackRow[] {
  const rows: TrackRow[] = [];
  const lines = text.split('\n');
  lines.forEach((line, n) => {
    if (line === '') return;
    let r: TrackRow;
    try {
      r = JSON.parse(line) as TrackRow;
    } catch {
      throw new Error(`tracks.ndjson line ${n + 1} is not JSON`);
    }
    if (typeof r.branch_id !== 'string' || typeof r.from_ref !== 'string' || typeof r.to_ref !== 'string' || typeof r.polyline !== 'string'
      || !Array.isArray(r.seconds) || !Number.isInteger(r.distance_m) || typeof r.build_id !== 'string' || !Array.isArray(r.steps)) {
      throw new Error(`tracks.ndjson line ${n + 1} is malformed`);
    }
    rows.push(r);
  });
  return rows;
}

export const trackKey = (branch: string, from: string, to: string): string => `${branch}|${from}|${to}`;

const CHUNK = 500;

/** Insert every track into world.van_track, its steps included, 500 rows per statement, in the caller's transaction. Returns the row count. */
export async function loadVanTracks(db: TrackDb, rows: readonly TrackRow[]): Promise<number> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const values = part.map((r, j) => {
      params.push(r.branch_id, r.from_ref, r.to_ref, r.polyline, r.seconds, r.distance_m, r.build_id, JSON.stringify(r.steps));
      const b = j * 8;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::integer[], $${b + 6}, $${b + 7}, $${b + 8}::jsonb)`;
    });
    await db.query(`INSERT INTO world.van_track (branch_id, from_ref, to_ref, polyline, seconds, distance_m, build_id, steps) VALUES ${values.join(', ')}`, params);
  }
  return rows.length;
}
