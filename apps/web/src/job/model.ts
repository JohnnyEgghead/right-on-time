// SPDX-License-Identifier: AGPL-3.0-or-later
// The job page's rules as plain functions (SCR-OFC-03 and its dialogs), so they are tested without a browser.
import type { JobDetailAnswer } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { analyzeSms } from '@bw/sms';
import { noRoomShown } from '../board/model.ts';

export type Job = JobDetailAnswer;
export type JobStatus = Job['job']['status'];

/** CTL-OFC-03-04 to -08: the office may change a job that is not Done, No one home or Canceled (F-505, owner ruling 4241980e). */
export const CLOSED: ReadonlySet<JobStatus> = new Set(['done', 'no_one_home', 'canceled']);
export const actionsOpen = (s: JobStatus): boolean => !CLOSED.has(s);

/** The reason the actions are off, as the page's states name it (Canceled, Done, No one home). */
export function closedKey(s: JobStatus): 'job.closed.canceled' | 'job.closed.done' | 'job.closed.noOneHome' | null {
  return s === 'canceled' ? 'job.closed.canceled' : s === 'done' ? 'job.closed.done' : s === 'no_one_home' ? 'job.closed.noOneHome' : null;
}

/** The status word's catalog key (FR-DISP-14), Unassigned when no technician holds a scheduled job. */
export function statusKey(j: Job['job']): 'status.job.unassigned' | 'status.job.scheduled' | 'status.job.onTheWay' | 'status.job.onSite' | 'status.job.done' | 'status.job.noOneHome' | 'status.job.canceled' {
  if (j.status === 'scheduled' && j.technician === null) return 'status.job.unassigned';
  return ({ scheduled: 'status.job.scheduled', on_the_way: 'status.job.onTheWay', on_site: 'status.job.onSite', done: 'status.job.done', no_one_home: 'status.job.noOneHome', canceled: 'status.job.canceled' } as const)[j.status];
}
export function chipClass(s: JobStatus): string {
  return ({ scheduled: 'sched', on_the_way: 'way', on_site: 'site', done: 'done', no_one_home: 'done', canceled: 'done' } as const)[s];
}

/**
 * F-565: a role-gated control shows only for a role whose API-07 permission keys hold its role-gated API entry's contract ID
 * (an action key is the contract ID; me.ts). The page passes the signed-in person's keys.
 */
export const can = (permissions: readonly string[] | null | undefined, contractId: `API-${number}`): boolean => (permissions ?? []).includes(contractId);

/** The contract each role-gated control of the page calls (CTL-OFC-03-04 to -08, -21, -23, -24). */
export const CONTROL_CONTRACT = {
  reassign: 'API-22', reschedule: 'API-24', cancel: 'API-25', finish: 'API-26', edit: 'API-27', note: 'API-140', equipment: 'API-142', text: 'API-143',
} as const satisfies Record<string, `API-${number}`>;

/** CTL-OFC-35-03: the shared segment counter the server also runs (D12, HC-06; @bw/sms). */
export interface TextCount {
  encoding: 'gsm7' | 'ucs2';
  units: number;
  limit: number;
  left: number;
  fits: boolean;
  /** The first character outside the standard text set, when the text is UCS-2. */
  outside: string | null;
}
export function textCount(body: string): TextCount {
  const a = analyzeSms(body);
  const limit = a.encoding === 'GSM-7' ? 160 : 70;
  const outside = a.encoding === 'GSM-7' ? null : ([...body].find((ch) => analyzeSms(ch).encoding !== 'GSM-7') ?? null);
  return { encoding: a.encoding === 'GSM-7' ? 'gsm7' : 'ucs2', units: a.units, limit, left: limit - a.units, fits: a.messages === 1, outside };
}

/** What a refusal shows in a dialog: a catalog key and its values (UI-SPECIFICATION 4.3). */
export interface Shown { key: string; values?: Record<string, string | number> }

export type Refusal = { ok: false; code: string; status: number; detail: Record<string, unknown> };

/**
 * A refusal's message in the dialog that made the call. rule_refused shows the rule its key names (F-506); time_overlap
 * names the block (FR-DISP-34); window_full the window that just filled (API-24, and API-27 across pools, F-507).
 */
/** CTL-OFC-20-03: the toast of a moved visit states the server's answer about the technician and any text (GAP-10). */
export function rescheduleDone(outcome: { technicianKept: boolean; textSent: boolean }, day: string, window: string): Shown {
  return { key: outcome.technicianKept ? 'job.reschedule.doneKept' : 'job.reschedule.doneUnassigned', values: { day, window, text: String(outcome.textSent) } };
}

