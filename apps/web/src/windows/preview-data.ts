// SPDX-License-Identifier: AGPL-3.0-or-later
// The data the arrival windows frame shows (mockups/pages/admin-windows.html), for the preview routes (harness build only) and the model
// tests: Columbus on Tue, Sep 15 with its 5 windows, the 2 weeks Mon Sep 14 to Sun Sep 27 and the peak days Wed Sep 16 and Fri Sep 18
// switched by Dana Ruiz. Every value is one API-90 answers (contracts/windows.ts); never imported by a release route.
import type { Settings, SettingsDay } from './model.ts';

const Z = '[America/New_York]';
const id = (n: number) => `00000000-0000-7000-8000-00000000000${n}`;

/** [start, end, technicians, limit, booked today]: the frame's table rows. */
const ROWS: [string, string, number, number, number][] = [
  ['08:00', '10:00', 12, 12, 12], ['10:00', '12:00', 12, 12, 12], ['12:00', '14:00', 12, 11, 11], ['14:00', '16:00', 12, 11, 10], ['16:00', '18:00', 10, 10, 7],
];
const TWO = ROWS.map(([start, end]) => ({ start, end }));
const FOUR = [{ start: '08:00', end: '12:00' }, { start: '10:00', end: '14:00' }, { start: '12:00', end: '16:00' }, { start: '14:00', end: '18:00' }];
const SAT = TWO.slice(0, 2);

const two = (date: string, booked: number, capacity: number, windows = TWO): SettingsDay => ({
  date, mode: 'two_hour', booked, capacity, bookedCount: booked, windows, reason: null, switchedBy: null, switchedAt: null,
});
const four = (date: string, booked: number, capacity: number, bookedCount: number): SettingsDay => ({
  date, mode: 'four_hour', booked, capacity, bookedCount, windows: FOUR, reason: 'Heat advisory', switchedBy: 'Dana Ruiz', switchedAt: `2026-09-14T16:10:00-04:00${Z}`,
});
const closed = (date: string): SettingsDay => ({ date, mode: 'closed', booked: 0, capacity: 0, bookedCount: 0, windows: [], reason: null, switchedBy: null, switchedAt: null });

export const DAYS: SettingsDay[] = [
  two('2026-09-14', 53, 56), two('2026-09-15', 52, 56), four('2026-09-16', 62, 67, 14), two('2026-09-17', 37, 56), four('2026-09-18', 62, 66, 14),
  two('2026-09-19', 13, 15, SAT), closed('2026-09-20'),
  two('2026-09-21', 22, 56), two('2026-09-22', 31, 56), two('2026-09-23', 26, 56), two('2026-09-24', 9, 56), two('2026-09-25', 6, 56), two('2026-09-26', 2, 15, SAT), closed('2026-09-27'),
];

export const SETTINGS: Settings = {
  branch: 'columbus',
  today: '2026-09-15',
  windows: ROWS.map(([start, end, technicians, limit, bookedToday], i) => ({ windowId: id(i + 1), start, end, technicians, limit, bookedToday })),
  rules: { onlineCutoff: '17:00', reminder: '18:00', quietFrom: '21:00', quietTo: '08:00', capacities: { twoHour: 5, fourHour: 6, saturday: 3 } },
  twoHourWindows: TWO,
  fourHourWindows: FOUR,
  days: DAYS,
};

/** The frame's Switched and Day picked states draw Thu, Sep 17 as the picked day. */
export const THURSDAY_FOUR: Settings = {
  ...SETTINGS,
  days: DAYS.map((d) => (d.date === '2026-09-17' ? { ...four('2026-09-17', 37, 67, 9), switchedAt: `2026-09-15T10:33:00-04:00${Z}` } : d)),
};

export const WINDOWS_STATES = ['success', 'loading', 'changed', 'saving', 'refused', 'error', 'switched', 'day-picked', 'saturday', 'dlg-asking', 'dlg-switching', 'dlg-done'] as const;
