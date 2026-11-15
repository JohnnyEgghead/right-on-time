// SPDX-License-Identifier: AGPL-3.0-or-later
// node packages/db/src/cli/migrate.ts   Apply every pending migration to DATABASE_URL (SD-40, forward-only).
// Exit 0 with the applied and already-applied lists; exit 1 on a failed, drifted or misordered migration.
import { migrateUrl } from '../migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('migrate: DATABASE_URL is not set');
  process.exit(2);
}
try {
  const r = await migrateUrl(url);
  console.log(`migrate: applied ${r.applied.length} (${r.applied.join(', ') || 'none'}); already applied ${r.alreadyApplied.length}`);
  if (r.newerThanCode.length > 0) console.log(`migrate: the database also has newer migrations ${r.newerThanCode.join(', ')} (a rollback; SD-40)`);
} catch (e) {
  console.error(`migrate: FAIL ${(e as Error).message}`);
  process.exit(1);
}
