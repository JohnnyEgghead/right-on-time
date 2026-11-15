// SPDX-License-Identifier: AGPL-3.0-or-later
// The billing list writes through the production kernel (P3-BILLING-WRITES; SPECIFICATIONS section 6.6 FR-BILL-3,
// FR-BILL-5, FR-BILL-7, FR-BILL-8, FR-BILL-10, FR-BILL-11): API-61 Send again, API-62 Correct a finish and send again,
// API-156 Retry now, API-157 Retry all, API-158 Mark fixed and API-68 Set pretend billing mode, each called over the
// real handlers as a signed-in office user (the web process's login bw_web, the real session layer), on real
// PostgreSQL 18 with pbs over real HTTP as bw_pbs and the billing link as bw_worker. Timeouts are scaled (link 200 ms,
// pbs hold 600 ms) as in exactly-once.db.test.ts. Run by gate G-CI10 (vitest.db.config.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../packages/config/src/index.ts';
import { createPool } from '../../../packages/db/src/client.ts';
import { createLogger } from '../../../packages/log/src/index.ts';
import { sessionCookie, SqlSessionStore, startSession } from '../../../packages/api-server/src/kernel/sessions.ts';
import { createWebKernel, type WebKernel } from '../../../packages/api-server/src/web.ts';
import { realNow, Temporal, type RealTimeUse } from '../../../packages/time/src/index.ts';
import { DEMO_START, useBillingWorld } from '../../../apps/worker/src/billing/testing.ts';

const HOLD_MS = 600;
const w = useBillingWorld({ holdMs: HOLD_MS, timeoutMs: 200 });
const at = (m: number) => Temporal.Instant.from(DEMO_START).add({ minutes: m }).toString();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ORIGIN = 'http://localhost:8080';

let kernel: WebKernel;
let web: ReturnType<typeof createPool>;
let office: { id: string; name: string; cookie: string };
let technician: { cookie: string };

const loginUrl = (url: string, login: string) => {
  const u = new URL(url);
  u.username = login;
  return u.toString();
};

beforeAll(async () => {
  const a = w.admin();
  const person = async (email: string, name: string, role: 'office' | 'technician') =>
    (await a.query<{ id: string }>(
      `INSERT INTO world."user" (email, name, name_search, role, branch_id, language, status, sample, reviewer)
       VALUES ($1, $2, lower($2), $3, 'columbus', 'en', 'active', false, false) RETURNING id`, [email, name, role])).rows[0]!.id;
  web = createPool({ connectionString: loginUrl(w.url(), 'bw_web'), max: 4 });
  kernel = createWebKernel({
    settings: loadConfig({ DATABASE_URL: loginUrl(w.url(), 'bw_web'), ACCESS_CODE_ON: 'off', PBS_URL: w.pbsUrl() }),
    log: createLogger({ process: 'web', write: () => undefined }),
  });
  const store = new SqlSessionStore(web);
  const clock = { realNow: (use: RealTimeUse) => realNow(use === 'session_idle' ? 'session_idle' : 'session_lifetime') };
  const cookieOf = async (userId: string, role: 'office' | 'technician') =>
    sessionCookie(await startSession(store, clock, { userId, role }, { client: 'web', via: 'password', keepSignedIn: false }), false, false).split(';')[0] as string;
  const officeId = await person('keisha.writes@example.test', 'Keisha Thompson', 'office');
  office = { id: officeId, name: 'Keisha Thompson', cookie: await cookieOf(officeId, 'office') };
  technician = { cookie: await cookieOf(await person('maria.writes@example.test', 'Maria Santos', 'technician'), 'technician') };
});

afterAll(async () => {
  await kernel?.close();
  await web?.end();
});

async function call(method: 'POST' | 'PUT', path: string, body: unknown, cookie = office.cookie) {
  const res = await kernel.router.handle(new Request(`http://web:3000/api/v1${path}`, {
    method, body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', origin: ORIGIN, cookie },
  }), { address: '203.0.113.9' });
  const json = (await res.json()) as { data?: Record<string, unknown>; code?: string; currentVersion?: number };
  return { status: res.status, data: json.data, code: json.code, body: json };
}

