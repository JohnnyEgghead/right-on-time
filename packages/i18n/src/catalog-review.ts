// SPDX-License-Identifier: AGPL-3.0-or-later
// catalog-review (REQUIREMENTS FR-LANG-4, OA-45: agents only): every Spanish catalog value carries a review record from an
// agent other than the one that wrote the value, against the rubric of "usted", correct accents, "AM" and "PM", and natural
// wording. The records live in packages/i18n/catalog/es.review.json:
//   { "rubric": [...4 points...], "pending": [keys], "reviews": { "<key>": { "h": <value hash>, "by": <reviewer>, "v": "pass" } } }
// A record is good when its hash is the current value's hash (a changed value is a new, unreviewed value), its verdict is
// "pass" on the whole rubric, and its reviewer is not the value's author. The author is NOT read from the record: it is
// derived from git (the commit that last wrote the value's line, see authorsFromBlame), so a record cannot name a different
// author to dodge the rule. An agent is named "<model>/<task>": the Co-Authored-By model of the writing commit and the task
// id its subject opens with ("P6-JOB-DIRECTIONS-PHOTOS: ..." gives "Claude Opus 5.5/P6-JOB-DIRECTIONS-PHOTOS"). A reviewer
// names itself the same way, and names the task that REVIEWS, never the task that wrote the value.
// A value whose review is still owed is listed in "pending": the plain check passes it and says so; the gate
// (ci/gates/catalog-review.sh) runs --strict, so a pending key fails it and main holds none.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { CatalogMap } from './catalog-format.ts';

export const RUBRIC = ['usted', 'accents', 'ampm', 'natural'] as const;

export interface ReviewRecord {
  /** Hash of the value reviewed (valueHash). */
  h: string;
  /** The reviewing agent, "<model>/<task>". */
  by: string;
  /** "pass" attests every rubric point; "fail" records a found problem (the check fails until the value is fixed and re-reviewed). */
  v: 'pass' | 'fail';
  note?: string;
}

export interface ReviewFile {
  rubric: string[];
  pending: string[];
  reviews: Record<string, ReviewRecord>;
}

export type IssueKind =
  | 'rubric-mismatch'
  | 'no-record'
  | 'stale'
  | 'self-review'
  | 'fail-verdict'
  | 'no-reviewer'
  | 'unknown-author'
  | 'orphan-record'
  | 'orphan-pending'
  | 'pending-has-record'
  | 'pending';

export interface Issue {
  kind: IssueKind;
  key: string;
  detail: string;
}

export interface ReviewReport {
  issues: Issue[];
  reviewed: number;
  pending: string[];
}

export function valueHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

/** Agent ids compare without case or surrounding space. */
const norm = (id: string): string => id.trim().toLowerCase();

/**
 * Check the records against the catalog. `authors` maps a key to the agent that wrote its current value (authorsFromBlame);
 * a key with no author is refused unless its review is pending.
 */
export function checkReviews(es: CatalogMap, file: ReviewFile, authors: ReadonlyMap<string, string>, opts: { strict?: boolean } = {}): ReviewReport {
  const issues: Issue[] = [];
  if (file.rubric.length !== RUBRIC.length || RUBRIC.some((p, i) => file.rubric[i] !== p)) {
    issues.push({ kind: 'rubric-mismatch', key: '-', detail: `the review file's rubric is [${file.rubric.join(', ')}], it must be [${RUBRIC.join(', ')}]` });
  }
  const pending = new Set(file.pending);
  for (const k of pending) {
    if (!(k in es)) issues.push({ kind: 'orphan-pending', key: k, detail: 'pending, but the Spanish catalog has no such key' });
    else if (file.reviews[k]) issues.push({ kind: 'pending-has-record', key: k, detail: 'listed as pending and also holds a record; drop it from pending' });
    if (opts.strict) issues.push({ kind: 'pending', key: k, detail: 'its review is still owed (--strict)' });
  }
  for (const k of Object.keys(file.reviews)) {
    if (!(k in es)) issues.push({ kind: 'orphan-record', key: k, detail: 'a record for a key the Spanish catalog does not have' });
  }
  let reviewed = 0;
  for (const key of Object.keys(es).sort()) {
    const rec = file.reviews[key];
    if (!rec) {
      if (!pending.has(key)) issues.push({ kind: 'no-record', key, detail: 'no review record and not pending' });
      continue;
    }
    const before = issues.length;
    if (rec.h !== valueHash(es[key] as string)) issues.push({ kind: 'stale', key, detail: 'the value changed after its review: review it again' });
    if (rec.v !== 'pass') issues.push({ kind: 'fail-verdict', key, detail: `the review found a problem${rec.note ? `: ${rec.note}` : ''}` });
    if (norm(rec.by ?? '') === '') {
      issues.push({ kind: 'no-reviewer', key, detail: 'the record names no reviewer' });
    } else {
      const author = authors.get(key);
      if (author === undefined) issues.push({ kind: 'unknown-author', key, detail: 'git names no author for this value (not committed yet?), so its review cannot be told from a self-review' });
      else if (isSelfReview(author, rec.by)) issues.push({ kind: 'self-review', key, detail: `reviewed by its own author, ${author}` });
    }
    if (issues.length === before) reviewed += 1;
  }
  return { issues, reviewed, pending: [...pending].filter((k) => k in es).sort() };
}

