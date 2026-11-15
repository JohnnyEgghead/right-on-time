// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: R-BP1, OI-57, FR-IMP-10 (P2-SETUP Acceptance: the planted known-bads)
// Setup's named stops, each on its own fresh migrated PostgreSQL 18 database, through runSetup (the CLI's pipeline):
// a planted fixture row whose key matches no customer, and a planted second customer carrying a fixture row's key, each
// stop setup with its named error before the snapshot (the import has committed; no world-seed row and no snapshot);
// an office import run marked running stops setup before it writes anything.
// Run by gate import-target-counts (ci/gates/import-target-counts/vitest.db.config.ts).
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createClient, migrateUrl } from '@bw/db';
import { generate, loadInputs, type Output } from '@bw/generator';
import { realNow } from '@bw/time';
import { DATA_DIR } from '../../db/src/data-asset.ts';
import { readStreetList } from '../../db/src/street-list.ts';
import { createDatabase, type TestDatabase } from '../../db/src/testing/database.ts';
import { pgAdminUrl } from '../../db/src/testing/provided.ts';
import { TEST_SAMPLE_SEED } from '../../import/src/testing/world.ts';
import { SetupError, type SetupErrorCode } from './errors.ts';
import type { WorldFixture } from './fixture.ts';
import { runSetup } from './pipeline.ts';

const STREET_LIST = path.join(DATA_DIR, 'street-list.json');
const streets = readStreetList(STREET_LIST);
let real: Output | undefined;
const output = (): Output => (real ??= generate(loadInputs({ streetList: STREET_LIST })));
const open: TestDatabase[] = [];
afterEach(async () => {
  for (const d of open.splice(0)) await d.drop();
});

async function freshDatabase(): Promise<TestDatabase> {
  const d = await createDatabase(pgAdminUrl(), 'bw_setup');
  open.push(d);
  await migrateUrl(d.url);
  return d;
}

