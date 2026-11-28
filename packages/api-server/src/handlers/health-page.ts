// SPDX-License-Identifier: AGPL-3.0-or-later
// The System health page's reads and writes and the bell's list (UI-SPECIFICATION 12.2 API-43, API-70, API-71, API-160, API-161;
// SPECIFICATIONS section 11.7 FR-HLTH-1 to FR-HLTH-4, SD-30, SD-43, SD-44; FR-DISP-12, FR-TEXT-16). The records are the ones the
// backup scripts, the board tabs, the alert checks and the text outbox write; this file only reads them and, for the 3 writes,
// changes the text simulator row, an alert switch, or runs the alert checks at once.
import { ALERT_FACTS, ALERT_TYPES, BOARD_DELAY_GOAL_MS, BOARD_DELAY_WINDOW_MINUTES } from '@bw/domain';
import type { alertEmailLink, checkNow, dismissAlert, officeAlerts, setAlertSwitch, setTextSimulator, systemHealth } from '@bw/api';
import { alertEventIds, publishEvent } from '@bw/db';
import { Temporal, toWire } from '@bw/time';
import { runAlertChecks, showAlertEmailLink } from 'bw-worker/alerts';
import { billingList } from 'bw-worker/billing';
import type { z } from 'zod';
import type { ApiRequest, ApiResult, Handler, HandlerContext, Tx } from '../types.ts';
import { pbsClientFor } from './billing.ts';
import { billingToday, givenUpJobs, jobRows, lastFailures, reasonKindOf } from './billing-reads.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;
type Alert = Out<typeof officeAlerts>['alerts'][number];
type Health = Out<typeof systemHealth>;

/** Real-time stamps (backups, restore tests, board delay) are shown in the zone the host timers use (SPECIFICATIONS section 2). */
const REAL_ZONE = 'America/New_York';
/** SD-30: the System health list shows the last 7 demo days, at most 100 rows (GAP-26). */
const RECENT_DAYS = 7;
const RECENT_MAX = 100;
const BACKUP_AT = { hour: 2, minute: 30 } as const;
const RESTORE_AT = { hour: 4, minute: 0 } as const;
/** The health checks whose open alert says the system is not working (SD-30 "Links to" System health, state open). */
const HEALTH_TYPES = ['backup_failed', 'restore_test_failed', 'board_delay_over_goal', 'billing_reset_waiting'];

const instantOf = (d: Date): Temporal.Instant => Temporal.Instant.from(d.toISOString());
const wireIn = (d: Date, zone: string): string => toWire(instantOf(d), zone);

interface CallerRow { id: string; role: 'office' | 'manager' | 'technician'; branch_id: string; zone: string }

/** null: nobody is signed in. 'gone': the session's user has no row any more (the session layer admits only an active user, so a row gone since is not this caller: 404 as API-07). */
async function callerOf(tx: Tx, req: ApiRequest): Promise<CallerRow | null | 'gone'> {
  if (req.caller.kind !== 'staff') return null;
  return (await tx.query<CallerRow>(
    `SELECT u.id, u.role, u.branch_id, b.zone FROM world."user" u JOIN world.branch b ON b.id = u.branch_id WHERE u.id = $1`, [req.caller.userId])).rows[0] ?? 'gone';
}

function dayBounds(now: Temporal.Instant, zone: string, date?: string): { from: string; to: string } {
  const day = date === undefined ? now.toZonedDateTimeISO(zone).startOfDay() : Temporal.PlainDate.from(date).toZonedDateTime(zone);
  return { from: day.toInstant().toString(), to: day.add({ days: 1 }).toInstant().toString() };
}

interface AlertRow {
  id: string; type: string; state: 'open' | 'resolved' | 'info'; at: Date; message_key: string; message_values: Record<string, string | number>;
  link_target: string; emailed: boolean;
}

/** SD-30 (F-875): the one alert a person can close is the `text_gave_up` alert of an office text about no visit. */
const isDismissibleText = (t: { kind: string; job_number: number | null }): boolean => t.kind === 'office' && t.job_number === null;

