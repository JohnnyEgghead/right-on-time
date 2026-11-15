// SPDX-License-Identifier: AGPL-3.0-or-later
// node packages/db/src/cli/start.ts   The migrate step of every start (F-150; SD-40): the Compose service `migrate`
// runs it once, as the schema owner, before web, worker and pbs start (they wait for it to complete successfully).
// It applies every pending migration, then sets each process login's password from that process's password file.
// Env: DATABASE_URL (the owner, no password in it), POSTGRES_PASSWORD (the owner's password, from the database's own
// env file), BW_DB_LOGINS_DIR (default /var/lib/bw/db-login). Exit 0 done; 1 failed; 2 a setting is missing.
// Output: 1 JSON line per outcome through @bw/log (SPECIFICATIONS 11.4; F-217): a fixed state or an error code, never free
// text, so no value from the environment and no error message reaches a line.
import { createLogger } from '@bw/log';
import { createClient } from '../client.ts';
import { provisionLogins } from '../logins.ts';
import { migrateUrl } from '../migrate.ts';

const log = createLogger({ process: 'migrate' });
/** A short code for the log: the driver's or system's own code (ECONNREFUSED, 28P01) or the error's name, never its message. */
const errorCode = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code ?? (e as Error | null)?.name;
  return typeof c === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(c) ? c : 'error';
};

const url = process.env.DATABASE_URL;
const ownerPassword = process.env.POSTGRES_PASSWORD;
if (!url || !ownerPassword) {
  log.error({ status: 'unhandled error', errorCode: 'settings_missing' });
  process.exit(2);
}
process.env.PGPASSWORD = ownerPassword; // node-postgres reads it; it never appears in a URL or a line
try {
  await migrateUrl(url);
  log.info({ status: 'migrated' });
  const owner = createClient({ connectionString: url, application_name: 'bw-migrate' });
  await owner.connect();
  try {
    await provisionLogins(owner, process.env.BW_DB_LOGINS_DIR || '/var/lib/bw/db-login');
    log.info({ status: 'logins set' });
  } finally {
    await owner.end();
  }
} catch (e) {
  log.error({ status: 'unhandled error', errorCode: errorCode(e) });
  process.exit(1);
}
