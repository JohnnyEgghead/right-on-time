// SPDX-License-Identifier: AGPL-3.0-or-later
// The alert checks of SPECIFICATIONS SD-30 on PostgreSQL 18: each rule opens 1 alert for a planted condition and resolves
// it when the condition clears; the default switches; the alert email in the on-screen store with one one-time link per
// manager that opens once (SD-29, FR-AUTH-8); the alert.check event and the worker heartbeat through the worker as
// main.ts starts it. Run by gate G-CI2 (ci/gates/G-CI2/vitest.db.config.ts); the merge set excludes *.db.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BUS_CHANNEL, createClient, decodeNotification, openEmailLink, type Queryable } from '@bw/db';
import { ALERT_FACTS, ALERT_TYPES, alertSettingDefaults, type AlertType } from '@bw/domain';
import { useMigratedDatabase } from '../../../../packages/db/src/testing/fixture.ts';
import { addCustomer, addJob, I, loginPool, seedOutboxWorld, setDemoClock, type OutboxRef } from '../../../../packages/outbox/src/testing/world.ts';
import { runNextDue, type EventHandler } from '../dispatcher.ts';
import { startTestWorker, type TestWorker } from '../testing/worker.ts';
import { runAlertChecks, showAlertEmailLink } from './check.ts';
import { RULES } from './rules.ts';
import { alertCheckHandler } from './jobs.ts';

const db = useMigratedDatabase();
const REAL = '2026-11-01T16:00:00Z';
const clock = { realNow: () => I(REAL) };
const NOW = '2026-09-15T14:00:00Z';
let ref: OutboxRef;
let luisId = '';

// One transaction, as the worker runs it: the checks take a savepoint for each rule (F-449), which needs one.
async function check(now = NOW, backupTarget: 'none' | 'lightsail' = 'none') {
  const a = db.admin();
  await a.query('BEGIN');
  try {
    const report = await runAlertChecks(a, { now: I(now), clock, backupTarget });
    await a.query('COMMIT');
    return report;
  } catch (e) {
    await a.query('ROLLBACK');
    throw e;
  }
}

async function alertsOf(type: AlertType) {
  const r = await db.admin().query<{ id: string; state: string; subject: string; branch_id: string | null; link_target: string; message_values: Record<string, unknown>; emailed: boolean; resolved_at: Date | null }>(
    `SELECT id, state, subject, branch_id, link_target, message_values, emailed, resolved_at FROM world.alert WHERE type = $1 ORDER BY at, subject`, [type]);
  return r.rows;
}
const open = async (type: AlertType) => (await alertsOf(type)).filter((a) => a.state === 'open');
const emailCount = async () => Number((await db.admin().query<{ n: string }>(`SELECT count(*) AS n FROM world.email_message WHERE kind = 'alert'`)).rows[0]!.n);

async function backupRecord(kind: 'backup' | 'restore_test', result: 'passed' | 'failed', startedReal: string, minutes = 5): Promise<string> {
  const r = await db.admin().query<{ id: string }>(
    `INSERT INTO system.backup_record (kind, location, started_real, finished_real, result) VALUES ($1, 'test', $2, $2::timestamptz + make_interval(mins => $4), $3) RETURNING id`,
    [kind, startedReal, result, minutes]);
  return r.rows[0]!.id;
}

beforeAll(async () => {
  ref = await seedOutboxWorld(db.admin(), NOW);
  const u = await db.admin().query<{ id: string }>(
    `INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, sample, reviewer)
     VALUES ('luis@example.test', 'Luis Mora', 'luis mora', 'manager', 'columbus', 'es', 'active', true, false),
            ('off@example.test', 'Off Manager', 'off manager', 'manager', 'columbus', 'en', 'turned_off', true, false) RETURNING id`);
  luisId = u.rows[0]!.id;
});

