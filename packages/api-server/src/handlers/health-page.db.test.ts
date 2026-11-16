// SPDX-License-Identifier: AGPL-3.0-or-later
// The System health page's reads and writes and the bell's list through the production kernel (P4-HEALTH; FR-HLTH-1 to FR-HLTH-4,
// FR-DISP-12, FR-TEXT-16, FR-AUTH-8): API-43 Office alerts, API-70 System health, API-71 Set text simulator, API-160 Check now and
// API-161 Set an alert switch, each called over the real handlers as a signed-in manager (the web process's login bw_web, the real
// session layer) on real PostgreSQL 18. Run by gate G-CI7 (ci/gates/G-CI7/vitest.db.config.ts); the merge set excludes *.db.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@bw/config';
import { BUS_CHANNEL, createClient, createPool, decodeNotification, openEmailLink } from '@bw/db';
import { alertSettingDefaults } from '@bw/domain';
import { createLogger } from '@bw/log';
import { realNow, Temporal } from '@bw/time';
import { openAlert, runAlertChecks } from 'bw-worker/alerts';
import { RULES } from '../../../../apps/worker/src/alerts/rules.ts';
import { useMigratedDatabase } from '../../../db/src/testing/fixture.ts';
import { addCustomer, addJob, seedOutboxWorld, type OutboxRef } from '../../../outbox/src/testing/world.ts';
import { sessionCookie, SqlSessionStore, startSession } from '../kernel/sessions.ts';
import { createWebKernel, type WebKernel } from '../web.ts';

const db = useMigratedDatabase();
const NOW = '2026-09-15T14:00:00Z';
const ORIGIN = 'http://localhost:8080';
const settle = () => new Promise((r) => setTimeout(r, 300));
const loginUrl = (url: string, login: string) => {
  const u = new URL(url);
  u.username = login;
  return u.toString();
};

let kernel: WebKernel;
let web: ReturnType<typeof createPool>;
let ref: OutboxRef;
let manager: { id: string; cookie: string };
let office: { id: string; cookie: string };
let pham: string;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = { data: Record<string, any>; code?: string };

