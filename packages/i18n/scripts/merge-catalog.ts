// SPDX-License-Identifier: AGPL-3.0-or-later
// Git merge driver for the catalog files (D-16): node merge-catalog.ts %O %A %B %P
// Writes the merged, key-sorted result over %A and exits 0. On a collision it writes the
// named error to stderr, writes %A with git-style conflict markers around each colliding key (so the file
// no longer parses and catalog-parity goes red if it is committed unresolved, F-137) and exits 1.
import { readFileSync, writeFileSync } from 'node:fs';
import { conflictText, parseCatalog, serializeCatalog } from '../src/catalog-format.ts';
import { CatalogKeyCollision, mergeCatalogs } from '../src/merge.ts';

const [basePath, oursPath, theirsPath, label = 'catalog'] = process.argv.slice(2);
if (!basePath || !oursPath || !theirsPath) {
  process.stderr.write('usage: merge-catalog.ts <base> <ours> <theirs> [path]\n');
  process.exit(2);
}

try {
  const read = (p: string, what: string) => parseCatalog(readFileSync(p, 'utf8'), `${label} (${what})`);
  const merged = mergeCatalogs(read(basePath, 'base'), read(oursPath, 'ours'), read(theirsPath, 'theirs'));
  writeFileSync(oursPath, serializeCatalog(merged));
} catch (err) {
  if (err instanceof CatalogKeyCollision) writeFileSync(oursPath, conflictText(err.merged, err.sides));
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${err instanceof CatalogKeyCollision ? `${msg} in ${label}` : msg}\n`);
  process.exit(1);
}
