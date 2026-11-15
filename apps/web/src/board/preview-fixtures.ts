// SPDX-License-Identifier: AGPL-3.0-or-later
// The harness build's board data (P4-BOARD): the sample day DK-85 draws (mockups/pages/office-board.html, its TECHS and RAW
// tables and its Tue, Sep 15, 10:28 AM clock), as an API-20 answer, so each preview state shows the frame's own rows, blocks
// and counts for the look comparator and the page walkers. Never served by a release build (only *.preview.tsx import it).
import type { Board, BoardJob, BoardTech, Van } from './model.ts';

const Z = '[America/New_York]';
const DAY = '2026-09-15';
const pad = (n: number) => String(n).padStart(2, '0');
/** A decimal hour on the sample day as a wire time (EDT). */
export const wireAt = (hour: number, date = DAY): string => {
  const m = Math.round(hour * 60);
  return `${date}T${pad(Math.floor(m / 60))}:${pad(m % 60)}:00-04:00${Z}`;
};
const fromText = (t: string): number => {
  const m = /^(\d+):(\d+) (AM|PM)$/.exec(t);
  if (!m) throw new Error(`fixture time ${t}`);
  const h = Number(m[1]) % 12 + (m[3] === 'PM' ? 12 : 0);
  return h + Number(m[2]) / 60;
};
const WINDOWS: Record<string, [number, number]> = { '8-10': [8, 10], '10-12': [10, 12], '12-2': [12, 14], '2-4': [14, 16], '4-6': [16, 18] };

/** DK-85 TECHS: [id, name, initials, van, skill]. */
const TECHS: [string, string, string, string, string][] = [
  ['bell', 'Marcus Bell', 'MB', '21', 'plumbing'], ['carter', 'Jamal Carter', 'JC', '9', 'plumbing'], ['doyle', 'Kevin Doyle', 'KD', '27', 'plumbing'],
  ['hoffman', 'Greg Hoffman', 'GH', '5', 'plumbing'], ['kowalski', 'Dave Kowalski', 'DK', '7', 'heating_cooling'], ['mitchell', 'Ryan Mitchell', 'RM', '11', 'heating_cooling'],
  ['nguyen', 'Ashley Nguyen', 'AN', '24', 'heating_cooling'], ['ortega', 'Luis Ortega', 'LO', '18', 'heating_cooling'], ['reinhart', 'Tom Reinhart', 'TR', '3', 'heating_cooling'],
  ['santos', 'Maria Santos', 'MS', '12', 'heating_cooling'], ['schaefer', 'Brian Schaefer', 'BS', '15', 'heating_cooling'], ['yoder', 'Chris Yoder', 'CY', '30', 'install'],
];

