// SPDX-License-Identifier: AGPL-3.0-or-later
// The legs of the seeded schedule (legs.ts) from the real inputs: the generator's fixture (seed 20260915), the verified
// street list and the committed technician roster. Needs the street list in .build/data (node ci/data-assets.ts ensure).
import path from 'node:path';
import { generate, loadInputs } from '../../generator/src/index.ts';
import { DATA_DIR } from '../../db/src/data-asset.ts';
import { readStreetList } from '../../db/src/street-list.ts';
import { parseFixture } from '../../setup/src/fixture.ts';
import { buildLegs, type LegSet } from './legs.ts';

export function seededLegs(streetListFile = process.env['BW_STREET_LIST'] ?? path.join(DATA_DIR, 'street-list.json')): LegSet {
  const inputs = loadInputs({ streetList: streetListFile });
  const fixture = parseFixture(generate(inputs)['fixture.json']);
  return buildLegs(fixture, readStreetList(streetListFile), inputs.technicians);
}
