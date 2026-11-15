// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixed data of the booking previews (harness build only): the sample data DK-118 to DK-121 show (Harold Jenkins, a furnace tune-up on Tue, Sep 15,
// 10 AM-12 PM, 418 Maple Hollow Ct, Westerville 43081, today Thu, Sep 10), in the shapes the real reads answer (API-110, API-111, API-112,
// API-114), so the look comparator reads the same state on both sides. Never imported by a release route.
import type { BookingSummaryAnswer, OnlineAvailabilityAnswer, OnlineDay, OnlineWindow } from '@bw/api';
import { wireAt } from '../board/preview-fixtures.ts';
import { emptyDraft, type Draft, type Nearest, type ServiceItem, type Street } from './model.ts';

export const BOOKING_PREVIEW_STATES = [
  'steps', 'phone', 'loading', 'no-match', 'no-days', 'day-full', 'no-mobile', 'booking', 'restored', 'street-results', 'booking-closed', 'phone-day',
] as const;
export type BookingPreviewState = (typeof BOOKING_PREVIEW_STATES)[number];
export const TAKEN_PREVIEW_STATES = ['options', 'none-nearby', 'booking', 'filled-again'] as const;
export type TakenPreviewState = (typeof TAKEN_PREVIEW_STATES)[number];
export const DONE_PREVIEW_STATES = ['success', 'no-texts', 'held', 'loading', 'not-found'] as const;
export type DonePreviewState = (typeof DONE_PREVIEW_STATES)[number];

export const TODAY = '2026-09-10';
export const PICKED_DAY = '2026-09-15';

export const SERVICES: ServiceItem[] = ['furnace_tune_up', 'ac_tune_up', 'heating_or_ac_fix', 'plumbing_repair', 'water_heater', 'thermostat'].map((id) => ({
  serviceId: id, screenLabelKey: `service.${id}.screen`, priceTextKey: `service.${id}.price`, typicalLengthKey: `service.${id}.length`,
}));

export const STREET: Street = { streetId: '0192f000-0000-7000-8000-0000000000a1', name: 'Maple Hollow Ct', city: 'Westerville', zip: '43081', branch: 'columbus' };
export const STREETS: Street[] = [STREET, { streetId: '0192f000-0000-7000-8000-0000000000a2', name: 'Maple Hill Dr', city: 'Dayton', zip: '45414', branch: 'dayton' }];

const win = (id: string, from: number, to: number, date: string, state: 'open' | 'full', placesLeft: number | null): OnlineWindow => ({
  windowId: id, start: wireAt(from, date), end: wireAt(to, date), state, placesLeft,
});
/** The picked day's 5 windows as the frames draw them: 8-10 Full, 10-12, 12-2 with 2 left, 2-4 Full, 4-6 Open. */
export const PICKED_WINDOWS = (date: string): OnlineWindow[] => [
  win('w08', 8, 10, date, 'full', null), win('w10', 10, 12, date, 'open', null), win('w12', 12, 14, date, 'open', 2), win('w14', 14, 16, date, 'full', null), win('w16', 16, 18, date, 'open', null),
];
const OPEN_WINDOWS = (date: string): OnlineWindow[] => [8, 10, 12, 14, 16].map((h) => win(`w${String(h).padStart(2, '0')}`, h, h + 2, date, 'open', null));

const FEW = new Set(['2026-09-12', '2026-09-16', '2026-09-18']);
/** 11 Sep to 1 Oct: Sundays closed, the picked day as the frames draw it, a few windows left on 12, 16 and 18. */
export function previewDays(): OnlineDay[] {
  const out: OnlineDay[] = [];
  for (let n = 1; n <= 21; n++) {
    const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000);
    const date = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0) { out.push({ date, mode: 'sunday', state: 'closed', reason: 'sunday', fewLeft: false, windows: [] }); continue; }
    const few = FEW.has(date);
    out.push({ date, mode: dow === 6 ? 'saturday' : 'two_hour', state: 'open', reason: null, fewLeft: few, windows: date === PICKED_DAY ? PICKED_WINDOWS(date) : OPEN_WINDOWS(date) });
  }
  return out;
}
export const AVAILABILITY = (days: OnlineDay[] = previewDays()): OnlineAvailabilityAnswer => ({ branch: 'columbus', zone: 'America/New_York', today: TODAY, days });
/** Nothing is bookable within the horizon. */
export const NO_DAYS: OnlineDay[] = previewDays().map((d) => ({ ...d, state: 'closed', reason: d.reason ?? 'booking_closed', fewLeft: false, windows: [] }));
/** Every window of the picked day is Full. */
export const DAY_FULL: OnlineDay[] = previewDays().map((d) => (d.date === PICKED_DAY ? { ...d, state: 'full', reason: 'full', windows: PICKED_WINDOWS(d.date).map((w) => ({ ...w, state: 'full', placesLeft: null })) } : d));

