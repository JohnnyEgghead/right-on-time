// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixed data for the SCR-OFC-30 preview routes (harness build only): the jobs the frame draws (mockups/pages/office-jobs.html, DK-88), with the
// frame's own values, for the look comparator (ci/look-values/jobs.pw.test.ts) and the page walkers. Never read by a release route.
import type { JobRow, JobsData } from './jobs-model.ts';

const ZONE = '[America/New_York]';
const at = (date: string, hhmm: string): string => `${date}T${hhmm}:00-04:00${ZONE}`;

const TECH = {
  MB: ['0198a0a0-0000-7000-8000-000000000001', 'Marcus Bell'],
  JC: ['0198a0a0-0000-7000-8000-000000000002', 'Jamal Carter'],
  KD: ['0198a0a0-0000-7000-8000-000000000003', 'Kevin Doyle'],
  GH: ['0198a0a0-0000-7000-8000-000000000004', 'Greg Hoffman'],
  DK: ['0198a0a0-0000-7000-8000-000000000005', 'Dave Kowalski'],
  RM: ['0198a0a0-0000-7000-8000-000000000006', 'Ryan Mitchell'],
  AN: ['0198a0a0-0000-7000-8000-000000000007', 'Ashley Nguyen'],
  TR: ['0198a0a0-0000-7000-8000-000000000008', 'Tom Reinhart'],
  MS: ['0198a0a0-0000-7000-8000-000000000009', 'Maria Santos'],
  LO: ['0198a0a0-0000-7000-8000-00000000000a', 'Luis Ortega'],
} as const;
type Initials = keyof typeof TECH;

/** The frame's service words, by the id the fixture rows carry: the seed's catalog has other services (the preview says these words). */
const FRAME_WORDS: Record<string, string> = {
  water_softener_service: 'Water softener service',
  kitchen_sink_leak: 'Kitchen sink leak',
  ac_tune_up: 'AC tune-up',
  ac_not_cooling: 'AC not cooling',
  thermostat_install: 'Thermostat install',
  garbage_disposal: 'Garbage disposal',
  tankless_heater_flush: 'Tankless heater flush',
  drain_cleaning: 'Drain cleaning',
  furnace_tune_up: 'Furnace tune-up',
  water_heater_leak: 'Water heater leak',
  heat_pump_check: 'Heat pump check',
  boiler_repair: 'Boiler repair',
};
/** The same services in Spanish for the Spanish walker, which flags a page text that holds an English catalog value (the frame's words are fixture data). */
const FRAME_WORDS_ES: Record<string, string> = {
  water_softener_service: 'Servicio de suavizador', kitchen_sink_leak: 'Fuga del fregadero', ac_tune_up: 'Ajuste de aire', ac_not_cooling: 'Aire sin enfriar',
  thermostat_install: 'Instalación de termostato', garbage_disposal: 'Triturador de basura', tankless_heater_flush: 'Lavado sin tanque', drain_cleaning: 'Limpieza de desagüe',
  furnace_tune_up: 'Ajuste de calefactor', water_heater_leak: 'Fuga del calentador', heat_pump_check: 'Revisión de bomba de calor', boiler_repair: 'Reparación de caldera',
};
export const JOBS_SERVICE_WORDS: Readonly<Record<'en' | 'es', Readonly<Record<string, string>>>> = { en: FRAME_WORDS, es: FRAME_WORDS_ES };

interface Plant {
  n: number; customer: string; area: string; service: string; day: string; from: string; to: string; tech: Initials | null;
  status: JobRow['status']; timing?: JobRow['timing']; eta?: string; arrived?: string; ended?: string; lateText?: boolean; four?: boolean;
  via: JobRow['bookedVia']; by?: string; billing?: JobRow['billingState']; tries?: number; billed?: string; attention?: boolean;
}

const TODAY = '2026-09-15';

function row(x: Plant): JobRow {
  const day = x.day;
  return {
    jobNumber: x.n, customer: x.customer, area: x.area, service: x.service, problem: null, day,
    window: { start: at(day, x.from), end: at(day, x.to) },
    technicianId: x.tech ? TECH[x.tech][0] : null, technician: x.tech ? TECH[x.tech][1] : null,
    status: x.status, timing: x.timing ?? null,
    eta: x.eta ? at(day, x.eta) : null, arrivedAt: x.arrived ? at(day, x.arrived) : null, endedAt: x.ended ? at(day, x.ended) : null,
    lateTextSentAt: x.lateText ? at(day, '10:30') : null,
    dayMode: x.four ? 'four_hour' : 'two_hour', bookedVia: x.via, bookedBy: x.by ?? null,
    billingState: x.billing ?? 'not_sent', billingTries: x.tries ?? 0, billedAt: x.billed ? at(day, x.billed) : null,
    needsAttention: x.attention ?? false,
  };
}

const FILTERS: JobsData['filters'] = {
  technicians: Object.values(TECH).map(([id, name]) => ({ id, name })),
  // F-1659: the service ids (the frame's), not the 2 language keys of JOBS_SERVICE_WORDS.
  services: Object.keys(FRAME_WORDS),
};

const BASE = {
  branch: 'columbus', today: TODAY, asOf: at(TODAY, '10:28'),
  counts: { all: 226, unassigned: 3, atRisk: 2, late: 1, notInBilling: 2 },
  range: { from: TODAY, to: '2026-09-19' }, filters: FILTERS,
};