const item = async (job: number) => (await w.rows<{ state: string; tries: number; left_how: string | null; send_cause: string | null; left_by: string | null; left_reason: string | null }>(
  'SELECT state, tries, left_how, send_cause, left_by, left_reason FROM world.billing_item WHERE job_number = $1', [job]))[0];
const invoices = (job: number) => w.rows<{ how: string; total_cents: number }>('SELECT how, total_cents FROM pbs.invoice WHERE job_number = $1', [job]);
const dueEvents = (job: number) => w.rows<{ kind: string }>(
  `SELECT kind FROM world.scheduled_event WHERE subject = $1 AND kind LIKE 'billing.%' AND state = 'due'`, [String(job)]);
const changes = (job: number) => w.rows<{ kind: string; actor_user_id: string | null; actor_kind: string; from_version: number; to_version: number }>(
  'SELECT kind, actor_user_id, actor_kind, from_version, to_version FROM world.job_change WHERE job_number = $1 ORDER BY id', [job]);
const versionOf = async (job: number) => (await w.rows<{ version: number }>('SELECT version FROM world.job WHERE job_number = $1', [job]))[0]!.version;
const partId = async (code: string) => (await w.rows<{ id: string }>('SELECT id FROM world.part WHERE code = $1', [code]))[0]!.id;

/** A finished job whose send was rejected as a data error: it waits for a person. */
async function waitingJob(minute: number): Promise<number> {
  await w.setDemo(at(minute));
  await w.setMode('reject_next_n', 1);
  const job = await w.newJob();
  await w.finish(job, { noPartsUsed: true });
  await w.link().runDue();
  expect((await item(job))?.state).toBe('waiting_person');
  return job;
}

describe('Send again (API-61)', () => {
  // why: FR-BILL-7, OA-57, OI-12, FR-BILL-8
  it('sends a job held after a data error once, and the job history names who sent it', async () => {
    const job = await waitingJob(200);
    const r = await call('POST', `/billing/queue/${job}/resend`, {});
    expect(r.status).toBe(202);
    expect(r.data).toEqual({ item: { jobNumber: job, state: 'sending', tries: 1 } });
    expect(await dueEvents(job)).toEqual([{ kind: 'billing.send' }]);
    expect(await w.link().runDue()).toBe(1);
    expect(await invoices(job)).toEqual([{ how: 'received', total_cents: 8900 }]);
    expect(await item(job)).toMatchObject({ state: 'in_billing', left_how: 'sent_again' });
    const sent = (await changes(job)).find((c) => c.kind === 'sent_again');
    expect(sent).toMatchObject({ actor_user_id: office.id, actor_kind: 'office' });
    // Pressed again, the job is no longer waiting for a person.
    expect(await call('POST', `/billing/queue/${job}/resend`, {})).toMatchObject({ status: 409, code: 'not_waiting_for_person' });
    expect(await invoices(job)).toHaveLength(1);
  });

  // why: FR-AUTH-1, FR-BILL-7
  it('refuses a technician', async () => {
    const job = await waitingJob(260);
    expect(await call('POST', `/billing/queue/${job}/resend`, {}, technician.cookie)).toMatchObject({ status: 403 });
    expect((await item(job))?.state).toBe('waiting_person');
  });
});

