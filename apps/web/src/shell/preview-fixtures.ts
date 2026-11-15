// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixed states for the shell preview routes (harness build only, *.preview.tsx): the sample data the kit frames show,
// so the look comparator reads the same text and the same state on both sides. Never imported by a release route.
import type { ClockAnswer } from './clock.ts';
import type { AppInfo } from './Footer.tsx';
import type { Me, SearchAnswer } from './OfficeTopBar.tsx';

const ZONE = '[America/New_York]';

export const CLOCK_RUNNING: ClockAnswer = { demoNow: `2026-09-15T10:28:00-04:00${ZONE}`, rate: 1, paused: false, worldEpoch: 1, lastMove: null, replay: null };
export const CLOCK_PAUSED: ClockAnswer = { ...CLOCK_RUNNING, paused: true };
export const CLOCK_MOVED: ClockAnswer = {
  ...CLOCK_RUNNING,
  demoNow: `2026-09-15T18:05:00-04:00${ZONE}`,
  lastMove: { by: 'Dana Ruiz', kind: 'jump', toDemo: `2026-09-15T18:05:00-04:00${ZONE}` },
};
export const CLOCK_CATCHING_UP: ClockAnswer = { ...CLOCK_MOVED, lastMove: null, replay: { running: true, done: 120, total: 340 } };
export const CLOCK_AFTER_RESET: ClockAnswer = { ...CLOCK_RUNNING, demoNow: `2026-09-15T07:00:00-04:00${ZONE}`, worldEpoch: 2 };
export const RESET_TO = `2026-09-15T07:00:00-04:00${ZONE}`;

export const APP_INFO: AppInfo = { demoMode: true, accessCodeOn: false, sourceUrl: 'https://github.com/JohnnyEgghead/right-on-time', sourceCommit: '4f1c2ab' };

const OFFICE_SCREENS = ['SCR-OFC-02', 'SCR-OFC-03', 'SCR-OFC-04', 'SCR-OFC-05', 'SCR-OFC-06', 'SCR-OFC-07', 'SCR-OFC-08', 'SCR-OFC-09', 'SCR-OFC-10', 'SCR-OFC-12', 'SCR-OFC-13', 'SCR-OFC-14', 'SCR-OFC-15', 'SCR-OFC-30', 'SCR-OFC-34'];
const MANAGER_SCREENS = [...OFFICE_SCREENS, 'SCR-OFC-11', 'SCR-OFC-16', 'SCR-OFC-17', 'SCR-OFC-43'];

export const MANAGER: Me = { name: 'Dana Ruiz', role: 'manager', branch: 'columbus', slashShortcut: 'on', permissions: MANAGER_SCREENS };
export const OFFICE: Me = { name: 'Keisha Turner', role: 'office', branch: 'columbus', slashShortcut: 'on', permissions: OFFICE_SCREENS };

export const CALL = { name: 'Maria', fullName: 'Maria Santos', number: '(614) 555-0112' };
export const TOAST_MOVED = { name: 'Luis Ortega', time: '11:35 AM' };
/** The CMP-07 Search results tile (office-board): "jenk" typed, 1 job, 1 customer, 1 address. */
export const SEARCH_JENK: { query: string; answer: SearchAnswer } = {
  query: 'jenk',
  answer: {
    jobs: [{ jobNumber: 24830, customer: 'Harold Jenkins' }],
    customers: [{ id: 'c-jenkins', name: 'Harold Jenkins' }],
    addresses: [{ customerId: 'c-jenkins-ave', address: '412 Jenkins Ave, Grove City' }],
  },
};
