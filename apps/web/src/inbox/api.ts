// SPDX-License-Identifier: AGPL-3.0-or-later
// The calls of the customer's inbox and reschedule pages (P5-INBOX): each names its contract row from @bw/api and goes through the
// typed client (SPECIFICATIONS section 4.1: page code calls only @bw/api). Link tokens travel only in the path of their own row.
import { ApiError, createClient, inboxMessages, inboxReply, reschedulePage, rescheduleVisit, z, type ContractRow } from '@bw/api';
import type { MessageKey } from '@bw/i18n';
import { fromWire, type Language } from '@bw/time';
import { callRow } from '../accounts/api.ts';
import { windowZoned } from '../booking/model.ts';

export type PageAnswer<T> = { ok: true; data: T } | { ok: false; code: string; status: number; officePhone: string | null };
export const rows = { inboxMessages, inboxReply, reschedulePage, rescheduleVisit };
export { callRow };

/** A call that keeps the office phone an ended link's refusal carries (API-117, API-118: the Ended state says whom to call). */
export async function callPage<R extends ContractRow>(row: R, input: Record<string, unknown>): Promise<PageAnswer<z.output<R['response']>>> {
  try {
    const a = await createClient({ baseUrl: window.location.origin }).call(row, input);
    return { ok: true, data: a.data as z.output<R['response']> };
  } catch (e) {
    if (e instanceof ApiError) {
      const phone = (e.problem as { officePhone?: unknown }).officePhone;
      return { ok: false, code: e.problem.code, status: e.status, officePhone: typeof phone === 'string' ? phone : null };
    }
    return { ok: false, code: 'offline', status: 0, officePhone: null };
  }
}

export type InboxData = z.output<typeof inboxMessages.response>;
export type InboxMessage = InboxData['messages'][number];
export type RescheduleData = z.output<typeof reschedulePage.response>;
export type RescheduleDay = RescheduleData['days'][number];
export type MovedVisit = z.output<typeof rescheduleVisit.response>;

type T = (key: MessageKey, values?: Record<string, string | number>) => string;

const hour12 = (h: number) => ({ n: h % 12 === 0 ? 12 : h % 12, mer: h < 12 ? 'AM' : 'PM' });
/** "8-10 AM" or "10 AM-2 PM" (SD-17's window label), from the 2 wire times of a window. No zone: the technician Today frames (DK-107 to DK-109) draw none. */
export function windowWords(start: string, end: string): string {
  const s = hour12(fromWire(start).hour);
  const e = hour12(fromWire(end).hour);
  return s.mer === e.mer ? `${s.n}-${e.n} ${e.mer}` : `${s.n} ${s.mer}-${e.n} ${e.mer}`;
}

/** "10 AM-12 PM EDT": a window as the reschedule page names it, with the branch zone after it (UD-15, owner ruling 037420bb; F-1162). */
export const windowLabel = (start: string, end: string): string => windowZoned(start, end);

/** The ISO weekday (1 Monday to 7 Sunday) of a local date. */
export const weekdayOf = (date: string): number => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7 + 1;

/** "Tue, Oct 20": the weekday and the date of a local date, words from the catalog (UI-SPECIFICATION section 12 rule 7). */
export function dayLabel(date: string, t: T): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  return t('inbox.date', { weekday: t(`time.weekday.${weekdayOf(date)}` as MessageKey), month: t(`time.month.${m}` as MessageKey), day: d });
}

/** "Tue, Oct 20, 8-10 AM": a visit as the page prints it. */
export const visitText = (day: string, start: string, end: string, t: T): string => `${dayLabel(day, t)}, ${windowLabel(start, end)}`;

export type { Language };
