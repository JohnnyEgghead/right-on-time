// SPDX-License-Identifier: AGPL-3.0-or-later
// Harness build only (imported by the preview routes, never by the release route): the frame's own Columbus day (mockups/pages/office-technicians.html,
// DK-92), the 12 technicians with their load, chip and phone app as the frame draws them, shaped as API-31 answers them. A preview state is this data
// and a fixed panel state; the frame's skills ("Drains", "Mini-splits") are not the seed's 3, so the previews say them in the frame's own words.
import { wireAt } from '../board/preview-fixtures.ts';
import type { SkillWords, TechData, TechRow, TechSkill } from './model.ts';

const at = (hour: number) => wireAt(hour);
const skill = (...s: string[]) => s as TechSkill[];

const FRAME_SKILLS = {
  heating_cooling: ['Heating & cooling', 'Calefacción y aire'], heat_pumps: ['Heat pumps', 'Bombas de calor'], furnaces: ['Furnaces', 'Calefactores'],
  boilers: ['Boilers', 'Calderas'], plumbing: ['Plumbing', 'Plomería'], drains: ['Drains', 'Desagües'], water_heaters: ['Water heaters', 'Calentadores de agua'],
  gas_lines: ['Gas lines', 'Líneas de gas'], tankless: ['Tankless', 'Sin tanque'], thermostats: ['Thermostats', 'Termostatos'], mini_splits: ['Mini-splits', 'Minisplits'],
  humidifiers: ['Humidifiers', 'Humidificadores'], installs: ['Installs', 'Instalaciones'], central_ac: ['Central AC', 'Aire central'],
} as const;
export const SKILL_WORDS: SkillWords = {
  en: Object.fromEntries(Object.entries(FRAME_SKILLS).map(([k, v]) => [k, v[0]])),
  es: Object.fromEntries(Object.entries(FRAME_SKILLS).map(([k, v]) => [k, v[1]])),
};
/** The panel's Skills control lists the branch's skills: the frame draws these 5 for Maria Santos. */
const PANEL_SKILLS = skill('heating_cooling', 'heat_pumps', 'furnaces', 'boilers', 'plumbing');

const VANS = [21, 9, 27, 5, 7, 11, 24, 18, 3, 12, 15, 30].map((n) => ({ id: `0192f000-0000-7000-8000-0000000a${String(n).padStart(4, '0')}`, number: String(n), vehicle: `Van ${n}` }));
const vanOf = (n: number) => VANS.find((v) => v.number === String(n)) as (typeof VANS)[number];
const uid = (i: number) => `0192f000-0000-7000-8000-0000000b${String(i).padStart(4, '0')}`;

type Status = 'on_site' | 'on_the_way';
interface Plant {
  name: string; van: number; skills: string[]; saturdays: TechRow['saturdays']; n: number; cap?: number; status: Status; phone: string;
  sync: number; app?: 'web' | 'native'; waiting?: number; invited?: boolean; hours?: [string, string]; days?: number[];
}
const PLANTS: Plant[] = [
  { name: 'Marcus Bell', van: 21, skills: ['plumbing', 'drains', 'water_heaters'], saturdays: 'none', n: 5, status: 'on_site', phone: '0121', sync: 10 + 27 / 60 },
  { name: 'Jamal Carter', van: 9, skills: ['plumbing', 'water_heaters', 'gas_lines'], saturdays: 'even_weeks', n: 4, status: 'on_site', phone: '0109', sync: 10 + 25 / 60 },
  { name: 'Kevin Doyle', van: 27, skills: ['water_heaters', 'tankless', 'plumbing'], saturdays: 'none', n: 4, status: 'on_site', phone: '0127', sync: 10 + 19 / 60, waiting: 2 },
  { name: 'Greg Hoffman', van: 5, skills: ['plumbing', 'drains', 'water_heaters'], saturdays: 'even_weeks', n: 4, status: 'on_site', phone: '0105', sync: 10 + 26 / 60 },
  { name: 'Dave Kowalski', van: 7, skills: ['heating_cooling', 'thermostats'], saturdays: 'none', n: 5, status: 'on_the_way', phone: '0107', sync: 10 + 27 / 60 },
  { name: 'Ryan Mitchell', van: 11, skills: ['heating_cooling', 'heat_pumps'], saturdays: 'even_weeks', n: 4, status: 'on_site', phone: '0111', sync: 10 + 24 / 60 },
  { name: 'Ashley Nguyen', van: 24, skills: ['heating_cooling', 'mini_splits'], saturdays: 'none', n: 4, status: 'on_site', phone: '0124', sync: 10 + 26 / 60 },
  { name: 'Luis Ortega', van: 18, skills: ['heating_cooling', 'furnaces'], saturdays: 'even_weeks', n: 4, status: 'on_site', phone: '0118', sync: 10 + 22 / 60 },
  { name: 'Tom Reinhart', van: 3, skills: ['heating_cooling', 'boilers'], saturdays: 'none', n: 4, status: 'on_the_way', phone: '0103', sync: 10 + 27 / 60 },
  { name: 'Maria Santos', van: 12, skills: ['heating_cooling', 'heat_pumps', 'furnaces', 'boilers', 'plumbing'], saturdays: 'even_weeks', n: 5, status: 'on_the_way', phone: '0112', sync: 10 + 28 / 60, app: 'native' },
  { name: 'Brian Schaefer', van: 15, skills: ['heating_cooling', 'humidifiers'], saturdays: 'none', n: 5, status: 'on_site', phone: '0115', sync: 10 + 26 / 60 },
  { name: 'Chris Yoder', van: 30, skills: ['installs', 'furnaces', 'central_ac'], saturdays: 'none', n: 1, cap: 1, status: 'on_site', phone: '0130', sync: 0, invited: true, hours: ['07:30', '18:00'], days: [1, 2, 3, 4] },
];

