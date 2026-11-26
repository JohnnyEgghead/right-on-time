// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-12 Admin: arrival windows and SCR-OFC-24 Switch a day's windows: the pure parts of the page (UI-SPECIFICATION CTL-OFC-12-01 to
// CTL-OFC-12-13, CTL-OFC-24-01 to CTL-OFC-24-04; FR-BOOK-2, FR-BOOK-17, FR-BOOK-18). API-90's answer in, the numbers, words and rules the
// screen shows out; no React and no clock of its own ("today" is the answer's `today`, the demo clock's date, FR-DEMO-2).
import type { MessageKey } from '@bw/i18n';
import type { bookingSettings, setWindowLimits, z } from '@bw/api';
import { clockLabel, dateNumbers, timeParts, windowLabel, wireClock } from '../week/week-model.ts';

export type Settings = z.infer<typeof bookingSettings.response>;
export type SettingsWindow = Settings['windows'][number];
export type SettingsDay = Settings['days'][number];
export type Span = { start: string; end: string };
export type T = (key: MessageKey, values?: Record<string, string | number>) => string;

/** FR-BOOK-17: a limit is a whole number from 0 to this (the contract's own bound). */
export const LIMIT_MAX = 999;
/** CTL-OFC-12-11: 2 weeks from the week that holds today. */
const CALENDAR_DAYS = 14;

export const spanLabel = (s: Span): string => windowLabel(timeParts(s.start), timeParts(s.end));

const wd = (t: T, n: number) => t(`time.weekday.${n}` as MessageKey);
const mo = (t: T, n: number) => t(`time.month.${n}` as MessageKey);

/** "Wed, Sep 16". */
export function dayText(t: T, date: string): string {
  const n = dateNumbers(date);
  return t('windows.date.short', { weekday: wd(t, n.weekday), month: mo(t, n.month), day: n.day });
}

/** "Sep 16": the calendar day's own label. */
export function dayShort(t: T, date: string): string {
  const n = dateNumbers(date);
  return t('windows.date.md', { month: mo(t, n.month), day: n.day });
}

/** "Mon, Sep 14, 4:10 PM": the wall time of a wire time in its own zone (never the device's). */
export function whenText(t: T, wire: string): string {
  const c = wireClock(wire);
  const n = dateNumbers(c.date);
  return t('shell.clock.short', { weekday: wd(t, n.weekday), month: mo(t, n.month), day: n.day, time: clockLabel(c.hour, c.minute) });
}

/** "A, B and C": the frame joins a list without a serial comma, in both languages. */
export function joinItems(t: T, items: readonly string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${t('windows.and')} ${items[items.length - 1]}`;
}

export const joinSpans = (t: T, spans: readonly Span[]): string => joinItems(t, spans.map(spanLabel));

/** "5:00 PM": an HH:MM rule time as the page words it. */
export const timeText = (hhmm: string): string => {
  const p = timeParts(hhmm);
  return clockLabel(p.hour, p.minute);
};

export type LimitParse = { ok: true; value: number } | { ok: false };

/** CTL-OFC-12-01: a typed limit is digits only, a whole number from 0 to LIMIT_MAX. */
export function parseLimit(text: string): LimitParse {
  if (!/^\d{1,3}$/.test(text.trim())) return { ok: false };
  const value = Number(text.trim());
  return value <= LIMIT_MAX ? { ok: true, value } : { ok: false };
}

/** The draft the fields start from: each window's saved limit as text. */
export const draftOf = (windows: readonly SettingsWindow[]): Record<string, string> => Object.fromEntries(windows.map((w) => [w.windowId, String(w.limit)]));

/** CTL-OFC-12-01, -06, -07: which windows differ from the saved numbers, which typed numbers are not valid, and the body of a save. */
export function draftState(windows: readonly SettingsWindow[], draft: Record<string, string>) {
  const changed = windows.filter((w) => (draft[w.windowId] ?? String(w.limit)) !== String(w.limit));
  const invalid = new Set(windows.filter((w) => !parseLimit(draft[w.windowId] ?? String(w.limit)).ok).map((w) => w.windowId));
  const limits: z.input<typeof setWindowLimits.request>['limits'] = changed.flatMap((w) => {
    const p = parseLimit(draft[w.windowId] ?? '');
    return p.ok ? [{ windowId: w.windowId, limit: p.value }] : [];
  });
  return { changed: changed.length > 0, changedIds: new Set(changed.map((w) => w.windowId)), invalid, limits, canSave: changed.length > 0 && invalid.size === 0 };
}

/** Why a day cannot be switched, or null when it can (CTL-OFC-12-04: not Closed, not before today, not a Saturday). */
export type SwitchBar = 'past' | 'closed' | 'saturday' | null;
export function switchBar(day: SettingsDay, today: string): SwitchBar {
  if (day.date < today) return 'past';
  if (day.mode === 'closed') return 'closed';
  if (dateNumbers(day.date).weekday === 6) return 'saturday';
  return null;
}

/** The Monday and the Sunday of the week that holds a day (the week runs Monday to Sunday). */
const weekOf = (date: string): { from: string; to: string } => {
  const t = new Date(`${date}T00:00:00Z`);
  const back = (t.getUTCDay() + 6) % 7;
  const at = (n: number) => new Date(t.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  return { from: at(-back), to: at(6 - back) };
};

/** The other 4-hour days of the picked day's week, Monday to Sunday: "Fri, Sep 18 is switched too" (CTL-OFC-12-12, F-754). */
export const otherSwitched = (days: readonly SettingsDay[], date: string): string[] => {
  const week = weekOf(date);
  return days.slice(0, CALENDAR_DAYS).filter((d) => d.mode === 'four_hour' && d.date !== date && d.date >= week.from && d.date <= week.to).map((d) => d.date);
};

/**
 * The day the address asks for that the 2 calendar weeks do not hold, or null (F-748). The week board's day-mode menu (CTL-OFC-34-15) links
 * here from any upcoming week, so the page reads that 1 day as well: it follows the 14 days of `days`, the panel and the confirm find it there,
 * and the calendar draws only the 14. A day before today is not read: no link is drawn on one, and the page opens on today.
 */
export const farDay = (days: readonly SettingsDay[], asked: string | null, today: string): string | null =>
  asked !== null && asked > today && !days.some((d) => d.date === asked) ? asked : null;

/** The picked day: the one asked for (the address's date, a click) when the calendar holds it, else today (CTL-OFC-12-12 "opens on today"). */
export function pickedOf(days: readonly SettingsDay[], asked: string | null, today: string): SettingsDay | null {
  return days.find((d) => d.date === asked) ?? days.find((d) => d.date === today) ?? days[0] ?? null;
}

/** API-91's refusals as the dialog's message key (CTL-OFC-24-02 "Errors to UI"). */
export function switchRefusal(code: string): MessageKey {
  switch (code) {
    case 'day_past': return 'windows.dlg.dayPast';
    case 'day_closed': return 'windows.dlg.dayClosed';
    case 'rule_refused': return 'windows.sat';
    default: return 'windows.dlg.failed';
  }
}

/** The calendar's rows: the 14 days in weeks of 7. */
export const weeksOf = (days: readonly SettingsDay[]): SettingsDay[][] => [days.slice(0, 7), days.slice(7, 14)].filter((w) => w.length > 0);
