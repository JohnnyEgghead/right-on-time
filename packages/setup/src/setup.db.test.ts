// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: OI-57, R-BP1, SD-24, SD-12, FR-IMP-10, FR-DISP-11, FR-DISP-20 (P2-SETUP Acceptance: the fresh end-to-end run)
// A fresh end-to-end `pnpm run setup` on an empty PostgreSQL 18 database (not even migrated), through the CLI the
// operator runs, then the Acceptance assertions on what it wrote, read back as the schema owner and through the
// production web kernel (createWebKernel, as the web process's login bw_web) for API-84 and API-130.
// Run by gate import-target-counts (ci/gates/import-target-counts/vitest.db.config.ts).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@bw/config';
import { createClient, createPool, resetWorld, verifyPassword } from '@bw/db';
import { alertSettingDefaults } from '@bw/domain';
import { createLogger } from '@bw/log';
import { realNow, Temporal, type RealTimeUse } from '@bw/time';
import { composeFromJob } from '../../../apps/worker/src/billing/compose.ts';
import { drainDue } from '../../../apps/worker/src/dispatcher.ts';
import { autopilotStepHandler } from '../../../apps/worker/src/outbox/autopilot.ts';
import { etaSweepHandler } from '../../../apps/worker/src/outbox/eta-sweep.ts';
import { catalogs } from '../../i18n/src/catalog.ts';
import { sessionCookie, SqlSessionStore, startSession } from '../../api-server/src/kernel/sessions.ts';
import { settleDay } from '../../api-server/src/office-writes/day.ts';
import { createWebKernel, type WebKernel } from '../../api-server/src/web.ts';
import { samplePassword } from '../../db/src/passwords.ts';
import { BRANCHES, MOCKUP_PARTS, PARTS, PARTS_COUNT } from '../../db/src/seed/reference-data.ts';
import { createDatabase, type TestDatabase } from '../../db/src/testing/database.ts';
import { pgAdminUrl } from '../../db/src/testing/provided.ts';
import { parseCsv } from '../../import/src/csv.ts';
import { TEST_SAMPLE_SEED } from '../../import/src/testing/world.ts';
import { SETUP_MOVER_NAME } from './snapshot.ts';
import { generateChecked, streetListFile } from './pipeline.ts';
import { parseFixture } from './fixture.ts';
import { RESET_DEMO_TIME } from './snapshot.ts';
import { chainCensusSql } from './testing/census.ts';
import { BILLING_HISTORY, BILLING_RECORD, DANA_EMAIL, KEISHA_EMAIL, MARCO, OFFICE_NOTE } from './world-seed.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const run = promisify(execFile);
const ORIGIN = 'http://localhost:8080';

let db: TestDatabase;
let admin: ReturnType<typeof createClient>;
let setupOut = { stdout: '', stderr: '' };
let kernel: WebKernel;
let sessionPool: ReturnType<typeof createPool>;
let office = '';

// F-1549: about 2.2 times the slowest green setup in the gate on the Spectre CI rig (D-15 measured-value rule): the beforeAll
// below took 125.7 s at 54a12538 (nightly, green) while the gate's other 6 files built their worlds beside it; 170 s was
// 1.35 times that, and the nightly at 14a96fe1, about 1.4 times slower beside a push run, ran past it.
const SETUP_LIMIT_MS = 280_000;
const setup = (url: string) => run('pnpm', ['run', '--silent', 'setup'], {
  cwd: ROOT, timeout: SETUP_LIMIT_MS, env: { ...process.env, DATABASE_URL: url, SAMPLE_PASSWORD_SEED: TEST_SAMPLE_SEED, REVIEWER_PASSWORD: '' },
});
const as = (login: string) => {
  const u = new URL(db.url);
  u.username = login;
  return u.toString();
};
const rows = async <T>(sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows as T[];
const n = async (sql: string, params: unknown[] = []) => Number((await rows<{ n: string }>(sql, params))[0]?.n);
const get = async (p: string) => (await kernel.router.handle(new Request(`http://web:3000/api/v1${p}`, { method: 'GET', headers: { cookie: office } }), { address: '203.0.113.9' }));
const post = (p: string, body: unknown) => kernel.router.handle(new Request(`http://web:3000/api/v1${p}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: office },
}), { address: '203.0.113.9' });

beforeAll(async () => {
  // F-414: a fresh worktree has no verified street list, and setup then fails with a bare 'setup: FAIL Error'; name the cause here.
  const streetList = path.resolve(import.meta.dirname, '..', '..', '..', '.build', 'data', 'street-list.json');
  if (!existsSync(streetList)) throw new Error(`${streetList} is missing: run \`node ci/data-assets.ts ensure\` (it fetches and verifies the street list)`);
  db = await createDatabase(pgAdminUrl(), 'bw_setup');
  setupOut = await setup(db.url);
  admin = createClient({ connectionString: db.url });
  await admin.connect();
  // PBS_URL: a port nothing listens on, so API-60's mode read answers "cannot tell" at once (no pbs runs beside this test).
  kernel = createWebKernel({ settings: loadConfig({ DATABASE_URL: as('bw_web'), ACCESS_CODE_ON: 'off', PBS_URL: 'http://127.0.0.1:9' }), log: createLogger({ process: 'web', write: () => undefined }) });
  sessionPool = createPool({ connectionString: as('bw_web'), max: 1 });
  const keisha = (await rows<{ id: string }>(`SELECT id FROM world."user" WHERE email = 'keisha.t@brightwater.example'`))[0]?.id as string;
  const clock = { realNow: (use: RealTimeUse) => (use === 'session_idle' ? realNow('session_idle') : realNow('session_lifetime')) };
  const token = await startSession(new SqlSessionStore(sessionPool), clock, { userId: keisha, role: 'office' }, { client: 'web', via: 'password', keepSignedIn: false });
  office = sessionCookie(token, false, false).split(';')[0] as string;
}, SETUP_LIMIT_MS + 20_000);
afterAll(async () => {
  await kernel?.close();
  await sessionPool?.end();
  await admin?.end();
  await db?.drop();
});

