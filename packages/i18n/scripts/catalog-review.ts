// SPDX-License-Identifier: AGPL-3.0-or-later
// catalog-review (FR-LANG-4): node packages/i18n/scripts/catalog-review.ts [--strict]
//   Exit 0: every Spanish value has a good review record or is pending. Exit 1: a value has no record, a stale one, a failing one,
//   or one from its own author (the author is read from git). Exit 2: cannot judge (no git blame, shallow clone). --strict also
//   fails on every pending key.
// Recording a review (the reviewing agent runs this after reading the values, never for a value it wrote):
//   node packages/i18n/scripts/catalog-review.ts --record --by "<model>/<TASK>" [--keys-file <file>] [--except-file <file>]
//   writes a "pass" record for each key (every key without a good record when no --keys-file) whose value this agent did not
//   write, and lists the rest as pending (the keys it wrote, which another agent reviews). --except-file names keys to leave alone.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCatalog } from '../src/catalog-format.ts';
import { authorsFromGit, checkReviews, isSelfReview, parseReviewFile, RUBRIC, serializeReviewFile, valueHash, type ReviewFile } from '../src/catalog-review.ts';

const catalogDir = fileURLToPath(new URL('../catalog/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const REL = 'packages/i18n/catalog/es.json';
const reviewPath = `${catalogDir}es.review.json`;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const lines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));

const es = parseCatalog(readFileSync(`${catalogDir}es.json`, 'utf8'), 'es.json');
const file: ReviewFile = existsSync(reviewPath) ? parseReviewFile(readFileSync(reviewPath, 'utf8')) : { rubric: [...RUBRIC], pending: [], reviews: {} };

let authors: Map<string, string>;
try {
  authors = authorsFromGit(repoRoot, REL);
} catch (e) {
  process.stderr.write(`catalog-review: cannot judge: ${(e as Error).message}\n`);
  process.exit(2);
}

if (args.includes('--record')) {
  const by = flag('--by');
  if (!by) {
    process.stderr.write('catalog-review: --record needs --by "<model>/<TASK>"\n');
    process.exit(2);
  }
  const except = new Set(flag('--except-file') ? lines(flag('--except-file') as string) : []);
  const before = checkReviews(es, { ...file, pending: [] }, authors);
  const owed = new Set(before.issues.filter((i) => i.kind === 'no-record' || i.kind === 'stale' || i.kind === 'self-review').map((i) => i.key));
  const keys = flag('--keys-file') ? lines(flag('--keys-file') as string) : [...owed];
  const pending = new Set(file.pending);
  let wrote = 0;
  for (const key of keys) {
    if (!(key in es) || except.has(key)) continue;
    const author = authors.get(key);
    // A value git names no author for is uncommitted, so this lane's own edit: it stays pending.
    if (author === undefined || isSelfReview(author, by)) {
      pending.add(key);
      delete file.reviews[key];
      continue;
    }
    file.reviews[key] = { h: valueHash(es[key] as string), by, v: 'pass' };
    pending.delete(key);
    wrote += 1;
  }
  // A key that is pending but now holds no owed work (value gone) is dropped.
  file.pending = [...pending].filter((k) => k in es);
  file.rubric = [...RUBRIC];
  writeFileSync(reviewPath, serializeReviewFile(file));
  process.stdout.write(`catalog-review: recorded ${wrote} review(s) by ${by}; ${file.pending.length} key(s) pending (written by ${by}, another agent reviews them)\n`);
  process.exit(0);
}

const report = checkReviews(es, file, authors, { strict: args.includes('--strict') });
for (const i of report.issues) process.stderr.write(`catalog-review: ${i.kind}: ${i.key}: ${i.detail}\n`);
if (report.issues.length > 0) process.exit(1);
process.stdout.write(`catalog-review: ${report.reviewed} of ${Object.keys(es).length} Spanish values hold a good review record; ${report.pending.length} pending${report.pending.length > 0 ? ` (${report.pending.join(', ')})` : ''}\n`);
