// SPDX-License-Identifier: AGPL-3.0-or-later
// The import pages' logic with no React in it (SCR-OFC-13 to -15, -25, -26): which run the dry run page shows, when Run the import is
// offered and why not, the problem reasons' order and outcome, the words of a duplicate pair's "why", the M, K and S keys, and
// the times the run line and the history print.
import type { importRun, importRuns, likelyDuplicates, merges } from '@bw/api';
import { dateParts, formatTime, fromWire, Temporal, type Language } from '@bw/time';
import type { MessageKey } from '@bw/i18n';
import type { z } from '@bw/api';

export type RunsAnswer = z.output<typeof importRuns.response>;
export type RunSummary = RunsAnswer['runs'][number];
export type RunAnswer = z.output<typeof importRun.response>;
export type RunReport = NonNullable<RunAnswer['report']>;
export type PairsAnswer = z.output<typeof likelyDuplicates.response>;
export type Pair = PairsAnswer['pairs'][number];
export type PairRecord = Pair['recordA'];
export type MergeItem = z.output<typeof merges.response>['merges'][number];

type T = (key: MessageKey, values?: Record<string, string | number>) => string;

/** The 6 problem reasons in the order the approved page lists them. */
export const REASON_ORDER = ['visit_no_customer', 'missing_zip', 'bad_phone', 'visit_date_unreadable', 'equipment_no_address', 'customer_name_blank'] as const;
export type Reason = (typeof REASON_ORDER)[number];

/** The file a reason belongs to; a customers.csv row is imported and flagged, any other is not imported (SPECIFICATIONS 6.7). */
export const reasonFile = (r: Reason): 'customers' | 'visits' | 'equipment' =>
  r === 'visit_no_customer' || r === 'visit_date_unreadable' ? 'visits' : r === 'equipment_no_address' ? 'equipment' : 'customers';
export const reasonFlagged = (r: Reason): boolean => reasonFile(r) === 'customers';

/** The run the dry run page reports on: the newest dry run (API-82 lists newest first), or the one a See report link named. */
export function shownRun(runs: readonly RunSummary[], runId?: string | null): RunSummary | null {
  if (runId) return runs.find((r) => r.runId === runId) ?? null;
  return runs.find((r) => r.kind === 'dry_run') ?? null;
}

export const runningRun = (runs: readonly RunSummary[]): RunSummary | null => runs.find((r) => r.status === 'running') ?? null;

export type RealOffer = { offered: true } | { offered: false; why: 'running' | 'real_done' | 'need_dry' };

/** CTL-OFC-13-08 (FR-IMP-10, OA-56, OI-11): offered only with no real run, a finished dry run and no run running. */
export function realRunOffer(a: RunsAnswer): RealOffer {
  if (a.realRun) return { offered: false, why: 'real_done' };
  if (runningRun(a.runs)) return { offered: false, why: 'running' };
  if (!a.runs.some((r) => r.kind === 'dry_run' && r.status === 'done')) return { offered: false, why: 'need_dry' };
  return { offered: true };
}

export const clampPercent = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

export const fmtNumber = (n: number, lang: Language): string => n.toLocaleString(lang === 'es' ? 'es-US' : 'en-US');

/** "Fri, Sep 4" */
export function dayText(wire: string, t: T): string {
  const z = fromWire(wire);
  const p = dateParts(z.toInstant(), z.timeZoneId);
  return `${t(`time.weekday.${p.weekday}` as MessageKey)}, ${t(`time.month.${p.month}` as MessageKey)} ${p.day}`;
}
/** "Fri, Sep 4, 2:10 PM" */
export function whenText(wire: string, lang: Language, t: T): string {
  const z = fromWire(wire);
  const p = dateParts(z.toInstant(), z.timeZoneId);
  return t('shell.clock.short', {
    weekday: t(`time.weekday.${p.weekday}` as MessageKey), month: t(`time.month.${p.month}` as MessageKey), day: p.day, time: formatTime(z.toInstant(), z.timeZoneId, lang),
  });
}
export const clockOf = (wire: string, lang: Language): string => {
  const z = fromWire(wire);
  return formatTime(z.toInstant(), z.timeZoneId, lang);
};
const sameDay = (a: string, b: string): boolean => {
  const [x, y] = [fromWire(a), fromWire(b)];
  return Temporal.PlainDate.compare(x.toPlainDate(), y.toPlainDate().withCalendar(x.calendarId)) === 0 && x.timeZoneId === y.timeZoneId;
};

