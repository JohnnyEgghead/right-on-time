// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCatalog } from './catalog-format.ts';
import { authorsFromGit, checkReviews, isSelfReview, modelOf, parseReviewFile, RUBRIC, serializeReviewFile, taskOf, valueHash, type ReviewFile } from './catalog-review.ts';

const es = { 'a.one': 'Hola', 'a.two': 'Adiós' };
const file = (over: Partial<ReviewFile> = {}): ReviewFile => ({
  rubric: [...RUBRIC],
  pending: [],
  reviews: { 'a.one': { h: valueHash('Hola'), by: 'M/REVIEW', v: 'pass' }, 'a.two': { h: valueHash('Adiós'), by: 'M/REVIEW', v: 'pass' } },
  ...over,
});
const authors = new Map([
  ['a.one', 'M/WRITE'],
  ['a.two', 'M/WRITE'],
]);
const kinds = (r: ReturnType<typeof checkReviews>): string[] => r.issues.map((i) => i.kind);

describe('catalog-review check (FR-LANG-4)', () => {
  // why: FR-LANG-4 the clean case must pass, or the gate would block every lane
  it('passes when every value holds a pass record from another agent', () => {
    const r = checkReviews(es, file(), authors);
    expect(r.issues).toEqual([]);
    expect(r.reviewed).toBe(2);
  });

  // why: FR-LANG-4 a planted self-review must fail; the author comes from git, not from the record
  it('fails a value reviewed by its own author', () => {
    const r = checkReviews(es, file({ reviews: { ...file().reviews, 'a.one': { h: valueHash('Hola'), by: 'm/write ', v: 'pass' } } }), authors);
    expect(kinds(r)).toEqual(['self-review']);
  });

  // why: FR-LANG-4 a new Spanish value without a review must fail
  it('fails a value with no record and not pending', () => {
    const f = file();
    delete f.reviews['a.two'];
    expect(kinds(checkReviews(es, f, authors))).toEqual(['no-record']);
  });

  // why: FR-LANG-4 an edited value is a new value and needs a new review
  it('fails a record whose value changed after the review', () => {
    expect(kinds(checkReviews({ ...es, 'a.one': 'Hola de nuevo' }, file(), authors))).toEqual(['stale']);
  });

  // why: FR-LANG-4 the review is against 4 rubric points: usted, accents, AM and PM, natural wording
  it('fails a fail verdict, a missing reviewer and an incomplete rubric', () => {
    const bad = file({ rubric: ['usted', 'accents'], reviews: { 'a.one': { h: valueHash('Hola'), by: '', v: 'fail' }, 'a.two': file().reviews['a.two'] as never } });
    expect(kinds(checkReviews(es, bad, authors)).sort()).toEqual(['fail-verdict', 'no-reviewer', 'rubric-mismatch']);
  });

  // why: FR-LANG-4 a value git names no author for cannot be told from a self-review
  it('fails a record for an uncommitted value unless the key is pending', () => {
    expect(kinds(checkReviews(es, file(), new Map([['a.two', 'M/WRITE']])))).toEqual(['unknown-author']);
  });

  // why: FR-LANG-4 a value this lane wrote is reviewed by a separate agent: pending passes now, --strict fails at the close
  it('accepts pending keys and fails them under --strict', () => {
    const f = file();
    delete f.reviews['a.two'];
    f.pending = ['a.two'];
    expect(checkReviews(es, f, authors).issues).toEqual([]);
    expect(kinds(checkReviews(es, f, authors, { strict: true }))).toEqual(['pending']);
  });

  // why: FR-LANG-4 the records must follow the catalog: no record or pending entry for a key that is gone
  it('fails orphans and a key both pending and recorded', () => {
    const f = file({ pending: ['a.one', 'gone.pending'] });
    f.reviews['gone.record'] = { h: 'x', by: 'M/REVIEW', v: 'pass' };
    expect(kinds(checkReviews(es, f, authors)).sort()).toEqual(['orphan-pending', 'orphan-record', 'pending-has-record']);
  });

  // why: FR-LANG-4 the author id is built from git data, so its parts must parse the shapes the commits use
  it('round-trips the file and reads the agent id from a trailer and a subject', () => {
    const f = file({ pending: ['a.two'] });
    expect(parseReviewFile(serializeReviewFile(f))).toEqual(f);
    expect(modelOf('Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')).toBe('Claude Opus 5.5');
    expect(modelOf('P7: x\n\nbody\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n\nClaude-Session: https://x')).toBe('Claude Opus 5.5');
    expect(modelOf('')).toBe('unattributed');
    expect(taskOf('P6-JOB-DIRECTIONS-PHOTOS: add it', 'abcdef1234')).toBe('P6-JOB-DIRECTIONS-PHOTOS');
    expect(taskOf('Merge lane 3', 'abcdef1234')).toBe('commit-abcdef1');
  });
});