describe('SD-30 rules: each opens 1 alert for a planted condition and resolves it when the condition clears', () => {
  // why: FR-HLTH-4, SD-30
  it('text_gave_up: opens for a text that gave up, links to its call list day, resolves when the call list entry gets an outcome', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c);
    const t = await db.admin().query<{ id: string }>(
      `INSERT INTO world.outbox_text (customer_id, job_number, kind, language, encoding, body, characters, status, tries, due_at, created_at)
       VALUES ($1, $2, 'confirmation', 'en', 'gsm7', 'x', 1, 'gave_up', 5, $3, $3) RETURNING id`, [c, job, NOW]);
    const textId = t.rows[0]!.id;
    const entry = await db.admin().query<{ id: string }>(
      `INSERT INTO world.call_list_entry (branch_id, call_date, customer_id, job_number, text_id, reason, added_at)
       VALUES ('columbus', '2026-09-15', $1, $2, $3, 'text_gave_up', $4) RETURNING id`, [c, job, textId, NOW]);
    await check();
    await check(); // 1 open alert per type and subject, however many checks run
    const mine = (await alertsOf('text_gave_up')).filter((a) => a.subject === textId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ state: 'open', branch_id: 'columbus', link_target: '/office/messages/call-list?date=2026-09-15', message_values: { textId, jobNumber: job } });
    await db.admin().query(`UPDATE world.call_list_entry SET outcome = 'reached', outcome_by = $2, outcome_at = $3 WHERE id = $1`, [entry.rows[0]!.id, ref.userId, NOW]);
    await check();
    expect((await alertsOf('text_gave_up')).filter((a) => a.subject === textId)).toMatchObject([{ state: 'resolved', resolved_at: new Date(NOW) }]);
  });

  // why: F-1277, F-1298, SD-30: an office text about no visit is not on the call list; its alert opens the text log on the day it was written
  it('text_gave_up: an office text about no visit that the outbox missed opens with the text log link at the day it was written', async () => {
    const c = await addCustomer(db.admin(), ref);
    const written = '2026-09-15T00:50:00Z'; // 8:50 PM EDT, Sep 14: the check runs on Sep 15, the log lists it on Sep 14
    const t = await db.admin().query<{ id: string }>(
      `INSERT INTO world.outbox_text (customer_id, job_number, kind, language, encoding, body, characters, status, tries, due_at, created_at, sent_by)
       VALUES ($1, NULL, 'office', 'en', 'gsm7', 'Your part arrived.', 18, 'gave_up', 5, $2, $2, $3) RETURNING id`, [c, written, ref.userId]);
    const textId = t.rows[0]!.id;
    await check();
    const mine = (await alertsOf('text_gave_up')).filter((a) => a.subject === textId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ state: 'open', link_target: '/office/messages?date=2026-09-14', message_values: { textId } });
    expect(mine[0]!.message_values).not.toHaveProperty('jobNumber');
  });

  // why: FR-HLTH-4, SD-30
  it('billing_waiting_person: opens while an item waits for a person, resolves when it leaves the list', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c);
    await db.admin().query(`INSERT INTO world.billing_item (job_number, state, reason_key, tries) VALUES ($1, 'waiting_person', 'billing.data_error', 1)`, [job]);
    await check();
    expect(await open('billing_waiting_person')).toMatchObject([{ subject: String(job), branch_id: 'columbus', link_target: '/office/billing' }]);
    await db.admin().query(`UPDATE world.billing_item SET state = 'marked_fixed', left_at = $2, left_how = 'marked_fixed' WHERE job_number = $1`, [job, NOW]);
    await check();
    expect(await open('billing_waiting_person')).toEqual([]);
    expect((await alertsOf('billing_waiting_person')).map((a) => a.state)).toEqual(['resolved']);
  });

  // why: F-1156, SD-30, EVT-04 a check that resolves an open alert publishes alert.dismissed with its id and branch in the check's transaction, so every open bell and System health page re-reads
  it('publishes alert.dismissed for each alert a check resolves, with its branch', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c);
    await db.admin().query(`INSERT INTO world.billing_item (job_number, state, reason_key, tries) VALUES ($1, 'waiting_person', 'billing.data_error', 1)`, [job]);
    await check();
    const opened = (await open('billing_waiting_person')).find((a) => a.subject === String(job))!;
    const listener = createClient({ connectionString: db.url() });
    await listener.connect();
    const notices: { name: string; ids: Record<string, unknown> }[] = [];
    listener.on('notification', (m) => {
      const d = m.channel === BUS_CHANNEL ? decodeNotification(m.payload) : null;
      if (d?.name === 'alert.dismissed') notices.push(d);
    });
    await listener.query(`LISTEN ${BUS_CHANNEL}`);
    try {
      await db.admin().query(`UPDATE world.billing_item SET state = 'marked_fixed', left_at = $2, left_how = 'marked_fixed' WHERE job_number = $1`, [job, NOW]);
      const report = await check();
      expect(report.resolved).toContain(opened.id);
      await vi.waitFor(() => expect(notices).toContainEqual({ name: 'alert.dismissed', ids: { alertId: opened.id, branch: 'columbus' } }), { timeout: 5_000, interval: 20 });
    } finally {
      listener.removeAllListeners('notification');
      await listener.end();
    }
  });

  // why: FR-HLTH-4, SD-30, F-448 (owner-approved 7ccb76ec: each billing alert resolves when its own state ends)
  it('a retrying item that hits a data error moves from billing_retrying_long to billing_waiting_person while still listed', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c);
    await db.admin().query(`INSERT INTO world.billing_item (job_number, state, tries) VALUES ($1, 'retrying', 1)`, [job]);
    await db.admin().query(`INSERT INTO world.billing_attempt (job_number, number, at, result) VALUES ($1, 1, '2026-09-15T12:00:00Z', 'down')`, [job]);
    await check();
    expect((await open('billing_retrying_long')).map((a) => a.subject)).toContain(String(job));
    await db.admin().query(`UPDATE world.billing_item SET state = 'waiting_person', reason_key = 'billing.data_error', tries = 2 WHERE job_number = $1`, [job]);
    await db.admin().query(`INSERT INTO world.billing_attempt (job_number, number, at, result) VALUES ($1, 2, '2026-09-15T13:00:00Z', 'data_error')`, [job]);
    await check();
    expect((await open('billing_retrying_long')).map((a) => a.subject)).not.toContain(String(job));
    expect((await open('billing_waiting_person')).map((a) => a.subject)).toContain(String(job));
    await db.admin().query(`UPDATE world.billing_item SET state = 'marked_fixed', left_at = $2, left_how = 'marked_fixed' WHERE job_number = $1`, [job, NOW]);
    await check();
  });

  // why: FR-HLTH-4, SD-30
  it('billing_retrying_long: opens at 60 demo minutes of retrying (not 59), counts from the current send, resolves when the item leaves', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c);
    const attempt = (n: number, at: string, result: string) =>
      db.admin().query(`INSERT INTO world.billing_attempt (job_number, number, at, result) VALUES ($1, $2, $3, $4)`, [job, n, at, result]);
    await db.admin().query(`INSERT INTO world.billing_item (job_number, state, tries) VALUES ($1, 'retrying', 1)`, [job]);
    await attempt(1, '2026-09-15T13:01:00Z', 'down'); // 59 minutes before NOW
    await check();
    expect(await open('billing_retrying_long')).toEqual([]);
    await check('2026-09-15T14:01:00Z');
    expect(await open('billing_retrying_long')).toMatchObject([{ subject: String(job), link_target: '/office/billing' }]);
    await db.admin().query(`UPDATE world.billing_item SET state = 'in_billing', left_at = $2, left_how = 'automatic_retry' WHERE job_number = $1`, [job, NOW]);
    await check('2026-09-15T14:02:00Z');
    expect(await open('billing_retrying_long')).toEqual([]);

    // A data error ends a send: retries since Send again are counted from their own first try.
    const c2 = await addCustomer(db.admin(), ref);
    const job2 = await addJob(db.admin(), ref, c2);
    await db.admin().query(`INSERT INTO world.billing_item (job_number, state, tries) VALUES ($1, 'retrying', 3)`, [job2]);
    for (const [n, at, r] of [[1, '2026-09-15T09:00:00Z', 'data_error'], [2, '2026-09-15T13:50:00Z', 'down'], [3, '2026-09-15T13:55:00Z', 'down']] as const) {
      await db.admin().query(`INSERT INTO world.billing_attempt (job_number, number, at, result) VALUES ($1, $2, $3, $4)`, [job2, n, at, r]);
    }
    await check('2026-09-15T14:03:00Z');
    expect((await open('billing_retrying_long')).map((a) => a.subject)).not.toContain(String(job2));
  });

  // why: FR-HLTH-4, SD-30
  it('offline_conflict: opens for a flagged phone item, links to the board, resolves when it is marked handled', async () => {
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c);
    const item = await db.admin().query<{ key: string }>(
      `INSERT INTO world.tech_item (key, technician_id, job_number, kind, world_epoch, device_time_real, offset_saved_real, demo_time, since_save_ms, received_at, result)
       VALUES (gen_random_uuid(), (SELECT id FROM world.technician LIMIT 1), $1, 'status', 1, $2, $2, $2, 0, $2, 'flagged') RETURNING key`, [job, NOW]);
    const conflict = await db.admin().query<{ id: string }>(
      `INSERT INTO world.offline_conflict (job_number, item_key, branch_id, message_key, message_values, offline_at, sent_at)
       VALUES ($1, $2, 'columbus', 'conflict.x', '{}', $3, $3) RETURNING id`, [job, item.rows[0]!.key, NOW]);
    await check();
    expect(await open('offline_conflict')).toMatchObject([{ subject: conflict.rows[0]!.id, branch_id: 'columbus', link_target: '/office/board?tab=needs-attention' }]);
    await db.admin().query(`UPDATE world.offline_conflict SET handled_by = $2, handled_at = $3 WHERE id = $1`, [conflict.rows[0]!.id, ref.userId, NOW]);
    await check();
    expect(await open('offline_conflict')).toEqual([]);
  });

  // why: FR-HLTH-4, SD-30
  it('backup_failed: opens when the last backup failed and resolves when the next passes; opens when none finished in 26 real hours on the hosted copy only', async () => {
    await backupRecord('backup', 'failed', '2026-11-01T02:00:00Z');
    await check();
    expect(await open('backup_failed')).toMatchObject([{ subject: 'backup', branch_id: null, link_target: '/office/admin/health', message_values: { reason: 'failed' } }]);
    await backupRecord('backup', 'passed', '2026-11-01T03:00:00Z');
    await check();
    expect(await open('backup_failed')).toEqual([]);

    // 03:05 finished: 12 h 55 min before REAL. Not stale at 26 h; an own copy (BACKUP_TARGET none) never has the stale rule.
    await check(NOW, 'lightsail');
    expect(await open('backup_failed')).toEqual([]);
    await db.admin().query(`UPDATE system.backup_record SET finished_real = '2026-10-31T13:59:59Z' WHERE result = 'passed' AND kind = 'backup'`); // 26 h + 1 s before REAL
    await check(NOW, 'none');
    expect(await open('backup_failed')).toEqual([]);
    await check(NOW, 'lightsail');
    expect(await open('backup_failed')).toMatchObject([{ message_values: { reason: 'stale' } }]);
    await db.admin().query(`UPDATE system.backup_record SET finished_real = '2026-11-01T15:00:00Z' WHERE result = 'passed' AND kind = 'backup'`);
    await check(NOW, 'lightsail');
    expect(await open('backup_failed')).toEqual([]);
    await db.admin().query(`DELETE FROM system.backup_record`);
  });

  // why: F-434
  it('backup_failed on a hosted copy with no finished backup yet: none before setup, then 26 real hours counted from the earliest snapshot', async () => {
    const snapshot = (createdReal: string) => db.admin().query(
      `INSERT INTO system.day_snapshot (schema_name, created_real, label) VALUES ('world', $1, 'F-434 test')`, [createdReal]);
    await db.admin().query(`DELETE FROM system.backup_record`);
    const kept = await db.admin().query(`DELETE FROM system.day_snapshot RETURNING schema_name, created_real, label`);
    try {
      // No snapshot row: setup has not finished, so no alert, however old the copy.
      await check(NOW, 'lightsail');
      expect(await open('backup_failed')).toEqual([]);
      // Setup 25 h 59 min 59 s before REAL: not yet 26 hours.
      await snapshot('2026-10-31T14:00:01Z');
      await check(NOW, 'lightsail');
      expect(await open('backup_failed')).toEqual([]);
      // A later snapshot (a reset's) does not restart the count; an earlier one, 26 h + 1 s before REAL, opens it.
      await snapshot('2026-11-01T15:00:00Z');
      await snapshot('2026-10-31T13:59:59Z');
      await check(NOW, 'lightsail');
      expect(await open('backup_failed')).toMatchObject([{ message_values: { reason: 'stale' } }]);
      // An own copy never has the stale rule; the first passed backup clears it on the hosted copy.
      await check(NOW, 'none');
      expect(await open('backup_failed')).toEqual([]);
      await backupRecord('backup', 'passed', '2026-11-01T03:00:00Z');
      await check(NOW, 'lightsail');
      expect(await open('backup_failed')).toEqual([]);
    } finally {
      await db.admin().query(`DELETE FROM system.backup_record`);
      await db.admin().query(`DELETE FROM system.day_snapshot`);
      for (const k of kept.rows as { schema_name: string; created_real: Date; label: string }[]) {
        await db.admin().query(`INSERT INTO system.day_snapshot (schema_name, created_real, label) VALUES ($1, $2, $3)`, [k.schema_name, k.created_real, k.label]);
      }
    }
  });

  // why: FR-HLTH-4, SD-30
  it('restore_test_failed: opens on a failed weekly test, resolves when the next one passes, which also writes 1 Info alert (restore_test_passed) once', async () => {
    await backupRecord('restore_test', 'failed', '2026-10-25T08:00:00Z', 12);
    await check();
    expect(await open('restore_test_failed')).toMatchObject([{ subject: 'restore_test', link_target: '/office/admin/health' }]);
    const passed = await backupRecord('restore_test', 'passed', '2026-11-01T08:00:00Z', 14);
    await check();
    await check();
    expect(await open('restore_test_failed')).toEqual([]);
    expect(await alertsOf('restore_test_passed')).toMatchObject([{ state: 'info', subject: passed, message_values: { minutes: 14 } }]);
    await db.admin().query(`DELETE FROM system.backup_record`);
  });

  // why: FR-HLTH-3, FR-HLTH-4, SD-30
  it('board_delay_over_goal: opens when the typical (median) delay of the last 60 real minutes is over 5 s, ignores older samples, resolves when back under', async () => {
    const sample = (seq: number, ms: number, ackedReal: string) =>
      db.admin().query(`INSERT INTO system.delay_sample (seq, emitted_real, acked_real, ms) VALUES ($1, $2::timestamptz - make_interval(secs => $3::int / 1000.0), $2, $3::int)`, [seq, ackedReal, ms]);
    // median 6000 (over) while the mean 4333 is under: the rule is the typical value, not the average
    await sample(1, 6000, '2026-11-01T15:30:00Z');
    await sample(2, 6000, '2026-11-01T15:40:00Z');
    await sample(3, 1000, '2026-11-01T15:50:00Z');
    await sample(4, 30000, '2026-11-01T14:30:00Z'); // older than 60 minutes: not counted
    await check();
    expect(await open('board_delay_over_goal')).toMatchObject([{ subject: 'board', message_values: { typicalMs: 6000 } }]);
    for (const [i, t] of ['15:51', '15:52', '15:53'].entries()) await sample(10 + i, 800, `2026-11-01T${t}:00Z`);
    await check();
    expect(await open('board_delay_over_goal')).toEqual([]);
    expect((await alertsOf('board_delay_over_goal')).map((a) => a.state)).toEqual(['resolved']);
  });
});

