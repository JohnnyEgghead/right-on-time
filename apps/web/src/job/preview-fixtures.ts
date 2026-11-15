// SPDX-License-Identifier: AGPL-3.0-or-later
// The harness build's job page data (P4-JOB): Harold Jenkins's Sep 15 furnace tune-up as DK-87 draws it
// (mockups/pages/office-job.html: job 24830, Maria Santos on the way, arriving about 10:40 AM), as API-23 and API-135
// answers: the stored codes the API answers, never the page's words (F-698), so a code the page prints raw shows in the look and
// walker runs. Never served by a release build (only *.preview.tsx import it, through JobPreview.tsx).
import type { AvailabilityAnswer, OnTheWayAnswer, PartsAnswer, ServicesAnswer } from '@bw/api';
import { wireAt } from '../board/preview-fixtures.ts';
import type { Answer, JobApi } from './api.ts';
import type { Job } from './model.ts';

export const JOB_PREVIEW_STATES = [
  'success', 'loading', 'error', 'panel-ended', 'partial', 'changed', 'canceled', 'done', 'no-one-home', 'bare',
  'reschedule-loading', 'reschedule-choosing', 'reschedule-no-room', 'reschedule-saving', 'reschedule-done',
  'cancel-asking', 'cancel-canceling', 'cancel-done',
  'finish-empty', 'finish-no-match', 'finish-invalid', 'finish-saving', 'finish-done',
  'edit-editing', 'edit-saving', 'edit-done',
  'text-empty', 'text-typing', 'text-too-long', 'text-sending', 'text-sent', 'text-held', 'text-refused',
  'note-empty', 'note-typing', 'note-saving', 'note-saved',
  'equipment-editing', 'equipment-saving', 'equipment-saved',
] as const;
export type JobPreviewState = (typeof JOB_PREVIEW_STATES)[number];

/**
 * F-787: the SCR-OFC-20 Done tile's own line. The look case reads the toast at the tile's width; the catalog's words (job.reschedule.doneKept) also
 * name the technician's answer, so they run wider than the tile and take 2 lines there, where the real page gives them 1 line at their own width.
 */
export const RESCHEDULE_DONE_LINE = 'Rescheduled to Thu, Sep 17, 10 AM-12 PM.';

const D = (date: string, hour: number) => wireAt(hour, date);
const HAROLD_ID = '00000000-0000-7000-8000-000000024830';

/** DK-87's Success screen: On the way, confirmed, with the frame's customer, equipment, history, notes and feed. */
export const HAROLD: Job = {
  job: {
    jobNumber: 24830, version: 4, status: 'on_the_way', branch: 'columbus', zone: 'America/New_York',
    date: '2026-09-15', windowId: 'w10', window: { start: wireAt(10), end: wireAt(12) },
    serviceId: 'furnace_tune_up', serviceLabelKey: 'service.furnace_tune_up.screen', jobType: 'maintenance', expectedMinutes: 80,
    problem: 'Yearly tune-up. Flame sensor was dirty last year.', equipmentId: 'eq-furnace',
    bookedVia: 'online', bookedAt: D('2026-09-10', 19 + 41 / 60),
    technician: { id: 'santos', name: 'Maria Santos', initials: 'MS', van: '12', skill: 'heating_cooling' },
    plannedArrival: wireAt(10 + 40 / 60), confirmed: true,
    onTheWayAt: wireAt(10 + 28 / 60), arrivedAt: null, endedAt: null, noOneHome: null,
  },
  customer: {
    id: HAROLD_ID, name: 'Harold Jenkins', mobile: '(614) 555-0148', phone: '(614) 555-0148', textsOn: true,
    language: 'en', zone: 'America/New_York', address: '418 Spring Hollow Court, Westerville 43081', area: 'Westerville',
    customerSince: '2014-10-01', pastVisitCount: 8, plan: 'comfort_club', notes: [],
  },
  equipment: [
    { id: 'eq-furnace', type: 'furnace', year: 2014, location: 'basement', details: '80,000 BTU, 96% efficient; filter 16x25x4' },
    { id: 'eq-ac', type: 'air_conditioner', year: 2014, location: 'east side', details: '2.5 ton outdoor unit' },
    { id: 'eq-tstat', type: 'thermostat', year: 2019, location: 'hallway', details: null },
  ],
  history: {
    count: 8, fromOldSystem: true,
    visits: [
      { date: '2025-10-14', what: null, serviceLabelKey: 'service.furnace_tune_up.screen', technician: 'Maria Santos', oldSystem: false, jobNumber: 21102, workDone: ['Cleaned the flame sensor, replaced the filter. All readings normal.'] },
      { date: '2025-06-09', what: null, serviceLabelKey: 'service.ac_tune_up.screen', technician: 'Brian Schaefer', oldSystem: false, jobNumber: 19877, workDone: ['Cleaned the outdoor coil. Capacitor reading a little low; check next visit.'] },
      { date: '2024-01-22', what: 'No heat (repair)', serviceLabelKey: null, technician: 'Tom Reinhart', oldSystem: true, jobNumber: null, workDone: ['Replaced the igniter. Furnace running normally.'] },
    ],
  },
  notes: [
    { id: 'n1', kind: 'office', author: 'Keisha Thompson', body: 'Please use the side door. The front steps are being repaired. Knock firmly; the doorbell does not work.', at: D('2026-09-10', 9), sentAt: D('2026-09-10', 9), enteredOffline: false },
    { id: 'n2', kind: 'technician', author: 'Maria Santos', body: 'Bring a 16x25x4 filter. Flame sensor was dirty last year; check it again.', at: D('2025-10-14', 11), sentAt: D('2025-10-14', 11), enteredOffline: false },
  ],
  photos: [],
  timeline: [
    { kind: 'created', at: D('2026-09-10', 19 + 41 / 60), by: null, byKind: 'customer', values: {} },
    { kind: 'status', at: wireAt(10 + 28 / 60), by: 'Maria Santos', byKind: 'technician', values: { 'from.status': 'scheduled', 'to.status': 'on_the_way' } },
  ],
  texts: [
    { id: 't1', kind: 'confirmation', status: 'delivered', at: D('2026-09-10', 19 + 42 / 60), body: '' },
    { id: 't2', kind: 'on_the_way', status: 'delivered', at: wireAt(10 + 28 / 60), body: '' },
  ],
  finish: null,
  signature: null,
  billing: { state: 'not_sent', reasonKey: null },
};

