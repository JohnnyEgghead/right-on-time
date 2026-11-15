// SPDX-License-Identifier: AGPL-3.0-or-later
// The Messages screens' data as their frames show it (mockups/pages/office-messages.html and office-call-list.html), in the shape of
// API-40, API-41 and API-42 answers, for the harness build's preview routes (never read by a release route).
import type { CallData, DetailData, LogData, ReminderCall, ReplyRowData, TextRowData } from './model.ts';

const Z = '[America/New_York]';
const at = (hhmm: string, day = '2026-09-15'): string => `${day}T${hhmm}:00-04:00${Z}`;
const win = (a: string, b: string, day = '2026-09-15') => ({ start: at(a, day), end: at(b, day) });

const ctx = (area: string, technician: string | null, extra: Partial<TextRowData['context']> = {}): TextRowData['context'] => ({
  area, technician, visitDay: null, window: null, bookedAt: null, ...extra,
});

// A customer's text is data in the customer's language: the cells that draw it carry lang, and the Spanish walker skips text inside an element whose lang is another language (F-658).
const BODY = {
  deborah: "Brightwater: You're booked! Thu, Sep 17, technician arrives 12-2 PM for an AC tune-up. Reply C to confirm or R to reschedule.",
  harold: 'Brightwater: Maria is on the way! Arriving about 10:40 AM. Follow the van: bw.j7l.io/m/7Hk2Ab9Q (this link stops working when Maria arrives).',
  linh: "Brightwater: You're booked! Tue, Sep 15, technician arrives 12-2 PM for an AC repair. Reply C to confirm or R to reschedule.",
  gary: 'Brightwater: Dave is on the way! Arriving about 10:45 AM. Follow the van: bw.j7l.io/m/Q4twLm3X (this link stops working when Dave arrives).',
  elena: 'Brightwater: Greg va con retraso. Nueva hora de llegada: aproximadamente 12:25 PM. ¡Disculpe la espera!',
  rosa: 'Brightwater: ¡Kevin va en camino! Llega aproximadamente a las 10:15 AM. Siga la camioneta: bw.j7l.io/m/3Qp8Rt6V (este enlace deja de funcionar cuando Kevin llegue).',
  marisol: 'Brightwater: ¡Su visita está reservada! Jue, 17 de sep., el técnico llega de 8 a 10 AM para una revisión del aire acondicionado. Responda C para confirmar o R para cambiar la fecha.',
  walter: "Brightwater: You're booked! Tue, Sep 15, technician arrives 4-6 PM for a heat pump check. Reply C to confirm or R to reschedule.",
} as const;

const text = (id: string, hhmm: string, customer: string, type: TextRowData['type'], language: 'en' | 'es', body: string, status: TextRowData['status'], context: TextRowData['context'], extra: Partial<TextRowData> = {}): TextRowData => ({
  id: `00000000-0000-4000-8000-0000000000${id}`, at: at(hhmm), customerId: `00000000-0000-4000-9000-0000000000${id}`, customer, type, language, body, status,
  reasonKey: null, heldUntil: null, tries: 0, nextTryAt: null, jobNumber: null, context, ...extra,
});

const reply = (id: string, hhmm: string, customer: string, body: string, handling: ReplyRowData['handling'], context: ReplyRowData['context']): ReplyRowData => ({
  id: `00000000-0000-4000-a000-0000000000${id}`, at: at(hhmm), customerId: `00000000-0000-4000-9000-0000000000${id}`, customer, language: 'en', body, handling, jobNumber: 24800 + Number(id), context,
});

export const LINH_ID = '00000000-0000-4000-8000-000000000003';

