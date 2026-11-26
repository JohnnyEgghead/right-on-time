// SPDX-License-Identifier: AGPL-3.0-or-later
// The native job screens' pure rules (SCR-TEC-04 to SCR-TEC-07, SCR-TEC-09; UI-SPECIFICATION 4.5 rules 6, 7 and 10): the job as the
// server last answered it (API-101) with the phone's own waiting items laid over it, the finish screen's checks (FR-BILL-3,
// FR-TECH-14) and the words the screens show. The rules are P5-TWA-JOB's (apps/web/src/tech/job/model.ts), ported because the native
// app imports no web code (SD-2); model.test.ts holds the 2 to the same answers on the same inputs.
import type { MyJobAnswer, PartsAnswer } from '@bw/api';
import type { FinishPayload, QueuedItem } from '@bw/outbox/src/items/native.ts';
import { fromWire, Temporal } from '@bw/time';
import type { Stroke } from './signature.ts';

export type JobCopy = MyJobAnswer;
export type Part = PartsAnswer['parts'][number];
export type JobStatus = JobCopy['job']['status'];

export interface PartRow { partId: string; name: string; code: string; quantity: number }

/** The finish screen's entries, kept on the phone until the job is finished (CTL-TEC-07-10, -11, -14). */
export interface FinishDraft {
  jobNumber: number;
  parts: PartRow[];
  noPartsUsed: boolean;
  /** The labor fields as typed (CTL-TEC-07-07); null until edited (prefilled from Arrived to now). */
  hours: string | null;
  minutes: string | null;
  workDone: string[];
  /** The customer's signature as drawn (finger strokes in the pad's points) and the demo time it was signed at; the PNG is made at the finish. */
  signature: { strokes: Stroke[]; width: number; height: number; at: string } | null;
}

export interface ShownNote { key: string; kind: 'office' | 'technician'; author: string | null; body: string; at: string; waiting: boolean }
export interface ShownPhoto { key: string; by: string | null; at: string; waiting: boolean }

/** F-1025: a finish item the server refused for want of parts (CTL-TEC-07-08): the job is not Done while it waits. */
export const isRefusedFinish = (i: QueuedItem): boolean => i.kind === 'finished' && i.lastTry?.outcome === 'refused' && i.lastTry.code === 'parts_required';

/** The status the phone shows: the server's, moved on by the technician's own waiting status items (rule 6). */
export function shownStatus(job: JobCopy, waiting: readonly QueuedItem[]): { status: JobStatus; waiting: boolean; at: string | null } {
  const order: Partial<Record<QueuedItem['kind'], JobStatus>> = { on_my_way: 'on_the_way', arrived: 'on_site', finished: 'done', no_one_home: 'no_one_home' };
  let status = job.job.status;
  let at: string | null = null;
  let moved = false;
  if (status === 'canceled') return { status, waiting: false, at: null };
  for (const i of waiting.filter((w) => w.jobNumber === job.job.jobNumber)) {
    const to = order[i.kind];
    if (!to || isRefusedFinish(i)) continue;
    status = to;
    at = i.demoTime;
    moved = true;
  }
  return { status, waiting: moved, at };
}

/** The notes the job shows: the technician's own unsent notes first (newest first), then the server's (CTL-TEC-04-08). */
export function shownNotes(job: JobCopy, waiting: readonly QueuedItem[], me: string | null): ShownNote[] {
  const local = waiting.filter((i): i is Extract<QueuedItem, { kind: 'note' }> => i.jobNumber === job.job.jobNumber && i.kind === 'note')
    .map((i) => ({ key: i.key, kind: 'technician' as const, author: me, body: i.payload.text, at: i.demoTime, waiting: true }))
    .reverse();
  const held = new Set(job.notes.map((n) => n.id.toLowerCase()));
  return [...local.filter((n) => !held.has(n.key.toLowerCase())), ...job.notes.map((n) => ({ key: n.id, kind: n.kind, author: n.author, body: n.body, at: n.at, waiting: false }))];
}

/** The photos the job shows: the server's in the order taken, then the technician's own unsent ones (CTL-TEC-04-10). */
export function shownPhotos(job: JobCopy, waiting: readonly QueuedItem[], me: string | null): ShownPhoto[] {
  const held = new Set(job.photos.map((p) => p.key));
  const local = waiting.filter((i) => i.jobNumber === job.job.jobNumber && i.kind === 'photo' && !held.has(i.key))
    .map((i) => ({ key: i.key, by: me, at: i.demoTime, waiting: true }));
  return [...job.photos.map((p) => ({ ...p, waiting: false })), ...local];
}

