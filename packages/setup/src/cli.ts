// SPDX-License-Identifier: AGPL-3.0-or-later
// pnpm run setup   (node packages/setup/src/cli.ts; in the image: docker compose --profile setup run --rm setup)
// Migrate the database, then run the 6 steps of BUILD_PLAN section 3 D-3 (./pipeline.ts) on a fresh world.
// Note: bare `pnpm setup` is pnpm's own built-in command (it sets up pnpm's home directory), which pnpm runs before any
// script of that name, so the script is run as `pnpm run setup`.
//
// Env: DATABASE_URL     the schema owner (F-150: setup runs as the owner, as the migrate step does)
//      POSTGRES_PASSWORD the owner's password when it is not in the URL (the database's own env file, as migrate reads it)
//      SAMPLE_PASSWORD_SEED (required, 16+ characters; SD-9), REVIEWER_PASSWORD (optional, 10+; HC-05)
//      MAPS_DIR         the folder of the downloaded map files and track set (`pnpm run setup:maps`). When set, setup checks
//                       them against packages/maps/MANIFEST.json first and stops with MAP_HASH_MISMATCH <file> on a
//                       difference (FR-MAP-4), then loads the track set as van_track rows (FR-MAP-5)
//      BW_STREET_LIST   the verified street list (default .build/data/street-list.json; `node ci/data-assets.ts ensure`)
// Output: JSON lines through @bw/log (process setup, fixed states, real time as log_stamp): 'import started' and
// 'import committed' bracket the real run, the measured import run time (SPECIFICATIONS section 14). A named stop is
// one 'setup refused' line whose errorCode is its code (F-327: setup writes JSON lines only, no console text).
// Exit 0 done; 1 stopped; 2 a setting is missing.
import { migrateUrl } from '@bw/db';
import { createLogger } from '@bw/log';
import { realNow } from '@bw/time';
import { readStreetList } from '../../db/src/street-list.ts';
import { SetupError } from './errors.ts';
import { readVerifiedMaps, runSetup, streetListFile as streetListFrom } from './pipeline.ts';

const log = createLogger({ process: 'setup' });
// Each real-time read names its section 11.3 use as a literal (the G-CI4 listing reads them).
const now = (use: 'clock_anchor' | 'record_stamp' | 'log_stamp'): Date => new Date((
  use === 'clock_anchor' ? realNow('clock_anchor') : use === 'record_stamp' ? realNow('record_stamp') : realNow('log_stamp')).epochMilliseconds);

const url = process.env.DATABASE_URL;
const seed = process.env.SAMPLE_PASSWORD_SEED;
const reviewer = process.env.REVIEWER_PASSWORD || undefined;
if (!url || !seed || seed.length < 16 || (reviewer !== undefined && reviewer.length < 10)) {
  // DATABASE_URL and SAMPLE_PASSWORD_SEED (16+ characters) are required; REVIEWER_PASSWORD, when set, needs 10+ (F-327: JSON lines only).
  log.error({ status: 'setup refused', errorCode: 'settings_missing' });
  process.exit(2);
}
if (process.env.POSTGRES_PASSWORD) process.env.PGPASSWORD = process.env.POSTGRES_PASSWORD; // never in a URL or a line

const streetListFile = streetListFrom(process.env);
let refused = false; // runSetup already wrote its own 'setup refused' line
try {
  // FR-MAP-4: a changed map file stops setup before it touches the database (runSetup checks again for a caller that is not this CLI).
  // F-1297: hashed once here; runSetup is handed the rows and does not hash the files again.
  const verifiedTracks = process.env.MAPS_DIR ? readVerifiedMaps(process.env.MAPS_DIR) : undefined;
  await migrateUrl(url);
  log.info({ status: 'migrated' });
  await runSetup({
    databaseUrl: url, sampleSeed: seed, reviewerPassword: reviewer, streetList: readStreetList(streetListFile), streetListFile,
    ...(process.env.MAPS_DIR && verifiedTracks ? { maps: { dir: process.env.MAPS_DIR, verified: verifiedTracks } } : {}),
    realNow: now,
    onEvent: (e) => {
      if (e.status === 'setup refused') {
        refused = true;
        log.error(e);
      } else log.info(e);
    },
  });
} catch (e) {
  // F-327 (owner ruling a35e8595 "JSON lines"): a named stop is its code, an unnamed failure its driver or system code, on 1 line.
  if (!refused) {
    const code = e instanceof SetupError ? e.code : (e as { code?: unknown } | null)?.code;
    log.error({ status: 'setup refused', errorCode: typeof code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(code) ? code : 'error' });
  }
  process.exitCode = 1;
}
