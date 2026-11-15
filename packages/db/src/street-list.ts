// SPDX-License-Identifier: AGPL-3.0-or-later
// The bundled street list (SPECIFICATIONS SD-23): read the built file and load it as world.street reference rows.
// The file is built by infra/data/p2-streets (docs/build/spikes/P2-STREETS.md) and shipped as a release asset, never in git.
// Street names are OpenStreetMap data under the ODbL (credit: (c) OpenStreetMap contributors); city and ZIP are
// US Census TIGER/Line 2024 (public domain). This module and the file carry no house number: those are made up later (OA-41).
import { manifestAsset, readVerifiedAsset } from './data-asset.ts';
import type { Queryable } from './client.ts';
import { foldStreetName } from './fold.ts';

// The fold lives in fold.ts (no file access); re-exported here for the generator's imports of this module.
export { foldStreetName };

export interface StreetListRow {
  branch: string;
  name: string;
  city: string;
  zip: string;
  /** 1 to 8 on-street points, each [lon, lat]. */
  points: [number, number][];
}

/** Read the street list after verifying its size and SHA-256 against packages/db/src/data-manifest.json (F-164); a missing or bad file throws and names the fix. */
export function readStreetList(path: string): StreetListRow[] {
  return JSON.parse(readVerifiedAsset(manifestAsset('street-list.json'), path).toString('utf8')) as StreetListRow[];
}

const CHUNK = 1000;

/** Insert every row into world.street, 1000 rows per statement, in the caller's transaction. Returns the row count. */
export async function loadStreetList(db: Queryable, rows: readonly StreetListRow[]): Promise<number> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const values = part.map((r, j) => {
      params.push(r.name, foldStreetName(r.name), r.city, r.zip, r.branch, JSON.stringify(r.points));
      const b = j * 6;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::jsonb)`;
    });
    await db.query(`INSERT INTO world.street (name, name_search, city, zip, branch_id, points) VALUES ${values.join(', ')}`, params);
  }
  return rows.length;
}