describe('default switches and the alert email', () => {
  // why: F-444
  it('a check run writes no alert_setting row: section 3 gives the rows to the seed, never to the alert checks', async () => {
    const count = async () => Number((await db.admin().query<{ n: string }>(`SELECT count(*) AS n FROM world.alert_setting`)).rows[0]!.n);
    expect(await count()).toBe(0); // the checks run above wrote none
    await check();
    expect(await count()).toBe(0);
  });

  // why: FR-HLTH-4, SD-30, F-444
  it('the seed\'s rows are 1 per SD-30 type with the table\'s bell and managers\' email defaults, set_by and set_at null, and a check leaves them as they are', async () => {
    // Written as the world seed writes them (packages/setup/src/world-seed.ts; the fresh setup run is checked in setup.db.test.ts).
    for (const d of alertSettingDefaults()) {
      await db.admin().query(`INSERT INTO world.alert_setting (type, bell, managers_email) VALUES ($1, $2, $3)`, [d.type, d.bell, d.managersEmail]);
    }
    await check();
    const r = await db.admin().query<{ type: string; bell: boolean; managers_email: boolean; set_by: string | null; set_at: Date | null }>(`SELECT * FROM world.alert_setting ORDER BY type`);
    expect(r.rows).toHaveLength(ALERT_TYPES.length);
    expect(r.rows).toEqual([...ALERT_TYPES].sort().map((type) => ({ type, bell: ALERT_FACTS[type].bell, managers_email: ALERT_FACTS[type].managersEmail, set_by: null, set_at: null })));
    // SD-30's table, restated: managers' email default is on for the 2 backup types only.
    expect(r.rows.filter((x) => x.managers_email).map((x) => x.type)).toEqual(['backup_failed', 'restore_test_failed']);
  });

  // why: FR-AUTH-8, FR-HLTH-4
  it('with the managers\' email switch on, each active manager gets 1 alert email in their language and 1 one-time link that opens once', async () => {
    const before = await emailCount();
    await backupRecord('backup', 'failed', '2026-11-01T02:00:00Z');
    const report = await check('2026-09-15T14:10:00Z');
    expect(report.emailed).toBe(2); // Dana (en) and Luis (es); the turned-off manager gets none
    expect(await emailCount()).toBe(before + 2);
    const [alert] = await open('backup_failed');
    expect(alert).toMatchObject({ emailed: true });
    const mail = await db.admin().query<{ to_address: string; language: string; subject: string; kind: string }>(
      `SELECT m.to_address::text, m.language, m.subject, m.kind FROM world.alert_email_link a
         JOIN world.email_link l ON l.token_hash = a.email_link_hash JOIN world.email_message m ON m.id = l.email_id
        WHERE a.alert_id = $1 ORDER BY m.to_address`, [alert!.id]);
    expect(mail.rows.map((m) => [m.to_address, m.language, m.kind])).toEqual([['dana@example.test', 'en', 'alert'], ['luis@example.test', 'es', 'alert']]);
    expect(mail.rows[0]!.subject).toBe('The backup failed');
    expect(mail.rows[1]!.subject).toBe('La copia de seguridad fall\u00f3');
    const links = await db.admin().query<{ manager_id: string }>(`SELECT manager_id FROM world.alert_email_link WHERE alert_id = $1`, [alert!.id]);
    expect(links.rows).toHaveLength(2);

    // The link is shown to the manager on the alert: it opens the message once.
    const shown = await showAlertEmailLink(db.admin(), alert!.id, luisId, I('2026-09-15T14:11:00Z'));
    expect(shown).not.toBeNull();
    const opened = await openEmailLink(db.admin(), shown!.token, '2026-09-15T14:12:00Z');
    expect(opened).toMatchObject({ toAddress: 'luis@example.test', kind: 'alert', language: 'es' });
    expect(await openEmailLink(db.admin(), shown!.token, '2026-09-15T14:13:00Z')).toBeNull(); // opens once
    expect(await openEmailLink(db.admin(), 'not-a-token', '2026-09-15T14:13:00Z')).toBeNull();
    expect(await showAlertEmailLink(db.admin(), alert!.id, luisId, I('2026-09-15T14:14:00Z'))).toBeNull(); // spent: not shown again
    await db.admin().query(`DELETE FROM system.backup_record`);
  });

  // why: SD-29, FR-AUTH-8
  it('a one-time link is stored as a SHA-256 hash, refuses after 24 demo hours, and a fresh link for the same alert retires the old one', async () => {
    await backupRecord('restore_test', 'failed', '2026-10-25T08:00:00Z', 12);
    await check('2026-09-16T10:00:00Z');
    const [alert] = await open('restore_test_failed');
    const stored = await db.admin().query<{ token_hash: Buffer }>(`SELECT l.token_hash FROM world.alert_email_link a JOIN world.email_link l ON l.token_hash = a.email_link_hash WHERE a.alert_id = $1`, [alert!.id]);
    expect(stored.rows.length).toBeGreaterThan(0);
    for (const row of stored.rows) expect(row.token_hash).toHaveLength(32);
    const first = await showAlertEmailLink(db.admin(), alert!.id, luisId, I('2026-09-16T10:01:00Z'));
    const second = await showAlertEmailLink(db.admin(), alert!.id, luisId, I('2026-09-16T10:02:00Z'));
    expect(await openEmailLink(db.admin(), first!.token, '2026-09-16T10:03:00Z')).toBeNull(); // the first token was retired by the second
    expect(await openEmailLink(db.admin(), second!.token, '2026-09-17T10:02:01Z')).toBeNull(); // 24 demo hours and 1 s after it was made
    const third = await showAlertEmailLink(db.admin(), alert!.id, luisId, I('2026-09-17T10:03:00Z'));
    expect(await openEmailLink(db.admin(), third!.token, '2026-09-17T11:00:00Z')).not.toBeNull();
    await db.admin().query(`DELETE FROM system.backup_record`);
  });

  // why: FR-HLTH-4
  it('with the bell and email switches off, the alert is still written and listed, and no email is sent', async () => {
    await db.admin().query(`UPDATE world.alert_setting SET bell = false, managers_email = false WHERE type = 'billing_waiting_person'`);
    const c = await addCustomer(db.admin(), ref);
    const job = await addJob(db.admin(), ref, c);
    await db.admin().query(`INSERT INTO world.billing_item (job_number, state, tries) VALUES ($1, 'waiting_person', 1)`, [job]);
    const before = await emailCount();
    await check('2026-09-16T11:00:00Z');
    expect((await open('billing_waiting_person')).map((a) => a.subject)).toEqual([String(job)]);
    expect(await emailCount()).toBe(before);
  });
});

