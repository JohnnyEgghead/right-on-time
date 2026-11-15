// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixed data of the New job preview route (harness build only): the sample data DK-89 shows (mockups/pages/office-new-job.html: Harold
// Jenkins, a water heater visit on Thu, Sep 17, 12-2 PM with Kevin Doyle), in the shapes the real reads answer (API-35, API-110, API-29,
// API-30), so the look comparator reads the same state on both sides. The services are the frame's 6 and the days its 6; the live page
// draws every service and day the API answers (the stack suite checks those). Never imported by a release route.
import type { ServicesAnswer, SuggestedTechniciansAnswer } from '@bw/api';
import { HAROLD_DETAIL } from '../customers/preview-data.ts';
import type { Detail } from '../customers/types.ts';
import { wireAt } from '../board/preview-fixtures.ts';
import type { Day, Picks } from './model.ts';

/** Harold with the frame's equipment (a water heater) and his booked visit today, Maria on the way. */
export const NJ_CUSTOMER: Detail = {
  ...HAROLD_DETAIL,
  equipment: [{ id: '0192f000-0000-7000-8000-0000000000e3', type: 'water_heater', year: 2016, location: 'basement', details: '50 gallon' }],
  upcoming: HAROLD_DETAIL.upcoming.map((u) => ({ ...u, window: { start: wireAt(10), end: wireAt(12) } })),
};

const FRAME_SERVICES = ['furnace_tune_up', 'ac_tune_up', 'heating_or_ac_fix', 'plumbing_repair', 'water_heater', 'thermostat'] as const;
export const NJ_SERVICES: ServicesAnswer['services'] = FRAME_SERVICES.map((serviceId) => ({
  serviceId, screenLabelKey: `service.${serviceId}.screen`, priceTextKey: '', typicalLengthKey: '', bookableOnline: true,
}));

const win = (id: string, from: number, to: number, left: number, date: string) => ({
  windowId: id, start: wireAt(from, date), end: wireAt(to, date), state: left === 0 ? ('full' as const) : ('open' as const), left,
});
const THU = '2026-09-17';
/** DK-89's days: Tue full, Wed and Fri in 4-hour windows, then Thu, Sat and Mon. */
export const NJ_DAYS: Day[] = [
  { date: '2026-09-15', mode: 'two_hour', state: 'full', reason: 'full', left: 0, windows: [] },
  { date: '2026-09-16', mode: 'four_hour', state: 'open', reason: null, left: 1, windows: [] },
  {
    date: THU, mode: 'two_hour', state: 'open', reason: null, left: 6,
    windows: [win('w8', 8, 10, 1, THU), win('w10', 10, 12, 0, THU), win('w12', 12, 14, 2, THU), win('w14', 14, 16, 3, THU), win('w16', 16, 18, 0, THU)],
  },
  { date: '2026-09-18', mode: 'four_hour', state: 'open', reason: null, left: 2, windows: [] },
  { date: '2026-09-19', mode: 'saturday', state: 'open', reason: null, left: 3, windows: [] },
  { date: '2026-09-21', mode: 'two_hour', state: 'open', reason: null, left: 11, windows: [] },
];
/** The No windows state: Wed, Sep 16 is open for the day but every window of it is taken. */
export const NJ_DAYS_NONE: Day[] = NJ_DAYS.map((d) => (d.date === '2026-09-16' ? { ...d, left: 0 } : d));

const tech = (id: string, name: string, van: string, skills: string[], minutes: number, jobs: number, hour: number, area: string, suggested = true): SuggestedTechniciansAnswer['technicians'][number] => ({
  id, name, van, skills, minutesFromStopBefore: minutes, stopBefore: { jobNumber: 24800 + minutes, plannedArrival: wireAt(hour, THU), area },
  load: { jobs, capacity: 5 }, room: true, suggested, reason: suggested ? null : 'skill_missing',
});
/** Kevin first, then the 2 who service water heaters as a second skill, nearest first (SD-26: a different order than DK-89 draws). */
export const NJ_TECHS: SuggestedTechniciansAnswer = {
  serviceSkill: 'plumbing',
  technicians: [
    tech('0192f000-0000-7000-8000-0000000000f1', 'Kevin Doyle', '27', ['plumbing'], 9, 4, 10, 'Gahanna'),
    tech('0192f000-0000-7000-8000-0000000000f2', 'Marcus Bell', '21', ['heating_cooling', 'plumbing'], 18, 4, 8, 'Bexley'),
    tech('0192f000-0000-7000-8000-0000000000f3', 'Greg Hoffman', '5', ['heating_cooling', 'plumbing'], 26, 2, 9, 'Dublin'),
  ],
};

export const NJ_PICKED: Picks = {
  serviceId: 'water_heater', equipmentId: '0192f000-0000-7000-8000-0000000000e3', problem: 'Popping noise when heating; a little water at\u200b the base.',
  day: THU, windowId: 'w12', technicianId: '0192f000-0000-7000-8000-0000000000f1',
};

/** The states DK-89 draws (the preview route's pages). */
export const NEWJOB_PREVIEW_STATES = ['picked', 'start', 'no-match', 'no-windows', 'saving', 'done', 'input-kept'] as const;
export type NewJobPreviewState = (typeof NEWJOB_PREVIEW_STATES)[number];
