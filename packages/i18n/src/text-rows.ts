// SPDX-License-Identifier: AGPL-3.0-or-later
// The words of the Messages page's text log rows (SCR-OFC-08: CTL-OFC-08-11 row, CTL-OFC-08-12 panel), shared by the page and its
// export, API-146, so the export says each row in the page's own words (FR-TEXT-24: the export's rows equal the on-screen log).
// Pure: the caller passes its formatter (the page's useT, the server's formatterFor) and its time helpers.
import type { MessageKey } from './catalog.ts';
import type { RowT } from './billing-rows.ts';

export type TextStatusName = 'queued' | 'held' | 'sending' | 'delivered' | 'retrying' | 'gave_up' | 'canceled';
export type ReplyHandlingName = 'confirmed' | 'reschedule_sent' | 'not_understood';
export type ChipTone = 'site' | 'sent' | 'held' | 'late' | 'neutral' | 'replyc' | 'replyr';

/** The time helpers the words need: a wire time as "10:31 AM", and as "11:00 AM EDT" in the branch's zone. */
export interface TimeWords {
  clock(wire: string): string;
  /** The wire time in the branch zone with its abbreviation ("11:00 AM EDT"). */
  branchClock(wire: string): string;
  /** The hour of a release time as the chip says it ("8 AM", or "8:30 AM" off the hour). */
  hourWord(wire: string): string;
  /** The customer's zone as a word ("Pacific"). */
  zoneWord(zone: string): string;
}

export interface StatusFacts {
  status: TextStatusName;
  heldUntil: string | null;
  tries: number;
  nextTryAt: string | null;
  /** The zone of the customer the text is for (a wire time's zone is in heldUntil itself). */
  customerZone: string;
  /** Whether the customer's zone differs from the branch zone (the note names the customer's zone only then). */
  otherZone: boolean;
}

// A wire time (RFC 9557, "2026-09-15T10:31:00-04:00[America/New_York]") already carries its own zone's local time: its hour and minute
// are read from the text, so no time library is needed for the clock words (both languages say "AM" and "PM", UD-16).
const hourOf = (wire: string): number => Number(wire.slice(11, 13));
const minuteOf = (wire: string): number => Number(wire.slice(14, 16));
const h12 = (h: number): number => (h % 12 === 0 ? 12 : h % 12);
const meridiem = (h: number): 'AM' | 'PM' => (h < 12 ? 'AM' : 'PM');

/** "10:31 AM" */
export const clockOfWire = (wire: string): string => `${h12(hourOf(wire))}:${String(minuteOf(wire)).padStart(2, '0')} ${meridiem(hourOf(wire))}`;
/** "8 AM", or "8:30 AM" off the hour. */
export const hourWordOfWire = (wire: string): string =>
  minuteOf(wire) === 0 ? `${h12(hourOf(wire))} ${meridiem(hourOf(wire))}` : clockOfWire(wire);
/** "8-10 AM", "10 AM-12 PM" (the arrival window as the texts print it). */
export function windowLabelOfWire(win: { start: string; end: string }): string {
  const s = hourOf(win.start);
  const e = hourOf(win.end);
  return meridiem(s) === meridiem(e) ? `${h12(s)}-${h12(e)} ${meridiem(e)}` : `${h12(s)} ${meridiem(s)}-${h12(e)} ${meridiem(e)}`;
}

export const TYPE_NAMES = ['confirmation', 'reminder', 'on_the_way', 'late', 'r_reply', 'office', 'replies'] as const;

export const typeText = (kind: (typeof TYPE_NAMES)[number], t: RowT): string => t(`msg.type.${kind}` as MessageKey);
export const languageText = (lang: 'en' | 'es', t: RowT): string => t(`msg.lang.${lang}` as MessageKey);

