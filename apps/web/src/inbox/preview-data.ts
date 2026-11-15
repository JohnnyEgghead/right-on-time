// SPDX-License-Identifier: AGPL-3.0-or-later
// The frames' own data for SCR-INB-01 and SCR-CUS-06 in each state they show (DK-125 to DK-128), in the shape the real rows answer
// (API-120, API-117, API-118), for the harness build's preview routes (apps/web/app/shell-preview/inbox, reschedule). Never read by a
// release route. A value the real row never answers does not appear here: a link token has 8 characters, a day is a date, a wire time
// names its zone.
import type { InboxData, InboxMessage, MovedVisit, RescheduleData } from './api.ts';
import type { PreviewAnswer } from './Preview.tsx';

const Z = '[America/New_York]';
const at = (date: string, time: string) => `${date}T${time}:00-04:00${Z}`;
const CUSTOMER = { name: 'Harold Jenkins', firstName: 'Harold', officePhone: '(614) 555-0100', hasMobile: true, textsOn: true, language: 'en' as const, today: '2026-09-15' };
const msg = (id: number, direction: 'in' | 'out', sentAt: string, body: string, extra: Partial<InboxMessage> = {}): InboxMessage => ({
  id: `00000000-0000-7000-8000-${String(id).padStart(12, '0')}`, direction, body, sentAt, handling: null, links: [], liveMapPreview: null, ...extra,
});

const BOOKED = msg(1, 'out', at('2026-09-10', '19:42'), "Brightwater: You're booked! Tue, Sep 15, technician arrives 10 AM-12 PM EDT for a furnace tune-up. Reply C to confirm or R to reschedule.");
const REMINDER = msg(2, 'out', at('2026-09-14', '18:00'), 'Brightwater reminder: your technician arrives tomorrow between 10 AM and 12 PM. Reply C to confirm or R to reschedule.');
const REPLY_C = msg(3, 'in', at('2026-09-14', '18:01'), 'C', { handling: 'confirmed' });
const MAP = 'bw.j7l.io/m/7Hk2Ab9Q';
const ON_THE_WAY = msg(4, 'out', at('2026-09-15', '10:28'), `Brightwater: Maria is on the way! Arriving about 10:40 AM. Follow the van: ${MAP} (this link stops working when Maria arrives).`, {
  links: [{ kind: 'live_map', path: '/m/7Hk2Ab9Q', text: MAP }], liveMapPreview: '/m/7Hk2Ab9Q/preview',
});
const LATE = msg(5, 'out', at('2026-09-15', '10:52'), 'Brightwater: Maria is running late. New arrival time: about 11:25 AM. Sorry for the wait!');
const R_REMINDER = msg(6, 'out', at('2026-10-19', '18:00'), 'Brightwater reminder: your technician arrives tomorrow between 8 AM and 10 AM. Reply C to confirm or R to reschedule.');
const REPLY_R = msg(7, 'in', at('2026-10-19', '18:01'), 'R', { handling: 'reschedule_sent' });
const RESCHED = 'bw.j7l.io/r/9Tm4Xy2Z';
const R_REPLY = msg(8, 'out', at('2026-10-19', '18:01'), `Brightwater: No problem. Pick a new time for your Tue, Oct 20 visit: ${RESCHED} or call (614) 555-0100. Your visit stays booked until you change it.`, {
  links: [{ kind: 'reschedule', path: '/r/9Tm4Xy2Z', text: RESCHED }],
});

const data = (messages: InboxMessage[], customer: Partial<InboxData['customer']> = {}): InboxData => ({ customer: { ...CUSTOMER, ...customer }, messages });

export const INBOX_STATES = ['success', 'loading', 'empty', 'nomobile', 'textsoff', 'sending', 'notvalid', 'error', 'ended', 'notsent', 'newtext', 'spanish', 'late'] as const;
export type InboxPreviewName = (typeof INBOX_STATES)[number];

export const INBOX_DATA: Record<InboxPreviewName, InboxData | null> = {
  success: data([BOOKED, REMINDER, REPLY_C, ON_THE_WAY]),
  loading: null,
  empty: data([]),
  nomobile: data([], { name: 'Ruth Ann Dobbs', firstName: 'Ruth Ann', hasMobile: false }),
  textsoff: data([BOOKED], { textsOn: false }),
  sending: data([BOOKED]),
  notvalid: null,
  error: null,
  ended: data([ON_THE_WAY]),
  notsent: data([BOOKED]),
  newtext: data([BOOKED, ON_THE_WAY]),
  spanish: data([], { name: 'Rosa Delgado', firstName: 'Rosa', language: 'es' }),
  late: data([ON_THE_WAY, LATE, R_REMINDER, REPLY_R, R_REPLY]),
};

/** A map picture for the preview card: a plain road grid (the real picture is drawn by the server from the app's own map file, API-164). */
const PICTURE = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 70"><rect width="300" height="70" fill="#dfe8ec"/><path d="M0 40H300M120 0V70" stroke="#fff" stroke-width="6" fill="none"/></svg>')}`;
export const LIVE_PREVIEW: PreviewAnswer = { status: 'live', image: PICTURE, altKey: 'inbox.previewAlt', captionKey: 'inbox.previewCaption', technician: 'Maria' };
export const ENDED_PREVIEW: PreviewAnswer = { status: 'ended' };

export const RESCHEDULE_STATES = ['choosing', 'loading', 'noother', 'saving', 'changed', 'kept', 'ended', 'notvalid', 'filled'] as const;
export type ReschedulePreviewName = (typeof RESCHEDULE_STATES)[number];

const win = (date: string, id: string, start: string, end: string, state: 'open' | 'full' = 'open', placesLeft: number | null = null) => ({
  windowId: id, start: at(date, start), end: at(date, end), state, placesLeft,
});
const twoHour = (date: string) => ({
  date, mode: 'two_hour' as const, state: 'open' as const,
  windows: [win(date, 'w8', '08:00', '10:00'), win(date, 'w10', '10:00', '12:00'), win(date, 'w12', '12:00', '14:00'), win(date, 'w14', '14:00', '16:00')],
});
const BUSY_DATE = '2026-10-21';
export const RESCHEDULE_DATA: RescheduleData = {
  visit: { serviceLabelKey: 'service.thermostat.screen', day: '2026-10-20', window: { start: at('2026-10-20', '08:00'), end: at('2026-10-20', '10:00') } },
  officePhone: '(614) 555-0100',
  days: [
    twoHour('2026-10-20'),
    { date: BUSY_DATE, mode: 'four_hour', state: 'open', windows: [
      win(BUSY_DATE, 'b8', '08:00', '12:00', 'full'), win(BUSY_DATE, 'b10', '10:00', '14:00'), win(BUSY_DATE, 'b12', '12:00', '16:00', 'open', 2), win(BUSY_DATE, 'b14', '14:00', '18:00'),
    ] },
    twoHour('2026-10-22'), twoHour('2026-10-23'), twoHour('2026-10-24'),
  ],
};
export const NO_OTHER_DATA: RescheduleData = { ...RESCHEDULE_DATA, days: RESCHEDULE_DATA.days.map((d) => ({ ...d, state: 'full' as const, windows: d.windows.map((w) => ({ ...w, state: 'full' as const })) })) };
export const MOVED: MovedVisit = {
  visit: { serviceLabelKey: 'service.thermostat.screen', day: BUSY_DATE, window: { start: at(BUSY_DATE, '10:00'), end: at(BUSY_DATE, '14:00') } },
  outcome: { textSent: true },
};