export const LOG_SUCCESS: LogData = {
  asOf: at('10:28'),
  texts: [
    text('01', '10:29', 'Deborah Lin', 'confirmation', 'en', BODY.deborah, 'held', ctx('Grandview', null, { bookedAt: at('10:29') }), {
      heldUntil: '2026-09-15T08:00:00-07:00[America/Los_Angeles]', reasonKey: 'text_reason.quiet_hours',
    }),
    text('02', '10:28', 'Harold Jenkins', 'on_the_way', 'en', BODY.harold, 'delivered', ctx('Westerville', 'Maria Santos')),
    text('03', '10:27', 'Linh Pham', 'confirmation', 'en', BODY.linh, 'retrying', ctx('Gahanna', null), {
      tries: 2, nextTryAt: at('10:31'), reasonKey: 'text_reason.send_failed', jobNumber: 24840,
    }),
    text('04', '10:24', 'Gary Graves', 'on_the_way', 'en', BODY.gary, 'queued', ctx('Powell', 'Dave Kowalski')),
    text('05', '10:12', 'Elena Reyes', 'late', 'es', BODY.elena, 'delivered', ctx('Dublin', 'Greg Hoffman')),
    text('06', '09:56', 'Rosa Castillo', 'on_the_way', 'es', BODY.rosa, 'delivered', ctx('Reynoldsburg', 'Kevin Doyle')),
    text('09', '08:47', 'Marisol Herrera', 'confirmation', 'es', BODY.marisol, 'delivered', ctx('Whitehall', 'Luis Ortega')),
    text('10', '08:00', 'Walter Brennan', 'confirmation', 'en', BODY.walter, 'delivered', ctx('New Albany', null, { bookedAt: '2026-09-14T23:48:00-04:00[America/New_York]' }), {
      heldUntil: at('08:00'),
    }),
  ],
  replies: [
    reply('07', '09:52', 'Carol Miller', 'C', 'confirmed', ctx('Westerville', null, { visitDay: '2026-09-15', window: win('12:00', '14:00') })),
    reply('08', '09:14', 'Paul Ferris', 'R', 'reschedule_sent', ctx('Whitehall', null, { visitDay: '2026-09-15', window: win('14:00', '16:00') })),
    reply('11', '07:41', 'Joan Hensley', 'C', 'confirmed', ctx('Lewis Center', null, { visitDay: '2026-09-15', window: win('12:00', '14:00') })),
  ],
  counts: {
    texts: 96, delivered: 93, held: 1, failedRetrying: 1, notSent: 0, replies: 34, confirmations: 31, confirmationsOnTime: 31, repliesConfirmed: 29, repliesReschedule: 5, gaveUp: 0,
  },
  nextReminders: { visitDay: '2026-09-16', visits: 56, reminderTexts: 47, at: at('18:00'), callListCount: 9 },
  simulatorMode: 'up',
  total: 130,
  cursors: { newer: null, older: 'o:1789471200000:00000000-0000-4000-8000-000000000011' },
};

/** The Empty day and Empty filter states: no rows. */
export const LOG_EMPTY: LogData = { ...LOG_SUCCESS, texts: [], replies: [], total: 0, cursors: { newer: null, older: null } };

/** The Live row state: the simulator fails every send, and 3 rows (the frame's own). */
export const LOG_LIVE: LogData = {
  ...LOG_SUCCESS,
  simulatorMode: 'all_fail',
  texts: [
    text('12', '10:31', 'Ruth Whitman', 'on_the_way', 'en', 'Brightwater: Tom is on the way! Arriving about 10:50 AM.', 'retrying', ctx('Bexley', 'Tom Reinhart'), { tries: 1, nextTryAt: at('10:32') }),
    LOG_SUCCESS.texts[0]!,
    text('02', '10:28', 'Harold Jenkins', 'on_the_way', 'en', BODY.harold, 'delivered', ctx('Westerville', 'Maria Santos')),
  ],
  replies: [],
  total: 3,
  cursors: { newer: null, older: null },
};

/** Linh Pham's text as API-41 answers it (the frame's panel). */
export const DETAIL_LINH: DetailData = {
  id: LINH_ID, type: 'confirmation', customerId: '00000000-0000-4000-9000-000000000003', customer: 'Linh Pham', language: 'en', encoding: 'gsm7', body: BODY.linh,
  status: 'retrying', reasonKey: 'text_reason.send_failed', heldUntil: null,
  attempts: [
    { number: 1, at: at('10:27'), result: 'failed', reasonKey: 'text_attempt.simulator_all_fail' },
    { number: 2, at: at('10:29'), result: 'failed', reasonKey: 'text_attempt.simulator_all_fail' },
  ],
  sentBy: null, canTryNow: true, nextTryAt: at('10:31'), plannedTries: [{ number: 4, at: at('10:36') }, { number: 5, at: at('10:46') }], onCallList: null,
  job: {
    jobNumber: 24840, service: 'heating_or_ac_fix', area: 'Gahanna', day: '2026-09-15', window: win('12:00', '14:00'), technician: null,
    bookedVia: 'office', bookedAt: at('10:26'), bookedBy: 'Keisha Thompson',
  },
  customerContact: { phone: '(614) 555-0187', mobileEnd: '0187', zone: 'America/New_York' },
};

// --- the call list --------------------------------------------------------------------------------------------------------------------