/** API-135 for HAROLD: Maria's van about 12 minutes out, inside the window, the link sent at 10:28 AM. */
export const HAROLD_WAY: OnTheWayAnswer = {
  onTheWay: true,
  van: { lon: -82.9301, lat: 40.1189, source: 'track' },
  destination: { lon: -82.9182, lat: 40.1262 },
  eta: wireAt(10 + 40 / 60), minutesAway: 12, insideWindow: true,
  technician: { name: 'Maria Santos', initials: 'MS', van: '12', skill: 'heating_cooling', phone: '(614) 555-0190' },
  linkSentAt: wireAt(10 + 28 / 60),
};

const DAYS: AvailabilityAnswer = {
  days: [
    { date: '2026-09-16', mode: 'four_hour', state: 'open', reason: null, left: 1, windows: [] },
    { date: '2026-09-17', mode: 'two_hour', state: 'open', reason: null, left: 6, windows: [
      { windowId: 'w8', start: D('2026-09-17', 8), end: D('2026-09-17', 10), state: 'full', left: 0 },
      { windowId: 'w10', start: D('2026-09-17', 10), end: D('2026-09-17', 12), state: 'open', left: 2 },
      { windowId: 'w12', start: D('2026-09-17', 12), end: D('2026-09-17', 14), state: 'open', left: 3 },
    ] },
    { date: '2026-09-18', mode: 'four_hour', state: 'open', reason: null, left: 2, windows: [] },
  ],
};
const FULL_DAYS: AvailabilityAnswer = {
  days: ['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']
    .map((date) => ({ date, mode: 'two_hour' as const, state: 'full' as const, reason: 'full' as const, left: 0, windows: [] })),
};
const PARTS: PartsAnswer = { parts: [{ partId: 'p-flt', name: 'Furnace filter 16x25x4 MERV 11', code: 'FLT-16254', priceCents: 2400 }] };
const SERVICES: ServicesAnswer = {
  services: [
    { serviceId: 'furnace_tune_up', screenLabelKey: 'service.furnace_tune_up.screen', priceTextKey: '', typicalLengthKey: '', bookableOnline: true },
    { serviceId: 'heating_or_ac_fix', screenLabelKey: 'service.heating_or_ac_fix.screen', priceTextKey: '', typicalLengthKey: '', bookableOnline: true },
  ],
};

const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);
const ok = <T,>(data: T): Promise<Answer<T>> => Promise.resolve({ ok: true, data });

/**
 * The preview's stand-in calls: the reads answer the frame's data (or never, for a Loading state); a write never answers, so a
 * dialog drawn busy stays busy.
 */
export function previewApi(o: { availability?: 'loading' | 'full' } = {}): JobApi {
  return {
    job: () => ok(HAROLD), onTheWay: () => ok(HAROLD_WAY), parts: () => ok(PARTS), services: () => ok(SERVICES),
    availability: () => (o.availability === 'loading' ? never() : ok(o.availability === 'full' ? FULL_DAYS : DAYS)),
    suggest: () => never(), preview: () => never(), inboxLink: () => never(), assign: () => never(), reschedule: () => never(), cancel: () => never(),
    edit: () => never(), finish: () => never(), correct: () => never(), text: () => never(), note: () => never(), addEquipment: () => never(), equipment: () => never(),
  };
}
