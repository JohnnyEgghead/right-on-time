// SPDX-License-Identifier: AGPL-3.0-or-later
// The alert checks (SPECIFICATIONS SD-30, FR-HLTH-4): run every rule once inside the caller's transaction (the worker's
// alert.check event every 5 demo minutes, and API-160 Check now). For each rule type: open 1 alert for each subject whose
// condition holds and has none open (the partial unique index alert_one_open_per_type_subject is the backstop), and
// resolve each open alert whose condition cleared. The bell and email switches act at creation: an alert is always
// written and listed; with the type's managers' email switch on, each active manager gets 1 alert email in the
// on-screen store with 1 one-time link, shown to that manager on the alert (FR-AUTH-8 note, alert_email_link).
import { alertEventIds, EMAIL_LINK_HOURS, hashToken, newToken, publishEvent, sendEmail, type Queryable } from '@bw/db';
import { ALERT_FACTS, ALERT_TYPES, type AlertType } from '@bw/domain';
import type { Clock, Instant } from '@bw/time';
import { alertEmailWords, type CopyLanguage } from './copy.ts';
import { INFO_RULES, RULES, type RuleEnv, type Wanted } from './rules.ts';

export interface CheckReport {
  opened: string[];
  resolved: string[];
  info: string[];
  emailed: number;
  /** The alert types whose rule threw: each ran in its own savepoint, was rolled back alone, and the other rules ran (F-449). */
  failed: string[];
  /** Why each failed rule threw (F-498): the database error code, constraint and error name; never the message, which can hold record text. */
  causes: RuleFailure[];
}

export interface RuleFailure {
  type: AlertType;
  /** A PostgreSQL error code such as 23505, else the error's class name. */
  code: string;
  constraint: string | null;
}

/** The safe description of a thrown error: the code and constraint a log line and the result line may carry. */
export function failureOf(type: AlertType, e: unknown): RuleFailure {
  const err = e as { code?: unknown; constraint?: unknown; name?: unknown };
  const code = typeof err?.code === 'string' && err.code !== '' ? err.code : typeof err?.name === 'string' && err.name !== '' ? err.name : 'Error';
  return { type, code, constraint: typeof err?.constraint === 'string' ? err.constraint : null };
}

export interface CheckEnv {
  now: Instant;
  clock: Pick<Clock, 'realNow'>;
  backupTarget: 'none' | 'lightsail';
}

