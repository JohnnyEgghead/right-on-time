// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixed data of the customer screens' preview routes (harness build only): the sample data the frames show (DK-90 and DK-91), so the
// look comparator reads the same text and the same state on both sides. Never imported by a release route.
import type { CustomerForm } from './model.ts';
import type { CustomerPage, Detail } from './types.ts';

const SEAN = '0192f000-0000-7000-8000-0000000000a1';
const KATHLEEN = '0192f000-0000-7000-8000-0000000000a2';
const HAROLD = '0192f000-0000-7000-8000-0000000000a3';
const Z = '[America/New_York]';

export const RESULTS: CustomerPage = {
  total: 2,
  next: null,
  cities: ['Clintonville', 'Upper Arlington', 'Westerville'],
  customers: [
    {
      id: SEAN, name: "Sean O'Brien", area: 'Clintonville', address: { houseNumber: 2291, street: 'Calumet St', city: 'Clintonville', zip: '43202' },
      mobile: '+16145550163', textsOn: true, language: 'en', plan: 'comfort_club', customerSince: '2017-04-02',
      lastVisit: { date: '2026-03-03', service: 'Furnace repair', serviceId: null },
      nextVisit: { jobNumber: 24866, day: '2026-09-17', window: { start: `2026-09-17T10:00:00-04:00${Z}`, end: `2026-09-17T12:00:00-04:00${Z}` }, serviceId: 'furnace_tune_up', status: 'scheduled', technician: 'Ryan Mitchell' },
    },
    {
      id: KATHLEEN, name: "Kathleen O'Brien-Miller", area: 'Upper Arlington', address: { houseNumber: 57, street: 'Kenwick Rd', city: 'Upper Arlington', zip: '43221' },
      mobile: '+16145550187', textsOn: true, language: 'en', plan: null, customerSince: '2021-06-14',
      lastVisit: { date: '2026-07-22', service: 'AC not cooling', serviceId: null }, nextVisit: null,
    },
  ],
};

export const SEAN_DETAIL: Detail = {
  id: SEAN, name: "Sean O'Brien", branch: 'columbus', area: 'Clintonville',
  contact: { mobile: '+16145550163', homePhone: null, email: null, textsOn: true },
  language: 'en', zone: 'America/New_York',
  address: { streetId: '0192f000-0000-7000-8000-0000000000b1', houseNumber: 2291, street: 'Calumet St', city: 'Clintonville', zip: '43202', homeType: null, gettingIn: null },
  position: { lon: -83.0, lat: 40.05 }, source: 'import', importedAt: `2026-08-31T12:00:00-04:00${Z}`, customerSince: '2017-04-02',
  membership: { since: '2019-03-01', renews: '2027-03-01', benefitsKey: 'comfort_club' },
  notes: [{ id: '0192f000-0000-7000-8000-0000000000c1', authorKind: 'office', author: 'Marco Perez', at: `2026-03-02T09:00:00-05:00[America/New_York]`, text: 'Dog in the back yard; call before going to the outdoor unit.' }],
  equipment: [
    { id: '0192f000-0000-7000-8000-0000000000d1', type: 'furnace', year: 2011, location: null, details: null },
    { id: '0192f000-0000-7000-8000-0000000000d2', type: 'air_conditioner', year: 2011, location: null, details: null },
  ],
  upcoming: [{
    jobNumber: 24866, day: '2026-09-17', window: { start: `2026-09-17T10:00:00-04:00${Z}`, end: `2026-09-17T12:00:00-04:00${Z}` }, serviceId: 'furnace_tune_up', status: 'scheduled',
    timing: null, eta: null, technician: { name: 'Ryan Mitchell', initials: 'RM', van: '7', skill: 'heating_cooling' },
  }],
  history: [
    { date: '2026-03-03', service: 'Furnace repair', serviceId: null, technician: 'Maria Santos', old: true, jobNumber: null, workDone: [] },
    { date: '2025-09-29', service: 'Furnace tune-up', serviceId: 'furnace_tune_up', technician: 'Maria Santos', old: true, jobNumber: null, workDone: [] },
    { date: '2025-05-12', service: 'AC tune-up', serviceId: 'ac_tune_up', technician: 'Brian Schaefer', old: true, jobNumber: null, workDone: [] },
  ],
  recentTexts: [],
};