/** The frame's Success rows: the 6 jobs needing attention, today's other 4 jobs and 2 upcoming (CTL-OFC-30-17). */
const SUCCESS_ROWS: JobRow[] = [
  row({ n: 24805, customer: 'Carmen Reyes', area: 'Dublin', service: 'water_softener_service', day: TODAY, from: '10:00', to: '12:00', tech: 'GH', status: 'scheduled', timing: 'late', eta: '12:25', lateText: true, via: 'office', by: 'Keisha Thompson', attention: true }),
  row({ n: 24797, customer: 'Dennis Hale', area: 'Grove City', service: 'kitchen_sink_leak', day: TODAY, from: '10:00', to: '12:00', tech: 'JC', status: 'scheduled', timing: 'at_risk', eta: '11:50', via: 'online', attention: true }),
  row({ n: 24819, customer: 'Linda Voss', area: 'Dublin', service: 'ac_tune_up', day: TODAY, from: '12:00', to: '14:00', tech: 'AN', status: 'scheduled', timing: 'at_risk', eta: '13:45', via: 'online', attention: true }),
  row({ n: 24840, customer: 'Thanh Pham', area: 'Gahanna', service: 'ac_not_cooling', day: TODAY, from: '12:00', to: '14:00', tech: null, status: 'scheduled', via: 'office', by: 'Keisha Thompson', attention: true }),
  row({ n: 24841, customer: 'Angela Russo', area: 'Worthington', service: 'thermostat_install', day: TODAY, from: '14:00', to: '16:00', tech: null, status: 'scheduled', via: 'online', attention: true }),
  row({ n: 24842, customer: 'Janet Kline', area: 'Hilliard', service: 'garbage_disposal', day: TODAY, from: '16:00', to: '18:00', tech: null, status: 'scheduled', via: 'online', attention: true }),
  row({ n: 24800, customer: 'Paul Marsh', area: 'Gahanna', service: 'tankless_heater_flush', day: TODAY, from: '08:00', to: '10:00', tech: 'KD', status: 'done', ended: '09:50', via: 'office', by: 'Marco Pace', billing: 'waiting_person' }),
  row({ n: 24790, customer: 'Don Hartley', area: 'Clintonville', service: 'drain_cleaning', day: TODAY, from: '08:00', to: '10:00', tech: 'MB', status: 'done', ended: '09:30', via: 'online', billing: 'in_billing', billed: '09:34' }),
  row({ n: 24830, customer: 'Harold Jenkins', area: 'Westerville', service: 'furnace_tune_up', day: TODAY, from: '10:00', to: '12:00', tech: 'MS', status: 'on_the_way', timing: 'on_time', eta: '10:40', via: 'online' }),
  row({ n: 24791, customer: 'Grace Okafor', area: 'Bexley', service: 'water_heater_leak', day: TODAY, from: '10:00', to: '12:00', tech: 'MB', status: 'on_site', arrived: '09:55', via: 'office', by: 'Keisha Thompson' }),
  row({ n: 24871, customer: 'Beth Whitfield', area: 'Westerville', service: 'heat_pump_check', day: '2026-09-16', from: '08:00', to: '12:00', tech: 'MS', status: 'scheduled', four: true, via: 'online' }),
  row({ n: 24866, customer: "Sean O'Brien", area: 'Clintonville', service: 'furnace_tune_up', day: '2026-09-17', from: '10:00', to: '12:00', tech: 'RM', status: 'scheduled', via: 'online' }),
];
/** F-1664: the page's problem words, so the look case draws the 220 px cell. F-1736: in the page's language, as the service words are. */
const withProblemWords = (words: Record<string, string>): JobRow[] => SUCCESS_ROWS.map((r) => ({ ...r, problem: words[r.service] ?? null }));

export const JOBS_SUCCESS: JobsData = { ...BASE, rows: withProblemWords(FRAME_WORDS), total: 226, pages: 19 };
/** The Success rows on a Spanish page: the problem words are fixture data in Spanish (the Spanish walker flags an English catalog value). */
export const JOBS_SUCCESS_ES: JobsData = { ...JOBS_SUCCESS, rows: withProblemWords(FRAME_WORDS_ES) };

/** Empty tab: the Late tab has no job. */
export const JOBS_EMPTY: JobsData = { ...BASE, counts: { ...BASE.counts, late: 0 }, rows: [], total: 0, pages: 0 };

/** No results: a search no job matches. */
export const JOBS_NO_RESULTS: JobsData = { ...BASE, counts: { all: 0, unassigned: 0, atRisk: 0, late: 0, notInBilling: 0 }, rows: [], total: 0, pages: 0 };

/** Live row: job 24812 joins the Not in billing tab (2 becomes 3). */
export const JOBS_LIVE: JobsData = {
  ...BASE, counts: { ...BASE.counts, notInBilling: 3 },
  rows: [
    row({ n: 24812, customer: 'Whitaker', area: 'Upper Arlington', service: 'ac_tune_up', day: TODAY, from: '08:00', to: '10:00', tech: 'KD', status: 'done', ended: '09:40', via: 'online', billing: 'retrying', tries: 1 }),
    row({ n: 24800, customer: 'Paul Marsh', area: 'Gahanna', service: 'tankless_heater_flush', day: TODAY, from: '08:00', to: '10:00', tech: 'KD', status: 'done', ended: '09:50', via: 'office', by: 'Marco Pace', billing: 'waiting_person' }),
    row({ n: 24825, customer: 'Ruth Whitman', area: 'Bexley', service: 'boiler_repair', day: TODAY, from: '08:00', to: '10:00', tech: 'MB', status: 'done', ended: '09:35', via: 'online', billing: 'retrying', tries: 3 }),
  ],
  total: 3, pages: 1,
};
export const JOBS_LIVE_CHANGED: readonly number[] = [24812];
