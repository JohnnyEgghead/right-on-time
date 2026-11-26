// SPDX-License-Identifier: AGPL-3.0-or-later
// The pure side of the Messages pages (SCR-OFC-08 text log, SCR-OFC-09 call list): the rows the log draws (texts and replies merged by
// time), the words around them (the same module the CSV export uses, @bw/i18n text-rows, so the export says each row as the page does), and
// the call list's grouping and script. No React here; model.test.ts pins it.
import type { callList, textDetail, textLog, z } from '@bw/api';
import { clockOfWire, hourWordOfWire, windowLabelOfWire, type MessageKey, type RowT, type StatusFacts, type TimeWords } from '@bw/i18n';
import { formatTime, fromWire, zoneAbbreviation, type Language } from '@bw/time';
import type { ClientT } from '../shell/intl.tsx';
import { addDays, dateNumbers } from '../week/week-model.ts';

export type LogData = z.infer<typeof textLog.response>;
export type TextRowData = LogData['texts'][number];
export type ReplyRowData = LogData['replies'][number];
export type DetailData = z.infer<typeof textDetail.response>;
export type CallData = z.infer<typeof callList.response>;
export type ReminderCall = CallData['reminderCalls'][number];
export type FailedText = CallData['failedTexts'][number];
export type CallOutcome = NonNullable<ReminderCall['outcome']>['kind'];

export interface LogFilters {
  type: string;
  status: string;
  language: string;
  customer: string;
}
export const NO_FILTERS: LogFilters = { type: '', status: '', language: '', customer: '' };
export const filtersSet = (f: LogFilters): boolean => f.type !== '' || f.status !== '' || f.language !== '' || f.customer.trim() !== '';

/** One row of the log: a text or a reply. */
export type LogRow = { kind: 'text'; key: string; at: string; row: TextRowData } | { kind: 'reply'; key: string; at: string; row: ReplyRowData };

const epoch = (wire: string): number => fromWire(wire).epochMilliseconds;

/** The page's rows, newest first (the API pages by time, so a page is already in order; a live update keeps it so). */
export function logRows(data: LogData): LogRow[] {
  const rows: LogRow[] = [
    ...data.texts.map((row): LogRow => ({ kind: 'text', key: `text:${row.id}`, at: row.at, row })),
    ...data.replies.map((row): LogRow => ({ kind: 'reply', key: `reply:${row.id}`, at: row.at, row })),
  ];
  return rows.sort((a, b) => epoch(b.at) - epoch(a.at) || (a.key < b.key ? 1 : -1));
}

/** "Tue, Sep 15" / "mar, 15 de sep" (the week board's date words). */
export function dayText(t: ClientT, date: string): string {
  const n = dateNumbers(date);
  return t('week.date.short', { weekday: t(`time.weekday.${n.weekday}` as MessageKey), month: t(`time.month.${n.month}` as MessageKey), day: n.day });
}

/** The time helpers the row words need, for the page's language and the branch's zone; the zone words come from the catalog (msg.zone.<IANA name>), else the city. */
export function timeWords(t: RowT, lang: Language, branchZone: string): TimeWords & { windowLabel(w: { start: string; end: string }): string } {
  return {
    clock: clockOfWire,
    hourWord: hourWordOfWire,
    windowLabel: windowLabelOfWire,
    branchClock: (wire) => {
      const at = fromWire(wire).toInstant();
      return `${formatTime(at, branchZone, lang)} ${zoneAbbreviation(at, branchZone)}`;
    },
    zoneWord: (zone) => {
      try {
        return t(`msg.zone.${zone}` as MessageKey);
      } catch {
        return zone.split('/').pop()!.replace(/_/g, ' ');
      }
    },
  };
}

export function statusFactsOf(r: TextRowData, branchZone: string): StatusFacts {
  const customerZone = r.heldUntil ? fromWire(r.heldUntil).timeZoneId : branchZone;
  return { status: r.status, heldUntil: r.heldUntil, tries: r.tries, nextTryAt: r.nextTryAt, customerZone, otherZone: customerZone !== branchZone };
}