const ZERO = /^0{40}$/;

/** The model a commit message names: its first "Co-Authored-By:" line anywhere in the message (not only git's trailer block, which
 * this repo's messages often miss). "Claude Opus 5.5 <noreply@anthropic.com>" gives "Claude Opus 5.5". No such line gives
 * "unattributed": the author id is then "unattributed/<task>" and only the task part is compared (see isSelfReview). */
export const UNATTRIBUTED = 'unattributed';
export function modelOf(message: string): string {
  const m = /^Co-Authored-By:[ \t]*(.*)$/im.exec(message);
  const name = m ? (m[1] as string).replace(/<[^>]*>/, '').trim() : '';
  return name === '' ? UNATTRIBUTED : name;
}

/** A review is a self-review when it names the author; an unattributed author matches on its task part alone. */
export function isSelfReview(author: string, by: string): boolean {
  if (norm(author) === norm(by)) return true;
  const a = norm(author);
  if (!a.startsWith(`${UNATTRIBUTED}/`)) return false;
  const task = (id: string): string => norm(id.slice(id.lastIndexOf('/') + 1));
  return task(author) === task(by);
}

/** The task id a commit subject opens with: "P6-JOB-DIRECTIONS-PHOTOS: ..." or "F-1289: ..."; else the short sha. */
export function taskOf(subject: string, sha: string): string {
  const m = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\b/.exec(subject.trim());
  return m ? (m[1] as string) : `commit-${sha.slice(0, 7)}`;
}

/** Parse `git blame --line-porcelain` of the catalog: key to the sha of the commit that last wrote its line. */
export function keyCommitsFromBlame(porcelain: string): Map<string, string> {
  const out = new Map<string, string>();
  let sha = '';
  for (const line of porcelain.split('\n')) {
    const head = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (head) {
      sha = head[1] as string;
      continue;
    }
    if (line.startsWith('\t')) {
      const m = /^\t\s*("(?:[^"\\]|\\.)*")\s*:/.exec(line);
      if (m) out.set(JSON.parse(m[1] as string) as string, sha);
    }
  }
  return out;
}

function git(root: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
}

/**
 * Who wrote each value of a catalog file, from git: blame on the file, then the Co-Authored-By model and the subject's task id
 * of each commit blamed (the whole message is read, %B). A line not committed yet has no author (absent from the map). Throws when git cannot give blame
 * (no repository, or a shallow clone, where every line would be blamed on the boundary commit).
 */
export function authorsFromGit(root: string, relPath: string): Map<string, string> {
  if (git(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new Error('the clone is shallow, so git cannot say who wrote a value; fetch full history, never skip');
  }
  const keyCommit = keyCommitsFromBlame(git(root, ['blame', '--line-porcelain', '--', relPath]));
  const shas = [...new Set(keyCommit.values())].filter((s) => !ZERO.test(s));
  const agent = new Map<string, string>();
  if (shas.length > 0) {
    const log = git(root, ['log', '--no-walk=unsorted', '--stdin', '-z', '--format=%H%x1f%s%x1f%B'], `${shas.join('\n')}\n`);
    for (const rec of log.split('\0')) {
      const [sha, subject, body] = rec.replace(/^\n/, '').split('\x1f');
      if (sha) agent.set(sha, `${modelOf(body ?? '')}/${taskOf(subject ?? '', sha)}`);
    }
  }
  const out = new Map<string, string>();
  for (const [key, sha] of keyCommit) {
    const a = agent.get(sha);
    if (a !== undefined) out.set(key, a);
  }
  return out;
}

export function parseReviewFile(text: string): ReviewFile {
  const raw = JSON.parse(text) as Partial<ReviewFile>;
  if (!Array.isArray(raw.rubric) || !Array.isArray(raw.pending) || raw.reviews === undefined || typeof raw.reviews !== 'object') {
    throw new Error('es.review.json must hold rubric, pending and reviews');
  }
  return { rubric: raw.rubric, pending: raw.pending, reviews: raw.reviews };
}

/** The file as written: keys sorted, 1 record per line, so a review adds lines and a merge stays line-based. */
export function serializeReviewFile(file: ReviewFile): string {
  const keys = Object.keys(file.reviews).sort();
  const recs = keys.map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(file.reviews[k])}`);
  const pend = [...file.pending].sort().map((k) => `    ${JSON.stringify(k)}`);
  return [
    '{',
    `  "rubric": ${JSON.stringify(file.rubric)},`,
    `  "pending": [${pend.length === 0 ? '' : `\n${pend.join(',\n')}\n  `}],`,
    '  "reviews": {',
    recs.join(',\n'),
    '  }',
    '}',
    '',
  ].join('\n');
}
