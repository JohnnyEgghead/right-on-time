// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixed data for the SCR-OFC-34 preview routes (harness build only): the week the frame draws (mockups/pages/office-board-week.html,
// its DAYS, LOAD, UNAS and TECHS), as API-132 answers it, so the look comparator reads the same numbers and words on both sides.
import type { WeekData } from './week-model.ts';

const DATES = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'];
const CAP = [5, 5, 6, 5, 6, 3];
const PEAK = [false, false, true, false, true, false];
type Load = number | 'i' | null;
const TECHS: { id: string; name: string; van: string; skill: string; load: Load[] }[] = [
  { id: 'bell', name: 'Marcus Bell', van: '21', skill: 'plumbing', load: [5, 5, 6, 4, 6, null] },
  { id: 'carter', name: 'Jamal Carter', van: '9', skill: 'plumbing', load: [4, 4, 5, 3, 5, 3] },
  { id: 'doyle', name: 'Kevin Doyle', van: '27', skill: 'plumbing', load: [5, 4, 5, 4, 6, null] },
  { id: 'hoffman', name: 'Greg Hoffman', van: '5', skill: 'plumbing', load: [5, 4, 6, 2, 6, 3] },
  { id: 'kowalski', name: 'Dave Kowalski', van: '7', skill: 'heating_cooling', load: [5, 5, 6, 4, 5, null] },
  { id: 'mitchell', name: 'Ryan Mitchell', van: '11', skill: 'heating_cooling', load: [4, 4, 5, 3, 6, 2] },
  { id: 'nguyen', name: 'Ashley Nguyen', van: '24', skill: 'heating_cooling', load: [5, 4, 5, 4, 6, null] },
  { id: 'ortega', name: 'Luis Ortega', van: '18', skill: 'heating_cooling', load: [5, 4, 6, 3, 5, 3] },
  { id: 'reinhart', name: 'Tom Reinhart', van: '3', skill: 'heating_cooling', load: [4, 4, 5, 2, 6, null] },
  { id: 'santos', name: 'Maria Santos', van: '12', skill: 'heating_cooling', load: [5, 5, 6, 4, 6, 2] },
  { id: 'schaefer', name: 'Brian Schaefer', van: '15', skill: 'heating_cooling', load: [5, 5, 6, 3, 5, null] },
  { id: 'yoder', name: 'Chris Yoder', van: '30', skill: 'install', load: ['i', 'i', 'i', 'i', null, null] },
];
const UNAS = [0, 3, 0, 0, 0, 0];
const ZONE = '[America/New_York]';

function build(): WeekData {
  const technicians = TECHS.map((t) => ({
    id: t.id, name: t.name, van: t.van, skills: [t.skill], primarySkill: t.skill, installer: t.skill === 'install',
    cells: t.load.map((n, i) => {
      const date = DATES[i]!;
      if (n === null) return { date, booked: 0, capacity: 0, installs: 0, state: 'day_off' as const };
      if (n === 'i') return { date, booked: 1, capacity: 1, installs: 1, state: 'full' as const };
      return { date, booked: n, capacity: CAP[i]!, installs: 0, state: n >= CAP[i]! ? ('full' as const) : ('has_room' as const) };
    }),
  }));
  const days = DATES.map((date, i) => {
    const cells = technicians.map((t) => t.cells[i]!);
    const booked = cells.reduce((n, c) => n + c.booked, 0) + UNAS[i]!;
    const capacity = cells.reduce((n, c) => n + c.capacity, 0);
    return {
      date, mode: PEAK[i] ? ('four_hour' as const) : ('two_hour' as const), booked, capacity, peak: PEAK[i]!,
      openOnline: Math.max(0, capacity - booked), span: i === 5 ? { start: '08:00', end: '12:00' } : null, unassigned: UNAS[i]!,
      reason: PEAK[i] ? 'Heat advisory' : null, switchedBy: PEAK[i] ? 'Dana Ruiz' : null,
      switchedAt: PEAK[i] ? `2026-09-14T16:10:00-04:00${ZONE}` : null,
    };
  });
  const at = (h: number) => `2026-09-15T${String(h).padStart(2, '0')}:00:00-04:00${ZONE}`;
  return {
    branch: 'columbus', week: DATES[0]!, today: '2026-09-15',
    fourHourWindows: [{ start: '08:00', end: '12:00' }, { start: '10:00', end: '14:00' }, { start: '12:00', end: '16:00' }, { start: '14:00', end: '18:00' }],
    days, technicians,
    unassigned: DATES.map((date, i) => ({ date, count: UNAS[i]! })),
    unassignedJobs: [
      { jobNumber: 24841, day: '2026-09-15', window: { start: at(12), end: at(14) }, customer: 'Pham', area: 'Gahanna', service: 'heating_or_ac_fix' },
      { jobNumber: 24842, day: '2026-09-15', window: { start: at(14), end: at(16) }, customer: 'Russo', area: 'Worthington', service: 'thermostat' },
      { jobNumber: 24843, day: '2026-09-15', window: { start: at(16), end: at(18) }, customer: 'Kline', area: 'Hilliard', service: 'plumbing_repair' },
    ],
  };
}

export const WEEK_FIXTURE: WeekData = build();

/** The Live frame: Ortega, Thu, Sep 17, went from 3 to 4 jobs. */
export const WEEK_LIVE_FIXTURE: WeekData = (() => {
  const w = build();
  const o = w.technicians.find((t) => t.id === 'ortega')!;
  o.cells[3] = { ...o.cells[3]!, booked: 4 };
  return w;
})();
export const WEEK_LIVE_CHANGED: readonly string[] = ['ortega|2026-09-17'];

export const WEEK_EMPTY_FIXTURE: WeekData = { ...build(), branch: 'springfield', technicians: [], unassigned: [], unassignedJobs: [], days: build().days.map((d) => ({ ...d, booked: 0, capacity: 0, unassigned: 0 })) };