describe('Correct a finish and send again (API-62)', () => {
  // why: FR-BILL-3, FR-BILL-7, OA-61
  it('refuses a correction with neither parts nor No parts used, then replaces the finish lines, bumps the version and sends 1 invoice', async () => {
    const job = await waitingJob(300);
    const v = await versionOf(job);
    const body = { parts: [] as { partId: string; quantity: number }[], noPartsUsed: false, laborMinutes: 60, baseVersion: v };
    // FR-BILL-3: neither parts nor No parts used.
    expect(await call('POST', `/billing/queue/${job}/correction`, body)).toMatchObject({ status: 422, code: 'parts_required' });
    // A part that is not on the list.
    expect(await call('POST', `/billing/queue/${job}/correction`, { ...body, parts: [{ partId: '00000000-0000-4000-8000-000000000000', quantity: 1 }] }))
      .toMatchObject({ status: 422, code: 'validation_failed' });
    // A stale version: the job is at v, the caller read v - 1.
    const stale = await call('POST', `/billing/queue/${job}/correction`, { ...body, noPartsUsed: true, baseVersion: v - 1 });
    expect(stale).toMatchObject({ status: 409, code: 'version_conflict' });
    // None of the refusals changed anything.
    expect(await versionOf(job)).toBe(v);
    expect((await item(job))?.state).toBe('waiting_person');
    expect(await dueEvents(job)).toEqual([]);

    const cap = await partId('CAP-455');
    const ok = await call('POST', `/billing/queue/${job}/correction`, { ...body, parts: [{ partId: cap, quantity: 2 }], laborMinutes: 75 });
    expect(ok.status).toBe(202);
    expect(ok.data).toEqual({ item: { jobNumber: job, state: 'sending', tries: 1 }, job: { jobNumber: job, version: v + 1 } });
    expect(await versionOf(job)).toBe(v + 1);
    expect(await w.rows('SELECT part_id, quantity FROM world.job_part WHERE job_number = $1', [job])).toEqual([{ part_id: cap, quantity: 2 }]);
    expect((await w.rows<{ no_parts_used: boolean; labor_minutes: number }>('SELECT no_parts_used, labor_minutes FROM world.job WHERE job_number = $1', [job]))[0])
      .toEqual({ no_parts_used: false, labor_minutes: 75 });
    expect(await dueEvents(job)).toEqual([{ kind: 'billing.send' }]);
    expect(await w.link().runDue()).toBe(1);
    const inv = await invoices(job);
    expect(inv).toEqual([{ how: 'received', total_cents: 8900 + 2 * 3800 }]);
    expect(await item(job)).toMatchObject({ state: 'in_billing', left_how: 'corrected' });
    expect((await changes(job)).find((c) => c.kind === 'finish_corrected')).toMatchObject({ actor_user_id: office.id, actor_kind: 'office', from_version: v, to_version: v + 1 });
    // Pressed again, the job is no longer waiting.
    expect(await call('POST', `/billing/queue/${job}/correction`, { ...body, noPartsUsed: true, baseVersion: v + 1 })).toMatchObject({ status: 409, code: 'not_waiting_for_person' });
  });
});

describe('Retry now (API-156) and Retry all (API-157)', () => {
  /** A job whose send timed out while pbs held it, then stored it late: retrying, with the invoice already there. */
  async function lateJob(): Promise<number> {
    await w.setMode('not_answering');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    await w.link().runDue();
    expect((await item(job))?.state).toBe('retrying');
    return job;
  }

  // why: FR-BILL-10, FR-BILL-8, invariant 10
  it('Retry now sends at once and, after a late success, leaves 1 invoice', async () => {
    await w.setDemo(at(400));
    const job = await lateJob();
    await pause(HOLD_MS + 300); // pbs stores the held request late
    await w.setMode('up');
    expect(await invoices(job)).toHaveLength(1);
    const r = await call('POST', `/billing/queue/${job}/retry`, {});
    expect(r.status).toBe(202);
    expect(r.data).toEqual({ item: { jobNumber: job, state: 'retrying', tries: 1 } });
    expect(await w.link().runDue()).toBe(1); // due now, not 15 minutes on
    expect(await item(job)).toMatchObject({ state: 'in_billing' });
    expect(await invoices(job)).toEqual([{ how: 'received', total_cents: 8900 }]);
    // It left the list: the row goes.
    expect(await call('POST', `/billing/queue/${job}/retry`, {})).toMatchObject({ status: 409, code: 'not_on_billing_list' });
    expect(await call('POST', '/billing/queue/999999/retry', {})).toMatchObject({ status: 409, code: 'not_on_billing_list' });
  });

  // why: FR-BILL-10, FR-BILL-7
  it('Retry now answers not_retrying for a job waiting for a person, and Retry all skips it', async () => {
    const waiting = await waitingJob(430);
    expect(await call('POST', `/billing/queue/${waiting}/retry`, {})).toMatchObject({ status: 409, code: 'not_retrying' });
    await w.setDemo(at(440));
    const a = await lateJob();
    const b = await lateJob();
    await pause(HOLD_MS + 300);
    await w.setMode('up');
    const r = await call('POST', '/billing/queue/retries', { branch: 'columbus' });
    expect(r.status).toBe(202);
    expect(r.data).toEqual({ retried: 2 });
    expect(await w.link().runDue()).toBe(2);
    for (const j of [a, b]) {
      expect(await item(j)).toMatchObject({ state: 'in_billing' });
      expect(await invoices(j)).toHaveLength(1);
    }
    expect((await item(waiting))?.state).toBe('waiting_person');
    // Nothing left to retry.
    expect((await call('POST', '/billing/queue/retries', { branch: 'columbus' })).data).toEqual({ retried: 0 });
  });
});