export const HAROLD_DETAIL: Detail = {
  id: HAROLD, name: 'Harold Jenkins', branch: 'columbus', area: 'Westerville',
  contact: { mobile: '+16145550148', homePhone: '+16145550122', email: null, textsOn: true },
  language: 'en', zone: 'America/New_York',
  address: { streetId: '0192f000-0000-7000-8000-0000000000b2', houseNumber: 418, street: 'Maple Hollow Ct', city: 'Westerville', zip: '43081', homeType: 'Single family, basement', gettingIn: 'Side door. Knock firmly.' },
  position: { lon: -82.93, lat: 40.12 }, source: 'import', importedAt: `2026-08-31T12:00:00-04:00${Z}`, customerSince: '2014-10-02',
  membership: { since: '2019-03-01', renews: '2027-03-01', benefitsKey: 'comfort_club' },
  notes: [
    { id: '0192f000-0000-7000-8000-0000000000c2', authorKind: 'office', author: 'Keisha Thompson', at: `2026-09-10T09:00:00-04:00${Z}`, text: 'Use the side door. Knock firmly.' },
    { id: '0192f000-0000-7000-8000-0000000000c3', authorKind: 'technician', author: 'Maria Santos', at: `2025-10-14T09:00:00-04:00${Z}`, text: 'Bring a 16x25x4 filter. Flame sensor was dirty last year; check it again.' },
  ],
  equipment: [
    { id: '0192f000-0000-7000-8000-0000000000e1', type: 'furnace', year: 2014, location: 'basement', details: '80,000 BTU, 96% efficient' },
    { id: '0192f000-0000-7000-8000-0000000000e2', type: 'air_conditioner', year: 2014, location: null, details: '2.5 ton, outdoor unit on the east side' },
    { id: '0192f000-0000-7000-8000-0000000000e3', type: 'water_heater', year: 2016, location: 'basement', details: '50 gallon' },
    { id: '0192f000-0000-7000-8000-0000000000e4', type: 'thermostat', year: 2019, location: 'first floor', details: 'Programmable' },
  ],
  upcoming: [{
    jobNumber: 24830, day: '2026-09-15', window: { start: `2026-09-15T10:00:00-04:00${Z}`, end: `2026-09-15T12:00:00-04:00${Z}` }, serviceId: 'furnace_tune_up', status: 'on_the_way',
    timing: null, eta: `2026-09-15T10:40:00-04:00${Z}`, technician: { name: 'Maria Santos', initials: 'MS', van: '12', skill: 'heating_cooling' },
  }],
  history: [
    ['2025-10-14', 'Maria Santos'], ['2025-06-09', 'Brian Schaefer'], ['2024-01-22', 'Tom Reinhart'], ['2023-10-03', 'Tom Reinhart'],
    ['2023-05-18', 'Ashley Nguyen'], ['2022-11-07', 'Kevin Doyle'], ['2021-08-02', 'Luis Ortega'], ['2020-10-12', null],
  ].map(([date, technician]) => ({ date: date as string, service: 'Furnace tune-up', serviceId: 'furnace_tune_up', technician: technician as string | null, old: true, jobNumber: null, workDone: [] })),
  recentTexts: [
    { at: `2026-09-15T10:28:00-04:00${Z}`, kind: 'on_the_way', direction: 'out', status: 'delivered' },
    { at: `2026-09-14T18:00:00-04:00${Z}`, kind: 'reminder', direction: 'out', status: 'delivered' },
    { at: `2026-09-10T19:42:00-04:00${Z}`, kind: 'confirmation', direction: 'out', status: 'delivered' },
  ],
};

export const NEW_FORM: CustomerForm = {
  name: 'Lucia Moreno', mobile: '(614) 555-0172',
  street: { streetId: '0192f000-0000-7000-8000-0000000000b3', name: 'Calumet St', city: 'Clintonville', zip: '43202', branch: 'columbus' },
  streetText: 'Calumet St, Clintonville, 43202', houseNumber: '2310', textLanguage: 'es', textsOn: true,
};
export const NO_MATCH_FORM: CustomerForm = { ...NEW_FORM, street: null, streetText: 'Calumett Ave', houseNumber: '' };

export const EDIT_FORM: CustomerForm = {
  name: 'Harold Jenkins', mobile: '(614) 555-0148',
  street: { streetId: HAROLD, name: 'Maple Hollow Ct', city: 'Westerville', zip: '43081', branch: 'columbus' },
  streetText: 'Maple Hollow Ct, Westerville, 43081', houseNumber: '418', textLanguage: 'en', textsOn: true,
};