/** DK-85 RAW: [tech, start, end, customer, city, window, status, eta]. */
type Raw = [string | null, number, number, string, string, string, string, string?];
const RAW: Raw[] = [
  ['bell', 8.25, 9.5, 'Hartley', 'Clintonville', '8-10', 'done'],
  ['bell', 9.92, 11.25, 'Okafor', 'Bexley', '10-12', 'site'],
  ['bell', 12.25, 13.5, 'Fischer', 'German Village', '12-2', 'sched'],
  ['bell', 14.33, 15.83, 'Delgado', 'Whitehall', '2-4', 'sched'],
  ['bell', 16.42, 17.42, 'Brooks', 'Bexley', '4-6', 'sched'],
  ['carter', 7.17, 7.92, 'Parts pickup', 'Supply house', '', 'task'],
  ['carter', 8.17, 11.5, 'Wallace', 'Grove City', '8-10', 'site'],
  ['carter', 11.83, 13.17, 'Hale', 'Grove City', '10-12', 'risk', '11:50 AM'],
  ['carter', 14.0, 15.25, 'Adeyemi', 'Grove City', '2-4', 'sched'],
  ['carter', 16.25, 17.25, 'Hughes', 'Grove City', '4-6', 'sched'],
  ['doyle', 8.33, 9.83, 'Marsh', 'Gahanna', '8-10', 'done'],
  ['doyle', 10.25, 11.5, 'Castillo', 'Reynoldsburg', '10-12', 'site'],
  ['doyle', 12.5, 14.5, 'Gruber', 'Pickerington', '12-2', 'sched'],
  ['doyle', 15.0, 16.0, 'Tate', 'Canal Winchester', '2-4', 'sched'],
  ['hoffman', 8.17, 11.75, 'Abbott', 'Upper Arlington', '8-10', 'site'],
  ['hoffman', 12.42, 13.75, 'Reyes', 'Dublin', '10-12', 'late', '12:25 PM'],
  ['hoffman', 14.5, 15.75, 'Rowe', 'Dublin', '2-4', 'sched'],
  ['hoffman', 16.25, 17.25, 'Esposito', 'Hilliard', '4-6', 'sched'],
  ['kowalski', 8.25, 10.17, 'Sutter', 'Worthington', '8-10', 'done'],
  ['kowalski', 10.75, 11.92, 'Graves', 'Powell', '10-12', 'way', '10:45 AM'],
  ['kowalski', 12.5, 13.67, 'Hensley', 'Lewis Center', '12-2', 'sched'],
  ['kowalski', 14.25, 15.5, 'Moretti', 'Powell', '2-4', 'sched'],
  ['kowalski', 16.17, 17.25, 'Lambert', 'Worthington', '4-6', 'sched'],
  ['mitchell', 8.08, 9.25, 'Pruitt', 'Reynoldsburg', '8-10', 'done'],
  ['mitchell', 10.0, 11.17, 'Daniels', 'Gahanna', '10-12', 'site'],
  ['mitchell', 12.17, 13.42, 'Kaminski', 'Bexley', '12-2', 'sched'],
  ['mitchell', 14.25, 15.5, 'Ferris', 'Whitehall', '2-4', 'sched'],
  ['nguyen', 8.17, 9.67, 'Coleman', 'Hilliard', '8-10', 'done'],
  ['nguyen', 10.0, 13.5, 'Barker', 'Dublin', '10-12', 'site'],
  ['nguyen', 13.75, 15.08, 'Voss', 'Dublin', '12-2', 'risk', '1:45 PM'],
  ['nguyen', 16.25, 17.25, 'Quinn', 'Hilliard', '4-6', 'sched'],
  ['ortega', 8.25, 9.75, 'Stanton', 'Upper Arlington', '8-10', 'done'],
  ['ortega', 10.0, 11.08, 'Ingram', 'Upper Arlington', '10-12', 'site'],
  ['ortega', 14.25, 15.5, 'Nolan', 'Hilliard', '2-4', 'sched'],
  ['ortega', 16.25, 17.5, 'Patel', 'Dublin', '4-6', 'sched'],
  ['reinhart', 8.0, 9.92, 'Whitman', 'Bexley', '8-10', 'done'],
  ['reinhart', 10.58, 12.0, 'Hollis', 'German Village', '10-12', 'way', '10:35 AM'],
  ['reinhart', 13.0, 14.5, 'Pierce', 'Bexley', '12-2', 'sched'],
  ['reinhart', 15.0, 16.0, 'Ward', 'Clintonville', '2-4', 'sched'],
  ['santos', 8.33, 10.25, 'Whitaker', 'Worthington', '8-10', 'done'],
  ['santos', 10.67, 12.0, 'Jenkins', 'Westerville', '10-12', 'way', '10:40 AM'],
  ['santos', 12.67, 13.75, 'Miller', 'Westerville', '12-2', 'sched'],
  ['santos', 14.33, 15.5, 'Holloway', 'Gahanna', '2-4', 'sched'],
  ['santos', 16.17, 17.25, 'Brennan', 'New Albany', '4-6', 'sched'],
  ['schaefer', 8.33, 9.5, 'Kerr', 'Westerville', '8-10', 'done'],
  ['schaefer', 10.08, 11.25, 'Dunbar', 'Westerville', '10-12', 'site'],
  ['schaefer', 12.25, 13.25, 'Lowry', 'Lewis Center', '12-2', 'sched'],
  ['schaefer', 14.17, 15.5, 'Ochoa', 'Westerville', '2-4', 'sched'],
  ['schaefer', 16.33, 17.25, 'Vance', 'Westerville', '4-6', 'sched'],
  ['yoder', 7.75, 15.5, 'Novak', 'New Albany', '8-10', 'site'],
  [null, 12.0, 13.25, 'Pham', 'Gahanna', '12-2', 'unas', 'Priority'],
  [null, 14.0, 15.0, 'Russo', 'Worthington', '2-4', 'unas'],
  [null, 16.0, 17.0, 'Kline', 'Hilliard', '4-6', 'unas'],
];

