// SPDX-License-Identifier: AGPL-3.0-or-later
// The Today screen's preview states (harness build only; the shell-preview routes tech-today and tech-frame): the frame's day
// (DK-107 mockups/pages/tech-today.html, Maria Santos at Tue, Sep 15) in each state its frames show, fixed, so the look comparator
// and the page walkers read the screen with no database behind it.
import type { TodayAnswer, TodayJob } from '@bw/api';
import type { ClockAnswer } from '../../shell/clock.ts';
import { CLOCK_RUNNING } from '../../shell/preview-fixtures.ts';
import type { OutboxState } from '../engine.ts';
import { STATES } from '../preview-states.ts';
import { catalogs } from '@bw/i18n/src/catalog.ts';
import { applyWaiting, PREVIEW_LINK, type LocalJob } from './model.ts';
import type { SheetKind } from './TodayView.tsx';

const Z = '[America/New_York]';
const at = (hhmm: string) => `2026-09-15T${hhmm}:00-04:00${Z}`;
const clockAt = (hhmm: string): ClockAnswer => ({ ...CLOCK_RUNNING, demoNow: at(hhmm) });

const base = (n: number, over: Partial<TodayJob> & { name: string; area: string; service: string; from: string; to: string }): TodayJob => {
  const { name, area, service, from, to, ...rest } = over;
  return {
    jobNumber: 24820 + n, version: 2, position: n, status: 'scheduled', window: { start: at(from), end: at(to) },
    customer: { name, language: 'en', phone: '(614) 555-0142' }, address: `${400 + n} Maple Hollow Ct, ${area}`, area, serviceLabelKey: service,
    equipment: null, lastVisit: null, customerNote: null, plannedArrival: null, textedArrival: null, endedAt: null, lateText: null, onMyWayPreview: null,
    ...rest,
  };
};

const SERVICE = { tune: 'service.furnace_tune_up.screen', ac: 'service.ac_tune_up.screen', fix: 'service.heating_or_ac_fix.screen' };
/** The server renders the text in the customer's language (API-100 onMyWayPreview); the fixture's customer reads Spanish, from the shipped catalog. */
const preview = (language: 'en' | 'es' = 'es') => ({
  language, arrival: at('10:40'),
  text: catalogs[language]['text.on_the_way']!.replace(/\{tech\}/g, 'Maria').replace('{arrival}', '10:40 AM').replace('{mapLink}', PREVIEW_LINK),
});

const whitaker = base(1, { name: 'Dale Whitaker', area: 'Worthington', service: SERVICE.tune, from: '08:00', to: '10:00', status: 'done', endedAt: at('10:15') });
const harold = base(2, {
  name: 'Harold Jenkins', area: 'Westerville', service: SERVICE.tune, from: '10:00', to: '12:00', address: '418 Maple Hollow Ct, Westerville',
  equipment: { type: 'furnace', year: 2014, details: null }, lastVisit: { date: '2025-10-14', what: null, labelKey: SERVICE.tune }, customerNote: 'Use the side door. Knock firmly.',
  onMyWayPreview: preview(),
});
const miller = base(3, { name: 'Linda Miller', area: 'Westerville', service: SERVICE.ac, from: '12:00', to: '14:00', address: '2271 Cobblestone Dr, Westerville', equipment: { type: 'air_conditioner', year: 2017, details: null }, onMyWayPreview: preview() });
const holloway = base(4, { name: 'Pat Holloway', area: 'Gahanna', service: SERVICE.fix, from: '14:00', to: '16:00' });
const brennan = base(5, { name: 'Sam Brennan', area: 'New Albany', service: SERVICE.fix, from: '16:00', to: '18:00' });

const day = (jobs: TodayJob[], asOf: string, over: Partial<TodayAnswer> = {}): TodayAnswer => ({
  date: '2026-09-15', asOf: at(asOf), zone: 'America/New_York', van: { number: '12', vehicle: 'Ford Transit' }, startedAt: at('07:41'), officePhone: '(614) 555-0100',
  technician: { name: 'Maria Santos', initials: 'MS', employeeNumber: '40712', skill: 'heating_cooling', branch: 'columbus' },
  jobs: jobs.map((j, i) => ({ ...j, position: i + 1 })), ...over,
});

