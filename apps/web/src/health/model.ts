// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-16 System health: the pure parts of the page (UI-SPECIFICATION 2.3 SCR-OFC-16; FR-HLTH-1 to FR-HLTH-4, FR-TEXT-16). The values
// come from API-70; this file words them: times (demo time in the branch zone, real time with its zone), sizes, the delay chart's
// points, the simulator's mode line, and the apply rules. No React, so a unit test covers each.
import type { MessageKey } from '@bw/i18n';
import type { systemHealth, z } from '@bw/api';
import { dateParts, formatTime, formatTimeWithZone, fromWire, type Language } from '@bw/time';

export type Health = z.infer<typeof systemHealth.response>;
export type SimMode = Health['textSimulator']['mode'];
export type T = (key: MessageKey, values?: Record<string, string | number>) => string;

export const SIM_MODES: readonly SimMode[] = ['up', 'all_fail', 'fail_customer', 'fail_next_n'];
/** SD-44: N is a whole number from 1 to 20. */
export const N_MAX = 20;

/** The settings' values of FR-HLTH-2 (SPECIFICATIONS 12.1 DATA_LOCATION_*), each with its catalog words (FR-LANG-2, owner ruling on F-665). */
const LOCATION_WORDS: Readonly<Record<string, MessageKey>> = {
  'This computer': 'health.loc.thisComputer',
  'AWS Lightsail, US East (Virginia)': 'health.loc.hosted',
  'AWS Lightsail, US East (Ohio)': 'health.loc.hostedOhio',
  'AWS Lightsail object storage, US East (Virginia)': 'health.loc.backupsHosted',
  'AWS Lightsail object storage, US East (Ohio)': 'health.loc.backupsHostedOhio',
};

/** A location in the page's language; a value the catalog does not hold (an operator's own setting) shows as set. */
export const locationWords = (t: T, value: string): string => {
  const key = LOCATION_WORDS[value];
  return key ? t(key) : value;
};

const wd = (t: T, n: number) => t(`time.weekday.${n}` as MessageKey);
const mo = (t: T, n: number) => t(`time.month.${n}` as MessageKey);

/** "10:28 AM" in the stamp's own zone (demo time: no zone word, the demo strip names it). */
export function demoClock(wire: string, lang: Language): string {
  const z = fromWire(wire);
  return formatTime(z.toInstant(), z.timeZoneId, lang);
}

/** "10:28 AM EDT": a demo time with its zone word (the held line names the branch's own time). */
export function demoClockZone(wire: string, lang: Language): string {
  const z = fromWire(wire);
  return formatTimeWithZone(z.toInstant(), z.timeZoneId, lang);
}

/** "8 AM" on the hour, else "8:30 AM" (the held chip and line, as the frame words them). */
export function heldClock(wire: string, lang: Language): string {
  const z = fromWire(wire);
  const full = formatTime(z.toInstant(), z.timeZoneId, lang);
  return z.minute === 0 ? full.replace(':00', '') : full;
}

/** "Tue, Sep 15, 2:30 AM EDT": real time always names its zone (FR-DEMO-2 named use; UI-SPECIFICATION 2.3). */
export function realWhen(wire: string, lang: Language, t: T, weekday = true): string {
  const z = fromWire(wire);
  const p = dateParts(z.toInstant(), z.timeZoneId);
  return `${weekday ? `${wd(t, p.weekday)}, ` : ''}${mo(t, p.month)} ${p.day}, ${formatTimeWithZone(z.toInstant(), z.timeZoneId, lang)}`;
}

/** "Today, 10:27 AM" for an alert of the demo day, else "Sun, Sep 13, 3:23 AM" (the Recent alerts time). */
export function alertWhen(wire: string, asOf: string, lang: Language, t: T): string {
  const z = fromWire(wire);
  const now = fromWire(asOf).withTimeZone(z.timeZoneId);
  const time = formatTime(z.toInstant(), z.timeZoneId, lang);
  if (z.toPlainDate().equals(now.toPlainDate())) return t('health.alerts.today', { time });
  const p = dateParts(z.toInstant(), z.timeZoneId);
  return `${wd(t, p.weekday)}, ${mo(t, p.month)} ${p.day}, ${time}`;
}