/** The frame's places, at their real points (the frame's map is a picture; the harness draws them on the branch map). */
const PLACES: Record<string, { lon: number; lat: number }> = {
  Clintonville: { lon: -83.02, lat: 40.04 }, Bexley: { lon: -82.93, lat: 39.97 }, 'German Village': { lon: -82.99, lat: 39.95 }, Whitehall: { lon: -82.89, lat: 39.97 },
  'Grove City': { lon: -83.09, lat: 39.88 }, Gahanna: { lon: -82.88, lat: 40.02 }, Reynoldsburg: { lon: -82.81, lat: 39.95 }, Pickerington: { lon: -82.75, lat: 39.88 },
  'Canal Winchester': { lon: -82.81, lat: 39.84 }, 'Upper Arlington': { lon: -83.06, lat: 40.03 }, Dublin: { lon: -83.11, lat: 40.1 }, Hilliard: { lon: -83.16, lat: 40.03 },
  Worthington: { lon: -83.02, lat: 40.09 }, Powell: { lon: -83.08, lat: 40.16 }, 'Lewis Center': { lon: -83.01, lat: 40.18 }, Westerville: { lon: -82.93, lat: 40.13 },
  'New Albany': { lon: -82.81, lat: 40.08 },
};

const STATUS: Record<string, BoardJob['status']> = { done: 'done', site: 'on_site', way: 'on_the_way', sched: 'scheduled', risk: 'scheduled', late: 'scheduled', unas: 'scheduled' };
const SERVICES = ['furnace_tune_up', 'ac_tune_up', 'heating_or_ac_fix', 'plumbing_repair', 'water_heater', 'thermostat'];

function job(r: Raw, i: number): BoardJob {
  const [tech, s, e, customer, area, win, st, eta] = r;
  const w = WINDOWS[win] ?? [8, 10];
  const at = wireAt(s);
  return {
    jobNumber: 24790 + i, version: 1, customerName: customer, area, serviceId: SERVICES[i % SERVICES.length]!,
    serviceLabelKey: `service.${SERVICES[i % SERVICES.length]}.screen`, windowId: `w-${win}`, window: { start: wireAt(w[0]), end: wireAt(w[1]) },
    technicianId: tech, plannedArrival: tech ? at : null, eta: tech ? (eta ? wireAt(fromText(eta)) : at) : null,
    expectedMinutes: Math.round((e - s) * 60), status: STATUS[st] ?? 'scheduled',
    timing: st === 'late' ? 'late' : st === 'risk' ? 'atRisk' : st === 'done' || st === 'unas' ? null : 'onTime',
    lateTextSent: st === 'late', confirmed: true, position: PLACES[area] ?? PLACES['Bexley'] as { lon: number; lat: number }, technicianSkill: null,
  };
}

/** The frame's sample day as API-20 answers it: 12 technicians, 52 jobs, 1 block, and the frame's tile counts. */
export function sampleBoard(): Board {
  const jobs = RAW.map((r, i) => ({ r, j: job(r, i) }));
  const attentionOf = (names: readonly string[], label: string): Board['needsAttention']['late'] => jobs.filter(({ j }) => names.includes(j.customerName)).map(({ r, j }) => ({
    jobNumber: j.jobNumber, label, customerName: j.customerName, area: j.area, technician: TECHS.find((x) => x[0] === r[0])?.[1] ?? null, eta: j.eta, window: j.window,
  }));
  const technicians: BoardTech[] = TECHS.map(([id, name, initials, van, skill]) => ({
    id, name, initials, van, skills: [skill], capacity: 5,
    jobs: jobs.filter(({ r }) => r[0] === id && r[6] !== 'task').map(({ j }) => j),
    blocks: jobs.filter(({ r }) => r[0] === id && r[6] === 'task').map(({ r }) => ({ blockId: `b-${id}`, version: 1, label: 'Pickup', place: 'Supply house', start: wireAt(r[1]), end: wireAt(r[2]) })),
  }));
  const unassigned = jobs.filter(({ r }) => r[0] === null).map(({ j }) => j);
  return {
    date: DAY, today: true, zone: 'America/New_York', dayMode: 'two_hour',
    // The frame's 5:30 PM edge is sample data (CTL-OFC-02-34); the harness draws the frame's edge.
    workingHours: { start: wireAt(8), end: wireAt(17.5) },
    onShift: 12,
    onTime7: { rate: 0.94, goal: 0.9, labelKey: 'board.summary.simulated', from: '2026-09-08', to: '2026-09-14' },
    technicians, unassigned,
    needsAttention: {
      late: attentionOf(['Reyes'], 'status.timing.late'), atRisk: attentionOf(['Hale', 'Voss'], 'status.timing.atRisk'), unassigned: attentionOf(['Pham'], 'status.job.unassigned'),
      flagged: [{ conflictId: 'c-okafor', jobNumber: 24791, listed: true, messageKey: 'offline.flag.status_set', values: { tech: 'Marcus', action: 'arrived', job: 24791, by: 'Keisha T.', at: '10:12 AM' }, offlineAt: wireAt(10.1), sentAt: wireAt(10.2), entry: null }],
    },
    counts: { jobs: 52, done: 9, onSite: 9, onTheWay: 3, late: 1, atRisk: 2, unassigned: 3, flagged: 1, lateTextSent: 1 },
  };
}