describe('a fresh pnpm run setup on an empty PostgreSQL 18 (D-3, OI-57)', () => {
  // why: SD-24, F-557 (a run with no MAPS_DIR says 'maps not checked' before its first step)
  it('completes with exit 0 through all 6 steps in order, with 0 foreign-key errors', () => {
    const states = setupOut.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => (JSON.parse(l) as { status: string }).status);
    // F-1668: with MAPS_DIR set the maps are checked, so 'maps not checked' is absent; the list is named per state.
    const afterStart = ['reference seed written', 'export generated', 'dry run done', 'import started', 'import committed', 'world seed written', 'snapshot written', 'setup done'];
    expect(states).toEqual(process.env.MAPS_DIR ? ['migrated', 'setup started', ...afterStart] : ['migrated', 'setup started', 'maps not checked', ...afterStart]);
    expect(setupOut.stderr).not.toMatch(/foreign key|23503/);
  });

  // why: SD-24
  it("every job's customer exists and is not a merged record B; every job's technician and window exist", async () => {
    expect(await n('SELECT count(*) AS n FROM world.job')).toBeGreaterThan(1000);
    expect(await n(`SELECT count(*) AS n FROM world.job j LEFT JOIN world.customer c ON c.id = j.customer_id
                     WHERE c.id IS NULL OR c.status <> 'active' OR c.merged_into IS NOT NULL`)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM world.job j WHERE (j.technician_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM world.technician t WHERE t.id = j.technician_id))
                       OR NOT EXISTS (SELECT 1 FROM world.arrival_window w WHERE w.id = j.window_id)`)).toBe(0);
    // F-292: the only jobs with no technician are the 3 the Jobs page shows Unassigned
    expect((await rows<{ job_number: number }>('SELECT job_number FROM world.job WHERE technician_id IS NULL ORDER BY 1')).map((r) => r.job_number)).toEqual([24840, 24841, 24842]);
    expect(await n(`SELECT count(*) AS n FROM world.membership m JOIN world.customer c ON c.id = m.customer_id WHERE c.status <> 'active'`)).toBe(0);
  });

  // why: SD-24, SD-25
  it("every pilot_call row's customer and its past visit or job exist, and the call's customer is the visit's", async () => {
    expect(await n('SELECT count(*) AS n FROM world.pilot_call')).toBeGreaterThan(1000);
    expect(await n(`SELECT count(*) AS n FROM world.pilot_call p
                      LEFT JOIN world.customer c ON c.id = p.customer_id
                      LEFT JOIN world.past_visit v ON v.id = p.past_visit_id
                      LEFT JOIN world.job j ON j.job_number = p.job_number
                     WHERE c.id IS NULL OR (v.id IS NULL AND j.job_number IS NULL)
                        OR coalesce(v.customer_id, j.customer_id) <> p.customer_id
                        OR coalesce(v.technician_id, j.technician_id) <> p.technician_id`)).toBe(0);
    expect(await n('SELECT count(*) AS n FROM world.pilot_call WHERE job_number IS NOT NULL')).toBeGreaterThan(0);
  });

  // why: F-314
  it("analyzes the tables the real import filled before the world seed reads them: the planner's row counts are the real ones", async () => {
    // The test server runs with autovacuum off, so setup's own ANALYZE is the only writer of these counts (never analyzed: -1).
    const r = await rows<{ relname: string; reltuples: number }>(
      `SELECT relname, reltuples FROM pg_class WHERE relnamespace = 'world'::regnamespace
          AND relname IN ('customer', 'past_visit', 'equipment', 'import_problem_row', 'duplicate_pair', 'merge', 'import_run') ORDER BY relname`);
    const { past_visit: visits, ...exact } = Object.fromEntries(r.map((x) => [x.relname, Number(x.reltuples)]));
    // the dry run's problem list stays (section 6.7), so problem rows are both runs'
    expect(exact).toEqual({ customer: 18_400, duplicate_pair: 1_240, equipment: 30_904, import_problem_row: 2 * 1_184, import_run: 2, merge: 812 });
    // past_visit is sampled (95,870 rows is over ANALYZE's 30,000-row sample): within 5 % of the real count
    expect(Math.abs((visits ?? 0) - 95_870)).toBeLessThan(95_870 * 0.05);
  });

  // why: SD-24, FR-IMP-10
  it('the dry-run and real-run history rows carry the SD-24 times and are recorded as setup\'s', async () => {
    const r = await rows<{ kind: string; status: string; by_setup: boolean; s: string; f: string }>(
      `SELECT kind, status, by_setup, to_char(started_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS s,
              to_char(finished_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS f FROM world.import_run ORDER BY started_at`);
    expect(r).toEqual([
      { kind: 'dry_run', status: 'done', by_setup: true, s: '2026-08-31 05:38', f: '2026-08-31 05:59' },
      { kind: 'real', status: 'done', by_setup: true, s: '2026-08-31 06:02', f: '2026-08-31 06:44' },
    ]);
  });

  // why: SD-21, F-238
  it("Maria Santos's 10:00 AM to 12:00 PM Harold Jenkins job 24830 exists on Tue, Sep 15, after her job 24825 at 8-10 AM", async () => {
    const r = await rows<{ job_number: number; customer: string; technician: string; w: string }>(
      `SELECT j.job_number, c.name AS customer, t.name AS technician,
              to_char(j.window_start AT TIME ZONE j.zone, 'YYYY-MM-DD HH24:MI') || '-' || to_char(j.window_end AT TIME ZONE j.zone, 'HH24:MI') AS w
         FROM world.job j JOIN world.customer c ON c.id = j.customer_id JOIN world.technician t ON t.id = j.technician_id
        WHERE j.job_number IN (24825, 24830) ORDER BY j.job_number`);
    expect(r).toEqual([
      { job_number: 24825, customer: expect.any(String), technician: 'Maria Santos', w: '2026-09-15 08:00-10:00' },
      { job_number: 24830, customer: 'Harold Jenkins', technician: 'Maria Santos', w: '2026-09-15 10:00-12:00' },
    ]);
    // SD-21: Harold's job and Maria's later ones wait for a visitor; the autopilot finishes her 8-10 job (F-1183 ruling).
    expect(await n(`SELECT count(*) AS n FROM world.scheduled_event WHERE kind = 'autopilot.step' AND subject = 'job:24830'`)).toBe(0);
    expect(await rows(`SELECT payload->>'step' AS step FROM world.scheduled_event WHERE kind = 'autopilot.step' AND subject = 'job:24825' ORDER BY due_at, id`))
      .toEqual([{ step: 'on_my_way' }, { step: 'arrived' }, { step: 'finished' }]);
  });

  // why: SD-25, FR-REP-8, F-1132, F-1151 the Late texts sent card reads stored rows: near the frame's 74 in each whole pilot week, all in the after period, each with the rows a real one leaves
  it('plants 74 delivered late texts in each whole pilot week and 12 on the Monday of Sep 14, with their attempt, inbox row and job columns', async () => {
    // Through API-50, the read the card uses, as a manager (FR-REP-1). The weeks of Aug 31 and Sep 7 hold 6 working days each, and the
    // week of Sep 14 only its Monday, so it takes the same per-day share: 74 / 6, rounded.
    const dana = (await rows<{ id: string }>(`SELECT id FROM world."user" WHERE email = $1`, [DANA_EMAIL]))[0]?.id as string;
    const clock = { realNow: (use: RealTimeUse) => (use === 'session_idle' ? realNow('session_idle') : realNow('session_lifetime')) };
    const token = await startSession(new SqlSessionStore(sessionPool), clock, { userId: dana, role: 'manager' }, { client: 'web', via: 'password', keepSignedIn: false });
    const res = await kernel.router.handle(new Request('http://web:3000/api/v1/reports?fromWeek=2026-08-31&toWeek=2026-09-14', {
      method: 'GET', headers: { cookie: sessionCookie(token, false, false).split(';')[0] as string },
    }), { address: '203.0.113.9' });
    expect(res.status).toBe(200);
    const report = (await res.json()) as { data: { lateTexts: { week: string; count: number }[] } };
    expect(report.data.lateTexts).toEqual([{ week: '2026-08-31', count: 74 }, { week: '2026-09-07', count: 74 }, { week: '2026-09-14', count: 12 }]);
    expect(await n(`SELECT count(*) AS n FROM world.outbox_text WHERE kind = 'late' AND status = 'delivered'`)).toBe(160);
    // The after period starts Jul 20 and the pilot jobs they point at run Aug 31 to Sep 14: none is in the before period (Jun 1 to Jul 13).
    expect(await n(`SELECT count(*) AS n FROM world.outbox_text o JOIN world.job j ON j.job_number = o.job_number
                     WHERE o.kind = 'late' AND (o.delivered_at AT TIME ZONE j.zone)::date NOT BETWEEN DATE '2026-08-31' AND DATE '2026-09-14'`)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM world.outbox_text o
                     WHERE o.kind = 'late' AND o.tries = 1 AND o.delivered_at = o.created_at AND o.link_token IS NULL AND o.sent_by IS NULL
                       AND EXISTS (SELECT 1 FROM world.text_attempt a WHERE a.text_id = o.id AND a.number = 1 AND a.result = 'delivered')
                       AND EXISTS (SELECT 1 FROM world.inbox_message m WHERE m.text_id = o.id AND m.direction = 'out' AND m.body = o.body AND m.at = o.delivered_at)
                       AND EXISTS (SELECT 1 FROM world.job j WHERE j.job_number = o.job_number AND j.late_text_sent_at = o.delivered_at AND j.texted_arrival IS NOT NULL)`)).toBe(160);
    // FR-TEXT-5 (section 6.4): every one meets the 20-minute rule against its stored baseline, as the sweep would have sent it: the
    // arrival and the texted arrival each 20 or more minutes after late_text_was_arrival, sent at or before the arrival, on a pilot visit.
    expect(await n(`SELECT count(*) AS n FROM world.outbox_text o JOIN world.job j ON j.job_number = o.job_number
                     WHERE o.kind = 'late' AND j.pilot AND j.late_text_was_arrival IS NOT NULL
                       AND j.arrived_at - j.late_text_was_arrival >= interval '20 minutes'
                       AND j.texted_arrival - j.late_text_was_arrival >= interval '20 minutes'
                       AND o.delivered_at <= j.arrived_at AND o.delivered_at >= j.window_start`)).toBe(160);
    // 1 per visit, and no text to a customer with texts off or no mobile.
    expect(await n(`SELECT count(DISTINCT job_number) AS n FROM world.outbox_text WHERE kind = 'late'`)).toBe(160);
    expect(await n(`SELECT count(*) AS n FROM world.outbox_text o JOIN world.customer c ON c.id = o.customer_id WHERE o.kind = 'late' AND (NOT c.texts_on OR c.mobile IS NULL)`)).toBe(0);
  });

  // why: F-1158, SD-15 every pilot job keeps its planned arrival, so a stored late-text baseline can be read against where it came from
  it('writes the SD-15 planned arrival on every pilot job, and a late-texted one has it as its baseline', async () => {
    expect(await n('SELECT count(*) AS n FROM world.job WHERE pilot')).toBeGreaterThan(0);
    expect(await n('SELECT count(*) AS n FROM world.job WHERE pilot AND planned_arrival IS NULL')).toBe(0);
    expect(await n('SELECT count(*) AS n FROM world.job WHERE pilot AND late_text_was_arrival IS NOT NULL AND late_text_was_arrival = planned_arrival')).toBe(160);
  });

  // why: F-652 the seed plans each seeded future scheduled visit's reminder, as every other creator of a job does (FR-TEXT-2, FR-DEMO-3)
  it('plans 1 text.reminder per seeded scheduled visit after the first day, at 6:00 PM the evening before, and none for the first day', async () => {
    const future = await n(`SELECT count(*) AS n FROM world.job WHERE status = 'scheduled' AND date > DATE '2026-09-15'`);
    expect(future).toBeGreaterThan(0);
    expect(await n(`SELECT count(*) AS n FROM world.scheduled_event WHERE kind = 'text.reminder' AND state = 'due'`)).toBe(future);
    expect(await n(`SELECT count(DISTINCT subject) AS n FROM world.scheduled_event WHERE kind = 'text.reminder'`)).toBe(future);
    expect(await n(`SELECT count(*) AS n FROM world.scheduled_event e JOIN world.job j ON j.job_number = e.subject::int
                     WHERE e.kind = 'text.reminder' AND (e.due_at AT TIME ZONE j.zone)::time <> TIME '18:00' OR (e.kind = 'text.reminder' AND j.date <= DATE '2026-09-15')`)).toBe(0);
  });

  // why: F-339 the seeded service calls' parts lines follow the disclosed spread rule and name parts beyond the 10 mockup parts
  // why: F-429 the rule is guarded by bounds near the measured counts and by an independent family-to-service table, not by the production function
  // why: F-428 every seeded line names a part that fits its job's service
  it('the seeded jobs use parts beyond the 10 mockup parts, and every line fits its job service', async () => {
    const { rows: steps } = await admin.query<{ job: number; service: string; codes: string[] }>(
      `SELECT (e.payload->>'jobNumber')::int AS job, j.service_id AS service, ARRAY(SELECT jsonb_array_elements_text(e.payload->'partCodes')) AS codes
         FROM world.scheduled_event e JOIN world.job j ON j.job_number = (e.payload->>'jobNumber')::int
        WHERE e.kind = 'autopilot.step' AND e.payload->>'step' = 'finished'`);
    const mockup = new Set(MOCKUP_PARTS.map((p) => p.code));
    const catalog = new Set(PARTS.map((p) => p.code));
    const used = steps.flatMap((s) => s.codes);
    const distinct = new Set(used);
    const beyond = [...distinct].filter((c) => !mockup.has(c));
    const share = used.filter((c) => mockup.has(c)).length / used.length;
    // measured on this seed: 708 lines, 460 distinct non-mockup codes, mockup share 0.192 (bounds are within 10%)
    expect(used.length).toBeGreaterThan(708 * 0.9);
    expect(used.length).toBeLessThan(708 * 1.1);
    expect(beyond.length).toBeGreaterThan(460 * 0.9);
    expect(beyond.length).toBeLessThan(460 * 1.1);
    expect(share).toBeGreaterThan(0.192 * 0.9);
    expect(share).toBeLessThan(0.192 * 1.1);
    expect(used.every((c) => catalog.has(c))).toBe(true);
    // the family-to-service table, written out here on purpose (not derived from the seed's own table)
    const AIR = ['furnace_tune_up', 'ac_tune_up', 'heating_or_ac_fix'];
    const PLUMB = ['plumbing_repair', 'water_heater', 'tankless_heater_flush', 'sump_pump_install', 'boiler_repair'];
    const FITS: Record<string, string[]> = {
      VLV: PLUMB, FIT: PLUMB, PIP: PLUMB,
      ELC: [...AIR, 'thermostat', 'boiler_repair', 'sump_pump_install'],
      MTR: [...AIR, 'boiler_repair'], FLT: AIR,
      WTR: ['water_heater', 'tankless_heater_flush', 'plumbing_repair'],
      CTL: [...AIR, 'thermostat', 'boiler_repair'],
      REF: ['ac_tune_up', 'heating_or_ac_fix'],
      MSC: [...AIR, ...PLUMB, 'thermostat'],
      RCK: AIR, CAP: AIR, HOS: AIR, WF: ['plumbing_repair'],
      CLP: [...AIR, 'plumbing_repair', 'water_heater', 'tankless_heater_flush', 'sump_pump_install'],
    };
    for (const s of steps) {
      for (const c of s.codes) expect({ job: s.job, service: s.service, code: c, fits: FITS[c.split('-')[0] as string]?.includes(s.service) }).toMatchObject({ fits: true });
    }
    expect(await n(`SELECT count(*) AS n FROM world.part`)).toBe(PARTS_COUNT);
  });

  // why: SD-12, F-251
  it('the snapshot exists at world epoch 1: every world and pbs table copied, the day_snapshot row, the reset clock_move by Setup', async () => {
    const tables = async (s: string) => n(`SELECT count(*) AS n FROM pg_tables WHERE schemaname = $1`, [s]);
    expect(await tables('world_snapshot')).toBe(await tables('world'));
    expect(await tables('pbs_snapshot')).toBe(await tables('pbs'));
    expect(await n('SELECT count(*) AS n FROM world_snapshot.customer')).toBe(await n('SELECT count(*) AS n FROM world.customer'));
    expect(await n('SELECT count(*) AS n FROM world_snapshot.pilot_call')).toBe(await n('SELECT count(*) AS n FROM world.pilot_call'));
    expect(await rows('SELECT schema_name, label FROM system.day_snapshot')).toEqual([{ schema_name: 'world_snapshot', label: 'Setup: world epoch 1' }]);
    const m = await rows<{ kind: string; by_name: string; world_epoch: number; to: string }>(
      `SELECT kind, by_name, world_epoch, to_char(to_demo AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS to FROM system.clock_move`);
    expect(m).toEqual([{ kind: 'reset', by_name: SETUP_MOVER_NAME, world_epoch: 1, to: '2026-09-15 07:00' }]);
    // F-251: epoch 1 is unconfirmed (pbs_epoch 0), so the reset confirmer resets pbs and unpauses, as after every reset.
    expect(await rows('SELECT world_epoch, pbs_epoch, paused FROM system.demo_clock')).toEqual([{ world_epoch: 1, pbs_epoch: 0, paused: true }]);
  });

  // why: F-444
  it('the world seed writes the section 3 seed rows the worker never writes: 1 alert_setting row per SD-30 type and exactly 1 due alert.check, in the world and its snapshot', async () => {
    const want = alertSettingDefaults().map((d) => ({ type: d.type, bell: d.bell, managers_email: d.managersEmail, set_by: null, set_at: null }))
      .sort((a, b) => (a.type < b.type ? -1 : 1));
    expect(want).toHaveLength(10);
    for (const schema of ['world', 'world_snapshot']) {
      expect(await rows(`SELECT type, bell, managers_email, set_by, set_at FROM ${schema}.alert_setting ORDER BY type COLLATE "C"`)).toEqual(want);
      expect(await rows(`SELECT to_char(due_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS at, subject FROM ${schema}.scheduled_event WHERE kind = 'alert.check' AND state = 'due'`))
        .toEqual([{ at: '2026-09-15 07:00', subject: 'alerts' }]);
    }
  });

  // why: FR-TEXT-16, F-643 the text simulator has its 1 row, mode up with nobody's name on it, in the world and its snapshot (the writer table gives it to the seed)
  it('the world seed writes the text simulator row: mode up, no customer, no count, nobody set it', async () => {
    for (const schema of ['world', 'world_snapshot']) {
      expect(await rows(`SELECT mode, customer_id, n_left, set_by, set_at FROM ${schema}.text_simulator`)).toEqual([{ mode: 'up', customer_id: null, n_left: null, set_by: null, set_at: null }]);
    }
  });

  // why: F-359
  it('role pbs can read every pbs_snapshot table setup wrote (migration 0011), so its reset can restore the snapshot', async () => {
    const unreadable = await rows<{ t: string }>(
      `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pbs_snapshot' AND c.relkind = 'r' AND NOT has_table_privilege('pbs', c.oid, 'SELECT') ORDER BY 1`);
    expect(unreadable).toEqual([]);
    expect(await n(`SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'pbs_snapshot'`)).toBeGreaterThan(0);
  });

  // why: F-150
  it('setup ran as the schema owner: role app reads nothing of the snapshot, which the reset alone reads', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE app');
      await expect(admin.query('SELECT 1 FROM world_snapshot.customer LIMIT 1')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  // why: F-272
  it('seeds Marco P. as an office staff user with his sample password', async () => {
    const u = await rows<{ role: string; status: string; password_hash: string }>(`SELECT role, status, password_hash FROM world."user" WHERE name = $1`, [MARCO.name]);
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ role: 'office', status: 'active' });
    expect(await verifyPassword(samplePassword(TEST_SAMPLE_SEED, MARCO.email), u[0]?.password_hash ?? '')).toBe(true);
  });

  // why: FR-IMP-10
  it("the office's real-run endpoint (API-84) refuses with real_run_exists once setup's run exists, and writes nothing", async () => {
    const before = await n('SELECT count(*) AS n FROM world.import_run');
    const r = await post('/import/runs', { kind: 'real' });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe('real_run_exists');
    expect(await n('SELECT count(*) AS n FROM world.import_run')).toBe(before);
  });

  // why: FR-DISP-11
  it("the top-bar search (API-130) finds job 24825, a sample customer's address by its street name, and both O'Briens", async () => {
    type Found = { jobs: { jobNumber: number }[]; customers: { name: string }[]; addresses: { address: string }[] };
    const search = async (query: string) => ((await (await post('/searches', { query, branch: 'columbus' })).json()) as { data: Found }).data;
    expect((await search('24825')).jobs[0]?.jobNumber).toBe(24825);
    const h = (await rows<{ house_number: number; street: string; city: string }>(
      `SELECT c.house_number, s.name AS street, s.city FROM world.customer c JOIN world.street s ON s.id = c.street_id WHERE c.name = 'Harold Jenkins'`))[0];
    const byStreet = await search(h?.street ?? '');
    const own = `${h?.house_number} ${h?.street}, ${h?.city}`;
    expect(byStreet.addresses.map((a) => a.address)).toContain(own);
    expect((await search(`${h?.house_number} ${h?.street}`)).addresses.map((a) => a.address)).toContain(own);
    const names = (await search("O'Brien")).customers.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Sean O'Brien", "Kathleen O'Brien-Miller"]));
  });

  // why: FR-DISP-20, FR-IMP-7
  it('every number a sample Call control dials is in 555-0100 to 555-0199 or is a branch office number', async () => {
    const offices = new Set<string>(BRANCHES.map((b) => b.phone));
    const numbers = await rows<{ phone: string }>(
      `SELECT mobile AS phone FROM world.customer WHERE mobile IS NOT NULL UNION SELECT home_phone FROM world.customer WHERE home_phone IS NOT NULL
       UNION SELECT phone FROM world.technician UNION SELECT office_phone FROM world.branch`);
    expect(numbers.length).toBeGreaterThan(10);
    const outside = numbers.map((r) => r.phone).filter((p) => !offices.has(p) && !/^\+1(614|937)55501\d\d$|^\(\d{3}\) 555-01\d\d$/.test(p));
    expect(outside).toEqual([]);
  });

  // why: SD-21, FR-DEMO-8 owner answer 36d87aec: the steps written to the world are chained (F-513: 139 and 67 of 332 before; F-292: 329 with the 3 unassigned Jobs page jobs)
  it('writes every autopilot step after the previous visit of its technician-day ends', async () => {
    expect(await rows(chainCensusSql())).toEqual([{ pairs: 329, left_during_visit: 0, on_site_at_two: 0 }]);
  });

  // why: F-815, SD-21: a step on the same minute as the end of the visit before runs after it, in the dispatcher's own order (due_at, id), so its text measures from the right stop; F-292: 43 same-minute pairs, was 38; F-1651: 42 on approximate minutes, 73 on the baked tracks (the 10:28 AM story pins)
  it('runs each On my way after the end of the visit before, even on the same minute', async () => {
    // F-1665: the count is the drive minutes', so it is named per state: setup chains on the manifest's baked tracks when
    // MAPS_DIR is set (it verifies them first), else on SD-22's approximate minutes.
    const SAME_MINUTE_PAIRS = process.env.MAPS_DIR ? 73 : 42;
    expect(await rows(`
      WITH s AS (SELECT subject, due_at, payload->>'step' AS step, row_number() OVER (ORDER BY due_at, id) AS rn FROM world.scheduled_event WHERE kind = 'autopilot.step'),
      v AS (SELECT j.technician_id, j.date, j.planned_arrival,
                   min(s.rn) FILTER (WHERE s.step = 'on_my_way') AS starts, min(s.due_at) FILTER (WHERE s.step = 'on_my_way') AS start_at,
                   max(s.rn) FILTER (WHERE s.step IN ('finished', 'no_one_home')) AS ends, max(s.due_at) FILTER (WHERE s.step IN ('finished', 'no_one_home')) AS end_at
              FROM s JOIN world.job j ON s.subject = 'job:' || j.job_number GROUP BY j.job_number),
      l AS (SELECT starts, start_at, lag(ends) OVER w AS before_ends, lag(end_at) OVER w AS before_end_at FROM v WINDOW w AS (PARTITION BY technician_id, date ORDER BY planned_arrival))
      SELECT count(*)::int AS pairs, (count(*) FILTER (WHERE start_at = before_end_at))::int AS same_instant, (count(*) FILTER (WHERE starts < before_ends))::int AS out_of_order
        FROM l WHERE before_ends IS NOT NULL`)).toEqual([{ pairs: 329, same_instant: SAME_MINUTE_PAIRS, out_of_order: 0 }]);
  });

  // why: SD-15 F-356: the first office write on a seeded technician-day moves nothing, because the seed wrote what that write computes
  it("leaves every seeded planned arrival unchanged when SD-15's day plan is recomputed for each seeded technician-day", async () => {
    const days = await rows<{ technician_id: string; date: string }>(
      `SELECT DISTINCT technician_id, date::text AS date FROM world.job WHERE NOT pilot AND technician_id IS NOT NULL ORDER BY 1, 2`);
    expect(days.length).toBeGreaterThan(100);
    const read = () => rows<{ job_number: number; at: string }>('SELECT job_number, planned_arrival::text AS at FROM world.job WHERE NOT pilot AND technician_id IS NOT NULL ORDER BY job_number');
    const before = await read();
    expect(before.every((j) => j.at !== null)).toBe(true);
    await admin.query('BEGIN');
    try {
      for (const d of days) expect(await settleDay(admin, { technicianId: d.technician_id, date: d.date })).toBeNull();
      expect(await read()).toEqual(before);
    } finally {
      await admin.query('ROLLBACK');
    }
  }, 120_000);

  // why: SD-21, FR-DEMO-8
  it("at 9:00 AM on the sample day the autopilot has moved the seeded jobs through their scripted steps and left Harold Jenkins's 10 AM job 24830 and Maria's later jobs for a visitor", async () => {
    const worker = createPool({ connectionString: as('bw_worker'), max: 2 });
    try {
      const textContext = { catalogs, linkHost: 'bw.j7l.io' };
      // A replay from the start of the week to 9:00 AM EDT on Tue, Sep 15: the demo clock sits before every event, so each runs at its own due time.
      const through = Temporal.Instant.from('2026-09-15T13:00:00Z');
      const report = await drainDue(worker, { 'autopilot.step': autopilotStepHandler(textContext), 'eta.sweep': etaSweepHandler(textContext) },
        { through, demoNow: Temporal.Instant.from('2026-09-01T00:00:00Z'), log: createLogger({ process: 'worker', write: () => undefined }), epoch: (await worker.query<{ world_epoch: number }>('SELECT world_epoch FROM system.demo_clock WHERE id = 1')).rows[0]!.world_epoch });
      expect(report.failed).toEqual([]);
      // Every seeded job stands where its last due step leaves it: no due step, still scheduled.
      const NEXT: Record<string, string> = { on_my_way: 'on_the_way', arrived: 'on_site', finished: 'done', no_one_home: 'no_one_home' };
      const jobs = await rows<{ job_number: number; status: string; last_step: string | null; touched_by_person: boolean }>(
        `SELECT j.job_number, j.status, j.touched_by_person,
                (SELECT e.payload->>'step' FROM world.scheduled_event e WHERE e.kind = 'autopilot.step' AND e.subject = 'job:' || j.job_number AND e.due_at <= $1
                  ORDER BY e.due_at DESC, e.id DESC LIMIT 1) AS last_step
           FROM world.job j WHERE EXISTS (SELECT 1 FROM world.scheduled_event e WHERE e.kind = 'autopilot.step' AND e.subject = 'job:' || j.job_number)`, [through.toString()]);
      expect(jobs.length).toBeGreaterThan(100);
      const wrong = jobs.filter((j) => j.status !== (j.last_step === null ? 'scheduled' : NEXT[j.last_step])).map((j) => [j.job_number, j.status, j.last_step]);
      expect(wrong).toEqual([]);
      expect(jobs.filter((j) => j.last_step !== null).length).toBeGreaterThan(10);
      expect(jobs.some((j) => j.status === 'on_the_way' || j.status === 'on_site')).toBe(true);
      expect(jobs.some((j) => j.touched_by_person)).toBe(false);
      // The happy path's start: Harold Jenkins's 10 AM job and Maria's jobs from it onward are untouched, with no item and no status change.
      const waiting = await rows<{ job_number: number; status: string; touched_by_person: boolean; items: string; changes: string }>(
        `SELECT j.job_number, j.status, j.touched_by_person,
                (SELECT count(*) FROM world.tech_item i WHERE i.job_number = j.job_number) AS items,
                (SELECT count(*) FROM world.job_change c WHERE c.job_number = j.job_number AND c.kind = 'status') AS changes
           FROM world.job j JOIN world.technician t ON t.id = j.technician_id
          WHERE j.job_number = 24830 AND t.name = 'Maria Santos'`);
      expect(waiting).toEqual([{ job_number: 24830, status: 'scheduled', touched_by_person: false, items: '0', changes: '0' }]);
      expect(await n(`SELECT count(*) AS n FROM world.job j JOIN world.technician t ON t.id = j.technician_id
                       WHERE t.name = 'Maria Santos' AND j.date = '2026-09-15' AND j.window_start >= '2026-09-15T10:00:00-04:00' AND j.status <> 'scheduled'`)).toBe(0);
      // The sweep chain is 1 due event, 5 demo minutes after the last run.
      expect(await n(`SELECT count(*) AS n FROM world.scheduled_event WHERE kind = 'eta.sweep' AND state = 'due'`)).toBe(1);
    } finally {
      await worker.end();
    }
  }, 280_000);

  // why: SD-24
  it('a second setup on the set-up world stops with world_not_fresh and writes nothing', async () => {
    const runs = await n('SELECT count(*) AS n FROM world.import_run');
    const err = await setup(db.url).then(() => null, (e: { code: number; stdout: string; stderr: string }) => e);
    expect(err?.code).toBe(1);
    // F-327: a stop is 1 JSON line whose errorCode is the stop's code, and setup writes no console text.
    expect(err?.stdout).toContain('"status":"setup refused"');
    expect(err?.stdout).toContain('"errorCode":"world_not_fresh"');
    expect(err?.stderr).not.toMatch(/setup: /);
    expect(await n('SELECT count(*) AS n FROM world.import_run')).toBe(runs);
  });
});