const ALERT_COLUMNS = 'a.id, a.type, a.state, a.at, a.message_key, a.message_values, a.link_target, a.emailed';
const BELL_DEFAULT_TYPES = ALERT_TYPES.filter((t) => ALERT_FACTS[t].bell);

/**
 * The alerts as the lists show them. A text_gave_up alert names the customer and the kind of the text it is about (FR-HLTH-4:
 * "an Open alert names the failed text"; the values hold the text's id only, section 3). A manager also gets the state of
 * their own copy of the alert email: opened already, or waiting (F-431; FR-AUTH-8 note, OA-74). No read makes a link: a click does, through
 * API-174, so no view retires a link another view shows (F-660).
 */
async function shapeAlerts(tx: Tx, rows: AlertRow[], caller: CallerRow, zone: string): Promise<Alert[]> {
  const textIds = rows.flatMap((r) => (r.type === 'text_gave_up' && typeof r.message_values['textId'] === 'string' ? [r.message_values['textId'] as string] : []));
  const texts = new Map<string, { customer: string; kind: string; job_number: number | null }>();
  if (textIds.length > 0) {
    const t = await tx.query<{ id: string; customer: string; kind: string; job_number: number | null }>(
      `SELECT o.id, c.name AS customer, o.kind, o.job_number FROM world.outbox_text o JOIN world.customer c ON c.id = o.customer_id WHERE o.id = ANY($1::uuid[])`, [textIds]);
    for (const x of t.rows) texts.set(x.id, x);
  }
  const copies = new Map<string, 'unused' | 'opened'>();
  const emailed = rows.filter((r) => r.emailed).map((r) => r.id);
  if (caller.role === 'manager' && emailed.length > 0) {
    const c = await tx.query<{ alert_id: string; used_at: Date | null; has_link: boolean }>(
      `SELECT a.alert_id, l.used_at, l.token_hash IS NOT NULL AS has_link
         FROM world.alert_email_link a LEFT JOIN world.email_link l ON l.token_hash = a.email_link_hash
        WHERE a.manager_id = $1 AND a.alert_id = ANY($2::uuid[])`, [caller.id, emailed]);
    // A copy whose link row is gone has been opened (or expired): it is not offered again either way.
    for (const x of c.rows) copies.set(x.alert_id, x.has_link && x.used_at === null ? 'unused' : 'opened');
  }
  const out: Alert[] = [];
  for (const r of rows) {
    const text = typeof r.message_values['textId'] === 'string' ? texts.get(r.message_values['textId'] as string) : undefined;
    const values: Record<string, string | number> = { ...r.message_values, ...(text ? { customer: text.customer, kind: text.kind } : {}) };
    const copy = copies.get(r.id);
    out.push({
      id: r.id, at: wireIn(r.at, zone), type: r.type, state: r.state, messageKey: r.message_key, messageValues: values, link: r.link_target,
      emailed: r.emailed, emailWaiting: copy === 'unused', emailOpened: copy === 'opened',
      dismissible: r.state === 'open' && text !== undefined && isDismissibleText(text),
    });
  }
  return out;
}

/** API-43: today's alerts of the types whose bell switch is on, newest first (F-430: the switch is read now, so a bell-off type's alerts are not counted). */
const officeAlertsHandler: Handler<Out<typeof officeAlerts>> = async (req, tx) => {
  const caller = await callerOf(tx, req);
  if (!caller) return { ok: false, status: 401, code: 'unauthenticated' };
  if (caller === 'gone') return { ok: false, status: 404, code: 'not_found' };
  const p = req.params as In<typeof officeAlerts>;
  const zone = (await tx.query<{ zone: string }>('SELECT zone FROM world.branch WHERE id = $1', [p.branch])).rows[0]?.zone;
  if (!zone) return { ok: false, status: 404, code: 'not_found' };
  const { from, to } = dayBounds(req.demoNow, zone, p.date);
  const rows = await tx.query<AlertRow>(
    `SELECT ${ALERT_COLUMNS} FROM world.alert a LEFT JOIN world.alert_setting s ON s.type = a.type
      WHERE (a.branch_id IS NULL OR a.branch_id = $1) AND a.at >= $2 AND a.at < $3 AND COALESCE(s.bell, a.type = ANY($4::text[]))
      ORDER BY a.at DESC, a.id DESC LIMIT $5`,
    [p.branch, from, to, BELL_DEFAULT_TYPES, RECENT_MAX]);
  return { ok: true, status: 200, data: { alerts: await shapeAlerts(tx, rows.rows, caller, zone) } };
};