export interface TodayPreviewState {
  day: TodayAnswer | null;
  jobs: LocalJob[];
  loading: boolean;
  online: boolean;
  savedAt: string | null;
  failed: boolean;
  fixed: OutboxState;
  clock: ClockAnswer;
  sheet: { kind: SheetKind; job: LocalJob } | null;
  notice: string | null;
  /** CTL-TEC-02-03: the next job's drive minutes (API-104); null: not known. */
  driveMinutes: number | null;
  /** The frame draws this state as a tile of its states board (a bordered mini screen). */
  mini: boolean;
  /** New day (F-1135): the date heading over the jobs as Later rows and a skeleton row. */
  newDay: boolean;
}

const plain = (d: TodayAnswer | null, waiting: OutboxState['waiting'] = [], sent: OutboxState['lastSent'] = []): LocalJob[] => applyWaiting(d?.jobs ?? [], waiting, sent);
/** The engine's answer to a status item (lastSent): what the Sent badge draws from. */
const answered = (kind: 'on_my_way' | 'arrived' | 'no_one_home' | 'finished', jobNumber: number): OutboxState['lastSent'][number] => ({
  key: `00000000-0000-4000-8000-00000000001${jobNumber % 10}`, kind, jobNumber, enteredRealMs: 0, answeredRealMs: 0, result: 'applied', code: null, messageKey: null, values: null,
});
const item = (kind: 'on_my_way' | 'arrived' | 'no_one_home' | 'finished', jobNumber: number, n: number, demoTime = '') => ({
  key: `00000000-0000-4000-8000-0000000000${n}0`, worldEpoch: 1, deviceTime: '', offsetSavedReal: '', sinceSaveMs: 0, demoTime, enteredRealMs: n, jobNumber, baseVersion: 2, userId: 'u', kind,
}) as OutboxState['waiting'][number];

function make(d: TodayAnswer | null, o: Partial<TodayPreviewState> & { time: string; waiting?: OutboxState['waiting']; sent?: OutboxState['lastSent'] }): TodayPreviewState {
  const { time, waiting = [], sent = [], ...rest } = o;
  const online = rest.online ?? true;
  const fixed: OutboxState = { ...(online ? STATES.synced! : STATES.offline!), waiting, lastSent: sent };
  return { day: d, jobs: plain(d, waiting, sent), loading: false, online, savedAt: d?.asOf ?? null, failed: false, fixed, clock: clockAt(time), sheet: null, notice: null, driveMinutes: null, mini: false, newDay: false, ...rest };
}

const dayOne = day([whitaker, harold, miller, holloway, brennan], '10:26');
const onSite = day([whitaker, { ...harold, status: 'on_site' }, miller, holloway, brennan], '10:30');
const withSheet = (kind: SheetKind, online: boolean, jobs: TodayAnswer): TodayPreviewState => {
  const s = make(jobs, { time: '10:28', online });
  const job = s.jobs.find((j) => j.jobNumber === harold.jobNumber)!;
  return { ...s, sheet: { kind, job: kind === 'noh' ? { ...job, status: 'on_site' } : job } };
};

export const TODAY_PREVIEWS = [
  'success', 'late', 'loading', 'none', 'alldone', 'offline-saved', 'offline-none', 'pending', 'failed',
  'omw', 'omw-offline', 'arrived', 'noh', 'noh-offline', 'arrived-saved', 'noh-saved', 'new-day',
] as const;
export type TodayPreviewName = (typeof TODAY_PREVIEWS)[number];

const TILES: ReadonlySet<TodayPreviewName> = new Set<TodayPreviewName>(['loading', 'none', 'alldone', 'offline-saved', 'offline-none', 'pending', 'failed', 'omw-offline', 'arrived', 'noh', 'noh-offline', 'arrived-saved', 'noh-saved', 'new-day']);

