// SPDX-License-Identifier: AGPL-3.0-or-later
// P2-STREETS: the real street list loads into world.street (all 3 branches, every row) and the rows read back as built.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { foldStreetName, loadStreetList, readStreetList } from './street-list.ts';
import { useMigratedDatabase } from './testing/fixture.ts';

const LIST = process.env['BW_STREET_LIST'] ?? path.resolve(import.meta.dirname, '..', '..', '..', '.build', 'data', 'street-list.json');
const db = useMigratedDatabase();

describe('loading the street list', () => {
  // why: SD-23
  it('inserts every row of the real file into world.street with folded names and the points as jsonb', async () => {
    const rows = readStreetList(LIST);
    await db.asRole('postgres', async (q) => {
      for (const b of ['columbus', 'dayton', 'springfield']) {
        await q.query(`INSERT INTO world.branch (id, name_key, zone, office_phone, depot_lon, depot_lat, map_file)
                       VALUES ($1, $2, 'America/New_York', '(614) 555-0100', -83.0, 39.96, $3)`, [b, `branch.${b}`, `${b}.pmtiles`]);
      }
      expect(await loadStreetList(q, rows)).toBe(rows.length);
      const n = await q.query<{ n: string }>('SELECT count(*) AS n FROM world.street');
      expect(Number(n.rows[0]?.n)).toBe(rows.length);
      const abbey = await q.query<{ zip: string; name_search: string; npts: number }>(
        `SELECT zip, name_search, jsonb_array_length(points) AS npts FROM world.street
          WHERE branch_id = 'columbus' AND name = 'Abbey Church Road' AND city = 'Columbus' ORDER BY zip`);
      expect(abbey.rows.map((r) => r.zip)).toEqual(['43017', '43235']);
      expect(abbey.rows[0]?.name_search).toBe(foldStreetName('Abbey Church Road'));
    });
  });
});