export const HAROLD: Draft = {
  ...emptyDraft('en'), serviceId: 'furnace_tune_up', streetText: 'Maple Hollow Ct, Westerville 43081', street: STREET, house: '418', date: PICKED_DAY, windowId: 'w10',
  name: 'Harold Jenkins', mobile: '(614) 555-0148', textsOn: true,
};

/** The window that filled on SCR-CUS-02 and its nearest open windows (DK-120). */
export const FILLED = { date: PICKED_DAY, windowId: 'w10', start: wireAt(10, PICKED_DAY), end: wireAt(12, PICKED_DAY) };
export const NEAREST: Nearest[] = [
  { ...win('w12', 12, 14, PICKED_DAY, 'open', 1), date: PICKED_DAY },
  { ...win('w16', 16, 18, PICKED_DAY, 'open', null), date: PICKED_DAY },
  { ...win('w10', 10, 12, '2026-09-16', 'open', null), date: '2026-09-16' },
];
/** The Window just taken page's left side: its window list as the frame draws it (10-12 Full now, 12-2 with 1 left). */
export const TAKEN_DAYS = (): OnlineDay[] => previewDays().map((d) => (d.date === PICKED_DAY ? { ...d, windows: [
  win('w08', 8, 10, d.date, 'full', null), win('w10', 10, 12, d.date, 'full', null), win('w12', 12, 14, d.date, 'open', 1), win('w14', 14, 16, d.date, 'full', null), win('w16', 16, 18, d.date, 'open', null),
] } : d));

/** What API-114 answers for Harold's booking (CTL-CUS-03-01): the frame's confirmation text, sent at 7:42 PM on Thu, Sep 10. */
export const SUMMARY: BookingSummaryAnswer = {
  visit: {
    jobNumber: 24830, serviceId: 'furnace_tune_up', serviceLabelKey: 'service.furnace_tune_up.screen', priceTextKey: 'service.furnace_tune_up.price', date: PICKED_DAY,
    window: { start: wireAt(10, PICKED_DAY), end: wireAt(12, PICKED_DAY) }, zone: 'America/New_York', branch: 'columbus', bookedAt: wireAt(19.7, '2026-09-10'), name: 'Harold Jenkins',
    address: { houseNumber: 418, street: 'Maple Hollow Ct', city: 'Westerville', zip: '43081' },
  },
  textsOn: true, textLanguage: 'en',
  confirmationText: {
    status: 'delivered', heldUntil: null, sentAt: wireAt(19.7, '2026-09-10'), to: '+16145550148',
    body: "Brightwater: You're booked! Tue, Sep 15, technician arrives 10 AM-12 PM EDT for a furnace tune-up. Reply C to confirm or R to reschedule.",
  },
  inboxUrl: '/inbox/preview',
};
export const SUMMARY_NO_TEXTS: BookingSummaryAnswer = {
  ...SUMMARY, visit: { ...SUMMARY.visit, name: 'Ruth Ann Dobbs' }, textsOn: false, confirmationText: null, inboxUrl: null,
};
export const SUMMARY_HELD: BookingSummaryAnswer = {
  ...SUMMARY, confirmationText: { ...(SUMMARY.confirmationText as NonNullable<BookingSummaryAnswer['confirmationText']>), status: 'held', sentAt: null, heldUntil: wireAt(8, '2026-09-11') },
};