/** Whether the technician's own finish of this job waits on the phone (the finish screen is then closed: the job is Done). */
export const finishWaits = (jobNumber: number, waiting: readonly QueuedItem[]): boolean =>
  waiting.some((i) => i.jobNumber === jobNumber && i.kind === 'finished');

/** F-1025: the job's waiting finish the server refused for want of parts; a corrected finish replaces it under its key. */
export function refusedFinish(jobNumber: number, waiting: readonly QueuedItem[]): (QueuedItem & { kind: 'finished'; payload: FinishPayload }) | null {
  const i = waiting.find((w) => w.jobNumber === jobNumber && isRefusedFinish(w));
  return (i as (QueuedItem & { kind: 'finished'; payload: FinishPayload }) | undefined) ?? null;
}

/** The finish screen's entries rebuilt from a refused finish (its parts named from the parts list), so the technician corrects what was sent. */
export function draftFromRefused(jobNumber: number, p: FinishPayload, parts: readonly Part[] | null): FinishDraft {
  const byId = new Map((parts ?? []).map((x) => [x.partId, x]));
  const rows = p.parts.flatMap((r) => {
    const x = byId.get(r.partId);
    return x ? [{ partId: r.partId, name: x.name, code: x.code, quantity: r.quantity }] : [];
  });
  return {
    jobNumber, parts: rows, noPartsUsed: p.noPartsUsed, hours: String(Math.floor(p.laborMinutes / 60)), minutes: String(p.laborMinutes % 60),
    workDone: p.workDone.length > 0 ? [...p.workDone] : [''], signature: null,
  };
}

// ---------- words ----------

const parts12 = (wire: string) => {
  const z = fromWire(wire);
  return { h12: z.hour % 12 === 0 ? 12 : z.hour % 12, minute: z.minute, pm: z.hour >= 12 };
};
const clock = (p: { h12: number; minute: number }, always: boolean) => (always || p.minute !== 0 ? `${p.h12}:${String(p.minute).padStart(2, '0')}` : `${p.h12}`);
const mer = (pm: boolean) => (pm ? 'PM' : 'AM');

/** "12:50 PM" of a wire time in its own zone (UD-16: AM and PM in both languages). */
export const clockWords = (wire: string): string => {
  const p = parts12(wire);
  return `${clock(p, true)} ${mer(p.pm)}`;
};

/** "10 AM-12 PM", "8-10 AM" (the board's window words). */
export function windowWords(job: JobCopy): string {
  const a = parts12(job.job.window.start);
  const b = parts12(job.job.window.end);
  return a.pm === b.pm ? `${clock(a, false)}-${clock(b, false)} ${mer(b.pm)}` : `${clock(a, false)} ${mer(a.pm)}-${clock(b, false)} ${mer(b.pm)}`;
}

