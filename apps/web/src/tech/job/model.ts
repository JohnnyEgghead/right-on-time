// SPDX-License-Identifier: AGPL-3.0-or-later
// The job screens' pure rules (SCR-TEC-04 to SCR-TEC-07; UI-SPECIFICATION 4.5 rules 6 and 7): the job as the server last
// answered it with the phone's own waiting items laid over it (a note, a photo or a status the technician entered shows at
// once, marked Waiting to send), the finish screen's checks (FR-BILL-3, FR-TECH-14) and the words the screens show.
import type { FinishPayload, QueuedItem } from '@bw/outbox/src/items/index.ts';
import { fromWire, Temporal } from '@bw/time';
import { windowText, timeText } from '../../board/model.ts';
import type { FinishDraft, JobCopy, Part, PartRow } from './store.ts';

export type JobStatus = JobCopy['job']['status'];

export interface ShownNote { key: string; kind: 'office' | 'technician'; author: string | null; body: string; at: string; waiting: boolean }
export interface ShownPhoto { key: string; by: string | null; at: string; waiting: boolean }

/** The status the phone shows: the server's, moved on by the technician's own waiting status items (rule 6). */
export function shownStatus(job: JobCopy, waiting: readonly QueuedItem[]): { status: JobStatus; waiting: boolean; at: string | null } {
  const mine = waiting.filter((i) => i.jobNumber === job.job.jobNumber);
  const order: Partial<Record<QueuedItem['kind'], JobStatus>> = { on_my_way: 'on_the_way', arrived: 'on_site', finished: 'done', no_one_home: 'no_one_home' };
  let status = job.job.status;
  let at: string | null = null;
  let moved = false;
  if (status === 'canceled') return { status, waiting: false, at: null };
  for (const i of mine) {
    const to = order[i.kind];
    if (!to || isRefusedFinish(i)) continue;
    status = to;
    at = i.demoTime;
    moved = true;
  }
  return { status, waiting: moved, at };
}

/** The notes the job shows: the server's, with the technician's own unsent notes first (newest first, CTL-TEC-04-08). */
export function shownNotes(job: JobCopy, waiting: readonly QueuedItem[], me: string | null): ShownNote[] {
  const local = waiting.filter((i): i is Extract<QueuedItem, { kind: 'note' }> => i.jobNumber === job.job.jobNumber && i.kind === 'note')
    .map((i) => ({ key: i.key, kind: 'technician' as const, author: me, body: i.payload.text, at: i.demoTime, waiting: true }))
    .reverse();
  // A note the server already holds (its id is the item key) shows once, as the server's.
  const held = new Set(job.notes.map((n) => n.id.toLowerCase()));
  const own = local.filter((n) => !held.has(n.key.toLowerCase()));
  return [...own, ...job.notes.map((n) => ({ key: n.id, kind: n.kind, author: n.author, body: n.body, at: n.at, waiting: false }))];
}

/** The photos the job shows: the server's in the order taken, then the technician's own unsent ones (CTL-TEC-04-10). */
export function shownPhotos(job: JobCopy, waiting: readonly QueuedItem[], me: string | null): ShownPhoto[] {
  const local = waiting.filter((i) => i.jobNumber === job.job.jobNumber && i.kind === 'photo')
    .map((i) => ({ key: i.key, by: me, at: i.demoTime, waiting: true }));
  const held = new Set(job.photos.map((p) => p.key));
  return [...job.photos.map((p) => ({ ...p, waiting: false })), ...local.filter((p) => !held.has(p.key))];
}

/** Whether the technician's own finish of this job waits on the phone (the finish screen is then closed: the job is Done). */
export const finishWaits = (jobNumber: number, waiting: readonly QueuedItem[]): boolean =>
  waiting.some((i) => i.jobNumber === jobNumber && i.kind === 'finished');

/** F-1025: a finish item the server refused for want of parts (CTL-TEC-07-08): the job is not Done while it waits, so the technician can reopen the finish screen. */
export const isRefusedFinish = (i: QueuedItem): boolean => i.kind === 'finished' && i.lastTry?.outcome === 'refused' && i.lastTry.code === 'parts_required';

/**
 * F-1048: SCR-TEC-09's refused-finish row acts as a link the app's way (role link, in the tab order, a click or Enter opens the job's
 * finish screen, UI-SPECIFICATION 4.5 rule 10); a plain row gets none of it. `to` is the move to a page (nav.ts go).
 */
export function rowLink(i: QueuedItem, to: (href: string) => void): { role?: 'link'; tabIndex?: 0; onClick?: () => void; onKeyDown?: (e: { key: string }) => void } {
  if (!isRefusedFinish(i)) return {};
  const open = () => to(`/tech/jobs/${i.jobNumber}/finish`);
  return { role: 'link', tabIndex: 0, onClick: open, onKeyDown: (e) => { if (e.key === 'Enter') open(); } };
}