/** The frame's vans at 10:28 AM (DK-85 BW.vanPositions), as API-21 answers them. */
export function sampleVans(b: Board): Van[] {
  return b.technicians.map((x) => {
    const site = x.jobs.find((j) => j.status === 'on_site');
    const way = x.jobs.find((j) => j.status === 'on_the_way');
    const last = x.jobs.filter((j) => j.status === 'done').pop();
    const current = site ?? way;
    const from = last?.position ?? PLACES['Bexley'] as { lon: number; lat: number };
    const position = site ? site.position : way ? { lon: from.lon + (way.position.lon - from.lon) * 0.62, lat: from.lat + (way.position.lat - from.lat) * 0.62 } : from;
    return {
      technicianId: x.id, name: x.name, initials: x.initials, van: x.van, skills: x.skills, phone: x.id === 'santos' ? '(614) 555-0112' : '(614) 555-0130', position,
      status: site ? 'on_site' as const : way ? 'on_the_way' as const : 'between_jobs' as const, jobNumber: current?.jobNumber ?? null, eta: current?.eta ?? null,
      route: way ? { from, to: way.position, track: null } : null,
    };
  });
}

/** The frame's small boards (DK-85 mini): only the named technicians' rows, with or without their jobs. */
export function subBoard(b: Board, names: readonly string[], jobs = true): Board {
  const technicians = b.technicians.filter((x) => names.includes(x.id)).map((x) => (jobs ? x : { ...x, jobs: [], blocks: [] }));
  return { ...b, technicians, unassigned: [], counts: { ...b.counts, jobs: jobs ? b.counts.jobs : 0 } };
}

/** F-1155 (DK-85 "Control details: what a flagged item held", owner ruling c4aa4366): 2 flagged rows that carry what the technician entered, with their entry lines. */
export function flaggedWithEntries(b: Board): Board {
  const base = b.needsAttention.flagged[0]!;
  const flagged: Board['needsAttention']['flagged'] = [
    {
      ...base, conflictId: 'c-santos', jobNumber: 24825, messageKey: 'offline.flag.assigned',
      values: { tech: 'Maria Santos', action: 'finished', job: 24825, byKind: 'user', by: 'Keisha T.', toKind: 'user', to: 'Kevin Doyle', at: '10:50 AM' },
      offlineAt: wireAt(10 + 41 / 60), sentAt: wireAt(10 + 58 / 60),
      entry: { kind: 'finish', parts: [{ partId: 'p-filter', name: 'Furnace filter 16x25x4 MERV 11', quantity: 1 }], noPartsUsed: false, laborMinutes: 52, workDone: ['Tune-up done, all readings normal'] },
    },
    {
      ...base, conflictId: 'c-bell', jobNumber: 24838, messageKey: 'offline.flag.canceled',
      values: { tech: 'Marcus Bell', action: 'note', job: 24838, byKind: 'user', by: 'Keisha T.', at: '9:40 AM' },
      offlineAt: wireAt(9 + 52 / 60), sentAt: wireAt(10 + 12 / 60),
      entry: { kind: 'note', text: 'Customer asked for a quote on a new AC unit.' },
    },
  ];
  return { ...b, needsAttention: { ...b.needsAttention, flagged }, counts: { ...b.counts, flagged: 2 } };
}

export const SAMPLE_DAY = DAY;

/** The harness states of SCR-OFC-02 and its hosted screens (app/shell-preview/board/[state]); a server module, so the route can read it. */
export const BOARD_PREVIEW_STATES = [
  'success', 'moving', 'loading', 'no-technicians', 'marking', 'offline', 'previewing', 'no-jobs', 'partial', 'map-hidden', 'jobs-on-map', 'skill-filter', 'flagged-entries',
  'job-open', 'job-updated', 'job-gone',
  'reassign-loading', 'reassign-choosing', 'reassign-previewing', 'reassign-no-others', 'reassign-saving', 'reassign-done',
  'conflict-shown', 'conflict-resending', 'conflict-again', 'conflict-gone', 'conflict-done',
  'block-adding', 'block-changing', 'block-saving', 'block-overlap', 'block-done',
  'blockpop-open', 'blockpop-updated', 'blockpop-gone', 'delete-asking', 'delete-deleting', 'delete-done',
] as const;
export type BoardPreviewState = (typeof BOARD_PREVIEW_STATES)[number];