/** "Mar 2015" from yyyy-mm-dd. */
export function monthYear(date: string, t: T): string {
  const [y, m] = date.split('-');
  return `${t(`time.month.${Number(m)}` as MessageKey)} ${y}`;
}

/**
 * CTL-OFC-13-10: "Ran Fri, Sep 4, 2:10-2:31 PM on the old system's Mon, Aug 31, 5:00 AM export. ..." The export's date is named when
 * it is not the run's day (SD-24); the first time drops its AM or PM when it is the second's.
 */
export function runLine(run: Pick<RunSummary, 'startedAt' | 'finishedAt' | 'sourceExportedAt'>, lang: Language, t: T): string | null {
  if (!run.finishedAt) return null;
  const to = clockOf(run.finishedAt, lang);
  const fromFull = clockOf(run.startedAt, lang);
  const from = fromFull.split(' ')[1] === to.split(' ')[1] ? fromFull.split(' ')[0]! : fromFull;
  const day = dayText(run.startedAt, t);
  if (!run.sourceExportedAt) return t('admin.import.runLineNoExport', { day, from, to });
  if (sameDay(run.startedAt, run.sourceExportedAt)) return t('admin.import.runLineSameDay', { day, from, to, export: clockOf(run.sourceExportedAt, lang) });
  return t('admin.import.runLine', { day, from, to, export: whenText(run.sourceExportedAt, lang, t) });
}

/** The widths (percent, 1 decimal) of the clean, flagged and not-imported segments of a count bar; a zero segment is left out. */
export function barSegments(clean: number, flagged: number, no: number): { cls: 'c-ok' | 'c-flag' | 'c-no'; width: string }[] {
  const total = clean + flagged + no;
  if (total === 0) return [];
  return ([['c-ok', clean], ['c-flag', flagged], ['c-no', no]] as const)
    .filter(([, n]) => n > 0)
    .map(([cls, n]) => ({ cls, width: `${((n / total) * 100).toFixed(1)}%` }));
}

export const STAGE_KEY: Record<RunAnswer['stage'], MessageKey> = {
  parse: 'admin.import.stage.parse', validate: 'admin.import.stage.validate', match: 'admin.import.stage.match', write: 'admin.import.stage.write',
};

/** The words for a failed run's code (F-521); a code the page does not know is named, never hidden. */
export function failureWords(code: string | null, t: T): string {
  if (code === 'attempts_exhausted' || code === 'generator_manifest' || code === 'import_failed') return t(`admin.import.failure.${code}` as MessageKey);
  return t('admin.import.failure.other', { code: code ?? 'unknown' });
}

/** Facts a pair's why key names (match.ts WHY_FIELDS): `phone_and_house_number_match_name_and_street_differ`. */
export function whyParts(why: string): { exact: boolean; match: string[]; differ: string[] } {
  if (why === 'exact_match') return { exact: true, match: [], differ: [] };
  const m = /^(?:(.+?)_match)?(?:_?(.+)_differ)?$/.exec(why);
  const facts = (s: string | undefined) => (s ? s.split('_and_').filter((f) => f !== '') : []);
  return { exact: false, match: facts(m?.[1]), differ: facts(m?.[2]) };
}

export type Decision = 'merge' | 'keep_separate' | 'skip';

/** CTL-OFC-14-10: M, K and S, with no modifier held, on the shown pair's region only (the handler sits on that region, WCAG 2.1.4). */
export function decisionForKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): Decision | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key.toLowerCase()) {
    case 'm': return 'merge';
    case 'k': return 'keep_separate';
    case 's': return 'skip';
    default: return null;
  }
}

/** Which decisions a pair takes (CTL-OFC-14-04, -05, -09). */
export function canDecide(status: Pair['status'], d: Decision): boolean {
  if (d === 'skip') return status === 'listed';
  return status === 'listed' || status === 'skipped';
}

/** The index shown after a decision: a decided pair leaves the To check list, so the next one takes its place; elsewhere the next one follows. */
export function indexAfter(index: number, length: number, filter: string): number {
  const next = filter === 'to_check' ? index : index + 1;
  return Math.max(0, Math.min(next, length - 1));
}

/** The rows of the side-by-side view with the word that marks a difference (CTL-OFC-14-06). */
export function differs(a: string, b: string): boolean {
  return a !== b;
}

/** The button label progress "n of total" value as a fraction for the bar (percent with 1 decimal). */
export const pct = (n: number, total: number): string => (total === 0 ? '0%' : `${((n / total) * 100).toFixed(1)}%`);
