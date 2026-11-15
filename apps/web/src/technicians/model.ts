// SPDX-License-Identifier: AGPL-3.0-or-later
// SCR-OFC-07, -41 and -42 Technicians: what the page derives from API-31's rows (UI-SPECIFICATION SCR-OFC-07; FR-DISP-33, FR-TEXT-11): the hours
// as the frame writes them ("Mon-Fri, 8-5:30"), the load bar's step, the phone apps' lines, the client-side filters (CTL-OFC-07-14 to -17),
// the subtitle and the name-check messages. Pure: no React, no clock of the device (the demo clock's date arrives in the answer).
import type { TechnicianListAnswer, TechnicianRow, TextCheckAnswer } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import type { ClientT } from '../shell/intl.tsx';
import { dateNumbers } from '../week/week-model.ts';

export type TechData = TechnicianListAnswer;
export type TechRow = TechnicianRow;
export type TechSkill = TechRow['skills'][number];
export type T = ClientT;
export type AppKind = 'web' | 'native';

export const WORKING_PICKS = ['', 'today', 'off'] as const;
export type WorkingPick = (typeof WORKING_PICKS)[number];
export const APP_PICKS = ['', 'waiting', 'clear'] as const;
export type AppPick = (typeof APP_PICKS)[number];

export interface Filters { query: string; skill: string; working: WorkingPick; app: AppPick }
export const NO_FILTERS: Filters = { query: '', skill: '', working: '', app: '' };
/** Where the page starts (the frame's Working today, F-763): a technician off today is reached through the Working filter; the subtitle still counts everyone. */
export const START_FILTERS: Filters = { ...NO_FILTERS, working: 'today' };

/** Words the preview states say a skill in (the frame draws skills the seed does not have); the live page uses the catalog's. */
export type SkillWords = Readonly<Record<'en' | 'es', Readonly<Record<string, string>>>>;

export const skillWord = (t: T, id: string, words?: SkillWords): string => words?.[t.lang]?.[id] ?? t(`skill.${id}` as MessageKey);

/** "8-5:30": a shift as the frame writes it, hours on the 12-hour clock without AM or PM, the minutes only when they are not 0. */
export function hoursText(start: string, end: string): string {
  const part = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number) as [number, number];
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m === 0 ? String(h12) : `${h12}:${String(m).padStart(2, '0')}`;
  };
  return `${part(start)}-${part(end)}`;
}

const weekday = (t: T, n: number) => t(`time.weekday.${n}` as MessageKey);

/** "Mon-Fri" for a run of weekdays, else the days listed ("Mon, Wed, Fri"). */
export function daysText(days: readonly number[], t: T): string {
  const d = [...days].sort((a, b) => a - b);
  if (d.length === 0) return '';
  const run = d.every((n, i) => i === 0 || n === d[i - 1]! + 1);
  return run && d.length > 1 ? `${weekday(t, d[0]!)}-${weekday(t, d.at(-1)!)}` : d.map((n) => weekday(t, n)).join(', ');
}

/** The Working hours cell: the days and the shift, then the Saturday pattern. */
export const hoursLine = (r: TechRow, t: T): string => `${daysText(r.workingDays, t)}, ${hoursText(r.workingHours.start, r.workingHours.end)}`;
export const saturdayNote = (r: TechRow): MessageKey => (r.saturdays === 'none' ? 'technicians.sat.none' : 'technicians.sat.alt');

/** A technician's week as API-33 and API-147 write it: 1 shift, the weekdays worked and the Saturday pattern. */
export interface WorkWeek { start: string; end: string; days: number[]; saturdays: TechRow['saturdays'] }
export const weekOf = (r: TechRow): WorkWeek => ({ start: r.workingHours.start, end: r.workingHours.end, days: [...r.workingDays], saturdays: r.saturdays });
export const sameWeek = (a: WorkWeek, b: WorkWeek): boolean =>
  a.start === b.start && a.end === b.end && a.saturdays === b.saturdays && [...a.days].sort().join() === [...b.days].sort().join();
export const withDayOff = (w: WorkWeek, day: number, off: boolean): WorkWeek =>
  ({ ...w, days: off ? w.days.filter((d) => d !== day) : [...w.days, day].sort((a, b) => a - b) });

/** What stops a week being saved (CTL-OFC-07-10, CTL-OFC-41-06): the end not after the start, or no weekday worked (API-33 and API-147 hold at least 1). */
/** The most days 1 time off span holds: the server's own limit (F-768; dispatch-rules MAX_TIME_OFF_DAYS). */
export const MAX_TIME_OFF_DAYS = 366;
/** The days from..to holds, ends included; 0 when either is blank. */
export const spanDays = (from: string, to: string): number =>
  from === '' || to === '' ? 0 : Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

