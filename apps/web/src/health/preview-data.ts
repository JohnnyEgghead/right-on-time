// SPDX-License-Identifier: AGPL-3.0-or-later
// The sample data of the System health frame (mockups/pages/admin-health.html) and the office alerts panel (office-board), for the harness
// build's preview routes and the look comparator. Never read by a release route. Times are the frame's: Tue, Sep 15, 10:28 AM EDT.
import type { BellAlert } from '../shell/AlertsPanel.tsx';
import type { Health } from './model.ts';

const Z = '[America/New_York]';
const at = (day: number, hhmm: string) => `2026-09-${String(day).padStart(2, '0')}T${hhmm}:00-04:00${Z}`;

const POINTS = [1.2, 1.3, 1.1, 1.4, 1.2, 1.3, 1.5, 1.2, 1.1, 1.3, 1.4, 1.2, 1.6, 1.3, 1.2, 1.1, 1.3, 1.4, 2.1, 2.9, 1.8, 1.4, 1.3, 1.2, 1.3, 1.1, 1.2, 1.4, 1.3, 1.2, 1.5, 1.3, 1.2, 1.1, 1.2, 1.3, 1.4, 1.2, 1.3, 1.6, 1.4, 1.2, 1.3, 1.1, 1.2, 1.3, 1.5, 1.4, 1.2, 1.3, 1.2, 1.1, 1.3, 1.4, 1.2, 1.3, 1.2, 1.4, 1.3, 1.3];