async function overallOf(tx: Tx, branch: string): Promise<Health['overall']> {
  const r = await tx.query<{ needs: number; sick: number }>(
    `SELECT count(*)::int AS needs, count(*) FILTER (WHERE type = ANY($2::text[]))::int AS sick
       FROM world.alert WHERE state = 'open' AND (branch_id IS NULL OR branch_id = $1)`, [branch, HEALTH_TYPES]);
  return { working: (r.rows[0]?.sick ?? 0) === 0, needsOffice: r.rows[0]?.needs ?? 0 };
}

/** lastCheck = the demo time of the last alert.check that ran (the worker's every 5 demo minutes, or a Check now). */
async function lastCheckOf(tx: Tx, zone: string): Promise<string | null> {
  const r = await tx.query<{ at: Date | null }>(`SELECT max(run_at) AS at FROM world.scheduled_event WHERE kind = 'alert.check' AND state = 'done'`);
  const at = r.rows[0]?.at;
  return at ? wireIn(at, zone) : null;
}

async function simulatorOf(tx: Tx, zone: string): Promise<Out<typeof setTextSimulator>['textSimulator']> {
  const r = await tx.query<{ mode: 'up' | 'all_fail' | 'fail_customer' | 'fail_next_n'; customer_id: string | null; customer: string | null; n_left: number | null; by: string | null; set_at: Date | null }>(
    `SELECT s.mode, s.customer_id, c.name AS customer, s.n_left, u.name AS by, s.set_at
       FROM world.text_simulator s LEFT JOIN world.customer c ON c.id = s.customer_id LEFT JOIN world."user" u ON u.id = s.set_by`);
  const x = r.rows[0];
  if (!x) return { mode: 'up', customerId: null, customerName: null, nLeft: null, setBy: null, setAt: null };
  return { mode: x.mode, customerId: x.customer_id, customerName: x.customer, nLeft: x.n_left, setBy: x.by, setAt: x.set_at ? wireIn(x.set_at, zone) : null };
}

/** The next time of day in America/New_York after a real instant: today's if it is still ahead, else tomorrow's (compatible: a missing hour moves on). */
export function nextDaily(after: Temporal.Instant, at: { hour: number; minute: number }): Temporal.Instant {
  const z = after.toZonedDateTimeISO(REAL_ZONE);
  // K-09.9: the wall-clock time is set on the zoned day, never added as exact hours, so a DST day (Mar 8, Nov 1, 2026) reads right.
  const today = z.startOfDay().with({ hour: at.hour, minute: at.minute });
  return (Temporal.Instant.compare(today.toInstant(), after) > 0 ? today : z.startOfDay().add({ days: 1 }).with({ hour: at.hour, minute: at.minute })).toInstant();
}

/** SPECIFICATIONS section 11.7: the weekly restore test runs Sunday 4:00 AM America/New_York. */
export function nextSunday(after: Temporal.Instant): Temporal.Instant {
  let day = after.toZonedDateTimeISO(REAL_ZONE).startOfDay();
  for (let i = 0; i < 8; i += 1, day = day.add({ days: 1 })) {
    if (day.dayOfWeek !== 7) continue;
    const at = day.with({ hour: RESTORE_AT.hour, minute: RESTORE_AT.minute });
    if (Temporal.Instant.compare(at.toInstant(), after) > 0) return at.toInstant();
  }
  return after;
}

