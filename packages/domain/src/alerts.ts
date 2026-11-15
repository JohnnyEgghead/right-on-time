// SPDX-License-Identifier: AGPL-3.0-or-later
// The alert types of SPECIFICATIONS SD-30: each type's default switches and link target. Pure data; the rules that open
// and resolve them are the worker's (apps/worker/src/alerts), the switches' rows are world.alert_setting (1 per type).

export const ALERT_TYPES = [
  'text_gave_up',
  'billing_waiting_person',
  'billing_retrying_long',
  'offline_conflict',
  'backup_failed',
  'restore_test_failed',
  'board_delay_over_goal',
  'restore_test_passed',
  'world_reset',
  'billing_reset_waiting',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_STATES = ['open', 'resolved', 'info'] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export interface AlertTypeFacts {
  /** Where the alert links to (SD-30 "Links to"). */
  link: string;
  /** The notification bell's default switch. */
  bell: boolean;
  /** The managers' on-screen email default switch. */
  managersEmail: boolean;
  /** A type whose alerts are written once as Info and never resolve. */
  info: boolean;
}

export const ALERT_FACTS: Readonly<Record<AlertType, AlertTypeFacts>> = {
  text_gave_up: { link: '/office/messages/call-list', bell: true, managersEmail: false, info: false },
  billing_waiting_person: { link: '/office/billing', bell: true, managersEmail: false, info: false },
  billing_retrying_long: { link: '/office/billing', bell: true, managersEmail: false, info: false },
  offline_conflict: { link: '/office/board?tab=needs-attention', bell: true, managersEmail: false, info: false },
  backup_failed: { link: '/office/admin/health', bell: true, managersEmail: true, info: false },
  restore_test_failed: { link: '/office/admin/health', bell: true, managersEmail: true, info: false },
  board_delay_over_goal: { link: '/office/admin/health', bell: true, managersEmail: false, info: false },
  restore_test_passed: { link: '/office/admin/health', bell: false, managersEmail: false, info: true },
  world_reset: { link: '/office/admin/clock', bell: false, managersEmail: false, info: true },
  billing_reset_waiting: { link: '/office/admin/health', bell: true, managersEmail: false, info: false },
};

/**
 * The world.alert_setting rows the seed writes (section 3 writer table: 1 per SD-30 type, with SD-30's default switches;
 * set_by and set_at null until API-161 changes one). The alert checks read these rows and never write them (F-444).
 */
export function alertSettingDefaults(): { type: AlertType; bell: boolean; managersEmail: boolean }[] {
  return ALERT_TYPES.map((type) => ({ type, bell: ALERT_FACTS[type].bell, managersEmail: ALERT_FACTS[type].managersEmail }));
}

/** SD-30: a billing item that has retried this many demo minutes opens billing_retrying_long. */
export const BILLING_RETRYING_LONG_MINUTES = 60;
/** SD-30: no backup finished in this many real hours opens backup_failed (hosted copy only). */
export const BACKUP_STALE_HOURS = 26;
/** SD-30: the typical board delay of the last 60 real minutes over this many ms opens board_delay_over_goal. */
export const BOARD_DELAY_GOAL_MS = 5_000;
export const BOARD_DELAY_WINDOW_MINUTES = 60;
/** SD-30: the alert checks run every 5 demo minutes. */
export const ALERT_CHECK_EVERY_MINUTES = 5;