/**
 * Edit job details (SCR-OFC-23, API-27): the dialog has no window to pick, so a window_full says the new service's window is
 * full and to pick another service, not "pick another" window (F-872). Every other refusal reads as in refusalShown.
 */
export function editRefusalShown(r: Refusal, spanText: (start: string, end: string) => string): Shown {
  return r.code === 'window_full' ? { key: 'job.refused.windowFullEdit' } : refusalShown(r, spanText);
}

export function refusalShown(r: Refusal, spanText: (start: string, end: string) => string, who?: { name: string; window: string }): Shown {
  switch (r.code) {
    // F-1805: the Reassign dialog (CTL-OFC-18-02) names the limit that refused the pick, the board's texts through the board's function.
    case 'technician_no_room': return (who && noRoomShown(r.detail, who.name, who.window)) || { key: 'job.refused.server' };
    case 'rule_refused': {
      const key = typeof r.detail['key'] === 'string' && /^rule\.[A-Za-z]+$/.test(r.detail['key']) ? r.detail['key'] : 'job.refused.rule';
      return { key };
    }
    case 'time_overlap': {
      const b = r.detail['block'] as { label?: string; start?: string; end?: string } | undefined;
      return b?.label && b.start && b.end ? { key: 'job.refused.overlap', values: { block: b.label, time: spanText(b.start, b.end) } } : { key: 'job.refused.overlapPlain' };
    }
    case 'window_full': return { key: 'job.refused.windowFull' };
    case 'version_conflict': return { key: 'job.refused.conflict' };
    case 'day_closed': return { key: 'job.refused.dayClosed' };
    case 'day_past': return { key: 'job.refused.dayPast' };
    case 'parts_required': return { key: 'job.finish.partsRequired' };
    case 'not_waiting_for_person': return { key: 'job.finish.notWaiting' };
    case 'message_too_long': return { key: 'job.text.twoMessages' };
    case 'texts_off': return { key: 'job.text.textsOff' };
    case 'no_mobile': return { key: 'job.text.noMobile' };
    case 'validation_failed': return { key: 'job.refused.invalid' };
    case 'not_found': return { key: 'job.refused.gone' };
    case 'offline': return { key: 'job.refused.offline' };
    default: return { key: 'job.refused.server' };
  }
}

/** CTL-OFC-03-17: an outbox_text.status's word (FR-TEXT-15), as the Messages page words it; API-23 carries no held-until time. */
const TEXT_STATUS_WORD: Record<string, MessageKey> = {
  queued: 'msg.status.sent', sending: 'msg.status.sent', held: 'msg.statusOpt.held', delivered: 'msg.status.delivered',
  retrying: 'msg.status.retrying', gave_up: 'msg.status.gave_up', canceled: 'msg.status.canceled',
};
export const textStatusKey = (status: string): MessageKey => TEXT_STATUS_WORD[status] ?? 'msg.status.sent';

/** CTL-OFC-03-17: an activity row's words: a technician's status change names the action (On my way, Arrived, Finished, No one home). */
export function feedKey(e: Pick<Job['timeline'][number], 'kind' | 'values'>): MessageKey {
  if (e.kind !== 'status') return `job.feed.kind.${e.kind}` as MessageKey;
  const to = e.values['to.status'];
  return to === 'on_the_way' || to === 'on_site' || to === 'done' || to === 'no_one_home' ? `job.feed.kind.status.${to}` : 'job.feed.kind.status';
}

export type FeedEntry = {
  key: string; at: string; kind: string; by: string | null; words: MessageKey | null;
  text: Job['texts'][number] | null; /** the office text's sender, from its own job_change row (F-704) */ textBy: string | null;
};

/**
 * CTL-OFC-03-17: the timeline entries and the texts in 1 list, in time order. Each text is 1 row (F-704): an office text writes a
 * job_change of kind office_text (its values carry textId) and an outbox_text row, so the change folds into the text row, which names who sent it.
 */
export function jobFeed(j: Pick<Job, 'timeline' | 'texts'>): FeedEntry[] {
  const byId = new Map(j.texts.map((x) => [x.id, x]));
  const sender = new Map<string, string | null>();
  for (const e of j.timeline) if (e.kind === 'office_text' && typeof e.values['textId'] === 'string' && byId.has(e.values['textId'])) sender.set(e.values['textId'], e.by);
  return [
    ...j.timeline.filter((e) => !(e.kind === 'office_text' && typeof e.values['textId'] === 'string' && byId.has(e.values['textId'])))
      .map((e, i) => ({ key: `${e.kind}-${i}`, at: e.at, kind: e.kind, by: e.by, words: feedKey(e), text: null, textBy: null })),
    ...j.texts.map((x) => ({ key: x.id, at: x.at, kind: 'text', by: null, words: null, text: x, textBy: sender.get(x.id) ?? null })),
  ].sort((a, b) => Date.parse(a.at.replace(/\[.*\]$/, '')) - Date.parse(b.at.replace(/\[.*\]$/, '')));
}