describe('catalog-review author from git (planted author probe)', () => {
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const commit = (cwd: string, subject: string, model: string): void => {
    git(cwd, 'add', 'es.json');
    git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', subject, '-m', `Co-Authored-By: ${model} <noreply@anthropic.com>`);
  };

  // why: FR-LANG-4 the planted-author probe: a record naming the writing agent as reviewer fails, and one naming another passes
  it('derives the author from the commit that wrote the line, so a record cannot hide a self-review', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bw-review-'));
    try {
      git(dir, 'init', '-q');
      writeFileSync(join(dir, 'es.json'), '{\n  "a.one": "Hola",\n  "a.two": "Adiós"\n}\n');
      commit(dir, 'P7-WRITE: first values', 'Model A');
      writeFileSync(join(dir, 'es.json'), '{\n  "a.one": "Hola",\n  "a.two": "Hasta luego"\n}\n');
      commit(dir, 'P7-EDIT: reword a.two', 'Model B');
      const got = authorsFromGit(dir, 'es.json');
      expect(got.get('a.one')).toBe('Model A/P7-WRITE');
      expect(got.get('a.two')).toBe('Model B/P7-EDIT');
      const cat = { 'a.one': 'Hola', 'a.two': 'Hasta luego' };
      const rec = (by: string): ReviewFile => ({
        rubric: [...RUBRIC],
        pending: [],
        reviews: { 'a.one': { h: valueHash('Hola'), by, v: 'pass' }, 'a.two': { h: valueHash('Hasta luego'), by, v: 'pass' } },
      });
      expect(checkReviews(cat, rec('Model A/P7-WRITE'), got).issues.map((i) => `${i.kind}:${i.key}`)).toEqual(['self-review:a.one']);
      expect(checkReviews(cat, rec('Model C/P7-REVIEW'), got).issues).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('catalog-review author on this repo\'s real commit shape (F-1520)', () => {
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const SESSION = 'Claude-Session: https://claude.ai/code/session_x';
  // Each message commits 1 more key to es.json, so key kN is written by message N.
  const run = (messages: string[][]): Map<string, string> => {
    const dir = mkdtempSync(join(tmpdir(), 'bw-review-shape-'));
    try {
      git(dir, 'init', '-q');
      messages.forEach((m, i) => {
        const keys = messages.slice(0, i + 1).map((_, j) => `  "k${j}": "v${j}",\n`).join('');
        writeFileSync(join(dir, 'es.json'), `{\n${keys}  "z": "z"\n}\n`);
        git(dir, 'add', 'es.json');
        git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', m.join('\n'));
      });
      return authorsFromGit(dir, 'es.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // why: FR-LANG-4 F-1520 the author is read from the whole message: Co-Authored-By then a blank line then Claude-Session is no git trailer block
  it('reads the model from a Co-Authored-By line git does not count as a trailer', () => {
    const got = run([
      ['P7-SPANISH: split shape', '', 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>', '', SESSION],
      ['P7-OTHER: one paragraph', '', 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>', SESSION],
      ['F-1289: no co-author at all', '', 'Just a body.'],
    ]);
    expect(got.get('k0')).toBe('Claude Sonnet 5.5/P7-SPANISH');
    expect(got.get('k1')).toBe('Claude Opus 5.5/P7-OTHER');
    expect(got.get('k2')).toBe('unattributed/F-1289');
  });

  // why: FR-LANG-4 F-1520 a planted self-review on the real shape fails; an unattributed author fails on a matching task part alone
  it('fails a self-review of a value written in the split shape, and of an unattributed value by the same task', () => {
    const got = run([
      ['P7-SPANISH: split shape', '', 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>', '', SESSION],
      ['F-1289: no co-author at all', '', 'Just a body.'],
    ]);
    const cat = { k0: 'v0', k1: 'v1' };
    const rec = (by0: string, by1: string): ReviewFile => ({
      rubric: [...RUBRIC],
      pending: [],
      reviews: { k0: { h: valueHash('v0'), by: by0, v: 'pass' }, k1: { h: valueHash('v1'), by: by1, v: 'pass' } },
    });
    const bad = checkReviews(cat, rec('Claude Sonnet 5.5/P7-SPANISH', 'Claude Opus 5.5/F-1289'), got).issues.map((i) => `${i.kind}:${i.key}`);
    expect(bad).toEqual(['self-review:k0', 'self-review:k1']);
    expect(checkReviews(cat, rec('Claude Opus 5.5/P7-SPANISH-REVIEW', 'Claude Opus 5.5/P7-SPANISH-REVIEW'), got).issues).toEqual([]);
  });

  // why: FR-LANG-4 F-1520 only an unattributed author is matched on its task part; a named model is matched whole
  it('matches an unattributed author on the task part only', () => {
    expect(isSelfReview('unattributed/F-1289', 'Any Model/F-1289')).toBe(true);
    expect(isSelfReview('unattributed/F-1289', 'Any Model/P7-REVIEW')).toBe(false);
    expect(isSelfReview('Claude Opus 5.5/F-1289', 'Other Model/F-1289')).toBe(false);
  });
});

describe('the real Spanish catalog', () => {
  // why: FR-LANG-4 SC-05 every Spanish value holds a current record and none is pending: main holds 0 pending (the gate runs --strict)
  it('has a review record for every value, none stale and none pending', () => {
    const dir = fileURLToPath(new URL('../catalog/', import.meta.url));
    const cat = parseCatalog(readFileSync(`${dir}es.json`, 'utf8'), 'es.json');
    const f = parseReviewFile(readFileSync(`${dir}es.review.json`, 'utf8'));
    const missing = Object.keys(cat).filter((k) => !f.reviews[k]);
    const stale = Object.keys(cat).filter((k) => f.reviews[k] && f.reviews[k]?.h !== valueHash(cat[k] as string));
    expect({ missing, stale, pending: f.pending, rubric: f.rubric }).toEqual({ missing: [], stale: [], pending: [], rubric: [...RUBRIC] });
  });
});