/** A status chip: its tone and word ("Held until 8 AM", "Failed - retrying", "Delivered"). */
export function statusChip(f: StatusFacts, t: RowT, w: TimeWords): { tone: ChipTone; label: string } {
  switch (f.status) {
    case 'delivered': return { tone: 'site', label: t('msg.status.delivered') };
    case 'queued': case 'sending': return { tone: 'sent', label: t('msg.status.sent') };
    case 'held': return { tone: 'held', label: t('msg.status.held', { time: f.heldUntil ? w.hourWord(f.heldUntil) : '' }) };
    case 'retrying': return { tone: 'late', label: t('msg.status.retrying') };
    case 'gave_up': return { tone: 'late', label: t('msg.status.gave_up') };
    case 'canceled': return { tone: 'neutral', label: t('msg.status.canceled') };
  }
}

/** The small line under a chip ("attempt 2 of 5, next try 10:31 AM"); '' when the chip says it all. */
export function statusNote(f: StatusFacts, t: RowT, w: TimeWords): string {
  switch (f.status) {
    case 'delivered': return f.heldUntil ? t('msg.status.delivered.heldNote', { time: w.clock(f.heldUntil) }) : '';
    case 'queued': case 'sending': return t('msg.status.sent.note');
    case 'held':
      if (!f.heldUntil) return '';
      return f.otherZone
        ? t('msg.status.held.note', { zone: w.zoneWord(f.customerZone), time: w.branchClock(f.heldUntil) })
        : t('msg.status.held.noteSame');
    case 'retrying':
      return f.nextTryAt ? t('msg.status.retrying.note', { n: f.tries, time: w.clock(f.nextTryAt) }) : '';
    case 'gave_up': return t('msg.status.gave_up.note');
    case 'canceled': return t('msg.status.canceled.note');
  }
}

/** A reply's handling word, the chip of a reply row ("Reply C - confirmed"). */
export function handlingChip(h: ReplyHandlingName, t: RowT): { tone: ChipTone; label: string } {
  return { tone: h === 'confirmed' ? 'replyc' : h === 'reschedule_sent' ? 'replyr' : 'neutral', label: t(`msg.handling.${h}` as MessageKey) };
}

/** The small line under a reply's chip ("reschedule link sent 9:14 AM"); '' for the others. */
export function handlingNote(h: ReplyHandlingName, at: string, t: RowT): string {
  return h === 'reschedule_sent' ? t('msg.handling.reschedule_sent.note', { time: clockOfWire(at) }) : '';
}

/** The status of a row for the Status filter and the export: the chip's word, then the note after a dash. */
export function statusLine(f: StatusFacts, t: RowT, w: TimeWords): string {
  const chip = statusChip(f, t, w).label;
  const note = statusNote(f, t, w);
  return note === '' ? chip : `${chip} - ${note}`;
}

/** Why a text is in its state (outbox_text.reason_key: text_reason.*) in the catalog's words. */
export function reasonText(reasonKey: string | null, t: RowT): string {
  return reasonKey === null ? '' : t(reasonKey as MessageKey);
}

/** The context line under a customer (CTL-OFC-08-24): "Westerville - Maria Santos", "Gahanna - unassigned", "New Albany - booked at 11:48 PM". */
export function contextLine(
  c: { area: string; technician: string | null; bookedAt: string | null; window: { start: string; end: string } | null; visitDay: string | null },
  mode: 'text' | 'reply' | 'held_confirmation',
  t: RowT,
  w: { clock(wire: string): string; windowLabel(win: { start: string; end: string }): string; dayWord(day: string): string },
): string {
  if (mode === 'held_confirmation' && c.bookedAt) return `${c.area} - ${t('msg.ctx.booked', { time: w.clock(c.bookedAt) })}`;
  if (mode === 'reply' && c.window && c.visitDay) return `${c.area} - ${w.dayWord(c.visitDay)} ${w.windowLabel(c.window)}`;
  return `${c.area} - ${c.technician ?? t('msg.ctx.unassigned')}`;
}