async function call(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown, who: { cookie: string } | null = manager) {
  await settle();
  const res = await kernel.router.handle(new Request(`http://web:3000/api/v1${path}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'GET' ? {} : { origin: ORIGIN }), ...(who ? { cookie: who.cookie } : {}) },
  }), { address: '203.0.113.9' });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : { data: {} }) as Reply };
}
const health = async () => (await call('GET', '/system/health')).json.data;
const bell = async (extra = '', who: { cookie: string } = office) => (await call('GET', `/alerts?branch=columbus&date=2026-09-15${extra}`, undefined, who)).json.data['alerts'] as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A text that failed its 5th try, with its alert (the shape tryText writes). */
async function gaveUp(customerId: string, job: number): Promise<string> {
  const a = db.admin();
  const t = (await a.query<{ id: string }>(
    `INSERT INTO world.outbox_text (customer_id, job_number, kind, language, encoding, body, characters, status, tries, due_at, created_at)
     VALUES ($1, $2, 'confirmation', 'en', 'gsm7', 'x', 1, 'gave_up', 5, $3, $3) RETURNING id`, [customerId, job, NOW])).rows[0]!.id;
  await openAlert(a, 'text_gave_up', { subject: t, branchId: 'columbus', link: '/office/messages/call-list?date=2026-09-15', values: { textId: t, jobNumber: job } }, {
    now: Temporal.Instant.from(NOW), clock: { realNow: () => Temporal.Instant.from('2026-11-01T16:00:00Z') },
  });
  return t;
}

const logged: string[] = [];

async function userWithSession(role: 'manager' | 'office', email: string, name: string) {
  const id = (await db.admin().query<{ id: string }>(
    `INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, sample, reviewer)
     VALUES ($1, $2, lower($2), $3, 'columbus', 'en', 'active', false, false) RETURNING id`, [email, name, role])).rows[0]!.id;
  const store = new SqlSessionStore(web);
  const clock = { realNow: () => realNow('session_lifetime') };
  const cookie = sessionCookie(await startSession(store, clock, { userId: id, role }, { client: 'web', via: 'password', keepSignedIn: false }), false, false).split(';')[0] as string;
  return { id, cookie };
}

beforeAll(async () => {
  const a = db.admin();
  ref = await seedOutboxWorld(a, NOW);
  for (const s of alertSettingDefaults()) await a.query('INSERT INTO world.alert_setting (type, bell, managers_email) VALUES ($1, $2, $3)', [s.type, s.bell, s.managersEmail]);
  web = createPool({ connectionString: loginUrl(db.url(), 'bw_web'), max: 4 });
  kernel = createWebKernel({
    settings: loadConfig({
      DATABASE_URL: loginUrl(db.url(), 'bw_web'), ACCESS_CODE_ON: 'off', PBS_URL: 'http://127.0.0.1:9', BACKUP_TARGET: 'lightsail',
      DATA_LOCATION_APP: 'AWS Lightsail, US East (Virginia)', DATA_LOCATION_BACKUPS: 'AWS Lightsail object storage, US East (Virginia)',
    }),
    log: createLogger({ process: 'web', write: (line) => void logged.push(line) }),
  });
  manager = await userWithSession('manager', 'dana.health@example.test', 'Dana Ruiz');
  office = await userWithSession('office', 'keisha.health@example.test', 'Keisha Thompson');
  pham = await addCustomer(a, ref, { name: 'Linh Pham' });
  await a.query('UPDATE world.branch SET zone = $2 WHERE id = $1', [ref.branchId, 'America/New_York']);
});

afterAll(async () => {
  await kernel?.close();
  await web?.end();
});

describe('who may call the health rows', () => {
  // why: FR-HLTH-1 the System health page is a manager's page (D13); the bell's list is the office's
  it('refuses API-70, API-71, API-160 and API-161 to the office, and answers the bell to both', async () => {
    expect((await call('GET', '/system/health', undefined, office)).status).toBe(403);
    expect((await call('PUT', '/system/text-simulator', { mode: 'up' }, office)).status).toBe(403);
    expect((await call('POST', '/system/checks', {}, office)).status).toBe(403);
    expect((await call('PUT', '/system/alert-settings/text_gave_up', { bell: false }, office)).status).toBe(403);
    expect((await call('GET', '/alerts?branch=columbus', undefined, null)).status).toBe(401);
    expect((await call('GET', '/alerts?branch=columbus', undefined, manager)).status).toBe(200);
  });
});

describe('the bell and the alert list (FR-DISP-12, FR-HLTH-4)', () => {
  // why: FR-DISP-12 after UC-06's 5th failure the bell's count rises by 1 and its list names the customer
  it('counts a text that gave up, names its customer and the kind, and opens the call list', async () => {
    expect(await bell()).toEqual([]);
    const job = await addJob(db.admin(), ref, pham);
    const text = await gaveUp(pham, job);
    const list = await bell();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      type: 'text_gave_up', state: 'open', messageKey: 'alert.text_gave_up', link: '/office/messages/call-list?date=2026-09-15',
      messageValues: { textId: text, customer: 'Linh Pham', kind: 'confirmation', jobNumber: job },
    });
  });

  // why: FR-HLTH-4 with that alert type's bell switch off a second UC-06 run leaves the bell count unchanged and the alert is still listed on System health (F-430)
  it('leaves a bell-off type out of the bell, still lists it on System health, and counts it again when the switch is back on', async () => {
    const before = (await bell()).length;
    const off = await call('PUT', '/system/alert-settings/text_gave_up', { bell: false });
    expect(off.json.data).toEqual({ alertSetting: { type: 'text_gave_up', bell: false, managersEmail: false } });
    const second = await gaveUp(await addCustomer(db.admin(), ref, { name: 'Deborah Lin' }), await addJob(db.admin(), ref, pham, '2026-09-17'));
    expect(await bell()).toEqual([]);
    const listed = (await health()).alerts as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(listed.filter((a) => a.type === 'text_gave_up').map((a) => a.messageValues.customer).sort()).toEqual(['Deborah Lin', 'Linh Pham']);
    expect(listed.find((a) => a.messageValues.textId === second)).toMatchObject({ state: 'open' });
    await call('PUT', '/system/alert-settings/text_gave_up', { bell: true });
    expect((await bell()).length).toBe(before + 1);
  });

  // why: FR-HLTH-4 the switches are 1 per alert type; an unknown type and an empty change are refused
  it('refuses a type it does not know and a body with no switch', async () => {
    expect((await call('PUT', '/system/alert-settings/not_a_type', { bell: true })).status).toBe(404);
    expect((await call('PUT', '/system/alert-settings/text_gave_up', {})).status).toBe(422);
    const settings = (await health()).alertSettings as Array<{ type: string; bell: boolean; managersEmail: boolean }>;
    expect(settings.find((s) => s.type === 'backup_failed')).toEqual({ type: 'backup_failed', bell: true, managersEmail: true });
    expect(settings).toHaveLength(10);
  });
});

describe("a manager's copy of an alert email (FR-AUTH-8 note, OA-74; F-431)", () => {
  // why: FR-HLTH-4 with an alert type's email switch on each manager's on-screen inbox gets 1 alert email, opened once by a one-time link on the alert (F-431)
  it('says a copy waits, opens it on the click with a fresh one-time link, uses it once, then says it was opened', async () => {
    await call('PUT', '/system/alert-settings/text_gave_up', { managersEmail: true });
    const t = await gaveUp(await addCustomer(db.admin(), ref, { name: 'Lee Park' }), await addJob(db.admin(), ref, pham, '2026-09-18'));
    const find = async () => ((await health()).alerts as Array<Record<string, any>>).find((a) => a.messageValues.textId === t)!; // eslint-disable-line @typescript-eslint/no-explicit-any
    const shown = await find();
    expect(shown).toMatchObject({ emailed: true, emailWaiting: true, emailOpened: false });
    expect((await bell('', manager)).find((a) => a.messageValues.textId === t)).toMatchObject({ emailed: true, emailWaiting: true });
    const click = () => call('POST', `/alerts/${shown.id}/email-link`, {});
    const minted = await click();
    expect(minted.status).toBe(200);
    const link = minted.json.data['link'] as string;
    expect(link).toMatch(/^\/email\/[A-Za-z0-9_-]{20,}$/);
    const opened = await openEmailLink(db.admin(), link.slice('/email/'.length), NOW);
    expect(opened).toMatchObject({ toAddress: 'dana.health@example.test', kind: 'alert' });
    expect(await find()).toMatchObject({ emailWaiting: false, emailOpened: true });
    // Spent: a late click in another view is refused, and that view re-reads to the used note.
    expect((await click()).status).toBe(404);
    // The office user is not a manager: no copy, no waiting flag, no opened flag, and the click is a manager's.
    expect((await bell()).find((a) => a.messageValues.textId === t)).toMatchObject({ emailed: true, emailWaiting: false, emailOpened: false });
    expect((await call('POST', `/alerts/${shown.id}/email-link`, {}, office)).status).toBe(403);
  });

  // why: FR-HLTH-4, UI-SPECIFICATION CTL-OFC-28-04 the bell offers the same link as Recent alerts: no view retires a link another view opens (F-660)
  it('writes nothing on a read, so no view can retire a link', async () => {
    await call('PUT', '/system/alert-settings/text_gave_up', { managersEmail: true });
    const t = await gaveUp(await addCustomer(db.admin(), ref, { name: 'Sam Reader' }), await addJob(db.admin(), ref, pham, '2026-09-18'));
    const rows = async () => (await db.admin().query<{ h: string }>(`SELECT encode(token_hash, 'hex') AS h FROM world.email_link ORDER BY 1`)).rows;
    const before = await rows();
    await health();
    await bell('', manager);
    await health();
    expect(await rows()).toEqual(before);
    const answer = JSON.stringify(await health()) + JSON.stringify(await bell('', manager));
    expect(answer).not.toContain('/email/');
    const id = ((await health()).alerts as Array<Record<string, any>>).find((a) => a.messageValues.textId === t)!.id as string; // eslint-disable-line @typescript-eslint/no-explicit-any
    const link = (await call('POST', `/alerts/${id}/email-link`, {})).json.data['link'] as string;
    await health();
    await bell('', manager);
    expect(await openEmailLink(db.admin(), link.slice('/email/'.length), NOW)).not.toBeNull();
  });
});

describe('Check now (API-160, FR-HLTH-4)', () => {
  // why: FR-HLTH-4 Check now sets Last check to the current demo time and reruns every check at once
  it('runs the rules, answers the demo time, and API-70 reads it back as Last check', async () => {
    await call('PUT', '/system/alert-settings/restore_test_failed', { managersEmail: false });
    await db.admin().query(`INSERT INTO system.backup_record (kind, location, started_real, finished_real, result) VALUES ('restore_test', 'test', now() - interval '3 hours', now() - interval '2 hours', 'failed')`);
    const r = await call('POST', '/system/checks', {});
    expect(r.status).toBe(200);
    expect(r.json.data['lastCheck']).toMatch(/^2026-09-15T10:00:00-04:00\[America\/New_York\]$/);
    expect(r.json.data['overall']).toMatchObject({ working: false });
    const h = await health();
    expect(h.lastCheck).toBe(r.json.data['lastCheck']);
    expect((h.alerts as Array<{ type: string; state: string }>).some((a) => a.type === 'restore_test_failed' && a.state === 'open')).toBe(true);
    // A rerun with nothing new opens nothing twice.
    const again = await call('POST', '/system/checks', {});
    expect(again.json.data['overall']).toEqual(r.json.data['overall']);
  });

  // why: F-661, F-498 FR-HLTH-4 a failing check says why it failed at Check now too: the run's line and the log carry the cause, never the record text
  it('writes a rule that threw into the result line and logs its cause', async () => {
    const rules = RULES as Record<string, unknown>;
    const original = rules['text_gave_up'];
    rules['text_gave_up'] = async () => {
      throw Object.assign(new Error('planted record text'), { code: '23505', constraint: 'alert_one_open_per_type_subject' });
    };
    logged.length = 0;
    try {
      expect((await call('POST', '/system/checks', {})).status).toBe(200);
    } finally {
      rules['text_gave_up'] = original;
    }
    const last = await db.admin().query<{ result: string }>(`SELECT result FROM world.scheduled_event WHERE kind = 'alert.check' AND result LIKE 'check now:%' ORDER BY id DESC LIMIT 1`);
    expect(last.rows[0]!.result).toContain('rules failed text_gave_up(23505 alert_one_open_per_type_subject)');
    expect(logged.join('')).toContain('alert_rule_failed text_gave_up 23505 alert_one_open_per_type_subject');
    expect(logged.join('')).not.toContain('planted');
  });

  // why: FR-HLTH-4 Check now works on the same checks as the worker: the worker's run is the other writer of Last check
  it('reads the worker\'s own run as Last check too', async () => {
    await db.admin().query(`INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state, run_at, result) VALUES ($1, 'alert.check', 'alerts', '{}', 'done', $1, 'x')`, ['2026-09-15T14:05:00Z']);
    expect((await health()).lastCheck).toBe('2026-09-15T10:05:00-04:00[America/New_York]');
    const a = db.admin();
    await a.query('BEGIN');
    const once = await runAlertChecks(a, { now: Temporal.Instant.from(NOW), clock: { realNow: () => realNow('record_stamp') }, backupTarget: 'lightsail' });
    await a.query('COMMIT');
    expect(once.failed).toEqual([]);
  });
});

describe('the text simulator (API-71, FR-TEXT-16)', () => {
  // why: FR-TEXT-16 each mode, once set, is stored with the inputs it names and who set it
  it('stores each mode with its customer or N, names who set it, and refuses a mode with the wrong inputs', async () => {
    const all = await call('PUT', '/system/text-simulator', { mode: 'all_fail' });
    expect(all.json.data['textSimulator']).toMatchObject({ mode: 'all_fail', customerId: null, nLeft: null, setBy: 'Dana Ruiz' });
    const one = await call('PUT', '/system/text-simulator', { mode: 'fail_customer', customerId: pham });
    expect(one.json.data['textSimulator']).toMatchObject({ mode: 'fail_customer', customerId: pham, customerName: 'Linh Pham', nLeft: null });
    const n = await call('PUT', '/system/text-simulator', { mode: 'fail_next_n', n: 3 });
    expect(n.json.data['textSimulator']).toMatchObject({ mode: 'fail_next_n', customerId: null, nLeft: 3 });
    expect((await health()).textSimulator).toMatchObject({ mode: 'fail_next_n', nLeft: 3, setBy: 'Dana Ruiz' });
    for (const bad of [
      { mode: 'fail_customer' }, { mode: 'fail_customer', customerId: '00000000-0000-4000-8000-000000000000' }, { mode: 'fail_next_n' },
      { mode: 'fail_next_n', n: 21 }, { mode: 'fail_next_n', n: 0 }, { mode: 'all_fail', n: 2 }, { mode: 'up', customerId: pham },
    ]) expect((await call('PUT', '/system/text-simulator', bad)).status).toBe(422);
    const up = await call('PUT', '/system/text-simulator', { mode: 'up' });
    expect(up.json.data['textSimulator']).toMatchObject({ mode: 'up', customerId: null, nLeft: null });
    expect((await db.admin().query<{ mode: string }>('SELECT mode FROM world.text_simulator')).rows).toEqual([{ mode: 'up' }]);
  });

  // why: FR-TEXT-16 a copy whose seed wrote no simulator row still takes the manager's pick (F-643): the pick is never silently dropped
  it('writes the simulator row when a copy has none', async () => {
    await db.admin().query('DELETE FROM world.text_simulator');
    expect((await health()).textSimulator).toMatchObject({ mode: 'up', setBy: null });
    const r = await call('PUT', '/system/text-simulator', { mode: 'all_fail' });
    expect(r.json.data['textSimulator']).toMatchObject({ mode: 'all_fail', setBy: 'Dana Ruiz' });
    expect((await db.admin().query<{ mode: string }>('SELECT mode FROM world.text_simulator')).rows).toEqual([{ mode: 'all_fail' }]);
    await call('PUT', '/system/text-simulator', { mode: 'up' });
  });
});

describe('the page numbers (FR-HLTH-1 to FR-HLTH-3)', () => {
  // why: FR-HLTH-3 the typical and slowest values equal an independent computation on the stored measurements, over the last 60 real minutes only
  it('reports the median and the maximum of the last 60 real minutes against the 5 s goal', async () => {
    const a = db.admin();
    await a.query('DELETE FROM system.delay_sample');
    for (const [min, ms] of [[5, 1200], [10, 900], [20, 4000], [30, 1500], [90, 60_000]] as const) {
      await a.query(`INSERT INTO system.delay_sample (seq, emitted_real, acked_real, ms) VALUES ($1, now() - make_interval(mins => $2), now() - make_interval(mins => $2), $3)`, [min, min, ms]);
    }
    const d = (await health()).delay;
    expect(d.samples.map((s: { ms: number }) => s.ms).sort((x: number, y: number) => x - y)).toEqual([900, 1200, 1500, 4000]);
    expect(d).toMatchObject({ typicalMs: 1350, slowestMs: 4000, goalMs: 5000 });
    await a.query('DELETE FROM system.delay_sample');
    expect((await health()).delay).toMatchObject({ samples: [], typicalMs: null, slowestMs: null });
  });

  // why: FR-HLTH-1 every value equals the stored record, with the times as real time; FR-HLTH-2 the 4 locations come from the running copy's settings
  it('shows the stored backup and restore tests as real time, the 7 nights, and the 4 locations', async () => {
    const a = db.admin();
    await a.query('DELETE FROM system.backup_record');
    await a.query(
      `INSERT INTO system.backup_record (kind, location, started_real, finished_real, result, size_bytes, nights_kept)
       VALUES ('backup', 'lightsail://bw/2026-11-01', date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' + interval '2 hours 30 minutes',
               date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' + interval '2 hours 37 minutes', 'passed', 2576980378, 30)`);
    await a.query(`INSERT INTO system.backup_record (kind, location, started_real, finished_real, result) VALUES ('restore_test', 'x', now() - interval '9 days', now() - interval '9 days' + interval '23 minutes', 'passed'), ('restore_test', 'x', now() - interval '2 days', now() - interval '2 days' + interval '31 minutes', 'failed')`);
    const h = await health();
    expect(h.backupSetUp).toBe(true);
    expect(h.backup).toMatchObject({ result: 'passed', sizeBytes: 2576980378, nightsKept: 30, copiesAt: 'lightsail://bw/2026-11-01' });
    expect(h.backup.at).toMatch(/T02:30:00-0[45]:00\[America\/New_York\]$/);
    expect(h.backup.finishedAt).toMatch(/T02:37:00/);
    expect(h.backup.nextAt).toMatch(/T02:30:00-0[45]:00\[America\/New_York\]$/);
    expect(h.backups).toHaveLength(7);
    expect(h.backups[6].result).toBe('passed');
    expect(h.backups[0].result).toBeNull();
    expect(h.restoreTests.map((t: { result: string; minutes: number; first: boolean }) => [t.result, t.minutes, t.first])).toEqual([['failed', 31, false], ['passed', 23, true]]);
    expect(h.restoreNextAt).toMatch(/T04:00:00-0[45]:00\[America\/New_York\]$/);
    expect(Temporal.ZonedDateTime.from(h.restoreNextAt).dayOfWeek).toBe(7);
    expect(h.locations).toEqual({
      app: 'AWS Lightsail, US East (Virginia)', backups: 'AWS Lightsail object storage, US East (Virginia)', texts: 'This computer', maps: 'This computer',
    });
  });

  // why: FR-TEXT-12 the retry queue and the held list name each text's customer, kind, try and time; FR-BILL-2 the billing card reads the world
  it('lists the retrying and the held texts and counts the day', async () => {
    const a = db.admin();
    const deborah = await addCustomer(a, ref, { name: 'Deborah Lin', zone: 'America/Los_Angeles' });
    await a.query(
      `INSERT INTO world.outbox_text (customer_id, kind, language, encoding, body, characters, status, tries, next_try_at, due_at, created_at)
       VALUES ($1, 'confirmation', 'en', 'gsm7', 'x', 1, 'retrying', 2, $2, $2, $2)`, [pham, '2026-09-15T14:31:00Z']);
    await a.query(
      `INSERT INTO world.outbox_text (customer_id, kind, language, encoding, body, characters, status, held_until, due_at, created_at)
       VALUES ($1, 'confirmation', 'en', 'gsm7', 'x', 1, 'held', '2026-09-15T15:00:00Z', '2026-09-15T14:00:00Z', '2026-09-15T14:00:00Z')`, [deborah]);
    const o = (await health()).outbox;
    expect(o.retryingTexts).toEqual([{ textId: expect.any(String), customer: 'Linh Pham', kind: 'confirmation', status: 'retrying', tries: 2, nextTryAt: '2026-09-15T10:31:00-04:00[America/New_York]' }]);
    expect(o.heldTexts).toEqual([{ textId: expect.any(String), customer: 'Deborah Lin', kind: 'confirmation', heldUntil: '2026-09-15T08:00:00-07:00[America/Los_Angeles]', heldUntilBranch: '2026-09-15T11:00:00-04:00[America/New_York]' }]);
    expect(o).toMatchObject({ retrying: 1, held: 1, notSentToday: 4, today: 6 });
    expect((await health()).billing).toMatchObject({ mode: null, waiting: 0, listed: [], finishedToday: 0, inBillingToday: 0 });
  });
});

