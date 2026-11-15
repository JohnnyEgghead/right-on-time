// SPDX-License-Identifier: AGPL-3.0-or-later
// The one main-module guard for every CI script (F-196, from F-195): is this module the program node was started on?
// Both sides go through realpathSync, so a symlinked argv[1] (macOS TMPDIR is under /var -> /private/var) still
// matches. A plain comparison of argv[1] with import.meta is false under a symlink, the CLI body is skipped and the
// script exits 0 having done nothing; for a gate that is a silent pass. ci/is-main.test.ts fails on that raw pattern.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when `metaUrl` (the caller's import.meta.url) is the module node was started on (argv[1] by default). */
export function isMain(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(path.resolve(argv1)) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