type Person = Omit<ReminderCall, 'reason'>;
const who = (id: string, customer: string, area: string, phone: string, language: 'en' | 'es', job: number, a: string, b: string, service: string, technician: string | null, tIn: string | null, outcome: Person['outcome'], day = '2026-09-16'): Person => ({
  entryId: `00000000-0000-4000-b000-0000000000${id}`, customerId: `00000000-0000-4000-9000-0000000000${id}`, customer, area, phone, language,
  visit: { jobNumber: job, day, window: win(a, b, day), service, technician, technicianInTexts: tIn, jobStatus: 'scheduled' },
  outcome,
});
const done = (kind: 'confirmed' | 'no_answer' | 'reschedule', by: string, hhmm: string) => ({ kind, by, at: at(hhmm) });

export const CALLS_SUCCESS: CallData = {
  asOf: at('10:28'),
  reminderCalls: [
    { ...who('01', 'Edna Fairbanks', 'Clintonville', '(614) 555-0112', 'en', 24901, '08:00', '10:00', 'furnace_tune_up', 'Tom Reinhart', 'Tom', done('confirmed', 'Keisha Thompson', '09:12')), reason: 'no_mobile' },
    { ...who('02', 'Walter Pruett', 'Bexley', '(614) 555-0125', 'en', 24902, '08:00', '10:00', 'boiler_repair', 'Tom Reinhart', 'Tom', done('no_answer', 'Keisha Thompson', '09:15')), reason: 'no_mobile' },
    { ...who('03', 'Josefina Morales', 'Whitehall', '(614) 555-0131', 'es', 24903, '10:00', '12:00', 'heating_or_ac_fix', 'Ryan Mitchell', 'Ryan', done('confirmed', 'Ana Gutierrez', '09:40')), reason: 'texts_off' },
    { ...who('04', 'Howard Bishop', 'Upper Arlington', '(614) 555-0139', 'en', 24904, '10:00', '12:00', 'water_heater', 'Kevin Doyle', 'Kevin', done('reschedule', 'Keisha Thompson', '09:50'), '2026-09-18'), reason: 'no_mobile' },
    { ...who('05', 'Margaret Ellison', 'Worthington', '(614) 555-0144', 'en', 24905, '12:00', '14:00', 'furnace_tune_up', 'Maria Santos', 'Maria', null), reason: 'no_mobile' },
    { ...who('06', 'Ruth Ann Dobbs', 'Grove City', '(614) 555-0152', 'en', 24906, '12:00', '14:00', 'plumbing_repair', 'Jamal Carter', 'Jamal', null), reason: 'no_mobile' },
    { ...who('07', 'Ernesto Salinas', 'Hilliard', '(614) 555-0157', 'es', 24907, '14:00', '16:00', 'thermostat', 'Luis Ortega', 'Luis', null), reason: 'no_mobile' },
    { ...who('08', 'Frank Lindqvist', 'Westerville', '(614) 555-0166', 'en', 24908, '14:00', '16:00', 'heating_or_ac_fix', 'Brian Schaefer', 'Brian', null), reason: 'no_mobile' },
    { ...who('09', 'Dorothy Haines', 'Gahanna', '(614) 555-0171', 'en', 24909, '16:00', '18:00', 'ac_tune_up', 'Ryan Mitchell', 'Ryan', null), reason: 'no_mobile' },
  ],
  failedTexts: [
    {
      ...who('10', 'Gail Porter', 'Clintonville', '(614) 555-0191', 'en', 24910, '10:00', '12:00', 'furnace_tune_up', 'Maria Santos', 'Maria', null, '2026-09-17'),
      reason: 'text_gave_up', textId: '00000000-0000-4000-8000-000000000010', textType: 'reminder', failedAt: '2026-09-14T18:46:00-04:00[America/New_York]', addedBy: null, addedAt: null,
    },
  ],
  progress: { total: 9, called: 4, confirmed: 2, reschedule: 1, noAnswer: 1 },
  count: 5,
  dayTotals: { visitDay: '2026-09-16', visits: 56, reminderTexts: 47, at: at('18:00'), callListCount: 9 },
};

export const CALLS_EMPTY: CallData = {
  ...CALLS_SUCCESS, reminderCalls: [], failedTexts: [], progress: { total: 0, called: 0, confirmed: 0, reschedule: 0, noAnswer: 0 }, count: 0,
  dayTotals: { ...CALLS_SUCCESS.dayTotals, visits: 0, reminderTexts: 0, callListCount: 0 },
};