/** 60 one-minute samples ending at 10:28 AM, the frame's sparkline. */
const SAMPLES = POINTS.map((s, i) => {
  const minute = 28 - (POINTS.length - 1 - i);
  const hh = minute < 0 ? 9 : 10;
  const mm = minute < 0 ? minute + 60 : minute;
  return { at: at(15, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`), ms: Math.round(s * 1000) };
});

export const HEALTH_ALERTS: Health['alerts'] = [
  {
    id: 'a-1', at: at(15, '10:27'), type: 'text_gave_up', state: 'open', messageKey: 'alert.text_gave_up',
    messageValues: { textId: 't-1', customer: 'Linh Pham', kind: 'confirmation', jobNumber: 24811 }, link: '/office/messages/call-list?date=2026-09-15',
    emailed: true, emailWaiting: true, emailOpened: false, dismissible: false,
  },
  {
    id: 'a-2', at: at(15, '09:05'), type: 'billing_retrying_long', state: 'open', messageKey: 'alert.billing_retrying_long', messageValues: { jobNumber: 24790 },
    link: '/office/billing', emailed: true, emailWaiting: true, emailOpened: false, dismissible: false,
  },
  {
    id: 'a-3', at: at(13, '03:23'), type: 'restore_test_passed', state: 'info', messageKey: 'alert.restore_test_passed', messageValues: { minutes: 23 },
    link: '/office/admin/health', emailed: false, emailWaiting: false, emailOpened: false, dismissible: false,
  },
  {
    id: 'a-4', at: at(15, '07:00'), type: 'world_reset', state: 'info', messageKey: 'alert.world_reset', messageValues: {},
    link: '/office/admin/clock', emailed: false, emailWaiting: false, emailOpened: false, dismissible: false,
  },
];

/** The frame's Alert settings table shows 4 rows: three with both switches on and the last with the email switch off. */
const SWITCH_TYPES = [['text_gave_up', true, true], ['billing_waiting_person', true, true], ['backup_failed', true, true], ['board_delay_over_goal', true, false]] as const;

export const HEALTH_SUCCESS: Health = {
  branch: 'columbus',
  asOf: at(15, '10:28'),
  lastCheck: at(15, '10:28'),
  overall: { working: true, needsOffice: 2 },
  backupSetUp: true,
  backup: { result: 'passed', at: at(15, '02:00'), finishedAt: at(15, '02:07'), sizeBytes: 2_400_000_000, nightsKept: 30, copiesAt: "Brightwater's server and in a US data center", nextAt: at(16, '02:00') },
  backups: [9, 10, 11, 12, 13, 14, 15].map((d) => ({ night: `2026-09-${String(d).padStart(2, '0')}`, result: 'passed' as const })),
  restoreTests: [
    { at: at(13, '03:00'), finishedAt: at(13, '03:23'), minutes: 23, result: 'passed', first: false },
    { at: at(6, '03:00'), finishedAt: at(6, '03:21'), minutes: 21, result: 'passed', first: false },
    { at: at(2, '03:00'), finishedAt: at(2, '03:24'), minutes: 24, result: 'passed', first: true },
  ],
  restoreNextAt: at(20, '03:00'),
  locations: { app: "Brightwater's server, Columbus", backups: 'US data center, Ohio', texts: 'US region only', maps: 'Van positions only' },
  delay: { samples: SAMPLES, typicalMs: 1300, slowestMs: 2900, goalMs: 5000 },
  alerts: HEALTH_ALERTS,
  alertSettings: SWITCH_TYPES.map(([type, bell, managersEmail]) => ({ type, bell, managersEmail })),
  textSimulator: { mode: 'up', customerId: null, customerName: null, nLeft: null, setBy: null, setAt: null },
  outbox: {
    today: 96, delivered: 93, held: 1, retrying: 1, notSentToday: 0, callList: 9,
    retryingTexts: [{ textId: 't-1', customer: 'Linh Pham', kind: 'confirmation', status: 'retrying', tries: 2, nextTryAt: at(15, '10:31') }],
    heldTexts: [{ textId: 't-2', customer: 'Deborah Lin', kind: 'confirmation', heldUntil: '2026-09-15T08:00:00-07:00[America/Los_Angeles]', heldUntilBranch: at(15, '11:00') }],
  },
  billing: {
    mode: 'up', waiting: 1, finishedToday: 9, inBillingToday: 8, lastSentAt: at(15, '10:21'),
    listed: [{ jobNumber: 24790, customer: 'Hartley', service: 'plumbing_repair', reasonKind: 'data_error', reason: 'Billing refused part code DC-114.' }],
  },
};

export const HEALTH_NO_BACKUP: Health = { ...HEALTH_SUCCESS, backupSetUp: false, backup: null, backups: [], restoreTests: [], restoreNextAt: null };

export const BELL_ALERTS: BellAlert[] = [
  {
    id: 'b-1', at: at(15, '10:27'), type: 'text_gave_up', state: 'open', messageKey: 'alert.text_gave_up',
    messageValues: { textId: 't-1', customer: 'Linh Pham', kind: 'confirmation', jobNumber: 24811 }, link: '/office/messages/call-list?date=2026-09-15',
    emailed: true, emailWaiting: true, emailOpened: false, dismissible: false,
  },
  {
    id: 'b-2', at: at(15, '09:05'), type: 'billing_waiting_person', state: 'open', messageKey: 'alert.billing_waiting_person', messageValues: { jobNumber: 24790 },
    link: '/office/billing', emailed: true, emailWaiting: true, emailOpened: false, dismissible: false,
  },
];
export const BELL_NEW: BellAlert = {
  id: 'b-3', at: at(15, '10:30'), type: 'billing_waiting_person', state: 'open', messageKey: 'alert.billing_waiting_person', messageValues: { jobNumber: 24800 },
  link: '/office/billing', emailed: true, emailWaiting: true, emailOpened: false, dismissible: false,
};

/** DK-102 / DK-85 "Dismissed" and "Control details: Dismiss" (owner ruling 9f7f745a): the 1 alert that offers Dismiss, an office text to Rosa Castillo that was not sent. */
export const DISMISS_ALERT: BellAlert = {
  id: 'd-1', at: at(15, '10:12'), type: 'text_gave_up', state: 'open', messageKey: 'alert.text_gave_up',
  messageValues: { textId: 't-9', customer: 'Rosa Castillo', kind: 'office' }, link: '/office/messages?date=2026-09-15',
  emailed: false, emailWaiting: false, emailOpened: false, dismissible: true,
};
export const DISMISSED_ALERT: BellAlert = { ...DISMISS_ALERT, state: 'resolved', dismissible: false };

export const HEALTH_STATES = [
  'dismiss', 'dismissed', 'success', 'loading', 'no-backup', 'checking', 'applying', 'applied', 'email-opened', 'new-alert', 'error', 'n-field', 'table',
] as const;
export const ALERT_STATES = ['loading', 'empty', 'success', 'new', 'dismiss', 'dismissed'] as const;
