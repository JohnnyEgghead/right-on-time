// SPDX-License-Identifier: AGPL-3.0-or-later
// The rules of SPECIFICATIONS SD-30: for each type, the subjects whose condition holds right now. A rule reads state and
// answers the set; opening, resolving, the 1-open-per-type-and-subject limit and the notices are check.ts's. A subject
// whose condition holds is open; an open alert whose subject is no longer in the set is resolved ("Resolves when").
import type { Queryable } from '@bw/db';
import { ALERT_FACTS, BACKUP_STALE_HOURS, BILLING_RETRYING_LONG_MINUTES, BOARD_DELAY_GOAL_MS, BOARD_DELAY_WINDOW_MINUTES, type AlertType } from '@bw/domain';
import type { Instant } from '@bw/time';

export interface Wanted {
  subject: string;
  branchId: string | null;
  /** Ids and numbers only (NFR-05): the page renders the words. */
  values: Record<string, string | number>;
  link: string;
}

export interface RuleEnv {
  /** Demo now. */
  now: Instant;
  /** Real now for the backup and delay rules (the named uses backup_records and board_delay_window). */
  realBackup: Instant;
  realDelay: Instant;
  /** BACKUP_TARGET: the 26-hour rule is the hosted copy's only. */
  backupTarget: 'none' | 'lightsail';
}

export type Rule = (tx: Queryable, env: RuleEnv) => Promise<Wanted[]>;

const iso = (t: Instant): string => t.toString();

/**
 * The link of a text_gave_up alert, the one place both writers (the outbox at the 5th failure, the check below) take it from.
 * A text about a visit is on the call list, at its row's day. An office text about no visit has no call list row
 * (SPECIFICATIONS 753), so its alert opens the text log (SCR-OFC-08, F-1277) at the day the log lists it: the branch-zone
 * day the text was written (the log keys a day on created_at, F-1298), not the day it gave up, which quiet hours or a
 * late send can push to the next day.
 */
export function textGaveUpLink(jobNumber: number | null, day: { callDate: string; writtenDate: string }): string {
  return jobNumber === null ? `/office/messages?date=${day.writtenDate}` : `${ALERT_FACTS.text_gave_up.link}?date=${day.callDate}`;
}

