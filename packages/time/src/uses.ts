// SPDX-License-Identifier: AGPL-3.0-or-later
// The named real-time uses of SPECIFICATIONS section 11.3 (OI-7): the only reasons any code may read real time.
// The order and spelling are the table's; ci/gates/G-CI4/spec-uses.test.ts holds this list to the table itself.
export const REAL_TIME_USES = [
  'tech_waiting_banner',
  'backup_records',
  'session_idle',
  'session_lifetime',
  'access_cookie',
  'board_delay_window',
  'billing_timeout',
  'device_stamp',
  'offline_entry',
  'clock_anchor',
  'reset_cooldown',
  'idle_reset',
  'nightly_reset',
  'rate_limit',
  'health_heartbeat',
  'record_stamp',
  'log_stamp',
] as const;

export type RealTimeUse = (typeof REAL_TIME_USES)[number];

const USES: ReadonlySet<string> = new Set(REAL_TIME_USES);

export function isRealTimeUse(value: unknown): value is RealTimeUse {
  return typeof value === 'string' && USES.has(value);
}

/** Refuse a tag outside section 11.3 at run time too: a plain-JavaScript or cast caller gets no silent real time. */
export function assertRealTimeUse(value: unknown): asserts value is RealTimeUse {
  if (!isRealTimeUse(value)) {
    throw new TypeError(`realNow: ${JSON.stringify(value)} is not a real-time use of SPECIFICATIONS section 11.3`);
  }
}