describe('Dismiss an alert (API-176; SD-30, F-875, owner ruling 9f7f745a)', () => {
  /** An office text about no visit that failed its 5th try, with its alert. */
  async function gaveUpOffice(customerId: string): Promise<string> {
    const a = db.admin();
    const t = (await a.query<{ id: string }>(
      `INSERT INTO world.outbox_text (customer_id, job_number, kind, language, encoding, body, characters, status, tries, due_at, created_at)
       VALUES ($1, NULL, 'office', 'en', 'gsm7', 'x', 1, 'gave_up', 5, $2, $2) RETURNING id`, [customerId, NOW])).rows[0]!.id;
    await openAlert(a, 'text_gave_up', { subject: t, branchId: 'columbus', link: '/office/messages/call-list?date=2026-09-15', values: { textId: t } }, {
      now: Temporal.Instant.from(NOW), clock: { realNow: () => Temporal.Instant.from('2026-11-01T16:00:00Z') },
    });
    return t;
  }
  const alertOf = async (text: string, who: { cookie: string } = office) => (await bell('', who)).find((a) => a.messageValues.textId === text)!;

  // why: SD-30, API-43, API-70 only an open text-gave-up alert for an office text about no visit is dismissible; the bell and System health both say so
  it('marks only the open no-visit office text alert dismissible, in the bell and on System health', async () => {
    const office1 = await gaveUpOffice(await addCustomer(db.admin(), ref, { name: 'Pat Dismiss' }));
    const visit = await gaveUp(await addCustomer(db.admin(), ref, { name: 'Vi Sit' }), await addJob(db.admin(), ref, pham, '2026-09-18'));
    expect(await alertOf(office1)).toMatchObject({ state: 'open', dismissible: true });
    expect(await alertOf(visit)).toMatchObject({ state: 'open', dismissible: false });
    const onHealth = ((await health()).alerts as Array<Record<string, any>>).find((a) => a.messageValues.textId === office1); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(onHealth).toMatchObject({ dismissible: true });
  });

  // why: SD-30, API-176 Dismiss closes the alert at demo now; a second press and any other alert answer rule_refused; the next alert check does not reopen it
  it('resolves the alert at demo now, refuses a second dismiss and any other alert, and the check leaves it closed', async () => {
    const t = await gaveUpOffice(await addCustomer(db.admin(), ref, { name: 'Dee Missal' }));
    const other = await gaveUp(await addCustomer(db.admin(), ref, { name: 'Oh Ther' }), await addJob(db.admin(), ref, pham, '2026-09-18'));
    const id = (await alertOf(t)).id as string;
    const ok = await call('POST', `/alerts/${id}/dismiss`, {}, office);
    expect([ok.status, ok.json.data['alert']]).toEqual([200, { id, state: 'resolved', resolvedAt: expect.stringMatching(/^2026-09-15T10:00:00-04:00/) }]);
    expect(await alertOf(t)).toMatchObject({ state: 'resolved', dismissible: false });
    const again = await call('POST', `/alerts/${id}/dismiss`, {}, office);
    expect([again.status, again.json.code]).toEqual([409, 'rule_refused']);
    const refused = await call('POST', `/alerts/${(await alertOf(other)).id}/dismiss`, {}, manager);
    expect([refused.status, refused.json.code]).toEqual([409, 'rule_refused']);
    expect((await call('POST', '/system/checks', {})).status).toBe(200);
    expect(await alertOf(t)).toMatchObject({ state: 'resolved' });
    expect((await db.admin().query(`SELECT 1 FROM world.alert WHERE type = 'text_gave_up' AND subject = $1 AND state = 'open'`, [t])).rows).toEqual([]);
    expect((await call('POST', '/alerts/00000000-0000-4000-8000-000000000000/dismiss', {}, manager)).status).toBe(404);
    expect((await call('POST', `/alerts/${id}/dismiss`, {}, null)).status).toBe(401);
  });

  // why: F-1156, SD-30, EVT-04 Dismiss publishes alert.dismissed with the alert id and its branch at commit, so every other open bell and System health page re-reads; a refused dismiss publishes nothing
  it('publishes alert.dismissed with the alert and its branch when Dismiss commits, and nothing on a refusal', async () => {
    const t = await gaveUpOffice(await addCustomer(db.admin(), ref, { name: 'Tab Two' }));
    const id = (await alertOf(t)).id as string;
    const listener = createClient({ connectionString: db.url() });
    await listener.connect();
    const notices: { name: string; ids: Record<string, unknown> }[] = [];
    listener.on('notification', (m) => {
      const d = m.channel === BUS_CHANNEL ? decodeNotification(m.payload) : null;
      if (d?.name === 'alert.dismissed') notices.push(d);
    });
    await listener.query(`LISTEN ${BUS_CHANNEL}`);
    try {
      expect((await call('POST', `/alerts/${id}/dismiss`, {}, office)).status).toBe(200);
      await vi.waitFor(() => expect(notices).toEqual([{ name: 'alert.dismissed', ids: { alertId: id, branch: 'columbus' } }]), { timeout: 5_000, interval: 20 });
      expect((await call('POST', `/alerts/${id}/dismiss`, {}, office)).status).toBe(409);
      await settle();
      expect(notices).toHaveLength(1);
    } finally {
      listener.removeAllListeners('notification');
      await listener.end();
    }
  });
});