const row = (p: Plant, i: number): TechRow => {
  const report = p.invited ? null : { lastSyncAt: at(p.sync), waitingCount: p.waiting ?? 0, device: p.app === 'native' ? 'iPhone 15' : 'Safari on iPhone', version: '1.0.1', reportedAt: at(p.sync) };
  const maria = p.name === 'Maria Santos';
  return {
    id: uid(i + 1), name: p.name, phone: `(614) 555-${p.phone}`, branch: 'columbus', van: vanOf(p.van),
    skills: p.skills as TechSkill[],
    workingHours: { start: p.hours?.[0] ?? '08:00', end: p.hours?.[1] ?? '17:30' }, workingDays: p.days ?? [1, 2, 3, 4, 5], saturdays: p.saturdays,
    todayLoad: p.n, capacity: p.cap ?? 5, workingToday: true, nameInTexts: p.name.split(' ')[0] as string, since: maria ? 2016 : 2012 + (i % 8),
    employeeNumber: maria ? '40712' : String(40701 + i),
    rightNow: { status: p.status, timing: null, jobNumber: 24800 + i, customerName: maria ? 'Harold Jenkins' : `Customer ${i + 1}` },
    timeOff: maria ? [{ id: '0192f000-0000-7000-8000-0000000c0001', from: '2026-10-01', to: '2026-10-02', note: 'Training' }] : [],
    userStatus: p.invited ? 'invited' : 'active',
    apps: { web: p.app === 'native' || !report ? null : report, native: p.app === 'native' ? report : null },
  };
};

export const TECH_SUCCESS: TechData = {
  branch: 'columbus', zone: 'America/New_York', today: '2026-09-15', readAt: at(10 + 28 / 60),
  technicians: PLANTS.map(row), vans: VANS, skills: PANEL_SKILLS, saturdayHours: { start: '08:00', end: '12:00' },
};

export const TECH_EMPTY: TechData = { ...TECH_SUCCESS, branch: 'springfield', technicians: [], vans: [] };

export const MARIA = TECH_SUCCESS.technicians.find((r) => r.name === 'Maria Santos') as TechRow;
export const DOYLE = TECH_SUCCESS.technicians.find((r) => r.name === 'Kevin Doyle') as TechRow;

/** Maria Santos with the frame's Saved-state time off: Mon, Sep 21 (Dentist) and Thu, Oct 1 to Fri, Oct 2 (Training). */
export const TECH_TIMEOFF_SAVED: TechData = {
  ...TECH_SUCCESS,
  technicians: TECH_SUCCESS.technicians.map((r) => (r.id === MARIA.id ? { ...r, timeOff: [{ id: '0192f000-0000-7000-8000-0000000c0002', from: '2026-09-21', to: '2026-09-21', note: 'Dentist' }, ...r.timeOff] } : r)),
};
export const TECH_TIMEOFF_REMOVED: TechData = {
  ...TECH_SUCCESS,
  technicians: TECH_SUCCESS.technicians.map((r) => (r.id === MARIA.id ? { ...r, timeOff: [] } : r)),
};

export const TECH_PREVIEW_STATES = [
  'success', 'loading', 'error', 'empty', 'no-match', 'checking', 'problem', 'saved', 'time-off-removed', 'time-off-saved', 'app-offline', 'hours-editing', 'hours-problem',
  'add-editing', 'add-hours', 'add-saving', 'add-added', 'add-used', 'timeoff-editing', 'timeoff-saving',
] as const;
export type TechPreviewState = (typeof TECH_PREVIEW_STATES)[number];