export function weekProblem(w: WorkWeek): 'times' | 'days' | null {
  if (w.days.length === 0) return 'days';
  return w.start === '' || w.end === '' || w.end <= w.start ? 'times' : null;
}

/** The 7 weekdays of a week: each with its hours or null for Off. Saturday is the branch's half day when the technician works any. */
export function weekRows(w: WorkWeek, saturday: TechData['saturdayHours']): { day: number; text: string | null }[] {
  return [1, 2, 3, 4, 5, 6, 7].map((day) => {
    let text: string | null = null;
    if (day <= 5 && w.days.includes(day)) text = hoursText(w.start, w.end);
    else if (day === 6 && w.saturdays !== 'none' && saturday) text = hoursText(saturday.start, saturday.end);
    return { day, text };
  });
}

/** The panel's 7 weekdays (CTL-OFC-07-10): each with its hours or Off; today's is marked. */
export function weekHours(r: TechRow, saturday: TechData['saturdayHours'], today: string): { day: number; text: string | null; today: boolean }[] {
  const todayDay = dateNumbers(today).weekday;
  return weekRows(weekOf(r), saturday).map((d) => ({ ...d, today: d.day === todayDay }));
}

/** The load bar's width step: classes `bw-tc-w<N>` are in the app's sheet (the page CSP refuses a style attribute). */
export const LOAD_STEPS = [0, 17, 20, 33, 40, 50, 60, 67, 80, 83, 100] as const;
export function loadStep(n: number, capacity: number): number {
  if (capacity <= 0) return 0;
  const pct = Math.min(100, (n / capacity) * 100);
  return LOAD_STEPS.reduce((best, s) => (Math.abs(s - pct) < Math.abs(best - pct) ? s : best), 0);
}
export const isFull = (r: TechRow): boolean => r.capacity > 0 && r.todayLoad >= r.capacity;

/** The tags of a row's Skills cell: all of them up to 3, else the first 2 and how many more. */
export function skillTags(r: TechRow, t: T, words?: SkillWords): string[] {
  const names = r.skills.map((s) => skillWord(t, s, words));
  return names.length > 3 ? [...names.slice(0, 2), `+${names.length - 2}`] : names;
}

/** The chip a row's Today column carries (CTL-OFC-07-22): the status word's class, and the timing word beside it for a late or at-risk job. */
export function rightNowChip(r: TechRow): { cls: 'way' | 'site' | 'sched'; key: MessageKey; timing: 'risk' | 'late' | null } | null {
  const n = r.rightNow;
  if (!n) return null;
  const timing = n.timing === 'late' ? 'late' : n.timing === 'atRisk' ? 'risk' : null;
  if (n.status === 'on_the_way') return { cls: 'way', key: 'status.job.onTheWay', timing };
  if (n.status === 'on_site') return { cls: 'site', key: 'status.job.onSite', timing };
  return { cls: 'sched', key: 'technicians.betweenJobs', timing };
}

export const appWord = (kind: AppKind): MessageKey => (kind === 'web' ? 'technicians.app.web' : 'technicians.app.native');

/** A phone app's last report (API-31 `apps`): kept while the app is offline. */
export type AppReport = NonNullable<TechRow['apps'][AppKind]>;
export const waitingTotal = (r: TechRow): number => (r.apps.web?.waitingCount ?? 0) + (r.apps.native?.waitingCount ?? 0);

/** The report the table's Phone app cell shows: the app with items waiting, else the one that synced last. */
export function shownApp(r: TechRow): { kind: AppKind; report: AppReport } | null {
  const all = (['web', 'native'] as const).flatMap((kind) => (r.apps[kind] ? [{ kind, report: r.apps[kind] as AppReport }] : []));
  if (all.length === 0) return null;
  return all.sort((a, b) => b.report.waitingCount - a.report.waitingCount || b.report.lastSyncAt.localeCompare(a.report.lastSyncAt))[0] ?? null;
}

/** "Thu, Oct 1 to Fri, Oct 2", or "Mon, Sep 21" for 1 day. */
export function spanText(from: string, to: string, t: T): string {
  const day = (d: string) => {
    const n = dateNumbers(d);
    return t('week.date.short', { weekday: weekday(t, n.weekday), month: t(`time.month.${n.month}` as MessageKey), day: n.day });
  };
  return from === to ? day(from) : t('technicians.timeOff.span', { from: day(from), to: day(to) });
}

/** The page subtitle (CTL-OFC-07-25): the branch, the technician count, how many work today and the time of the read. */
export function subtitle(data: TechData, branchName: string, time: string, t: T): string {
  const n = data.technicians.length;
  if (n === 0) return t('technicians.sub.none', { branch: branchName, time });
  const working = data.technicians.filter((r) => r.workingToday).length;
  return t('technicians.sub', {
    branch: branchName, count: n, time,
    working: working === n ? t('technicians.sub.all') : t('technicians.sub.some', { n: working }),
  });
}