/** The seeded and imported equipment.type codes; a type someone typed in SCR-OFC-37 has no code and shows as typed. */
const EQUIPMENT_WORD: Record<string, MessageKey> = {
  furnace: 'customers.equipment.furnace', air_conditioner: 'customers.equipment.air_conditioner',
  water_heater: 'customers.equipment.water_heater', thermostat: 'customers.equipment.thermostat',
};
/** CTL-OFC-03-11, CTL-OFC-23-02, CTL-OFC-37-01: an equipment type's word in the page's language. */
export const equipmentWord = (t: (key: MessageKey) => string, type: string): string => {
  const key = EQUIPMENT_WORD[type];
  return key ? t(key) : type;
};

/**
 * CTL-OFC-37-01 (F-852): the Type field's suggestions are the 4 seeded codes, shown as their words in the page's language. A type that
 * is 1 of those words (or the code itself, in any case) is sent as its code, so a Spanish page reads it in Spanish like a seeded one;
 * any other typed type is sent as typed.
 */
const EQUIPMENT_CODES = Object.keys(EQUIPMENT_WORD);
export const equipmentSuggestions = (t: (key: MessageKey) => string): { code: string; word: string }[] => EQUIPMENT_CODES.map((code) => ({ code, word: equipmentWord(t, code) }));
export function equipmentTypeSent(t: (key: MessageKey) => string, typed: string): string {
  const x = typed.trim();
  const low = x.toLowerCase();
  const hit = equipmentSuggestions(t).find((s) => s.word.toLowerCase() === low || s.code === low);
  return hit ? hit.code : x;
}

/** CTL-OFC-03-14: the job's notes and the customer's together, newest first (FR-DISP-5). */
export function notesOf(j: Pick<Job, 'notes'> & { customer: Pick<Job['customer'], 'notes'> }): Job['notes'] {
  const at = (n: Job['notes'][number]) => Date.parse(n.at.replace(/\[.*\]$/, ''));
  return [...j.notes, ...j.customer.notes].sort((a, b) => at(b) - at(a));
}

/** The finish lines a form holds (SCR-OFC-22). */
export interface Lines {
  parts: { partId: string; name: string; code: string; quantity: number }[];
  noPartsUsed: boolean;
  hours: string;
  minutes: string;
}

/** Labor in whole minutes from the 2 fields; null when either is not a whole number or the total is 0 (CTL-OFC-22-06). */
export function laborMinutes(l: Pick<Lines, 'hours' | 'minutes'>): number | null {
  const h = l.hours.trim() === '' ? 0 : Number(l.hours);
  const m = l.minutes.trim() === '' ? 0 : Number(l.minutes);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59) return null;
  const total = h * 60 + m;
  return total > 0 ? total : null;
}

/** CTL-OFC-22-07 and -09: neither parts nor No parts used is refused in the dialog, without a call (FR-BILL-3). */
export const needsParts = (l: Lines): boolean => l.parts.length === 0 && !l.noPartsUsed;

/** CTL-OFC-22-09: correction mode saves only when at least 1 line differs from what billing receives. */
export function linesDiffer(a: Lines, b: Lines): boolean {
  if (a.noPartsUsed !== b.noPartsUsed || laborMinutes(a) !== laborMinutes(b)) return true;
  const key = (l: Lines) => l.parts.map((p) => `${p.partId}x${p.quantity}`).sort().join(',');
  return key(a) !== key(b);
}

/** The lines billing receives, read from API-23 (correction mode's prefill, OA-61). */
export function linesOf(job: Job): Lines {
  const f = job.finish;
  const m = f?.laborMinutes ?? 0;
  return {
    parts: (f?.parts ?? []).map((p) => ({ ...p })), noPartsUsed: f?.noPartsUsed ?? false,
    hours: String(Math.floor(m / 60)), minutes: String(m % 60).padStart(2, '0'),
  };
}

/** CTL-OFC-22-02: the seeded parts matching the typed name or code (no free text: a part not on the list cannot be entered). */
export function findParts<T extends { name: string; code: string }>(parts: readonly T[], text: string, max = 6): T[] {
  const q = text.trim().toLowerCase();
  if (q.length === 0) return [];
  return parts.filter((p) => p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)).slice(0, max);
}
