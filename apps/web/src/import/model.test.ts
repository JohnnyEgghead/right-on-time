// SPDX-License-Identifier: AGPL-3.0-or-later
// The import pages' logic (model.ts): when Run the import is offered, the M, K and S keys, the run line, a pair's why, the count bars.
import { catalogs } from '@bw/i18n';
import { describe, expect, it } from 'vitest';
import { barSegments, canDecide, decisionForKey, failureWords, indexAfter, realRunOffer, runLine, shownRun, whyParts, type RunSummary, type RunsAnswer } from './model.ts';

const t = (key: string, values: Record<string, string | number> = {}): string =>
  (catalogs.en[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? `{${k}}`));
const Z = '[America/New_York]';
const run = (over: Partial<RunSummary>): RunSummary => ({
  runId: 'r', kind: 'dry_run', startedAt: `2026-09-04T14:10:00-04:00${Z}`, finishedAt: `2026-09-04T14:31:00-04:00${Z}`, sourceExportedAt: `2026-08-31T05:00:00-04:00${Z}`,
  by: { kind: 'setup' }, status: 'done', counts: null, ...over,
});
const answer = (runs: RunSummary[], real = false): RunsAnswer => ({ runs, realRun: real ? { runId: 'x', by: { kind: 'setup' }, finishedAt: `2026-08-31T06:44:00-04:00${Z}` } : null });

describe('Run the import is offered only when no real run exists (FR-IMP-10)', () => {
  // why: FR-IMP-10 on a world with no real run and a finished dry run, Run the import is offered
  it('offers it with no real run, a finished dry run and nothing running', () => {
    expect(realRunOffer(answer([run({})]))).toEqual({ offered: true });
  });
  // why: FR-IMP-10 a world that has a real run (setup's) gets Run the import disabled with that reason, even with a finished dry run
  it('disables it with the real run as the reason when a real run exists', () => {
    expect(realRunOffer(answer([run({ kind: 'real', by: { kind: 'setup' } }), run({})], true))).toEqual({ offered: false, why: 'real_done' });
  });
  // why: FR-IMP-10 no dry run has finished (UD-39) or a run is running: not offered, with the matching reason
  it('disables it while no dry run has finished and while a run runs', () => {
    expect(realRunOffer(answer([]))).toEqual({ offered: false, why: 'need_dry' });
    expect(realRunOffer(answer([run({ status: 'failed' })]))).toEqual({ offered: false, why: 'need_dry' });
    expect(realRunOffer(answer([run({ status: 'running', finishedAt: null }), run({})]))).toEqual({ offered: false, why: 'running' });
  });
  // why: UC-08 the report shown is the newest dry run's, or the one a See report link named
  it('shows the newest dry run, or the run a link names', () => {
    const runs = [run({ runId: 'real', kind: 'real' }), run({ runId: 'new' }), run({ runId: 'old' })];
    expect(shownRun(runs)?.runId).toBe('new');
    expect(shownRun(runs, 'old')?.runId).toBe('old');
    expect(shownRun(runs, 'gone')).toBeNull();
  });
});

describe('the M, K and S keys (FR-IMP-11)', () => {
  // why: FR-IMP-11 M merges, K keeps separate and S skips; any other key, and any key with Ctrl, Meta or Alt held, does nothing
  it('maps M, K and S in either case and nothing else', () => {
    const k = (key: string, m: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => decisionForKey({ key, ctrlKey: false, metaKey: false, altKey: false, ...m });
    expect([k('m'), k('K'), k('s')]).toEqual(['merge', 'keep_separate', 'skip']);
    expect([k('x'), k('Enter'), k('m', { ctrlKey: true }), k('k', { metaKey: true }), k('s', { altKey: true })]).toEqual([null, null, null, null, null]);
  });
  // why: FR-IMP-11 a skipped pair can still be merged or kept, but not skipped again; a decided pair takes no key
  it('lets a skipped pair be merged or kept and no decided pair be decided again', () => {
    expect(['merge', 'keep_separate', 'skip'].map((d) => canDecide('listed', d as never))).toEqual([true, true, true]);
    expect(['merge', 'keep_separate', 'skip'].map((d) => canDecide('skipped', d as never))).toEqual([true, true, false]);
    expect(['merged', 'kept_separate'].flatMap((s) => ['merge', 'keep_separate', 'skip'].map((d) => canDecide(s as never, d as never)))).toEqual([false, false, false, false, false, false]);
  });
  // why: FR-IMP-11 (OI-32) after a decision the next shown pair is the one that follows, and the list never points past its end
  it('moves to the next pair after a decision', () => {
    expect(indexAfter(3, 6, 'to_check')).toBe(3); // the decided pair left the list: the next one took its place
    expect(indexAfter(3, 5, 'all')).toBe(4);
    expect(indexAfter(5, 6, 'to_check')).toBe(5);
    expect(indexAfter(4, 5, 'to_check')).toBe(4);
    expect(indexAfter(0, 0, 'all')).toBe(0);
  });
});

describe('the dry run page text (S4-1, OI-53)', () => {
  // why: FR-IMP-10 the run line names the run's times and the old system's export, with the export's date when it is not the run's day (S4-1)
  it('prints the run line of the approved page', () => {
    expect(runLine(run({}), 'en', t as never)).toBe("Ran Fri, Sep 4, 2:10-2:31 PM on the old system's Mon, Aug 31, 5:00 AM export. The live system was not touched.");
    expect(runLine(run({ sourceExportedAt: `2026-09-04T05:00:00-04:00${Z}` }), 'en', t as never)).toContain("old system's 5:00 AM export");
    expect(runLine(run({ sourceExportedAt: null }), 'en', t as never)).toBe('Ran Fri, Sep 4, 2:10-2:31 PM. The live system was not touched.');
    expect(runLine(run({ finishedAt: null }), 'en', t as never)).toBeNull();
  });
  // why: FR-IMP-6 the count bar widths are shares of the total to 1 decimal, and a zero share draws nothing (the frame's 97.3 and 2.7)
  it('draws the count bars from the shares', () => {
    expect(barSegments(17912, 488, 0)).toEqual([{ cls: 'c-ok', width: '97.3%' }, { cls: 'c-flag', width: '2.7%' }]);
    expect(barSegments(95870, 0, 542)).toEqual([{ cls: 'c-ok', width: '99.4%' }, { cls: 'c-no', width: '0.6%' }]);
    expect(barSegments(0, 0, 0)).toEqual([]);
  });
  // why: FR-IMP-11 a pair's why key becomes the facts that match and the facts that differ, in the key's order
  it('reads a pair\'s why key', () => {
    expect(whyParts('phone_and_house_number_match_name_and_street_differ')).toEqual({ exact: false, match: ['phone', 'house_number'], differ: ['name', 'street'] });
    expect(whyParts('house_number_match_name_differ')).toEqual({ exact: false, match: ['house_number'], differ: ['name'] });
    expect(whyParts('name_differ')).toEqual({ exact: false, match: [], differ: ['name'] });
    expect(whyParts('exact_match')).toEqual({ exact: true, match: [], differ: [] });
  });
  // why: FR-IMP-2 a failed run says why it stopped (F-521): tried 3 times, the export refused, an error, or a code the page does not know
  it('puts words to a failed run\'s code', () => {
    expect(failureWords('attempts_exhausted', t as never)).toBe('it was tried 3 times and did not finish');
    expect(failureWords('generator_manifest', t as never)).toContain('export was refused');
    expect(failureWords('import_failed', t as never)).toContain('error');
    expect(failureWords('odd_code', t as never)).toBe('it stopped with the error odd_code');
  });
});