/** The rules the alert checks own. world_reset and billing_reset_waiting are written by worldReset and the reset confirmer (section 3 writer table). */
export const RULES: Readonly<Partial<Record<AlertType, Rule>>> = {
  // A text that gave up (5th failure). The outbox opens it the moment it gives up; the check opens one the outbox missed
  // and resolves it when the call list entry has an outcome.
  async text_gave_up(tx, env) {
    const r = await tx.query<{ id: string; job_number: number | null; branch_id: string; date: string; written: string }>(
      `SELECT t.id, t.job_number, c.branch_id,
              coalesce(to_char(cl.call_date, 'YYYY-MM-DD'), to_char($1::timestamptz AT TIME ZONE b.zone, 'YYYY-MM-DD')) AS date,
              to_char(t.created_at AT TIME ZONE b.zone, 'YYYY-MM-DD') AS written
         FROM world.outbox_text t
         JOIN world.customer c ON c.id = t.customer_id
         JOIN world.branch b ON b.id = c.branch_id
         LEFT JOIN LATERAL (SELECT call_date, outcome FROM world.call_list_entry WHERE text_id = t.id ORDER BY added_at DESC LIMIT 1) cl ON true
        WHERE t.status = 'gave_up' AND cl.outcome IS NULL
          AND NOT EXISTS (SELECT 1 FROM world.alert d WHERE d.type = 'text_gave_up' AND d.subject = t.id::text AND d.state = 'resolved')
        ORDER BY t.id`,
      [iso(env.now)],
    );
    return r.rows.map((x) => ({
      subject: x.id, branchId: x.branch_id, link: textGaveUpLink(x.job_number, { callDate: x.date, writtenDate: x.written }),
      values: x.job_number === null ? { textId: x.id } : { textId: x.id, jobNumber: x.job_number },
    }));
  },

  async billing_waiting_person(tx) {
    const r = await tx.query<{ job_number: number; branch_id: string }>(
      `SELECT bi.job_number, j.branch_id FROM world.billing_item bi JOIN world.job j USING (job_number)
        WHERE bi.state = 'waiting_person' AND bi.left_at IS NULL ORDER BY bi.job_number`,
    );
    return r.rows.map((x) => ({ subject: String(x.job_number), branchId: x.branch_id, link: ALERT_FACTS.billing_waiting_person.link, values: { jobNumber: x.job_number } }));
  },

  // Retrying for 60 demo minutes: from the first try of the current send (a data error ends a send; Send again starts the next).
  async billing_retrying_long(tx, env) {
    const r = await tx.query<{ job_number: number; branch_id: string }>(
      `SELECT bi.job_number, j.branch_id FROM world.billing_item bi JOIN world.job j USING (job_number)
        WHERE bi.state = 'retrying' AND bi.left_at IS NULL
          AND (SELECT min(a.at) FROM world.billing_attempt a
                WHERE a.job_number = bi.job_number
                  AND a.number > coalesce((SELECT max(d.number) FROM world.billing_attempt d WHERE d.job_number = bi.job_number AND d.result = 'data_error'), 0))
              <= $1::timestamptz - make_interval(mins => $2)
        ORDER BY bi.job_number`,
      [iso(env.now), BILLING_RETRYING_LONG_MINUTES],
    );
    return r.rows.map((x) => ({ subject: String(x.job_number), branchId: x.branch_id, link: ALERT_FACTS.billing_retrying_long.link, values: { jobNumber: x.job_number } }));
  },

  async offline_conflict(tx) {
    const r = await tx.query<{ id: string; job_number: number; branch_id: string }>(
      `SELECT id, COALESCE(job_number, (message_values->>'job')::integer) AS job_number, branch_id FROM world.offline_conflict WHERE handled_at IS NULL ORDER BY id`,
    );
    return r.rows.map((x) => ({ subject: x.id, branchId: x.branch_id, link: ALERT_FACTS.offline_conflict.link, values: { conflictId: x.id, jobNumber: x.job_number } }));
  },

  // The last finished backup failed, or (the hosted copy only) none passed in the last 26 real hours.
  async backup_failed(tx, env) {
    const last = await tx.query<{ result: string }>(
      `SELECT result FROM system.backup_record WHERE kind = 'backup' AND result IS NOT NULL ORDER BY started_real DESC, id DESC LIMIT 1`,
    );
    const failed = last.rows[0]?.result === 'failed';
    let stale = false;
    if (env.backupTarget !== 'none') {
      const fresh = await tx.query(
        `SELECT 1 FROM system.backup_record WHERE kind = 'backup' AND result = 'passed' AND finished_real > $1::timestamptz - make_interval(hours => $2) LIMIT 1`,
        [iso(env.realBackup), BACKUP_STALE_HOURS],
      );
      stale = fresh.rows.length === 0;
    }
    return failed || stale
      ? [{ subject: 'backup', branchId: null, link: ALERT_FACTS.backup_failed.link, values: { reason: failed ? 'failed' : 'stale' } }]
      : [];
  },

  async restore_test_failed(tx) {
    const last = await tx.query<{ result: string }>(
      `SELECT result FROM system.backup_record WHERE kind = 'restore_test' AND result IS NOT NULL ORDER BY started_real DESC, id DESC LIMIT 1`,
    );
    return last.rows[0]?.result === 'failed' ? [{ subject: 'restore_test', branchId: null, link: ALERT_FACTS.restore_test_failed.link, values: {} }] : [];
  },

  // The typical (median) delay of the last 60 real minutes is over the 5 s goal.
  async board_delay_over_goal(tx, env) {
    const r = await tx.query<{ typical: number | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::float8 AS typical FROM system.delay_sample WHERE acked_real >= $1::timestamptz - make_interval(mins => $2)`,
      [iso(env.realDelay), BOARD_DELAY_WINDOW_MINUTES],
    );
    const typical = r.rows[0]?.typical ?? null;
    return typical !== null && typical > BOARD_DELAY_GOAL_MS
      ? [{ subject: 'board', branchId: null, link: ALERT_FACTS.board_delay_over_goal.link, values: { typicalMs: Math.round(typical) } }]
      : [];
  },
};

/** The types whose alerts the checks write once as Info (never open, never resolved). */
export const INFO_RULES: Readonly<Partial<Record<AlertType, (tx: Queryable, env: RuleEnv) => Promise<Wanted[]>>>> = {
  // A restore test that passed in the last 7 real days; one Info alert per record.
  async restore_test_passed(tx, env) {
    const r = await tx.query<{ id: string; minutes: number }>(
      `SELECT id, round(extract(epoch FROM finished_real - started_real) / 60)::int AS minutes FROM system.backup_record
        WHERE kind = 'restore_test' AND result = 'passed' AND finished_real >= $1::timestamptz - interval '7 days' ORDER BY started_real, id`,
      [iso(env.realBackup)],
    );
    return r.rows.map((x) => ({ subject: x.id, branchId: null, link: ALERT_FACTS.restore_test_passed.link, values: { minutes: x.minutes } }));
  },
};