/** The type icon of a row (the frame's TYPE table). */
export const TYPE_ICON = { confirmation: 'check', reminder: 'bell', on_the_way: 'truck', late: 'clock', r_reply: 'message', office: 'user', replies: 'message' } as const;

/** The first name on a Call button ("Call Linh"). */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/** Whether the shown day is the demo clock's today (the tiles say "today" then). */
export const isToday = (date: string, today: string | null): boolean => today !== null && date === today;

// --- the call list --------------------------------------------------------------------------------------------------------------------

/** Whether the outcome buttons show for a row: no outcome yet, or the row's Change is open. */
export const showsButtons = (outcome: ReminderCall['outcome'], changing: boolean): boolean => outcome === null || changing;

/**
 * Which outcome buttons a row offers, and which are off (CTL-OFC-09-04, -05, -07, -15): Confirmed and Reschedule need a visit that is
 * still scheduled; No answer is off once the row is Confirmed or Reschedule ("Already reached", UD-53).
 */
export function outcomeRules(row: { outcome: ReminderCall['outcome']; visit: { jobStatus: string } }): { confirm: boolean; reschedule: boolean; noAnswer: boolean } {
  const open = row.visit.jobStatus === 'scheduled';
  const reached = row.outcome?.kind === 'confirmed' || row.outcome?.kind === 'reschedule';
  return { confirm: open, reschedule: open, noAnswer: !reached };
}

/** "between 12 and 2 PM" without the word between: "12 and 2 PM", "10 AM and 12 PM" (the script's window). */
export function betweenWords(win: { start: string; end: string }, t: RowT): string {
  const label = windowLabelOfWire(win); // "12-2 PM" or "10 AM-12 PM"
  const m = /^(\d+(?: [AP]M)?)-(\d+ [AP]M)$/.exec(label);
  const from = m?.[1] ?? label;
  const to = m?.[2] ?? label;
  return t('calls.say.between', { from, to });
}

/**
 * The script's day words for a visit on `day` called about on `callDate` (F-655): null for the next day (the frame's
 * "your visit tomorrow"), else "today" or "on Thu, Sep 17". A failed-text row can be about any day of the week.
 */
function scriptWhen(day: string, callDate: string, t: RowT): string | null {
  if (day === addDays(callDate, 1)) return null;
  if (day === callDate) return t('calls.say.when.today');
  const n = dateNumbers(day);
  return t('calls.say.when.on', {
    day: t('week.date.short', { weekday: t(`time.weekday.${n.weekday}` as MessageKey), month: t(`time.month.${n.month}` as MessageKey), day: n.day }),
  });
}

/** The script's pieces: text and the 2 filled values (shown in bold), so the page can draw the values apart from the words. */
export function scriptParts(
  row: { visit: { day: string; window: { start: string; end: string }; technicianInTexts: string | null } },
  t: RowT,
  callDate: string,
): { text: string; bold: boolean }[] {
  const TECH = '␟T␟';
  const WIN = '␟W␟';
  const tech = row.visit.technicianInTexts;
  const when = scriptWhen(row.visit.day, callDate, t);
  const text = when === null
    ? (tech === null ? t('calls.say.noTech', { window: WIN }) : t('calls.say.script', { tech: TECH, window: WIN }))
    : (tech === null ? t('calls.say.noTechOn', { window: WIN, when }) : t('calls.say.scriptOn', { tech: TECH, window: WIN, when }));
  const win = betweenWords(row.visit.window, t);
  let techSeen = false;
  return text.split(/(␟T␟|␟W␟)/).filter((p) => p !== '').map((p) => {
    if (p === TECH) {
      const bold = !techSeen; // the first mention is bold (the frame), the second is plain
      techSeen = true;
      return { text: tech ?? '', bold };
    }
    return p === WIN ? { text: win, bold: true } : { text: p, bold: false };
  });
}

/** The branch zone's abbreviation for the intro line ("EDT"), at the read's time. */
export function zoneAbbr(zone: string, asOf: string | undefined): string {
  const at = asOf ? fromWire(asOf).toInstant() : null;
  return at ? zoneAbbreviation(at, zone) : zone;
}
