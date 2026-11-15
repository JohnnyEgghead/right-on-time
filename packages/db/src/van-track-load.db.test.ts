// SPDX-License-Identifier: AGPL-3.0-or-later
// P3-MAPS-BAKE: setup's track loader writes world.van_track rows (id by default, seconds as integer[]) that read back as built.
// P6-ROUTE-BAKE: and the steps as jsonb (migration 0024), read back field for field; a row written without steps holds the empty list.
import { describe, expect, it } from 'vitest';
import { loadVanTracks, type TrackRow } from '../../maps/src/tracks.ts';
import { useMigratedDatabase } from './testing/fixture.ts';

const db = useMigratedDatabase();

const STEPS: TrackRow['steps'] = [
  { kind: 'depart', direction: null, heading: 'n', road: 'Cleveland Ave', exit: null, side: null, at: [-83.0, 39.96], distanceMeters: 480 },
  { kind: 'roundabout', direction: null, heading: null, road: null, exit: 2, side: null, at: [-83.00123, 39.96456], distanceMeters: 420 },
  { kind: 'arrive', direction: null, heading: null, road: 'Cobblestone Dr', exit: null, side: 'right', at: [-83.01, 39.97], distanceMeters: 0 },
];

describe('loading the baked track set', () => {
  // why: FR-MAP-5
  it('inserts tracks into world.van_track with a generated id and the cumulative seconds array', async () => {
    const rows: TrackRow[] = Array.from({ length: 1001 }, (_, i) => ({
      branch_id: 'columbus', from_ref: i === 0 ? 'depot' : String(24800 + i), to_ref: String(24801 + i), polyline: '_p~iF~ps|U_ulLnnqC', seconds: [0, 12, 40 + i], distance_m: 900 + i, build_id: 'ohio-261001+osrm-v26.10.0', steps: STEPS,
    }));
    await db.asRole('postgres', async (q) => {
      await q.query(`INSERT INTO world.branch (id, name_key, zone, office_phone, depot_lon, depot_lat, map_file)
                     VALUES ('columbus', 'branch.columbus', 'America/New_York', '(614) 555-0100', -83.0, 39.96, 'columbus.pmtiles')`);
      expect(await loadVanTracks(q, rows)).toBe(1001);
      const r = await q.query<{ n: string; ids: string }>('SELECT count(*) AS n, count(DISTINCT id) AS ids FROM world.van_track');
      expect([r.rows[0]?.n, r.rows[0]?.ids]).toEqual(['1001', '1001']);
      const one = await q.query<{ seconds: number[]; distance_m: number; from_ref: string; steps: unknown }>(
        `SELECT seconds, distance_m, from_ref, steps FROM world.van_track WHERE to_ref = '24801'`);
      expect(one.rows[0]).toEqual({ seconds: [0, 12, 40], distance_m: 900, from_ref: 'depot', steps: STEPS });
    });
  });

  // why: FR-TECH-5
  it('holds the empty list for a row written without steps, and refuses steps that are not a list', async () => {
    await db.asRole('postgres', async (q) => {
      await q.query(`INSERT INTO world.branch (id, name_key, zone, office_phone, depot_lon, depot_lat, map_file)
                     VALUES ('columbus', 'branch.columbus', 'America/New_York', '(614) 555-0100', -83.0, 39.96, 'columbus.pmtiles')`);
      await q.query(`INSERT INTO world.van_track (branch_id, from_ref, to_ref, polyline, seconds, distance_m, build_id)
                     VALUES ('columbus', 'depot', '1', '_p~iF~ps|U', '{0,5}', 10, 'b')`);
      expect((await q.query<{ steps: unknown }>(`SELECT steps FROM world.van_track WHERE to_ref = '1'`)).rows[0]?.steps).toEqual([]);
      await expect(q.query(`INSERT INTO world.van_track (branch_id, from_ref, to_ref, polyline, seconds, distance_m, build_id, steps)
                            VALUES ('columbus', 'depot', '2', '_p~iF~ps|U', '{0,5}', 10, 'b', '{"kind":"depart"}')`)).rejects.toThrow(/van_track_steps_array/);
    });
  });
});