export function previewState(name: TodayPreviewName): TodayPreviewState {
  return { ...state(name), mini: TILES.has(name) };
}

function state(name: TodayPreviewName): TodayPreviewState {
  switch (name) {
    case 'success': return make(dayOne, { time: '10:26', driveMinutes: 12 });
    case 'late': {
      const late = { ...miller, lateText: { sentAt: at('12:52'), eta: at('13:05'), wasEta: at('12:40') }, textedArrival: at('13:05'), customerNote: null };
      const d = day([whitaker, { ...harold, status: 'done', endedAt: at('12:51') }, late, holloway, brennan], '12:53');
      return make(d, { time: '12:53', driveMinutes: 11 });
    }
    case 'loading': return { ...make(null, { time: '10:26' }), loading: true };
    case 'none': return make(day([], '10:26'), { time: '10:26' });
    case 'alldone': {
      // F-1078: the frame's 5-job day ("5 of 5 done", "All 5 jobs are done."), its tile showing the first 3 ended rows.
      const d = day([
        whitaker, { ...harold, status: 'done', endedAt: at('12:51') }, { ...miller, status: 'no_one_home', endedAt: at('13:22') },
        { ...holloway, status: 'done', endedAt: at('15:34') }, { ...brennan, status: 'done', endedAt: at('17:21') },
      ], '17:42');
      return make(d, { time: '17:42' });
    }
    case 'offline-saved': return make(dayOne, { time: '11:06', online: false, waiting: [item('finished', harold.jobNumber, 1, at('11:02')), item('on_my_way', 24829, 2), item('arrived', 24829, 3)] });
    case 'offline-none': return make(null, { time: '10:26', online: false });
    case 'pending': return make(dayOne, { time: '10:28', waiting: [item('on_my_way', harold.jobNumber, 1)], driveMinutes: 12 });
    case 'failed': return { ...make(dayOne, { time: '10:30' }), failed: true };
    // SCR-TEC-13 Saved: Arrived was tapped and sent, so the job reads On site (the server's status) and the engine's lastSent holds the answer.
    case 'arrived-saved': return make(onSite, { time: '10:30', sent: [answered('arrived', harold.jobNumber)] });
    // SCR-TEC-14 Saved: No one home was tapped and waits to send; the visit shows as over and Linda Miller is next. The clock is the
    // confirm frame's own (Tue, Sep 15, 10:28 AM EDT on every tile, F-1078); the row keeps the frame's No one home 10:52 AM.
    case 'noh-saved': return make(dayOne, { time: '10:28', waiting: [item('no_one_home', harold.jobNumber, 1, at('10:52'))] });
    // SCR-TEC-02 New day (DK-107): the clock passed midnight (Wed, Sep 16, 12:00 AM) and the read for the new today answers; its jobs show as Later rows.
    case 'new-day': {
      const atNext = (hhmm: string) => `2026-09-16T${hhmm}:00-04:00${Z}`;
      const nd = (n: number, over: Partial<TodayJob> & { name: string; area: string; service: string; from: string; to: string }): TodayJob => {
        const { from, to, ...rest } = over;
        return base(n, { ...rest, from, to, window: { start: atNext(from), end: atNext(to) } });
      };
      const d = day([
        nd(1, { name: 'Jim Okafor', area: 'Dublin', service: SERVICE.tune, from: '08:00', to: '10:00' }),
        nd(2, { name: 'Ana Reyes', area: 'Hilliard', service: 'service.thermostat.screen', from: '10:00', to: '12:00' }),
      ], '00:00', { date: '2026-09-16' });
      return { ...make(d, { time: '00:00' }), clock: { ...CLOCK_RUNNING, demoNow: atNext('00:00') }, newDay: true };
    }
    case 'omw': return withSheet('omw', true, dayOne);
    case 'omw-offline': return withSheet('omw', false, dayOne);
    case 'arrived': return withSheet('arrived', true, dayOne);
    case 'noh': return withSheet('noh', true, dayOne);
    case 'noh-offline': return withSheet('noh', false, dayOne);
  }
}
