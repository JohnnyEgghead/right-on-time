// SPDX-License-Identifier: AGPL-3.0-or-later
// The sample data of the live map frames (mockups/pages/customer-live-map.html, customer-live-map-ended.html), for the harness build's preview
// routes and the look comparator. Never read by a release route. Maria Santos, Van 12, the furnace tune-up at 10 AM-12 PM on Tue, Sep 15; the
// van left at 10:28 AM and is due at 10:40 AM.
import type { ClockAnswer } from '../shell/clock.ts';
import { APP_INFO, CLOCK_RUNNING } from '../shell/preview-fixtures.ts';
import type { Fixed } from './LiveMapView.tsx';
import type { EndedDetail, LiveData, LiveState } from './model.ts';

const Z = '[America/New_York]';
const at = (hhmm: string) => `2026-09-15T${hhmm}-04:00${Z}`;
const clockAt = (hhmm: string): ClockAnswer => ({ ...CLOCK_RUNNING, demoNow: at(`${hhmm}:00`) });

const TECH = { name: 'Maria Santos', initials: 'MS', van: '12' };
const VISIT = { serviceLabelKey: 'service.furnace_tune_up.screen', day: '2026-09-15', window: { start: at('10:00:00'), end: at('12:00:00') } };
const PHONE = '(614) 555-0100';

export const LIVE_DATA: LiveData = {
  branch: 'columbus',
  technician: TECH,
  visit: VISIT,
  eta: at('10:40:00'),
  minutesAway: 12,
  leftAt: at('10:28:00'),
  van: { lon: -82.9, lat: 40.1, source: 'track' },
  destination: { lon: -82.88, lat: 40.12 },
  route: { from: { lon: -82.93, lat: 40.08 }, to: { lon: -82.88, lat: 40.12 }, track: null },
  officePhone: PHONE,
};

/** 10:30:10 AM, 2 minutes 10 seconds into the 12-minute trip: the frame's 18 percent. */
const NOW_LIVE = at('10:30:10');

export const ARRIVED: EndedDetail = { reason: 'arrived', arrivedAt: at('10:41:00'), visit: VISIT, technician: TECH, officePhone: PHONE };
/** The office changed the visit: the office phone only (SCR-CUS-05 Visit changed). */
export const CHANGED: EndedDetail = { reason: 'changed', arrivedAt: null, visit: null, technician: null, officePhone: PHONE };

const fixed = (hhmm: string): Fixed => ({ clock: clockAt(hhmm), appInfo: APP_INFO, reader: false });

/** SCR-CUS-04 in each state its frame shows, with the frame's clock. */
/** `officePhone` is what the page carries from its first load: Loading draws it and Call (F-1134); Not valid has none. */
export const LIVE_PREVIEWS: Record<string, { state: LiveState; fixed: Fixed; officePhone?: string }> = {
  'on-the-way': { state: { kind: 'live', data: LIVE_DATA, now: NOW_LIVE, failed: false }, fixed: fixed('10:29') },
  loading: { state: { kind: 'loading' }, fixed: fixed('10:29'), officePhone: PHONE },
  'not-valid': { state: { kind: 'not_found' }, fixed: fixed('10:29') },
  'update-failed': { state: { kind: 'live', data: LIVE_DATA, now: NOW_LIVE, failed: true }, fixed: fixed('10:29') },
};

/** SCR-CUS-05 in each state its frame shows (by arrival, visit changed). The arrival-less Ended drawing is retired (DK-124, F-1140). */
export const ENDED_PREVIEWS: Record<string, { detail: EndedDetail; fixed: Fixed }> = {
  'by-arrival': { detail: ARRIVED, fixed: fixed('10:43') },
  changed: { detail: CHANGED, fixed: fixed('10:34') },
};