const digits = (s: string) => s.replace(/\D/g, '');

/** CTL-OFC-07-14 to -17: the filters over the loaded list (a client filter). */
export function filterRows(rows: readonly TechRow[], f: Filters): TechRow[] {
  const q = f.query.trim().toLowerCase();
  const qd = digits(q);
  return rows.filter((r) => {
    if (q !== '') {
      const van = r.van ? [`van ${r.van.number}`.toLowerCase(), r.van.number.toLowerCase()] : [];
      const hit = r.name.toLowerCase().includes(q) || van.some((v) => v.includes(q)) || (qd.length >= 3 && digits(r.phone).includes(qd));
      if (!hit) return false;
    }
    if (f.skill !== '' && !r.skills.includes(f.skill as TechSkill)) return false;
    if (f.working === 'today' && !r.workingToday) return false;
    if (f.working === 'off' && r.workingToday) return false;
    if (f.app === 'waiting' && waitingTotal(r) === 0) return false;
    if (f.app === 'clear' && waitingTotal(r) > 0) return false;
    return true;
  });
}

export const filtersSet = (f: Filters): boolean => f.query.trim() !== '' || f.skill !== '' || f.working !== '' || f.app !== '';

/** The first name: what a toast calls the technician ("Maria already has 1 job that day"). */
export const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/** The letter a name without its accents would use ("ó" gives "o"); null when no plain letter stands for it. */
export function plainLetter(ch: string): string | null {
  const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return base !== ch && /^[\x20-\x7e]$/.test(base) ? base : null;
}

export type NameCheckState = { step: 'idle' } | { step: 'checking' } | { step: 'done'; answer: TextCheckAnswer } | { step: 'failed' };

/** The line under the Name in texts field (CTL-OFC-07-04): what is wrong with the value, or that it fits. */
export function nameMessage(a: TextCheckAnswer, t: T): { ok: boolean; text: string } {
  if (a.ok) return { ok: true, text: t('technicians.name.fits') };
  if (a.problem === 'not_gsm7_basic') {
    const chars = [...new Set(a.characters)];
    const use = chars.map(plainLetter);
    const hint = use.every((u) => u !== null) && chars.length > 0 ? ` ${t('technicians.name.use', { use: use.join(', ') })}` : '';
    return { ok: false, text: `${t('technicians.name.charset', { chars: chars.join(', '), count: chars.length })}${hint}` };
  }
  if (a.problem === 'too_long') return { ok: false, text: t('technicians.name.tooLong', { max: a.maximum, length: a.length }) };
  if (a.problem === 'empty') return { ok: false, text: t('technicians.name.empty') };
  return { ok: false, text: t('technicians.name.breaks') };
}

/** A job of a time off answer as the toast names it: "job 24903, 10 AM-12 PM". */
export function jobsText(jobs: readonly { jobNumber: number; window: { start: string; end: string } }[], t: T, windowText: (start: string, end: string) => string): string {
  return jobs.map((j) => t('technicians.timeOff.job', { job: j.jobNumber, window: windowText(j.window.start, j.window.end) })).join('; ');
}

/** The jobs an hours edit left on days off (API-33 offDayJobs, F-764), each with its day: "job 24903, Mon, Sep 21, 10 AM-12 PM". */
export function offDayJobsText(jobs: readonly { jobNumber: number; date: string; window: { start: string; end: string } }[], t: T, windowText: (start: string, end: string) => string): string {
  return jobs.map((j) => t('technicians.timeOff.job', { job: j.jobNumber, window: `${spanText(j.date, j.date, t)}, ${windowText(j.window.start, j.window.end)}` })).join('; ');
}

export const initials = (name: string): string => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return w.length === 0 ? '' : (w[0]!.charAt(0) + (w.length > 1 ? w.at(-1)!.charAt(0) : '')).toUpperCase();
};

/** What the Skills control writes: the skills ticked, in the branch list's order. */
export const toggleSkill = (all: readonly TechSkill[], have: readonly TechSkill[], skill: TechSkill): TechSkill[] =>
  all.filter((s) => (s === skill ? !have.includes(s) : have.includes(s)));

/** What the panel's fields hold while the person edits (CTL-OFC-07-03, -07-08 to -07-10): the saved values until changed. `hoursOpen`: the hours are in their editor. */
export interface DraftEdit { name: string; vanId: string | null; skills: TechSkill[]; week: WorkWeek; hoursOpen: boolean }
export const draftOf = (r: TechRow): DraftEdit => ({ name: r.nameInTexts, vanId: r.van?.id ?? null, skills: [...r.skills], week: weekOf(r), hoursOpen: false });