describe('the channel and the person on the seeded jobs (F-293, owner ruling b23b26d9 "Match the page")', () => {
  const fixture = () => parseFixture(generateChecked(streetListFile(process.env))['fixture.json']);
  const people = new Map([[MARCO.email, 'Marco P.'], [KEISHA_EMAIL, 'Keisha Thompson'], [DANA_EMAIL, 'Dana Ruiz']]);

  // why: F-293 after a fresh setup no seeded job has booked_via seed; the office and online counts are the fixture's bookedVia counts;
  // an office job's booked_by is a seeded office user and an online job's is null; the approved Jobs page's two bookers carry their jobs
  it('writes booked_via from the fixture and booked_by on each office job', async () => {
    const fx = fixture();
    const all = [...fx.pilotJobs, ...fx.demoWeekJobs];
    const want = (via: string) => all.filter((j) => j.bookedVia === via).length;
    expect(await n(`SELECT count(*) AS n FROM world.job WHERE booked_via = 'seed'`)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM world.job WHERE booked_via = 'office'`)).toBe(want('office'));
    expect(await n(`SELECT count(*) AS n FROM world.job WHERE booked_via = 'online'`)).toBe(want('online'));
    expect(await n(`SELECT count(*) AS n FROM world.job j JOIN world."user" u ON u.id = j.booked_by
                     WHERE j.booked_via = 'office' AND u.role IN ('office', 'manager') AND u.sample AND u.status = 'active'`)).toBe(want('office'));
    expect(await n(`SELECT count(*) AS n FROM world.job WHERE booked_via = 'online' AND booked_by IS NOT NULL`)).toBe(0);
    // the approved Jobs page: 24800 is Office - Marco P.; 24791, 24805 and 24840 are Office - Keisha T. (F-555)
    const named = await rows<{ job_number: number; name: string }>(
      `SELECT j.job_number, u.name FROM world.job j JOIN world."user" u ON u.id = j.booked_by WHERE j.job_number IN (24791, 24800, 24805, 24840) ORDER BY 1`);
    expect(named).toEqual([{ job_number: 24791, name: 'Keisha Thompson' }, { job_number: 24800, name: 'Marco P.' },
      { job_number: 24805, name: 'Keisha Thompson' }, { job_number: 24840, name: 'Keisha Thompson' }]);
    // each office job's created row names its booker; an online job's names the customer
    expect(await n(`SELECT count(*) AS n FROM world.job j JOIN world.job_change c ON c.job_number = j.job_number AND c.kind = 'created'
                     WHERE (j.booked_via = 'office' AND c.actor_kind = 'office' AND c.actor_user_id = j.booked_by)
                        OR (j.booked_via = 'online' AND c.actor_kind = 'customer' AND c.actor_user_id IS NULL)`)).toBe(all.length);
  });

  // why: F-293 each history entry the approved pages name exists for its job and names its person
  it('writes the history entries and the office note that name the office people', async () => {
    for (const h of BILLING_HISTORY) {
      const r = await rows<{ name: string; actor_kind: string }>(
        `SELECT u.name, c.actor_kind FROM world.job_change c JOIN world."user" u ON u.id = c.actor_user_id WHERE c.job_number = $1 AND c.kind = $2`, [h.jobNumber, h.kind]);
      expect(r, `${h.kind} on ${h.jobNumber}`).toEqual([{ name: people.get(h.by), actor_kind: 'office' }]);
    }
    const note = await rows<{ name: string; body: string; entered_at: Date; who: string }>(
      `SELECT u.name, n.body, n.entered_at, c.name AS who FROM world.note n JOIN world."user" u ON u.id = n.author_user_id JOIN world.customer c ON c.id = n.customer_id
        WHERE n.job_number IS NULL`);
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({ name: 'Marco P.', body: OFFICE_NOTE.body, who: OFFICE_NOTE.customer });
    expect(note[0]?.entered_at.toISOString().slice(0, 10)).toBe(OFFICE_NOTE.date);
    // every person a seeded job or history row names is a seeded office user
    expect(await n(`SELECT count(*) AS n FROM world.job_change c LEFT JOIN world."user" u ON u.id = c.actor_user_id
                     WHERE c.actor_kind = 'office' AND (u.id IS NULL OR u.role NOT IN ('office', 'manager'))`)).toBe(0);
  });

  // why: F-554, F-293, FR-BILL-12 at the reset demo time the billing page's Fixed in the last 7 days table (API-60, the record the page
  // reads) names the 3 people of the approved page, from the billing records the seed writes as the live writers leave them
  it('lists the 3 seeded history jobs in the Fixed table with their people at the reset demo time', async () => {
    expect((await rows<{ demo_anchor: Date }>('SELECT demo_anchor FROM system.demo_clock'))[0]?.demo_anchor.toISOString()).toBe(RESET_DEMO_TIME.toISOString());
    const want: Record<number, Record<string, unknown>> = {
      24671: { how: 'sent_again', tries: 2, by: 'Marco P.', reasonKind: 'data_error', reason: 'Refused customer account', markedReason: null },
      24755: { how: 'corrected', tries: 2, by: 'Keisha Thompson', reasonKind: 'data_error', reason: 'Refused part code', markedReason: null },
      24688: { how: 'marked_fixed', tries: 1, by: 'Dana Ruiz', reasonKind: 'data_error', reason: 'Account closed', markedReason: 'Entered in billing by hand' },
    };
    for (const h of BILLING_HISTORY) {
      const { branch_id: branch, billing_state: state } = (await rows<{ branch_id: string; billing_state: string }>(
        'SELECT branch_id, billing_state FROM world.job WHERE job_number = $1', [h.jobNumber]))[0]!;
      expect(state, `job ${h.jobNumber} billing_state`).toBe(BILLING_RECORD[h.kind].state);
      const res = await get(`/billing/queue?branch=${branch}`);
      expect(res.status).toBe(200);
      const q = ((await res.json()) as { data: { items: { jobNumber: number }[]; leftLast7Days: { jobNumber: number }[] } }).data;
      expect(q.leftLast7Days.find((l) => l.jobNumber === h.jobNumber), `job ${h.jobNumber} in the Fixed table`).toMatchObject(want[h.jobNumber]!);
      expect(q.items.some((i) => i.jobNumber === h.jobNumber)).toBe(false);
    }
    // Each try is a billing_attempt row (append-only history), and the item's tries count them.
    expect(await rows(`SELECT bi.job_number, bi.tries, count(a.*)::int AS attempts FROM world.billing_item bi JOIN world.billing_attempt a USING (job_number)
                        WHERE bi.job_number = ANY($1::int[]) GROUP BY 1, 2 HAVING bi.tries <> count(a.*)`, [BILLING_HISTORY.map((h) => h.jobNumber)])).toEqual([]);
  });

  // why: F-293 2 setups from the same seed write identical rows (D-3); both are fresh databases, since the shared one has been written to
  it('writes the same job and history rows on 2 fresh setups', async () => {
    const digest = `SELECT md5(string_agg(concat_ws('|', j.job_number, j.booked_via, u.email, j.version), ',' ORDER BY j.job_number)) AS d FROM world.job j LEFT JOIN world."user" u ON u.id = j.booked_by`;
    const changes = `SELECT md5(string_agg(concat_ws('|', c.job_number, c.kind, u.email, c.actor_kind, c.from_version, c.to_version, c.at, c.data), ',' ORDER BY c.job_number, c.kind, c.at)) AS d
                       FROM world.job_change c LEFT JOIN world."user" u ON u.id = c.actor_user_id`;
    const notes = `SELECT md5(string_agg(concat_ws('|', n.job_number, n.body, u.email, n.entered_at, n.item_key), ',' ORDER BY n.job_number, n.entered_at, n.body)) AS d
                     FROM world.note n JOIN world."user" u ON u.id = n.author_user_id`;
    // why: F-1541 the past jobs' records are a function of the fixture too: ids and item keys included
    const past = `SELECT md5(concat_ws('#',
        (SELECT string_agg(concat_ws('|', job_number, seq, text), ',' ORDER BY job_number, seq) FROM world.work_done_line),
        (SELECT string_agg(concat_ws('|', jp.job_number, p.code, jp.quantity), ',' ORDER BY jp.job_number, p.code) FROM world.job_part jp JOIN world.part p ON p.id = jp.part_id),
        (SELECT string_agg(concat_ws('|', key, job_number, kind, base_version, demo_time, received_at), ',' ORDER BY key) FROM world.tech_item),
        (SELECT string_agg(concat_ws('|', job_number, on_the_way_at, labor_minutes, no_parts_used, billing_state), ',' ORDER BY job_number) FROM world.job),
        (SELECT string_agg(concat_ws('|', job_number, state, tries, last_try_at, left_at), ',' ORDER BY job_number) FROM world.billing_item),
        (SELECT string_agg(concat_ws('|', job_number, number, at, result), ',' ORDER BY job_number, number) FROM world.billing_attempt),
        (SELECT string_agg(concat_ws('|', job_number, received_at, how, total_cents, customer_name, done_at), ',' ORDER BY job_number) FROM pbs.invoice),
        (SELECT string_agg(concat_ws('|', job_number, seq, kind, label, code, quantity, unit_cents, amount_cents), ',' ORDER BY job_number, seq) FROM pbs.invoice_line),
        (SELECT string_agg(concat_ws('|', id, job_number, at, answer), ',' ORDER BY id) FROM pbs."call"),
        (SELECT string_agg(concat_ws('|', n.id, n.job_number), ',' ORDER BY n.id) FROM world.note n WHERE n.item_key IS NOT NULL OR n.job_number IN (SELECT job_number FROM world.job WHERE pilot)))) AS d`;
    const read = async (name: string): Promise<string[]> => {
      const d = await createDatabase(pgAdminUrl(), name);
      try {
        await run('pnpm', ['run', '--silent', 'setup'], {
          cwd: ROOT, timeout: 170_000, env: { ...process.env, DATABASE_URL: d.url, SAMPLE_PASSWORD_SEED: TEST_SAMPLE_SEED, REVIEWER_PASSWORD: '' },
        });
        const c = createClient({ connectionString: d.url });
        await c.connect();
        try {
          const out: string[] = [];
          for (const sql of [digest, changes, notes, past]) out.push((await c.query(sql)).rows[0]?.d as string);
          return out;
        } finally {
          await c.end();
        }
      } finally {
        await d.drop();
      }
    };
    const a = await read('bw_setup_a');
    const b = await read('bw_setup_b');
    for (const d of a) expect(d).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toEqual(a);
  }, 240_000);
});

// why-describe: F-1541 (owner ruling 9796c392, Nov 13, 2026: "Fill them in"), SD-25: each ended pilot job carries the record a live visit leaves.
describe('the past pilot jobs carry their visit steps, finish, sent bill and some notes (F-1541)', () => {
  // why: F-1541, SD-25 each ended pilot job has its technician's status steps as the technician app writes them (1 history row and 1
  // ledger row per item, version + 1 each), and the steps leave the outcome columns the reports read as the fixture wrote them
  it('writes On my way, Arrived, Finished (or On my way, No one home) per ended pilot job, by its technician, in order', async () => {
    const bad = await rows(`
      WITH s AS (
        SELECT j.job_number, j.status, j.version, j.arrived_at, j.ended_at, j.on_the_way_at, j.technician_id,
               array_agg(c.data->>'item' ORDER BY c.at, c.from_version) AS items, array_agg(c.at ORDER BY c.at, c.from_version) AS ats,
               array_agg(c.from_version ORDER BY c.at, c.from_version) AS froms, max(c.to_version) AS last,
               bool_and(t.user_id = c.actor_user_id AND c.actor_kind = 'technician') AS by_tech,
               bool_and(i.key IS NOT NULL AND i.result = 'applied' AND i.kind = c.data->>'item' AND i.base_version = c.from_version AND i.technician_id = j.technician_id) AS ledger
          FROM world.job j JOIN world.technician t ON t.id = j.technician_id
          JOIN world.job_change c ON c.job_number = j.job_number AND c.kind = 'status'
          LEFT JOIN world.tech_item i ON i.key = (c.data->>'itemKey')::uuid
         WHERE j.pilot GROUP BY j.job_number)
      SELECT job_number FROM s
       WHERE NOT by_tech OR NOT ledger OR froms[1] <> 1
          OR (status = 'done' AND (items <> ARRAY['on_my_way', 'arrived', 'finished'] OR ats[2] <> arrived_at OR ats[3] <> ended_at OR NOT (ats[1] < arrived_at)))
          OR (status = 'no_one_home' AND (items <> ARRAY['on_my_way', 'no_one_home'] OR ats[2] <> ended_at OR arrived_at IS NOT NULL OR NOT (ats[1] < ended_at)))
          OR on_the_way_at <> ats[1]
          OR version <> last + CASE WHEN EXISTS (SELECT 1 FROM world.job_change x WHERE x.job_number = s.job_number AND x.kind = 'finish_corrected') THEN 1 ELSE 0 END`);
    expect(bad).toEqual([]);
    // Every ended pilot job has them; no demo-week job does (the sample day's autopilot writes those).
    expect(await n(`SELECT count(*) AS n FROM world.job j WHERE j.pilot AND j.status IN ('done', 'no_one_home')
                     AND NOT EXISTS (SELECT 1 FROM world.job_change c WHERE c.job_number = j.job_number AND c.kind = 'status')`)).toBe(0);
    // Read in the snapshot: the sample day's autopilot test above has since moved demo-week jobs.
    expect(await n(`SELECT count(*) AS n FROM world_snapshot.job_change c JOIN world_snapshot.job j USING (job_number) WHERE NOT j.pilot AND c.kind = 'status'`)).toBe(0);
    // A technician's On my way never comes before the end of the visit before it that day (F-1546: no visit is skipped; the
    // fitted ends of past-jobs.ts fitPastVisitEnds make room for every one).
    expect(await n(`SELECT count(*) AS n FROM (SELECT on_the_way_at,
                           lag(ended_at) OVER (PARTITION BY technician_id, date ORDER BY coalesce(arrived_at, ended_at), job_number) AS prev
                      FROM world.job WHERE pilot AND ended_at IS NOT NULL) x
                     WHERE on_the_way_at < prev`)).toBe(0);
    // Each technician-day of the pilot started at its first On my way (applyStatus: technician_day.started_at).
    expect(await n(`SELECT count(*) AS n FROM (SELECT technician_id, date, min(on_the_way_at) AS first FROM world.job WHERE pilot AND ended_at IS NOT NULL GROUP BY 1, 2) f
                      LEFT JOIN world.technician_day d USING (technician_id, date) WHERE d.started_at IS DISTINCT FROM f.first`)).toBe(0);
  });

  // why: F-1546 a technician is at 1 visit at a time: over every ended pilot visit, in the order each technician-day ran them (On my
  // way), none starts its drive or reaches the door before the same technician's previous visit ended, and none ends before it began
  it("finds 0 pilot visits that overlap the same technician's previous visit, over every ended pilot visit", async () => {
    const r = (await rows<{ visits: number; overlaps: number; inverted: number }>(`
      SELECT count(*)::int AS visits,
             count(*) FILTER (WHERE prev IS NOT NULL AND (on_the_way_at < prev OR coalesce(arrived_at, ended_at) <= prev))::int AS overlaps,
             count(*) FILTER (WHERE on_the_way_at >= coalesce(arrived_at, ended_at) OR ended_at <= coalesce(arrived_at, on_the_way_at))::int AS inverted
        FROM (SELECT on_the_way_at, arrived_at, ended_at,
                     lag(ended_at) OVER (PARTITION BY technician_id, date ORDER BY on_the_way_at, job_number) AS prev
                FROM world.job WHERE pilot AND status IN ('done', 'no_one_home')) x`))[0]!;
    const ended = await n(`SELECT count(*) AS n FROM world.job WHERE pilot AND ended_at IS NOT NULL`);
    expect(r).toEqual({ visits: ended, overlaps: 0, inverted: 0 });
    expect(r.visits).toBeGreaterThan(600);
  });

  // why: F-1541, FR-BILL-3 every done pilot job has a finish the finish validator accepts: parts or No parts used, labor minutes from
  // the arrival to the end, and at least 1 work-done line; parts fit the job's service (partCodeForLine)
  it('writes each done pilot job a finish: parts or No parts used, its labor minutes and its work-done lines', async () => {
    expect(await rows(`
      SELECT j.job_number FROM world.job j WHERE j.pilot AND j.status = 'done' AND (
        j.labor_minutes IS DISTINCT FROM round(extract(epoch FROM j.ended_at - j.arrived_at) / 60)::int
        OR (j.no_parts_used = EXISTS (SELECT 1 FROM world.job_part p WHERE p.job_number = j.job_number))
        OR NOT EXISTS (SELECT 1 FROM world.work_done_line w WHERE w.job_number = j.job_number AND w.seq = 1)
        OR EXISTS (SELECT 1 FROM world.job_part p WHERE p.job_number = j.job_number AND p.quantity < 1))`)).toEqual([]);
    expect(await n(`SELECT count(*) AS n FROM world_snapshot.job j WHERE NOT (j.pilot AND j.status = 'done')
                     AND (j.labor_minutes IS NOT NULL OR j.no_parts_used OR EXISTS (SELECT 1 FROM world_snapshot.work_done_line w WHERE w.job_number = j.job_number))`)).toBe(0);
    // Both kinds of finish occur, as on a real week.
    const mix = (await rows<{ none: number; some: number }>(`SELECT count(*) FILTER (WHERE no_parts_used)::int AS none, count(*) FILTER (WHERE NOT no_parts_used)::int AS some
                                                             FROM world.job WHERE pilot AND status = 'done'`))[0]!;
    expect(mix.none).toBeGreaterThan(0);
    expect(mix.some).toBeGreaterThan(mix.none);
  });

  // why: F-1541, FR-BILL-13, FR-BILL-12 every done pilot job's bill was sent: billing holds the invoice composeFromJob composes from the
  // job as stored (the live billing link's read), and the job's billing record is the link's (1 attempt per try, in_billing)
  it("has billing's invoice for every done pilot job, equal to the one the billing link composes from the job", async () => {
    const jobs = (await rows<{ job_number: number }>(`SELECT job_number FROM world.job WHERE pilot AND status = 'done' ORDER BY job_number`)).map((r) => r.job_number);
    expect(jobs.length).toBeGreaterThan(600);
    const mismatched: number[] = [];
    for (const job of jobs) {
      const c = await composeFromJob(admin, job);
      const inv = (await rows<{ total_cents: number; customer_name: string; done_at: Date }>('SELECT total_cents, customer_name, done_at FROM pbs.invoice WHERE job_number = $1', [job]))[0];
      const lines = await rows<Record<string, unknown>>(
        `SELECT kind, label, code, quantity, unit_cents AS "unitCents", amount_cents AS "amountCents" FROM pbs.invoice_line WHERE job_number = $1 ORDER BY seq`, [job]);
      if (!c.ok || !inv || inv.total_cents !== c.totalCents || inv.customer_name !== c.customerName || inv.done_at.toISOString() !== c.doneAt
        || JSON.stringify(lines) !== JSON.stringify(c.lines)) mismatched.push(job);
    }
    expect(mismatched).toEqual([]);
    // The billing record: every done pilot job sent; the 1 Mark fixed job entered by hand (FR-BILL-12); tries = attempts; pbs's calls match.
    expect(await rows(`SELECT j.job_number, j.billing_state, b.state FROM world.job j LEFT JOIN world.billing_item b USING (job_number)
                        WHERE j.pilot AND j.status = 'done' AND (b.state IS NULL OR b.state <> j.billing_state OR b.state NOT IN ('in_billing', 'marked_fixed'))`)).toEqual([]);
    expect(await rows(`SELECT b.job_number FROM world.billing_item b JOIN world.job j USING (job_number)
                        WHERE j.pilot AND b.tries <> (SELECT count(*) FROM world.billing_attempt a WHERE a.job_number = b.job_number)`)).toEqual([]);
    expect(await rows(`SELECT b.job_number FROM world.billing_item b JOIN world.job j USING (job_number) WHERE j.pilot
                        AND b.tries <> (SELECT count(*) FROM pbs."call" c WHERE c.job_number = b.job_number)`)).toEqual([]);
    expect(await rows(`SELECT job_number, how, entered_by_hand_reason AS reason FROM pbs.invoice WHERE how <> 'received'`))
      .toEqual([{ job_number: 24688, how: 'entered_by_hand', reason: 'Entered in billing by hand' }]);
    // A first-try success left no list: no left_at, and its billing_sent history row is the system's at the finish.
    expect(await n(`SELECT count(*) AS n FROM world.billing_item b JOIN world.job j USING (job_number)
                     WHERE j.pilot AND b.tries = 1 AND b.state = 'in_billing' AND (b.left_at IS NOT NULL OR b.last_try_at <> j.ended_at
                       OR NOT EXISTS (SELECT 1 FROM world.job_change c WHERE c.job_number = j.job_number AND c.kind = 'billing_sent' AND c.actor_kind = 'system' AND c.at = j.ended_at AND c.data = '{"try": 1}'))`)).toBe(0);
    // A bill carries the Comfort Club discount line exactly when its customer is a member (FR-BILL-13; composeFromJob's rule, checked above).
    expect(await n(`SELECT count(*) AS n FROM pbs.invoice i JOIN world.job j USING (job_number)
                     WHERE EXISTS (SELECT 1 FROM world.membership m WHERE m.customer_id = j.customer_id)
                       <> EXISTS (SELECT 1 FROM pbs.invoice_line l WHERE l.job_number = i.job_number AND l.kind = 'discount')`)).toBe(0);
  });

  // why: F-1541 about 1 job in 5 has a note: an office note before the visit (API-140's rows) or the technician's during it (the note item's rows)
  it('writes about 1 note per 5 ended pilot jobs, each with the history row and ledger row its live writer leaves', async () => {
    const counts = (await rows<{ jobs: number; noted: number }>(`SELECT count(*)::int AS jobs, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM world.note n WHERE n.job_number = j.job_number))::int AS noted
                                                                 FROM world.job j WHERE j.pilot AND j.ended_at IS NOT NULL`))[0]!;
    expect(counts.noted / counts.jobs).toBeGreaterThan(0.15);
    expect(counts.noted / counts.jobs).toBeLessThan(0.25);
    expect(await rows(`
      SELECT n.job_number, n.author_kind FROM world.note n JOIN world.job j USING (job_number)
        LEFT JOIN world.job_change c ON c.job_number = n.job_number AND c.kind = 'note_added' AND c.data->>'noteId' = n.id::text
        LEFT JOIN world.tech_item i ON i.key = n.item_key
       WHERE j.pilot AND (c.job_number IS NULL OR c.actor_user_id <> n.author_user_id OR c.at <> n.entered_at OR n.sent_at <> n.entered_at
          OR (n.author_kind = 'office' AND (n.entered_at >= j.window_start OR n.item_key IS NOT NULL OR c.actor_kind <> 'office'))
          OR (n.author_kind = 'technician' AND (n.entered_at < coalesce(j.arrived_at, j.on_the_way_at) OR n.entered_at > j.ended_at
              OR i.kind <> 'note' OR i.key IS NULL OR c.actor_kind <> 'technician' OR c.data->>'itemKey' <> n.item_key::text)))`)).toEqual([]);
    expect(await n(`SELECT count(DISTINCT author_kind) AS n FROM world.note n JOIN world.job j USING (job_number) WHERE j.pilot`)).toBe(2);
  });

  // why: F-1541, FR-DISP-5 the office job page (API-23) of a past job reads its steps, finish, bill and history as a real visit's
  it('the office job page of a past done job shows its steps, its finish and its sent bill', async () => {
    const job = (await rows<{ job_number: number }>(`SELECT job_number FROM world.job WHERE pilot AND status = 'done' AND NOT no_parts_used AND job_number <> ALL($1::int[]) ORDER BY job_number LIMIT 1`, [BILLING_HISTORY.map((h) => h.jobNumber)]))[0]!.job_number;
    const res = await get(`/jobs/${job}`);
    expect(res.status).toBe(200);
    const d = ((await res.json()) as { data: { job: { onTheWayAt: string | null; version: number }; timeline: { kind: string; byKind: string; values: Record<string, unknown> }[];
      finish: { parts: unknown[]; laborMinutes: number | null; workDone: string[] } | null; billing: { state: string } } }).data;
    expect(d.job.onTheWayAt).not.toBeNull();
    expect(d.job.version).toBe(4);
    expect(d.timeline.filter((t) => t.kind === 'status').map((t) => [t.byKind, t.values['item']])).toEqual([['technician', 'on_my_way'], ['technician', 'arrived'], ['technician', 'finished']]);
    expect(d.timeline.some((t) => t.kind === 'billing_sent')).toBe(true);
    expect(d.finish?.parts.length).toBeGreaterThan(0);
    expect(d.finish?.laborMinutes).toBeGreaterThan(0);
    expect(d.finish?.workDone.length).toBeGreaterThan(0);
    expect(d.billing.state).toBe('in_billing');
  });

  // why: F-1541, SD-12 the snapshot (what Reset the demo world restores) holds every past-job row the seed wrote
  it('the snapshot holds the same past-job rows as the world', async () => {
    for (const [live, snap, cols] of [
      ['world.work_done_line', 'world_snapshot.work_done_line', 'job_number, seq, text'],
      ['world.job_part', 'world_snapshot.job_part', 'job_number, part_id, quantity'],
      ['world.tech_item', 'world_snapshot.tech_item', 'key, job_number, kind, base_version, demo_time'],
      ['world.note', 'world_snapshot.note', 'job_number, body, entered_at'],
      ['world.billing_item', 'world_snapshot.billing_item', 'job_number, state, tries'],
      ['pbs.invoice', 'pbs_snapshot.invoice', 'job_number, total_cents, how'],
      ['pbs.invoice_line', 'pbs_snapshot.invoice_line', 'job_number, seq, amount_cents'],
    ] as const) {
      // The pilot jobs' rows only: the sample day's autopilot test above has since written demo-week rows.
      const pilot = 'WHERE job_number IN (SELECT job_number FROM world_snapshot.job WHERE pilot)';
      expect(await n(`SELECT count(*) AS n FROM ((SELECT ${cols} FROM ${live} ${pilot} EXCEPT ALL SELECT ${cols} FROM ${snap} ${pilot})
                      UNION ALL (SELECT ${cols} FROM ${snap} ${pilot} EXCEPT ALL SELECT ${cols} FROM ${live} ${pilot})) x`), live).toBe(0);
    }
    expect(await n('SELECT count(*) AS n FROM world_snapshot.work_done_line')).toBeGreaterThan(600);
  });
});

describe('who the Sign in as list shows over a fresh setup (F-317, F-281, F-1654)', () => {
  // The list is the 5 people the approved office sign-in frame shows, in its order (mockups/pages/office-signin.html, CTL-OFC-01-05;
  // owner ruling b66aaae8 "A short list"). The expected names are written here, not read from the handler's constant.
  const FRAME = ['Dana Ruiz', 'Keisha Thompson', 'Ana Gutierrez', 'Maria Santos', 'Luis Ortega'];
  const list = async (app: 'office' | 'tech' = 'office'): Promise<string[]> => {
    const demo = createWebKernel({ settings: loadConfig({ DATABASE_URL: as('bw_web'), DEMO_MODE: 'on', SAMPLE_PASSWORD_SEED: TEST_SAMPLE_SEED, PBS_URL: 'http://127.0.0.1:9' }), log: createLogger({ process: 'web', write: () => undefined }) });
    try {
      const r = await demo.router.handle(new Request(`http://web:3000/api/v1/demo/people?app=${app}`), { address: '203.0.113.9' });
      expect(r.status).toBe(200);
      return ((await r.json()) as { data: { people: { name: string }[] } }).data.people.map((p) => p.name);
    } finally {
      await demo.close();
    }
  };

  // why: F-317 F-1654 (the list over the real seeded world is exactly the frame's 5, in the frame's order, though more sample actors hold a password)
  it('lists exactly the 5 people the approved sign-in frame shows, in its order, over the real seeded world', async () => {
    expect(await list()).toEqual(FRAME);
    expect(await list('tech')).toEqual(['Maria Santos', 'Luis Ortega']);
    // The world holds more password-holders than the frame lists (Marco P. among them), so a list built from the passwords alone fails here.
    expect(await n(`SELECT count(*) AS n FROM world."user" WHERE sample AND password_hash IS NOT NULL AND status = 'active'`)).toBeGreaterThan(FRAME.length);
    expect(await n(`SELECT count(*) AS n FROM world."user" WHERE email = $1 AND password_hash IS NOT NULL AND sample`, [MARCO.email])).toBe(1);
  });

  // why: F-317 F-1654 (a password-holding actor the seed adds does NOT join the list: shown by planting one and removing it; the test fails if the list is every password-holder)
  it('leaves a planted password-holding sample actor out of the list', async () => {
    const id = (await rows<{ id: string }>(
      `INSERT INTO world."user" (email, name, name_search, password_hash, role, branch_id, language, status, sample, reviewer)
       SELECT 'planted.actor@brightwater.example', 'Planted Actor', 'planted actor', password_hash, 'office', branch_id, 'en', 'active', true, false
         FROM world."user" WHERE email = $1 RETURNING id`, [KEISHA_EMAIL]))[0]!.id;
    try {
      const shown = await list();
      expect(shown).not.toContain('Planted Actor');
      expect(shown).toEqual(FRAME);
    } finally {
      await admin.query('DELETE FROM world."user" WHERE id = $1', [id]);
    }
    expect(await list()).toEqual(FRAME);
  });
});