describe('Mark fixed (API-158)', () => {
  // why: FR-BILL-11, invariant 10
  it('records exactly 1 entered-by-hand invoice, and answers not_on_billing_list the second time', async () => {
    await w.setDemo(at(500));
    await w.setMode('down');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    await w.link().runDue();
    expect((await item(job))?.state).toBe('retrying');
    // A job that never failed is not on the list; an empty reason is a validation error.
    const fresh = await w.newJob();
    await w.finish(fresh, { noPartsUsed: true });
    expect(await call('POST', `/billing/queue/${fresh}/fixed`, { reason: 'Entered by hand' })).toMatchObject({ status: 409, code: 'not_on_billing_list' });
    expect(await call('POST', `/billing/queue/${job}/fixed`, { reason: '   ' })).toMatchObject({ status: 422, code: 'validation_failed' });

    const r = await call('POST', `/billing/queue/${job}/fixed`, { reason: 'Entered in billing by hand' });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ left: { jobNumber: job, by: office.name, reason: 'Entered in billing by hand' } });
    expect(await item(job)).toMatchObject({ state: 'marked_fixed', left_how: 'marked_fixed', left_by: office.id, left_reason: 'Entered in billing by hand' });
    expect(await invoices(job)).toEqual([{ how: 'entered_by_hand', total_cents: 8900 }]);
    expect(await dueEvents(job)).toEqual([]);

    expect(await call('POST', `/billing/queue/${job}/fixed`, { reason: 'again' })).toMatchObject({ status: 409, code: 'not_on_billing_list' });
    expect(await invoices(job)).toHaveLength(1);
    await w.setMode('up');
    await w.setDemo(at(560));
    await w.link().runDue();
    expect(await invoices(job)).toHaveLength(1);
  });
});

describe('Set pretend billing mode (API-68)', () => {
  // why: FR-BILL-5, FR-BILL-7, SD-44
  it('Reject the next 2 rejects exactly 2 sends, then billing accepts again', async () => {
    await w.setDemo(at(600));
    await w.setMode('up');
    const r = await call('PUT', '/pretend-billing/mode', { mode: 'reject_next_n', n: 2 });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ mode: 'reject_next_n', nLeft: 2 });
    const mode = await w.client().getMode();
    expect(mode).toMatchObject({ mode: 'reject_next_n', nLeft: 2, setBy: office.id });

    const jobs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const j = await w.newJob();
      await w.finish(j, { noPartsUsed: true });
      jobs.push(j);
    }
    await w.link().runDue();
    const states: (string | undefined)[] = [];
    for (const j of jobs) states.push((await item(j))?.state); // 1 shared connection: 1 query at a time
    expect(states.filter((s) => s === 'waiting_person')).toHaveLength(2);
    expect(states.filter((s) => s === 'in_billing')).toHaveLength(1);
    expect((await w.client().getMode()).mode).toBe('up');
  });

  // why: FR-BILL-5, SD-44
  it('sets each mode and refuses n where it does not belong', async () => {
    for (const mode of ['down', 'not_answering', 'up'] as const) {
      expect((await call('PUT', '/pretend-billing/mode', { mode })).data).toEqual({ mode, nLeft: null });
    }
    for (const bad of [{ mode: 'reject_next_n' }, { mode: 'reject_next_n', n: 0 }, { mode: 'reject_next_n', n: 21 }, { mode: 'up', n: 3 }]) {
      expect(await call('PUT', '/pretend-billing/mode', bad), JSON.stringify(bad)).toMatchObject({ status: 422, code: 'validation_failed' });
    }
    expect((await w.client().getMode()).mode).toBe('up');
    expect(await call('PUT', '/pretend-billing/mode', { mode: 'down' }, technician.cookie)).toMatchObject({ status: 403 });
  });
});