/** API-174: this manager's fresh link to their unopened copy (the showAlertEmailLink of the click, never of a read). */
const alertEmailLinkHandler: Handler<Out<typeof alertEmailLink>> = async (req, tx) => {
  const caller = await callerOf(tx, req);
  if (!caller) return { ok: false, status: 401, code: 'unauthenticated' };
  if (caller === 'gone') return { ok: false, status: 404, code: 'not_found' };
  const shown = await showAlertEmailLink(tx, (req.params as In<typeof alertEmailLink>).alertId, caller.id, req.demoNow);
  if (!shown) return { ok: false, status: 404, code: 'not_found' };
  return { ok: true, status: 200, data: { link: `/email/${shown.token}` } };
};

export function healthHandlers(): { 'API-43': Handler<unknown>; 'API-70': Handler<unknown>; 'API-71': Handler<unknown>; 'API-160': Handler<unknown>; 'API-161': Handler<unknown>; 'API-174': Handler<unknown>; 'API-176': Handler<unknown> } {
  const client = pbsClientFor();
  const read: Handler<Health> = async (req, tx, ctx) => {
    const caller = await callerOf(tx, req);
    if (!caller) return { ok: false, status: 401, code: 'unauthenticated' };
    if (caller === 'gone') return { ok: false, status: 404, code: 'not_found' };
    const zone = caller.zone;
    const backupNow = ctx.clock.realNow('backup_records');
    const delayNow = ctx.clock.realNow('board_delay_window');
    const target = ctx.settings.BACKUP_TARGET ?? 'none';

    // FR-HLTH-1: the stored backup and restore-test records.
    let backup: Health['backup'] = null;
    const backups: Health['backups'] = [];
    if (target !== 'none') {
      const last = await tx.query<{ result: 'passed' | 'failed' | null; started_real: Date; finished_real: Date | null; size_bytes: string | null; nights_kept: number | null; location: string }>(
        `SELECT result, started_real, finished_real, size_bytes, nights_kept, location FROM system.backup_record
          WHERE kind = 'backup' AND result IS NOT NULL ORDER BY started_real DESC, id DESC LIMIT 1`);
      const b = last.rows[0];
      if (b?.result) {
        backup = {
          result: b.result, at: wireIn(b.started_real, REAL_ZONE), finishedAt: b.finished_real ? wireIn(b.finished_real, REAL_ZONE) : null,
          sizeBytes: b.size_bytes === null ? null : Number(b.size_bytes), nightsKept: b.nights_kept, copiesAt: b.location, nextAt: toWire(nextDaily(backupNow, BACKUP_AT), REAL_ZONE),
        };
      }
      const today = backupNow.toZonedDateTimeISO(REAL_ZONE).toPlainDate();
      const since = today.subtract({ days: 6 }).toZonedDateTime(REAL_ZONE).toInstant().toString();
      const nights = await tx.query<{ night: string; result: 'passed' | 'failed' }>(
        `SELECT DISTINCT ON (night) night, result FROM (
           SELECT to_char(started_real AT TIME ZONE $2, 'YYYY-MM-DD') AS night, result, started_real FROM system.backup_record
            WHERE kind = 'backup' AND result IS NOT NULL AND started_real >= $1) x
          ORDER BY night, started_real DESC`, [since, REAL_ZONE]);
      const byNight = new Map(nights.rows.map((n) => [n.night, n.result]));
      for (let i = 6; i >= 0; i -= 1) {
        const night = today.subtract({ days: i }).toString();
        backups.push({ night, result: byNight.get(night) ?? null });
      }
    }
    const tests = target === 'none' ? { rows: [] as { result: 'passed' | 'failed'; started_real: Date; finished_real: Date | null; first: boolean }[] } : await tx.query<{ result: 'passed' | 'failed'; started_real: Date; finished_real: Date | null; first: boolean }>(
      `SELECT r.result, r.started_real, r.finished_real,
              NOT EXISTS (SELECT 1 FROM system.backup_record e WHERE e.kind = 'restore_test' AND e.started_real < r.started_real) AS first
         FROM system.backup_record r WHERE r.kind = 'restore_test' AND r.result IS NOT NULL ORDER BY r.started_real DESC, r.id DESC LIMIT 5`);

    // FR-HLTH-3: the samples of the last 60 real minutes (SD-43); typical = median, slowest = maximum.
    const samples = await tx.query<{ acked_real: Date; ms: number }>(
      `SELECT acked_real, ms FROM system.delay_sample WHERE acked_real >= $1::timestamptz - make_interval(mins => $2) ORDER BY acked_real, ms`,
      [delayNow.toString(), BOARD_DELAY_WINDOW_MINUTES]);
    const sorted = samples.rows.map((s) => s.ms).sort((a, b) => a - b);
    const median = (): number | null => {
      if (sorted.length === 0) return null;
      const mid = sorted.length >> 1;
      return Math.round(sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
    };

    // The recent alerts and the alert switches (FR-HLTH-4).
    const recent = await tx.query<AlertRow>(
      `SELECT ${ALERT_COLUMNS} FROM world.alert a WHERE (a.branch_id IS NULL OR a.branch_id = $1) AND a.at >= $2::timestamptz - make_interval(days => $3)
        ORDER BY a.at DESC, a.id DESC LIMIT $4`, [caller.branch_id, req.demoNow.toString(), RECENT_DAYS, RECENT_MAX]);
    const settingRows = await tx.query<{ type: string; bell: boolean; managers_email: boolean }>('SELECT type, bell, managers_email FROM world.alert_setting');
    const have = new Map(settingRows.rows.map((s) => [s.type, s]));

    // FR-TEXT-12, FR-TEXT-16: the outbox in numbers, the retry and held lists, the simulator.
    const { from, to } = dayBounds(req.demoNow, zone);
    const counts = (await tx.query<{ today: number; delivered: number; held: number; retrying: number; not_sent: number }>(
      `SELECT count(*) FILTER (WHERE o.created_at >= $2 AND o.created_at < $3)::int AS today,
              count(*) FILTER (WHERE o.status = 'delivered' AND o.created_at >= $2 AND o.created_at < $3)::int AS delivered,
              count(*) FILTER (WHERE o.status = 'held')::int AS held,
              count(*) FILTER (WHERE o.status = 'retrying')::int AS retrying,
              count(*) FILTER (WHERE o.status = 'gave_up' AND o.created_at >= $2 AND o.created_at < $3)::int AS not_sent
         FROM world.outbox_text o JOIN world.customer c ON c.id = o.customer_id WHERE c.branch_id = $1`, [caller.branch_id, from, to])).rows[0];
    const callList = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM world.call_list_entry WHERE branch_id = $1 AND outcome IS NULL', [caller.branch_id])).rows[0]?.n ?? 0;
    const retrying = await tx.query<{ id: string; customer: string; kind: string; status: string; tries: number; next_try_at: Date | null }>(
      `SELECT o.id, c.name AS customer, o.kind, o.status, o.tries, o.next_try_at FROM world.outbox_text o JOIN world.customer c ON c.id = o.customer_id
        WHERE c.branch_id = $1 AND o.status = 'retrying' ORDER BY o.next_try_at NULLS LAST, o.id LIMIT 20`, [caller.branch_id]);
    const held = await tx.query<{ id: string; customer: string; kind: string; held_until: Date; zone: string }>(
      `SELECT o.id, c.name AS customer, o.kind, o.held_until, c.zone FROM world.outbox_text o JOIN world.customer c ON c.id = o.customer_id
        WHERE c.branch_id = $1 AND o.status = 'held' AND o.held_until IS NOT NULL ORDER BY o.held_until, o.id LIMIT 20`, [caller.branch_id]);

    // The billing card: the jobs waiting on a person, today's counts and the last send (FR-BILL-2).
    const { waiting } = await billingList(tx, { branchId: caller.branch_id, now: req.demoNow });
    const counted = await billingToday(tx, { branch: caller.branch_id, zone, now: req.demoNow });
    const listedItems = waiting.filter((w) => w.state === 'waiting_person');
    const numbers = listedItems.map((w) => w.jobNumber);
    // F-886: 1 query at a time on the call's client.
    const jobs = await jobRows(tx, numbers);
    const failures = await lastFailures(tx, numbers);
    const gaveUp = await givenUpJobs(tx, numbers);
    const lastSent = (await tx.query<{ at: Date | null }>(
      `SELECT max(a.at) AS at FROM world.billing_attempt a JOIN world.job j USING (job_number) WHERE j.branch_id = $1 AND a.result = 'success' AND a.at <= $2`,
      [caller.branch_id, req.demoNow.toString()])).rows[0]?.at ?? null;
    const mode = await client(ctx).getMode().then((m) => (typeof m?.mode === 'string' ? m.mode : null), () => null);

    const lists = await shapeAlerts(tx, recent.rows, caller, zone);
    return {
      ok: true, status: 200,
      data: {
        branch: caller.branch_id,
        asOf: toWire(req.demoNow, zone),
        lastCheck: await lastCheckOf(tx, zone),
        overall: await overallOf(tx, caller.branch_id),
        backupSetUp: target !== 'none',
        backup,
        backups,
        restoreTests: tests.rows.map((t) => ({
          at: wireIn(t.started_real, REAL_ZONE), finishedAt: t.finished_real ? wireIn(t.finished_real, REAL_ZONE) : null,
          minutes: t.finished_real ? Math.round((t.finished_real.getTime() - t.started_real.getTime()) / 60_000) : null, result: t.result, first: t.first,
        })),
        restoreNextAt: target === 'none' ? null : toWire(nextSunday(backupNow), REAL_ZONE),
        locations: {
          app: ctx.settings.DATA_LOCATION_APP ?? 'This computer', backups: ctx.settings.DATA_LOCATION_BACKUPS ?? 'This computer',
          texts: ctx.settings.DATA_LOCATION_TEXTS ?? 'This computer', maps: ctx.settings.DATA_LOCATION_MAPS ?? 'This computer',
        },
        delay: {
          samples: samples.rows.map((s) => ({ at: wireIn(s.acked_real, REAL_ZONE), ms: s.ms })),
          typicalMs: median(), slowestMs: sorted.length === 0 ? null : sorted[sorted.length - 1]!, goalMs: BOARD_DELAY_GOAL_MS,
        },
        alerts: lists,
        alertSettings: ALERT_TYPES.map((type) => ({ type, bell: have.get(type)?.bell ?? ALERT_FACTS[type].bell, managersEmail: have.get(type)?.managers_email ?? ALERT_FACTS[type].managersEmail })),
        textSimulator: await simulatorOf(tx, zone),
        outbox: {
          today: counts?.today ?? 0, delivered: counts?.delivered ?? 0, held: counts?.held ?? 0, retrying: counts?.retrying ?? 0, notSentToday: counts?.not_sent ?? 0, callList,
          retryingTexts: retrying.rows.map((r) => ({ textId: r.id, customer: r.customer, kind: r.kind, status: r.status, tries: r.tries, nextTryAt: r.next_try_at ? wireIn(r.next_try_at, zone) : null })),
          heldTexts: held.rows.map((h) => ({ textId: h.id, customer: h.customer, kind: h.kind, heldUntil: wireIn(h.held_until, h.zone), heldUntilBranch: wireIn(h.held_until, zone) })),
        },
        billing: {
          mode, waiting: waiting.length, ...counted, lastSentAt: lastSent ? wireIn(lastSent, zone) : null,
          listed: listedItems.map((w) => {
            const j = jobs.get(w.jobNumber);
            const f = failures.get(w.jobNumber);
            // The billing page's own read (F-2123): the latest event wins, so a given-up item says so here too.
            const kind = reasonKindOf(f, gaveUp.get(w.jobNumber));
            return { jobNumber: w.jobNumber, customer: j?.customer ?? '', service: j?.service_id ?? '', reasonKind: kind, reason: kind === 'data_error' ? f?.reason ?? null : null };
          }),
        },
      },
    };
  };

  /** API-71: the simulator row changes for everyone (FR-TEXT-16); the mode's own inputs are checked, never defaulted. */
  const setSimulator: Handler<Out<typeof setTextSimulator>> = async (req, tx) => {
    const caller = await callerOf(tx, req);
    if (!caller) return { ok: false, status: 401, code: 'unauthenticated' };
    if (caller === 'gone') return { ok: false, status: 404, code: 'not_found' };
    const p = req.params as In<typeof setTextSimulator>;
    const bad: ApiResult<never> = { ok: false, status: 422, code: 'validation_failed' };
    if (p.mode === 'fail_customer') {
      if (!p.customerId || p.n !== undefined) return bad;
      if (!(await tx.query('SELECT 1 FROM world.customer WHERE id = $1', [p.customerId])).rows[0]) return bad;
    } else if (p.mode === 'fail_next_n') {
      if (p.n === undefined || p.customerId !== undefined) return bad;
    } else if (p.customerId !== undefined || p.n !== undefined) {
      return bad;
    }
    const values = [p.mode, p.mode === 'fail_customer' ? p.customerId : null, p.mode === 'fail_next_n' ? p.n : null, caller.id, req.demoNow.toString()];
    // The row is the seed's; a copy that has none gets its one row here, so a pick is never silently dropped. 1 statement, so 2 first saves
    // at once both succeed: the unique index on a constant holds the table to 1 row and the loser updates it (K-09.8a).
    await tx.query(
      `INSERT INTO world.text_simulator (mode, customer_id, n_left, set_by, set_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ((true)) DO UPDATE SET mode = EXCLUDED.mode, customer_id = EXCLUDED.customer_id, n_left = EXCLUDED.n_left, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`, values);
    await publishEvent(tx, 'settings.changed', { kind: 'text_simulator' });
    return { ok: true, status: 200, data: { textSimulator: await simulatorOf(tx, caller.zone) } };
  };

  /** API-160: every alert rule at once, in this call's transaction, and the time it ran (the same row the worker's chain writes). */
  const check: Handler<Out<typeof checkNow>> = async (req, tx, ctx) => {
    const caller = await callerOf(tx, req);
    if (!caller) return { ok: false, status: 401, code: 'unauthenticated' };
    if (caller === 'gone') return { ok: false, status: 404, code: 'not_found' };
    const report = await runAlertChecks(tx, { now: req.demoNow, clock: ctx.clock, backupTarget: ctx.settings.BACKUP_TARGET ?? 'none' });
    await tx.query(
      `INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state, run_at, result) VALUES ($1, 'alert.check', 'alerts', '{}'::jsonb, 'done', $1, $2)`,
      [req.demoNow.toString(), `check now: opened ${report.opened.length}, resolved ${report.resolved.length}, info ${report.info.length}, emailed ${report.emailed}${report.failed.length > 0 ? `, rules failed ${report.causes.map((c) => `${c.type}(${c.code}${c.constraint ? ` ${c.constraint}` : ''})`).join(' ')}` : ''}`]);
    // A rule that threw ran in its own savepoint; the page still gets the other rules' answer (F-449), and its cause is logged here as the worker logs its own runs (F-661).
    for (const c of report.causes) {
      ctx.log.error({ status: 'unhandled error', errorCode: `alert_rule_failed ${c.type} ${c.code}${c.constraint ? ` ${c.constraint}` : ''}`, demoTime: req.demoNow.toString() });
    }
    return { ok: true, status: 200, data: { lastCheck: toWire(req.demoNow, caller.zone), overall: await overallOf(tx, caller.branch_id) } };
  };

  /** API-161: one type's switches; the checks and creators read them at the next alert (the bell switch also at the next read, F-430). */
  const setSwitch: Handler<Out<typeof setAlertSwitch>> = async (req, tx) => {
    const caller = await callerOf(tx, req);
    if (!caller) return { ok: false, status: 401, code: 'unauthenticated' };
    if (caller === 'gone') return { ok: false, status: 404, code: 'not_found' };
    const p = req.params as In<typeof setAlertSwitch>;
    if (!(ALERT_TYPES as readonly string[]).includes(p.alertType)) return { ok: false, status: 404, code: 'not_found' };
    // K-09.8b: a copy whose seed wrote no row for the type gets it here, from the type's own defaults, so the switch is never refused as not found.
    const facts = ALERT_FACTS[p.alertType as keyof typeof ALERT_FACTS];
    const r = await tx.query<{ type: string; bell: boolean; managers_email: boolean }>(
      `INSERT INTO world.alert_setting (type, bell, managers_email, set_by, set_at)
       VALUES ($1, COALESCE($2::boolean, $6::boolean), COALESCE($3::boolean, $7::boolean), $4, $5)
       ON CONFLICT (type) DO UPDATE SET bell = COALESCE($2::boolean, world.alert_setting.bell), managers_email = COALESCE($3::boolean, world.alert_setting.managers_email), set_by = $4, set_at = $5
       RETURNING type, bell, managers_email`,
      [p.alertType, p.bell ?? null, p.managersEmail ?? null, caller.id, req.demoNow.toString(), facts.bell, facts.managersEmail]);
    const row = r.rows[0];
    if (!row) return { ok: false, status: 500, code: 'server_error' };
    await publishEvent(tx, 'settings.changed', { kind: 'alert_settings' });
    return { ok: true, status: 200, data: { alertSetting: { type: row.type, bell: row.bell, managersEmail: row.managers_email } } };
  };

  /** API-176: Dismiss (SD-30; F-875). Only an open text_gave_up alert for an office text about no visit; anything else is refused rule_refused. */
  const dismiss: Handler<Out<typeof dismissAlert>> = async (req, tx) => {
    const caller = await callerOf(tx, req);
    if (!caller) return { ok: false, status: 401, code: 'unauthenticated' };
    if (caller === 'gone') return { ok: false, status: 404, code: 'not_found' };
    const p = req.params as In<typeof dismissAlert>;
    const a = (await tx.query<{ id: string; type: string; state: string; branch_id: string | null; text_kind: string | null; text_job: number | null }>(
      `SELECT a.id, a.type, a.state, a.branch_id, o.kind AS text_kind, o.job_number AS text_job
         FROM world.alert a LEFT JOIN world.outbox_text o ON a.type = 'text_gave_up' AND o.id::text = a.message_values->>'textId'
        WHERE a.id = $1 FOR UPDATE OF a`, [p.alertId])).rows[0];
    if (!a) return { ok: false, status: 404, code: 'not_found' };
    if (a.type !== 'text_gave_up' || a.state !== 'open' || a.text_kind === null || !isDismissibleText({ kind: a.text_kind, job_number: a.text_job })) {
      return { ok: false, status: 409, code: 'rule_refused' };
    }
    await tx.query(`UPDATE world.alert SET state = 'resolved', resolved_at = $2 WHERE id = $1`, [a.id, req.demoNow.toString()]);
    // SD-30, F-1156: every open bell and System health page re-reads, so the alert shows Resolved in every other tab.
    await publishEvent(tx, 'alert.dismissed', alertEventIds(a.id, a.branch_id));
    return { ok: true, status: 200, data: { alert: { id: a.id, state: 'resolved' as const, resolvedAt: toWire(req.demoNow, caller.zone) } } };
  };

  return {
    'API-176': dismiss as Handler<unknown>,
    'API-43': officeAlertsHandler as Handler<unknown>, 'API-70': read as Handler<unknown>, 'API-71': setSimulator as Handler<unknown>,
    'API-160': check as Handler<unknown>, 'API-161': setSwitch as Handler<unknown>, 'API-174': alertEmailLinkHandler as Handler<unknown>,
  };
}

export type { HandlerContext };