// Runs last in this file: it resets the shared world (the reset restores the day-start snapshot, which the tests above read as set up).
describe('the Jobs list words after a fresh setup (F-1652, the approved Jobs page)', () => {
  // why: F-1652 the list says the job's own words and the Clintonville area: 24805 reads Water softener service, 24790 reads Clintonville, as the approved page does
  it('lists 24805 as Water softener service and 24790 in Clintonville', async () => {
    const found = new Map<number, { service: string; problem: string | null; area: string }>();
    for (const jn of [24805, 24790]) {
      const res = await post('/job-searches', { branch: 'columbus', query: String(jn), date: 'upcoming' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { rows: Array<{ jobNumber: number; service: string; problem: string | null; area: string }> } };
      const row = body.data.rows.find((r) => r.jobNumber === jn);
      if (row) found.set(jn, row);
    }
    expect(found.get(24805)?.problem).toBe('Water softener service');
    expect(found.get(24790)?.area).toBe('Clintonville');
  });
});

describe("each imported customer's old customer number (SPECIFICATIONS v0.11 section 3, owner ruling d9901466, F-879)", () => {
  /**
   * customers.csv as setup imported it (the export is a pure function of the committed generator inputs, D-3), read as
   * (row, customer_ref): the row is its place among the data rows and its name cell.
   */
  const fileRows = (): Set<string> => {
    const csv = parseCsv('customers.csv', generateChecked(streetListFile(process.env))['customers.csv']);
    const head = csv[0]!.cells;
    const [ref, name] = [head.indexOf('customer_ref'), head.indexOf('name')];
    expect(ref).toBeGreaterThanOrEqual(0);
    return new Set(csv.slice(1).filter((r) => r.cells.some((c) => c !== '')).map((r, i) => `${i}|${r.cells[name]}|${r.cells[ref]}`));
  };
  /**
   * The world's (customer, old reference) pairs: the customer is its place among the imported customers in id order (the import
   * mints the ids in row order, uuidv7) and its name; and every customer the import did not write, which must have none.
   */
  const worldPairs = async (): Promise<{ pairs: Set<string>; others: number }> => {
    const imported = await rows<{ name: string; old: string | null }>(
      `SELECT name, old_customer_number AS old FROM world.customer WHERE source = 'import' ORDER BY id`);
    const others = await n(`SELECT count(*) AS n FROM world.customer WHERE source <> 'import' AND old_customer_number IS NOT NULL`);
    return { pairs: new Set(imported.map((c, i) => `${i}|${c.name}|${c.old}`)), others };
  };

  // why: F-879 the import writes each customers.csv row's customer_ref as its customer's old number, and nothing else writes one (set equality, never a count)
  it('after a fresh setup the (customer, old reference) pairs are the (row, customer_ref) pairs of the customers.csv it imported', async () => {
    const want = fileRows();
    expect(want.size).toBeGreaterThan(1000);
    const got = await worldPairs();
    expect(got.others).toBe(0);
    expect(got.pairs).toEqual(want);
  });

  // why: F-879 Reset the demo world restores every customer's old number from the snapshot (system.restore_world copies the column by name)
  it('after Reset the demo world the same set holds, though the world had changed the column before the reset', async () => {
    // Change the column first, so the reset has something to restore: 1 number blanked, 1 rewritten.
    await admin.query(`UPDATE world.customer SET old_customer_number = NULL WHERE id = (SELECT id FROM world.customer WHERE source = 'import' ORDER BY id LIMIT 1)`);
    await admin.query(`UPDATE world.customer SET old_customer_number = 'X1' WHERE id = (SELECT id FROM world.customer WHERE source = 'import' ORDER BY id DESC LIMIT 1)`);
    expect((await worldPairs()).pairs).not.toEqual(fileRows());
    const c = createClient({ connectionString: db.url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await resetWorld(c, { byName: 'Dana Ruiz', real: new Date(realNow('clock_anchor').epochMilliseconds) });
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      await c.end();
    }
    const got = await worldPairs();
    expect(got.others).toBe(0);
    expect(got.pairs).toEqual(fileRows());
  });
});
