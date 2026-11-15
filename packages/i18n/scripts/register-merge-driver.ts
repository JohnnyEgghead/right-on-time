// SPDX-License-Identifier: AGPL-3.0-or-later
// Registers the catalog merge driver in this clone's git config (D-16). Run by the root
// `prepare` script. Idempotent: it writes a value only when it differs, so running it twice, or
// in several worktrees (which share one git config), changes nothing. Worktrees that install at
// the same moment contend for git's config lock (F-155); a write that loses the lock is retried
// with a short random back-off. Outside a git work tree (a source archive, a Docker build) it
// does nothing. A registration that still fails warns with git's own message and exits 0 (F-139).
import { spawnSync } from 'node:child_process';

const run = (...args: string[]) => spawnSync('git', args, { encoding: 'utf8' });
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (run('rev-parse', '--is-inside-work-tree').status !== 0) process.exit(0);

// Git runs a merge driver from the top of the work tree, so the path is repo-relative.
const VALUES: [string, string][] = [
  ['merge.bw-catalog.name', 'Brightwater catalog key-union merge'],
  ['merge.bw-catalog.driver', 'node packages/i18n/scripts/merge-catalog.ts %O %A %B %P'],
];
const ATTEMPTS = 20;

let failed = false;
for (const [key, value] of VALUES) {
  let lastError = '';
  let done = false;
  for (let attempt = 0; attempt < ATTEMPTS && !done; attempt++) {
    // A read never takes the lock; exit 1 means the key is unset.
    if (run('config', '--local', '--get-all', key).stdout.trim() === value) {
      done = true;
      break;
    }
    const w = run('config', '--local', key, value);
    if (w.status === 0) done = true;
    else {
      lastError = (w.stderr || String(w.error ?? `exit ${String(w.status)}`)).trim();
      sleep(10 + Math.floor(Math.random() * 90));
    }
  }
  if (!done) {
    failed = true;
    process.stderr.write(`warning: could not set git config ${key} after ${ATTEMPTS} tries: ${lastError}\n`);
  }
}
if (failed) process.stderr.write('warning: the catalog merge driver is not registered; run `node packages/i18n/scripts/register-merge-driver.ts` again.\n');