/** F-1025: the job's waiting finish the server refused for want of parts (CTL-TEC-07-08); a corrected finish replaces it under its key. */
export function refusedFinish(jobNumber: number, waiting: readonly QueuedItem[]): (QueuedItem & { kind: 'finished'; payload: FinishPayload }) | null {
  const i = waiting.find((w) => w.jobNumber === jobNumber && w.kind === 'finished' && w.lastTry?.outcome === 'refused' && w.lastTry.code === 'parts_required');
  return (i as (QueuedItem & { kind: 'finished'; payload: FinishPayload }) | undefined) ?? null;
}

/**
 * The finish screen's entries rebuilt from a refused finish, so the technician corrects what was sent rather than typing it again:
 * its parts (named from the parts list; one no longer on it is left out), No parts used, the labor and the work-done lines. The
 * signature is not in the finish item (it is its own item, already entered), so the pad starts empty.
 */
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

/** "10 AM-12 PM" (the board's window words). */
export const windowWords = (job: JobCopy): string => windowText(job.job.window.start, job.job.window.end);
/** When an item was entered, as SCR-TEC-09 says it: the time, with the short date when it was another demo day than today (DK-111 Old items). */
export function enteredWords(at: string, demoNowMs: number | null, lang: string): string {
  const z = fromWire(at);
  const today = demoNowMs === null ? null : Temporal.Instant.fromEpochMilliseconds(demoNowMs).toZonedDateTimeISO(z.timeZoneId).toPlainDate().toString();
  return today !== null && at.slice(0, 10) !== today ? `${dateShort(at, lang)}, ${clockWords(at)}` : clockWords(at);
}

/**
 * FR-AUTH-4 (F-1034): the phone number only for today's jobs. The server's `today` is true for the demo day of its read; a copy kept on
 * the phone is shown later with no signal, so the day is compared again with the phone's own demo date (the job's window day). A kept copy
 * with no demo date known yet is not trusted: its number stays hidden until the date is known.
 */
export function shownAsToday(job: JobCopy, demoNowMs: number | null, fromPhone: boolean): boolean {
  if (!job.job.today) return false;
  if (demoNowMs === null) return !fromPhone;
  const z = fromWire(job.job.window.start);
  const day = Temporal.Instant.fromEpochMilliseconds(demoNowMs).toZonedDateTimeISO(z.timeZoneId).toPlainDate().toString();
  return job.job.window.start.slice(0, 10) === day;
}

/** "12:50 PM" of a wire time. */
export const clockWords = (wire: string): string => timeText(wire);

const locale = (lang: string) => (lang === 'es' ? 'es-US' : 'en-US');
/** A date with its year and no weekday ("Oct 14, 2025"): a past visit, a note of another year than the job's. */
export const datePast = (date: string, lang: string): string =>
  new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString(locale(lang), { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
/** "Thu, Sep 10" (a note of the job's year). */
export const dateShort = (date: string, lang: string): string =>
  new Date(`${date.slice(0, 10)}T12:00:00Z`).toLocaleDateString(locale(lang), { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A note's time as DK-110 writes it: the time for one of the job's day, the short date in the job's year, else the date with its year. */
export function noteWhen(at: string, jobDate: string, lang: string): string {
  const day = at.slice(0, 10);
  if (day === jobDate) return clockWords(at);
  return day.slice(0, 4) === jobDate.slice(0, 4) ? dateShort(day, lang) : datePast(day, lang);
}

// ---------- The finish screen (SCR-TEC-07) ----------

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

/** CTL-TEC-07-04: a quantity of at least 1. */
export const stepQuantity = (rows: readonly PartRow[], partId: string, by: number): PartRow[] =>
  rows.map((r) => (r.partId === partId ? { ...r, quantity: Math.max(1, r.quantity + by) } : r));

/** CTL-TEC-07-07: the labor prefilled from the Arrived time to now (UD-10), in whole minutes, never below 0. */
export function laborFrom(arrivedAt: string | null, demoNowMs: number): { hours: string; minutes: string } {
  if (!arrivedAt) return { hours: '0', minutes: '0' };
  const from = fromWire(arrivedAt).toInstant().epochMilliseconds;
  const total = Math.max(0, Math.floor((demoNowMs - from) / 60_000));
  return { hours: String(Math.floor(total / 60)), minutes: String(total % 60) };
}

/** The labor minutes the fields say; null when 0, empty or not whole numbers (the field's message). */
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

/** "2 hr 9 min" for the confirm step. */
export const laborWords = (minutes: number): { h: number; m: number } => ({ h: Math.floor(minutes / 60), m: minutes % 60 });

/** The demo time now as a wire time in the job's zone (the signature's time; the Saved state's Done at). */
export function demoWire(demoNowMs: number, zone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(demoNowMs).toZonedDateTimeISO(zone).toString({ smallestUnit: 'second' });
}