async function counts(url: string) {
  const c = createClient({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM world.import_run WHERE kind = 'real' AND status = 'done') AS real_runs,
              (SELECT count(*)::int FROM world.customer) AS customers,
              (SELECT count(*)::int FROM world.job) AS jobs, (SELECT count(*)::int FROM world.pilot_call) AS calls,
              (SELECT count(*)::int FROM world.membership) AS members,
              (SELECT count(*)::int FROM world."user" WHERE name = 'Marco P.') AS marco,
              (SELECT count(*)::int FROM system.day_snapshot) AS snapshots, (SELECT count(*)::int FROM system.clock_move) AS moves,
              (SELECT count(*)::int FROM pg_tables WHERE schemaname IN ('world_snapshot', 'pbs_snapshot')) AS snapshot_tables`);
    return r.rows[0] as Record<string, number>;
  } finally {
    await c.end();
  }
}

async function stopCode(url: string, out: () => Output): Promise<SetupErrorCode | 'no stop'> {
  try {
    await runSetup({
      databaseUrl: url, sampleSeed: TEST_SAMPLE_SEED, streetList: streets, streetListFile: STREET_LIST, generate: out,
      realNow: (use) => new Date((use === 'clock_anchor' ? realNow('clock_anchor') : use === 'record_stamp' ? realNow('record_stamp') : realNow('log_stamp')).epochMilliseconds),
    });
    return 'no stop';
  } catch (e) {
    if (e instanceof SetupError) return e.code;
    throw e;
  }
}

// why: F-1297 setup hashes the map folder once: the CLI hands runSetup the rows it verified, and runSetup does not read the folder again
describe('the map folder is verified once per setup run (F-1297)', () => {
  const stopAt = (maps: { dir: string; verified?: [] }): Promise<SetupErrorCode | 'no stop'> => freshDatabase().then(async (d) => {
    try {
      await runSetup({
        databaseUrl: d.url, sampleSeed: TEST_SAMPLE_SEED, streetList: streets, streetListFile: STREET_LIST, maps,
        generate: () => { throw new SetupError('generator_manifest', 'stop after the maps step'); },
        realNow: (use) => new Date((use === 'clock_anchor' ? realNow('clock_anchor') : use === 'record_stamp' ? realNow('record_stamp') : realNow('log_stamp')).epochMilliseconds),
      });
      return 'no stop';
    } catch (e) {
      if (e instanceof SetupError) return e.code;
      throw e;
    }
  });

  it('reads the folder when it is not handed verified rows, and does not when it is', async () => {
    expect(await stopAt({ dir: '/nonexistent-bw-maps' })).toBe('map_missing');
    expect(await stopAt({ dir: '/nonexistent-bw-maps', verified: [] })).toBe('generator_manifest');
  });
});

const withFixture = (edit: (fx: WorldFixture) => void) => (): Output => {
  const o = output();
  const fx = JSON.parse(o['fixture.json']) as WorldFixture;
  edit(fx);
  return { ...o, 'fixture.json': JSON.stringify(fx) };
};
const csvCell = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

describe("setup's planted known-bads stop it with their named error before the snapshot (R-BP1)", () => {
  // why: SD-24
  it('a fixture row whose key matches no customer stops setup with customer_not_found', async () => {
    const d = await freshDatabase();
    const code = await stopCode(d.url, withFixture((fx) => {
      const c = fx.customers[0] as WorldFixture['customers'][number];
      c.houseNumber = 99_999; // no customer lives there: the key's house number matches no row
    }));
    expect(code).toBe('customer_not_found');
    expect(await counts(d.url)).toMatchObject({ real_runs: 1, customers: 18_400, jobs: 0, calls: 0, members: 0, marco: 0, snapshots: 0, moves: 0, snapshot_tables: 0 });
  });

  // why: SD-24
  it("a planted second customer carrying a fixture row's key stops setup with customer_not_unique", async () => {
    const d = await freshDatabase();
    const code = await stopCode(d.url, () => {
      const o = output();
      const fx = JSON.parse(o['fixture.json']) as WorldFixture;
      const ref = (fx.customers[0] as WorldFixture['customers'][number]).ref;
      const lines = o['customers.csv'].split('\n');
      const header = (lines[0] as string).split(',');
      const row = lines.find((l) => l.startsWith(`${ref},`)) as string;
      expect(row).toBeDefined();
      // The same name, street and house number under a new old-system ref, with no mobile, so it is no exact match of the
      // fixture's customer and the import writes it as its own active row: the key now finds 2 customers.
      const cells = parseRow(row);
      cells[header.indexOf('customer_ref')] = 'C199999';
      cells[header.indexOf('mobile')] = '';
      const twin = cells.map(csvCell).join(',');
      return { ...o, 'customers.csv': o['customers.csv'].replace(/\n$/, `\n${twin}\n`) };
    });
    expect(code).toBe('customer_not_unique');
    expect(await counts(d.url)).toMatchObject({ real_runs: 1, customers: 18_401, jobs: 0, calls: 0, snapshots: 0, moves: 0, snapshot_tables: 0 });
  });
});

describe('an office import run marked running (FR-IMP-10)', () => {
  // why: FR-IMP-10
  it('stops setup with import_run_running before it writes anything; setup neither fails nor takes over the run', async () => {
    const d = await freshDatabase();
    const c = createClient({ connectionString: d.url });
    await c.connect();
    try {
      await c.query(`INSERT INTO world.import_run (kind, status, stage, percent, started_at, by_user, by_setup)
                     VALUES ('dry_run', 'running', 'parse', 0, '2026-09-15T09:00:00-04:00', NULL, false)`);
      expect(await stopCode(d.url, output)).toBe('import_run_running');
      const r = await c.query<{ status: string }>('SELECT status FROM world.import_run');
      expect(r.rows).toEqual([{ status: 'running' }]);
      expect(await counts(d.url)).toMatchObject({ customers: 0, jobs: 0, snapshots: 0 });
      expect((await c.query('SELECT 1 FROM world.branch')).rowCount).toBe(0); // not even the reference seed ran
    } finally {
      await c.end();
    }
  });
});

/** 1 RFC 4180 row into its cells (the generator quotes only cells with a comma, quote or line break). */
function parseRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
  }
  cells.push(cur);
  return cells;
}