describe('the worker: alert.check event and heartbeat', () => {
  const T0 = '2026-09-17T09:00:00Z';
  const at = (minutes: number) => I(T0).add({ minutes }).toString();
  const hhmm = (d: Date) => d.toISOString().slice(11, 16);
  let worker: TestWorker;
  const events = async () => (await db.admin().query<{ state: string; due_at: Date; run_at: Date | null; result: string | null }>(
    `SELECT state, due_at, run_at, result FROM world.scheduled_event WHERE kind = 'alert.check' ORDER BY due_at, id`)).rows;
  const due = async () => (await events()).filter((e) => e.state === 'due');
  /** An alert.check event shaped as the world seed writes its first one (packages/setup/src/world-seed.ts). */
  const seedShaped = (dueAt: string) => db.admin().query(
    `INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state) VALUES ($1, 'alert.check', 'alerts', '{}', 'due')`, [dueAt]);
  beforeAll(async () => {
    await setDemoClock(db.admin(), T0);
    worker = await startTestWorker(db.url());
  });
  afterAll(async () => {
    await worker?.stop();
  });

  // why: NFR-11
  it('writes system.worker_heartbeat from the named real-time use at start', async () => {
    const r = await db.admin().query<{ fresh: boolean; rows: string }>(
      `SELECT beat_real > now() - interval '1 minute' AS fresh, (SELECT count(*) FROM system.worker_heartbeat) AS rows FROM system.worker_heartbeat WHERE id = 1`);
    expect(r.rows).toEqual([{ fresh: true, rows: '1' }]);
  });

  // why: F-444
  it('writes no alert.check event at start: the first one is the seed\'s (section 3 writer table)', async () => {
    expect(await events()).toEqual([]);
  });

  // why: SD-30, F-444
  it('runs the seed\'s alert.check and writes exactly 1 next event, 5 demo minutes after the run', async () => {
    await seedShaped(T0);
    await worker.drain();
    const rows = await events();
    const done = rows.filter((r) => r.state === 'done');
    expect(done).toHaveLength(1);
    expect(done[0]!.result).toMatch(/^opened \d+, resolved \d+, info \d+, emailed \d+$/);
    const next = rows.filter((r) => r.state === 'due');
    expect(next).toHaveLength(1);
    expect(next[0]!.due_at.getTime()).toBe(done[0]!.run_at!.getTime() + 5 * 60_000);
  });

  // why: F-444
  it('a seed-shaped second due alert.check converges: from its run on exactly 1 event is due, and the check runs every 5 demo minutes', async () => {
    // The chain above is due at 09:05; a second first event (as a setup run with the worker up could leave) is due at 09:02.
    await seedShaped(at(2));
    const runsBefore = (await events()).filter((e) => e.state === 'done').length;
    for (let m = 1; m <= 60; m += 1) {
      await setDemoClock(db.admin(), at(m));
      await worker.drain();
      if (m >= 2) expect((await due()).length, `due alert.check events at 09:${String(m).padStart(2, '0')}`).toBe(1);
    }
    const runs = (await events()).filter((e) => e.state === 'done').slice(runsBefore).map((e) => hhmm(e.run_at!));
    expect(runs).toEqual(['09:02', '09:05', '09:10', '09:15', '09:20', '09:25', '09:30', '09:35', '09:40', '09:45', '09:50', '09:55', '10:00']);
    expect((await due()).map((e) => hhmm(e.due_at))).toEqual(['10:05']);
  });

  // why: F-444
  it('2 due alert.check events run at the same time by 2 transactions leave exactly 1 due successor', async () => {
    // Both are due after the clock (10:00), so only these 2 runs claim them. Each run, after its checks, waits at its
    // successor write (the chain lock, or the INSERT when there is no lock) until both runs are there, so the 2 writes
    // overlap with neither transaction committed: the case where 2 runs that each see the other due would both skip.
    await seedShaped(at(66));
    expect((await due()).map((e) => hhmm(e.due_at))).toEqual(['10:05', '10:06']);
    const inner = alertCheckHandler({ clock, backupTarget: 'none' });
    let arrived = 0;
    let release = (): void => undefined;
    const both = new Promise<void>((resolve) => { release = resolve; });
    const atWrite = async (): Promise<void> => {
      arrived += 1;
      if (arrived === 2) release();
      await Promise.race([both, new Promise((_, reject) => setTimeout(() => reject(new Error('the 2nd run never reached its write')), 10_000))]);
    };
    const gated: EventHandler = (event, ctx) => {
      let waited = false;
      const tx: Queryable = {
        query: async (text, values) => {
          if (!waited && /pg_advisory_xact_lock|INSERT INTO world\.scheduled_event/.test(text)) {
            waited = true;
            await atWrite();
          }
          return ctx.tx.query(text, values);
        },
      };
      return inner(event, { ...ctx, tx });
    };
    const pool = loginPool(db.url(), 'bw_worker');
    try {
      const opts = { through: I(at(90)), demoNow: I(at(60)) };
      const results = await Promise.all([runNextDue(pool, { 'alert.check': gated }, opts), runNextDue(pool, { 'alert.check': gated }, opts)]);
      expect(results.map((r) => (r && 'outcome' in r ? r.outcome.state : r))).toEqual(['done', 'done']);
    } finally {
      await pool.end();
    }
    const next = await due();
    expect(next).toHaveLength(1);
    expect(['10:10', '10:11']).toContain(hhmm(next[0]!.due_at));
  });
});

describe('one rule that throws does not stop the others (F-449)', () => {
  // why: F-449, F-498 FR-HLTH-4 a failing check says why it failed
  it('undoes the throwing rule alone, reports it, and still opens the other rules\' alerts', async () => {
    await backupRecord('backup', 'failed', '2026-11-02T02:00:00Z');
    const rules = RULES as Record<string, unknown>;
    const original = rules['text_gave_up'];
    rules['text_gave_up'] = async () => {
      throw Object.assign(new Error('planted record text'), { code: '23505', constraint: 'alert_one_open_per_type_subject' });
    };
    try {
      const report = await check();
      expect(report.failed).toEqual(['text_gave_up']);
      // F-498: the cause is kept (code and constraint), and the message, which can hold record text, is not.
      expect(report.causes).toEqual([{ type: 'text_gave_up', code: '23505', constraint: 'alert_one_open_per_type_subject' }]);
      expect(JSON.stringify(report.causes)).not.toContain('planted');
    } finally {
      rules['text_gave_up'] = original;
    }
    expect((await open('backup_failed')).length).toBe(1);
    await backupRecord('backup', 'passed', '2026-11-02T03:00:00Z');
    await check();
    expect(await open('backup_failed')).toEqual([]);
  });
});
