// SPDX-License-Identifier: AGPL-3.0-or-later
// P2-SEED: the seed loads the real bundled street list (SD-23) after the branches it names, and a second run adds nothing.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readStreetList } from '../street-list.ts';
import { useMigratedDatabase } from '../testing/fixture.ts';
import { seedReference } from './index.ts';

const LIST = process.env['BW_STREET_LIST'] ?? path.resolve(import.meta.dirname, '..', '..', '..', '..', '.build', 'data', 'street-list.json');
const db = useMigratedDatabase();

describe('the seed and the street list', () => {
  // why: SD-23 the seed writes the branches, then loads every row of the real street list once
  it('loads every street of the real file into world.street on the first run and none on the second', async () => {
    const streetList = readStreetList(LIST);
    const opts = { sampleSeed: 'test-seed-0123456789ab', anchorReal: new Date('2026-11-01T16:00:00Z'), streetList };
    const a = db.admin();
    await a.query('BEGIN');
    const first = await seedReference(a, opts);
    const second = await seedReference(a, opts);
    await a.query('COMMIT');
    expect(first.streetsLoaded).toBe(streetList.length);
    expect(second.streetsLoaded).toBe(0);
    const n = await a.query<{ n: string; b: string }>('SELECT count(*) AS n, count(DISTINCT branch_id) AS b FROM world.street');
    expect(Number(n.rows[0]?.n)).toBe(streetList.length);
    expect(Number(n.rows[0]?.b)).toBe(3);
  });
});