async function insertAlert(tx: Queryable, type: AlertType, state: 'open' | 'info', w: Wanted, env: Pick<CheckEnv, 'now' | 'clock'>): Promise<string | null> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO world.alert (type, state, branch_id, at, at_real, subject, message_key, message_values, link_target, emailed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)
     ON CONFLICT (type, subject) WHERE state = 'open' DO NOTHING
     RETURNING id`,
    [type, state, w.branchId, env.now.toString(), env.clock.realNow('record_stamp').toString(), w.subject, `alert.${type}`, JSON.stringify(w.values), w.link],
  );
  return r.rows[0]?.id ?? null;
}

/** publish alert.created, then email the managers when the type's switch is on (the bell and email switches act at creation). */
async function announce(tx: Queryable, type: AlertType, id: string, w: Wanted, env: Pick<CheckEnv, 'now'>, managersEmail: boolean): Promise<number> {
  await publishEvent(tx, 'alert.created', w.branchId === null ? { alertId: id } : { alertId: id, branch: w.branchId });
  return managersEmail ? emailManagers(tx, id, type, w, env) : 0;
}

/**
 * Open 1 alert outside the checks (a creator such as a text that gave up): insert (ON CONFLICT DO NOTHING on the open
 * subject), publish alert.created and email the managers by the type's switch, exactly as the checks do (SD-30,
 * FR-HLTH-4; F-447). Answers the new alert's id, or null when the subject already has an open alert.
 */
export async function openAlert(tx: Queryable, type: AlertType, wanted: Wanted, env: Pick<CheckEnv, 'now' | 'clock'>): Promise<string | null> {
  const id = await insertAlert(tx, type, 'open', wanted, env);
  if (!id) return null;
  const row = await tx.query<{ managers_email: boolean }>(`SELECT managers_email FROM world.alert_setting WHERE type = $1`, [type]);
  await announce(tx, type, id, wanted, env, row.rows[0]?.managers_email ?? ALERT_FACTS[type].managersEmail);
  return id;
}

/** 1 alert email per active manager for a new alert; returns how many were written. */
async function emailManagers(tx: Queryable, alertId: string, type: AlertType, w: Wanted, env: Pick<CheckEnv, 'now'>): Promise<number> {
  const managers = await tx.query<{ id: string; email: string; language: CopyLanguage }>(
    `SELECT id, email::text AS email, language FROM world."user" WHERE role = 'manager' AND status = 'active' ORDER BY id`,
  );
  for (const m of managers.rows) {
    const words = alertEmailWords(type, m.language === 'es' ? 'es' : 'en', w.values);
    const sent = await sendEmail(tx, {
      userId: m.id, toAddress: m.email, kind: 'alert', language: m.language === 'es' ? 'es' : 'en',
      subject: words.subject, body: words.body, now: env.now.toString(), shownTo: [m.id],
    });
    await tx.query(`INSERT INTO world.alert_email_link (alert_id, manager_id, email_link_hash) VALUES ($1, $2, $3)`, [alertId, m.id, sent.links[0]!.hash]);
  }
  if (managers.rows.length > 0) await tx.query(`UPDATE world.alert SET emailed = true WHERE id = $1`, [alertId]);
  return managers.rows.length;
}

/**
 * The one-time link of a manager's alert email, shown to that manager on the alert (FR-AUTH-8 note). Only a token's hash
 * is stored (SD-29), so a link made at alert creation cannot be shown again: this makes a fresh token for the same
 * message, points the manager's alert_email_link at it, and retires the old one. Answers null when the manager has no
 * email for this alert or has already opened it (a spent link is not shown again).
 */
export async function showAlertEmailLink(tx: Queryable, alertId: string, managerId: string, now: Instant): Promise<{ token: string; emailId: string } | null> {
  const cur = await tx.query<{ email_link_hash: Buffer; email_id: string; used_at: Date | null }>(
    `SELECT a.email_link_hash, l.email_id, l.used_at FROM world.alert_email_link a JOIN world.email_link l ON l.token_hash = a.email_link_hash
      WHERE a.alert_id = $1 AND a.manager_id = $2 FOR UPDATE OF a`,
    [alertId, managerId],
  );
  const row = cur.rows[0];
  if (!row || row.used_at !== null) return null;
  const token = newToken();
  const hash = hashToken(token);
  await tx.query(
    `INSERT INTO world.email_link (token_hash, email_id, shown_to_user, expires_at) VALUES ($1, $2, $3, $4::timestamptz + make_interval(hours => $5))`,
    [hash, row.email_id, managerId, now.toString(), EMAIL_LINK_HOURS],
  );
  await tx.query(`UPDATE world.alert_email_link SET email_link_hash = $3 WHERE alert_id = $1 AND manager_id = $2`, [alertId, managerId, hash]);
  await tx.query(`DELETE FROM world.email_link WHERE token_hash = $1`, [row.email_link_hash]);
  return { token, emailId: row.email_id };
}

export async function runAlertChecks(tx: Queryable, env: CheckEnv): Promise<CheckReport> {
  // The switches' rows are the seed's (section 3 writer table; F-444): a check reads them and writes none. A type with no
  // row acts on SD-30's default.
  const settings = new Map(
    (await tx.query<{ type: string; managers_email: boolean }>(`SELECT type, managers_email FROM world.alert_setting`)).rows.map((s) => [s.type, s.managers_email]),
  );
  const rule: RuleEnv = { now: env.now, realBackup: env.clock.realNow('backup_records'), realDelay: env.clock.realNow('board_delay_window'), backupTarget: env.backupTarget };
  const report: CheckReport = { opened: [], resolved: [], info: [], emailed: 0, failed: [], causes: [] };

  const created = async (type: AlertType, id: string, w: Wanted): Promise<void> => {
    report.emailed += await announce(tx, type, id, w, env, settings.get(type) ?? ALERT_FACTS[type].managersEmail);
  };

  // F-449: a background loop fails per record, never whole. Each type's rule (its alerts, their emails, its resolves) runs
  // in a savepoint; a throw undoes that type alone and the others still run.
  const guarded = async (type: AlertType, run: () => Promise<void>): Promise<void> => {
    const marks = { opened: report.opened.length, resolved: report.resolved.length, info: report.info.length, emailed: report.emailed };
    await tx.query('SAVEPOINT alert_rule');
    try {
      await run();
    } catch (e) {
      await tx.query('ROLLBACK TO SAVEPOINT alert_rule');
      report.causes.push(failureOf(type, e));
      report.opened.length = marks.opened;
      report.resolved.length = marks.resolved;
      report.info.length = marks.info;
      report.emailed = marks.emailed;
      report.failed.push(type);
    }
    await tx.query('RELEASE SAVEPOINT alert_rule');
  };

  for (const type of ALERT_TYPES) await guarded(type, async () => {
    const open = RULES[type];
    if (open) {
      const wanted = await open(tx, rule);
      const have = await tx.query<{ subject: string }>(`SELECT subject FROM world.alert WHERE type = $1 AND state = 'open'`, [type]);
      const haveSet = new Set(have.rows.map((h) => h.subject));
      const wantSet = new Set(wanted.map((w) => w.subject));
      for (const w of wanted) {
        if (haveSet.has(w.subject)) continue;
        const id = await insertAlert(tx, type, 'open', w, env);
        if (id) {
          report.opened.push(id);
          await created(type, id, w);
        }
      }
      const gone = [...haveSet].filter((s) => !wantSet.has(s));
      if (gone.length > 0) {
        const r = await tx.query<{ id: string; branch_id: string | null }>(
          `UPDATE world.alert SET state = 'resolved', resolved_at = $3 WHERE type = $1 AND state = 'open' AND subject = ANY($2::text[]) RETURNING id, branch_id`,
          [type, gone, env.now.toString()],
        );
        report.resolved.push(...r.rows.map((x) => x.id));
        // SD-30, F-1156: a close publishes alert.dismissed in this transaction, as an opening publishes alert.created.
        for (const x of r.rows) await publishEvent(tx, 'alert.dismissed', alertEventIds(x.id, x.branch_id));
      }
    }
    const infoRule = INFO_RULES[type];
    if (infoRule) {
      for (const w of await infoRule(tx, rule)) {
        const seen = await tx.query(`SELECT 1 FROM world.alert WHERE type = $1 AND subject = $2`, [type, w.subject]);
        if (seen.rows.length > 0) continue;
        const id = await insertAlert(tx, type, 'info', w, env);
        if (id) {
          report.info.push(id);
          await created(type, id, w);
        }
      }
    }
  });
  return report;
}
