// SPDX-License-Identifier: AGPL-3.0-or-later
// node apps/worker/src/import/check.ts   (in its own worker container: docker compose run --rm --no-deps -T worker node apps/worker/src/import/check.ts)
// The import job's export, made once as an office run makes it (./source.ts: the generator's checked output from the
// street list setup reads), with no database. infra/deploy/server-deploy.sh runs it after every deploy, so the hosted
// server proves the worker finds the generator's inputs and that the export it makes matches
// packages/generator/MANIFEST.json (P3-IMPORT-WORKER Acceptance). 1 @bw/log line either way: exit 0 and status
// 'import source ok' on a match; exit 1 and 'import source refused' with the failure's code (generator_manifest, or the
// street list's own) on anything else. No row value and no error text is written.
import { createLogger } from '@bw/log';
import { failureCode } from '@bw/import';
import { officeExport } from './source.ts';

const log = createLogger({ process: 'worker' });
try {
  officeExport();
  log.info({ status: 'import source ok' });
} catch (e) {
  log.error({ status: 'import source refused', errorCode: failureCode(e) });
  process.exitCode = 1;
}