/** "2.4 GB" from bytes (decimal, 1 place; under 1 MB the KB). */
export function sizeText(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** The night strip's cell: "Wed 9" (weekday and day of the month; the date is real, America/New_York). */
export function nightLabel(night: string, t: T): string {
  const [y, m, d] = night.split('-').map(Number) as [number, number, number];
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const weekday = ((noon.getUTCDay() + 6) % 7) + 1;
  return `${wd(t, weekday)} ${d}`;
}

/** Milliseconds as seconds with 1 place: 1300 -> "1.3". */
export const seconds = (ms: number): string => (ms / 1000).toFixed(1);

/** The overall chip: "All working, 2 items need the office" (CTL-OFC-16-11). */
export function overallText(o: Health['overall'], t: T): string {
  const head = t(o.working ? 'health.overall.working' : 'health.overall.attention');
  return o.needsOffice > 0 ? `${head}, ${t('health.overall.items', { count: o.needsOffice })}` : head;
}

/** The simulator's mode line in force (CTL-OFC-16-05): the word, and who set it. */
export function simInForce(s: Health['textSimulator'], t: T): { mode: string; by: string } {
  const mode =
    s.mode === 'fail_customer' ? t('health.sim.now.fail_customer', { customer: s.customerName ?? '' })
    : s.mode === 'fail_next_n' ? t('health.sim.now.fail_next_n', { n: s.nLeft ?? 0 })
    : t(`health.sim.mode.${s.mode}` as MessageKey);
  return { mode, by: s.setBy ?? t('health.sim.setup') };
}

export interface Picked {
  mode: SimMode;
  customerId: string | null;
  n: string;
}

/** What Apply sends for a pick, or the field message that stops it (CTL-OFC-16-02, -03, -04). */
export function applyInput(p: Picked): { ok: true; body: { mode: SimMode; customerId?: string; n?: number } } | { ok: false; field: 'customer' | 'n' } {
  if (p.mode === 'fail_customer') return p.customerId ? { ok: true, body: { mode: p.mode, customerId: p.customerId } } : { ok: false, field: 'customer' };
  if (p.mode === 'fail_next_n') {
    const n = Number(p.n);
    return /^\d+$/.test(p.n.trim()) && n >= 1 && n <= N_MAX ? { ok: true, body: { mode: p.mode, n } } : { ok: false, field: 'n' };
  }
  return { ok: true, body: { mode: p.mode } };
}

/** Apply is enabled when the pick differs from what is in force and its inputs are valid. */
export function canApply(p: Picked, now: Health['textSimulator']): boolean {
  const a = applyInput(p);
  if (!a.ok) return false;
  if (p.mode !== now.mode) return true;
  if (p.mode === 'fail_customer') return p.customerId !== now.customerId;
  if (p.mode === 'fail_next_n') return Number(p.n) !== now.nLeft;
  return false;
}

export interface SparkPoint {
  /** Minutes before the newest stamp, 0 to 60. */
  ago: number;
  ms: number;
}

/** One point per minute that has samples (the minute's slowest), over the last 60 minutes before `end`. */
export function sparkPoints(samples: Health['delay']['samples'], end: string): SparkPoint[] {
  const last = fromWire(end).epochMilliseconds;
  const byMinute = new Map<number, number>();
  for (const s of samples) {
    const ago = Math.floor((last - fromWire(s.at).epochMilliseconds) / 60_000);
    if (ago < 0 || ago > 60) continue;
    byMinute.set(ago, Math.max(byMinute.get(ago) ?? 0, s.ms));
  }
  return [...byMinute.entries()].sort((a, b) => b[0] - a[0]).map(([ago, ms]) => ({ ago, ms }));
}

/** A zone's short name for the held line ("Pacific"); an unknown zone shows its own id. */
export function zoneWord(zone: string, t: T): string {
  try {
    return t(`health.zone.${zone}` as MessageKey);
  } catch {
    return zone; // a zone the catalog has no word for shows its own id
  }
}