const locale = (lang: string) => (lang === 'es' ? 'es-US' : 'en-US');
/** "Oct 14, 2025": a past visit, a note of another year than the job's. */
export const datePast = (date: string, lang: string): string =>
  new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString(locale(lang), { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
/** "Thu, Sep 10" (a note of the job's year). */
export const dateShort = (date: string, lang: string): string =>
  new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString(locale(lang), { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A note's time as the frames write it: the time on the job's day, the short date in the job's year, else the date with its year. */
export function noteWhen(at: string, jobDate: string, lang: string): string {
  const day = at.slice(0, 10);
  if (day === jobDate) return clockWords(at);
  return day.slice(0, 4) === jobDate.slice(0, 4) ? dateShort(day, lang) : datePast(day, lang);
}

/** When an item was entered, as SCR-TEC-09 says it: the time, with the short date when it was another demo day than today. */
export function enteredWords(at: string, demoNowMs: number | null, lang: string): string {
  const z = fromWire(at);
  const today = demoNowMs === null ? null : Temporal.Instant.fromEpochMilliseconds(demoNowMs).toZonedDateTimeISO(z.timeZoneId).toPlainDate().toString();
  return today !== null && at.slice(0, 10) !== today ? `${dateShort(at, lang)}, ${clockWords(at)}` : clockWords(at);
}

/** FR-AUTH-4 (F-1034): the number only for today's jobs; a kept copy is compared again with the phone's own demo date. */
export function shownAsToday(job: JobCopy, demoNowMs: number | null, fromPhone: boolean): boolean {
  if (!job.job.today) return false;
  if (demoNowMs === null) return !fromPhone;
  const z = fromWire(job.job.window.start);
  const day = Temporal.Instant.fromEpochMilliseconds(demoNowMs).toZonedDateTimeISO(z.timeZoneId).toPlainDate().toString();
  return job.job.window.start.slice(0, 10) === day;
}

/** The demo time now as a wire time in the job's zone (the signature's time). */
export const demoWire = (demoNowMs: number, zone: string): string =>
  Temporal.Instant.fromEpochMilliseconds(demoNowMs).toZonedDateTimeISO(zone).toString({ smallestUnit: 'second' });

// ---------- the rules of the Finish job screen (SCR-TEC-07) ----------

/** CTL-TEC-07-02: the parts whose name or code holds the typed text, ignoring case (OA-54: only the fixed list). */
export function findParts(parts: readonly Part[], text: string, limit = 6): Part[] {
  const q = text.trim().toLowerCase();
  if (q === '') return [];
  return parts.filter((p) => p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)).slice(0, limit);
}

/** Picking a result: a new row with quantity 1, or the same rows when the part is listed (focus moves to its quantity). */
export function addPart(rows: readonly PartRow[], p: Part): { rows: PartRow[]; added: boolean } {
  if (rows.some((r) => r.partId === p.partId)) return { rows: [...rows], added: false };
  return { rows: [...rows, { partId: p.partId, name: p.name, code: p.code, quantity: 1 }], added: true };
}

/** Changes the quantity of 1 part by `by`, never below 1 (CTL-TEC-07-04). */
export const stepQuantity = (rows: readonly PartRow[], partId: string, by: number): PartRow[] =>
  rows.map((r) => (r.partId === partId ? { ...r, quantity: Math.max(1, r.quantity + by) } : r));

/** CTL-TEC-07-07: the labor prefilled from the Arrived time to now (UD-10), in whole minutes, never below 0. */
export function laborFrom(arrivedAt: string | null, demoNowMs: number): { hours: string; minutes: string } {
  if (!arrivedAt) return { hours: '0', minutes: '0' };
  const total = Math.max(0, Math.floor((demoNowMs - fromWire(arrivedAt).toInstant().epochMilliseconds) / 60_000));
  return { hours: String(Math.floor(total / 60)), minutes: String(total % 60) };
}

/** The labor minutes the fields say; null when 0, empty or not whole numbers. */
export function laborMinutes(hours: string, minutes: string): number | null {
  const h = hours.trim() === '' ? 0 : Number(hours);
  const m = minutes.trim() === '' ? 0 : Number(minutes);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59) return null;
  const total = h * 60 + m;
  return total > 0 ? total : null;
}

export type FinishCheck = { ok: true; payload: FinishPayload } | { ok: false; on: 'parts' | 'labor' };

/** CTL-TEC-07-06: a finish needs parts or No parts used (FR-BILL-3) and a labor time; the work-done lines go blank-free. */
export function checkFinish(d: FinishDraft, labor: { hours: string; minutes: string }): FinishCheck {
  if (d.parts.length === 0 && !d.noPartsUsed) return { ok: false, on: 'parts' };
  const minutes = laborMinutes(labor.hours, labor.minutes);
  if (minutes === null) return { ok: false, on: 'labor' };
  return {
    ok: true,
    payload: {
      parts: d.noPartsUsed ? [] : d.parts.map((p) => ({ partId: p.partId, quantity: p.quantity })),
      noPartsUsed: d.noPartsUsed && d.parts.length === 0, laborMinutes: minutes,
      workDone: d.workDone.map((l) => l.trim()).filter((l) => l !== ''),
    },
  };
}

export const emptyFinish = (jobNumber: number): FinishDraft => ({ jobNumber, parts: [], noPartsUsed: false, hours: null, minutes: null, workDone: [''], signature: null });

/** "2 hr 9 min" parts. */
export const laborWords = (minutes: number): { h: number; m: number } => ({ h: Math.floor(minutes / 60), m: minutes % 60 });

/** Where the outer scroll goes to show the history heading: the heading's y inside the body plus the body's y in the scroll (null until both are laid out; F-1688). */
export const historyScrollY = (body: number | null, head: number | null): number | null => (body === null || head === null ? null : body + head);
