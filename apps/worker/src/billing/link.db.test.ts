// SPDX-License-Identifier: AGPL-3.0-or-later
// The billing link against a running pbs (SPECIFICATIONS section 14 Integration: "the billing link against a running
// pbs"; section 6.6). Real PostgreSQL 18, pbs over real HTTP as bw_pbs, the link as bw_worker. Timeouts are scaled
// (link 200 ms, pbs hold 600 ms) so the late-success order of FR-BILL-5 holds; G-CI10 runs the production 30 s / 60 s.
// Run by gate G-CI10 (ci/gates/G-CI10/vitest.db.config.ts); the merge set excludes *.db.test.ts.
import { describe, expect, it } from 'vitest';
import { inTransaction } from '@bw/db';
import { Temporal } from '@bw/time';
import { createLogger } from '@bw/log';
import { markFixed } from './fixed.ts';
import type { SendOutcome } from './client.ts';
import { startDispatcher, type Dispatcher, type ParallelLane } from '../dispatcher.ts';
import { billingLane, billingLaneFor, type PreparedSend } from './link.ts';
import { billingList, resendCorrected, retryAll, retryNow, sendAgain } from './queue.ts';
import { DEMO_START, useBillingWorld } from './testing.ts';

const HOLD_MS = 600;
const w = useBillingWorld({ holdMs: HOLD_MS, timeoutMs: 200 });
const at = (minutes: number) => Temporal.Instant.from(DEMO_START).add({ minutes }).toString();
const item = async (job: number) => (await w.rows<{ state: string; tries: number; reason_key: string | null; next_try_at: Date | null; left_how: string | null; left_at: Date | null; send_cause: string | null; left_by: string | null; left_reason: string | null }>(
  'SELECT state, tries, reason_key, next_try_at, left_how, left_at, send_cause, left_by, left_reason FROM world.billing_item WHERE job_number = $1', [job]))[0];
const attempts = (job: number) => w.rows<{ number: number; result: string; http_status: number | null }>(
  'SELECT number, result, http_status FROM world.billing_attempt WHERE job_number = $1 ORDER BY number', [job]);
const due = (job: number) => w.rows<{ kind: string; due_at: Date }>(
  `SELECT kind, due_at FROM world.scheduled_event WHERE subject = $1 AND kind LIKE 'billing.%' AND state = 'due'`, [String(job)]);
const invoices = (job: number) => w.rows<{ how: string; total_cents: number; entered_by_hand_reason: string | null }>(
  'SELECT how, total_cents, entered_by_hand_reason FROM pbs.invoice WHERE job_number = $1', [job]);
const jobState = async (job: number) => (await w.rows<{ billing_state: string }>('SELECT billing_state FROM world.job WHERE job_number = $1', [job]))[0]?.billing_state;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const managerId = async () => (await w.rows<{ id: string }>(`SELECT id FROM world."user" WHERE email = 'dana@example.test'`))[0]!.id;

describe('a finished job flows to billing', () => {
  // why: FR-BILL-1, FR-BILL-13, FR-BILL-4
  it("bills Harold's job with 3 parts and 2 hr 9 min of labor as 1 invoice with those lines, on the first try", async () => {
    await w.setDemo(at(0));
    await w.setMode('up');
    const job = await w.newJob();
    expect(await w.finish(job, { parts: [{ code: 'CAP-455', quantity: 1 }, { code: 'FLT-16251', quantity: 2 }, { code: 'HOS-0750', quantity: 4 }], laborMinutes: 129, workDone: ['Replaced a weak run capacitor'] }))
      .toEqual({ queued: true });
    expect(await jobState(job)).toBe('sending');
    expect(await w.link().runDue()).toBe(1);
    const inv = await w.client().getInvoice(job) as { how: string; totalCents: number; lines: { kind: string; label: string; code: string | null; quantity: number | null; amountCents: number | null }[]; calls: { answer: string }[] };
    expect(inv.how).toBe('received');
    expect(inv.lines.map((l) => [l.kind, l.code, l.quantity, l.amountCents])).toEqual([
      ['service', null, 1, 8900], ['part', 'CAP-455', 1, 3800], ['part', 'FLT-16251', 2, 1900], ['part', 'HOS-0750', 4, 900],
      ['labor', null, null, 0], ['work_done', null, null, null],
    ]);
    expect(inv.lines.find((l) => l.kind === 'labor')?.label).toBe('Hours worked: 2 hr 9 min');
    expect(inv.totalCents).toBe(8900 + 3800 + 1900 + 900);
    expect(inv.calls).toEqual([expect.objectContaining({ answer: 'stored' })]);
    // A first-try success never listed: no left_at, no left_how (FR-BILL-12).
    expect(await item(job)).toMatchObject({ state: 'in_billing', tries: 1, left_how: null, left_at: null });
    expect(await jobState(job)).toBe('in_billing');
    expect(await due(job)).toEqual([]);
    const change = await w.rows<{ kind: string; actor_kind: string }>('SELECT kind, actor_kind FROM world.job_change WHERE job_number = $1', [job]);
    expect(change).toEqual([{ kind: 'billing_sent', actor_kind: 'system' }]);
  });

  // why: FR-BILL-1, FR-BILL-13
  it('bills a labor-only job with No parts used as 1 invoice on the first try, and a member gets the discount line', async () => {
    const job = await w.newJob({ member: true, serviceId: 'heating_or_ac_fix' });
    await w.finish(job, { noPartsUsed: true, laborMinutes: 90 });
    await w.link().runDue();
    const inv = await w.client().getInvoice(job) as { totalCents: number; lines: { kind: string; amountCents: number | null }[] };
    expect(inv.lines.map((l) => [l.kind, l.amountCents])).toEqual([['service', 7900], ['labor', 0], ['discount', -1185]]);
    expect(inv.totalCents).toBe(7900 - 1185);
    expect(await attempts(job)).toEqual([{ number: 1, result: 'success', http_status: 200 }]);
  });

  // why: FR-BILL-9, OI-8
  it('creates no billing item for a No one home visit, and none for an imported past visit', async () => {
    const job = await w.newJob();
    expect(await w.finish(job, { status: 'no_one_home' })).toEqual({ queued: false, why: 'not_finished' });
    const pv = await w.rows<{ id: string }>(`SELECT id FROM world.customer LIMIT 1`);
    await w.admin().query(`INSERT INTO world.past_visit (customer_id, technician_name, date, zone, window_start, window_end, outcome, service_text, source_ref)
                           VALUES ($1, 'Maria Santos', '2021-03-01', 'America/New_York', '2021-03-01T13:00:00Z', '2021-03-01T17:00:00Z', 'done', 'Furnace tune-up', 'V1')`, [pv[0]!.id]);
    await w.link().runDue();
    expect(await item(job)).toBeUndefined();
    expect(await jobState(job)).toBe('not_sent');
    expect(await w.rows('SELECT 1 FROM pbs.invoice WHERE job_number = $1', [job])).toEqual([]);
    // billing_item can reference only a job (its foreign key), never a past visit: no billing path exists for one.
    const fk = await w.rows<{ ref: string }>(`SELECT confrelid::regclass::text AS ref FROM pg_constraint WHERE conrelid = 'world.billing_item'::regclass AND contype = 'f' AND conname = 'billing_item_job_number_fkey'`);
    expect(fk).toEqual([{ ref: 'world.job' }]);
  });

  // why: FR-BILL-3, invariant 10
  it('refuses, in the finish transaction, a done job with neither parts nor No parts used', async () => {
    const job = await w.newJob();
    expect(await w.finish(job, { laborMinutes: 30 })).toEqual({ refused: 'parts_required' });
    // A finish path that skipped the validator is refused by billFinishedJob and rolls back.
    const err = await inTransaction(w.worker(), async (tx) => {
      await tx.query(`UPDATE world.job SET status = 'done', ended_at = $2, labor_minutes = 30 WHERE job_number = $1`, [job, at(0)]);
      const { billFinishedJob } = await import('./queue.ts');
      return billFinishedJob(tx, { jobNumber: job, at: Temporal.Instant.from(at(0)) });
    }).catch((e: Error) => e.name);
    expect(err).toBe('BillingRefusedError');
    expect((await w.rows<{ status: string }>('SELECT status FROM world.job WHERE job_number = $1', [job]))[0]?.status).toBe('on_site');
    expect(await item(job)).toBeUndefined();
  });
});

describe('a job that fails to reach billing is listed, never dropped', () => {
  // why: FR-BILL-2, UC-07, FR-BILL-6
  it('retries every 15 demo minutes while billing is Down, lists the job, and sends it once when Up', async () => {
    await w.setDemo(at(60));
    await w.setMode('down');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    await w.link().runDue();
    expect(await item(job)).toMatchObject({ state: 'retrying', tries: 1, next_try_at: new Date(at(75)) });
    expect(await due(job)).toEqual([{ kind: 'billing.retry', due_at: new Date(at(75)) }]);
    // Nothing runs before the retry is due.
    await w.setDemo(at(74));
    await w.link().runDue();
    expect((await attempts(job)).length).toBe(1);
    await w.setDemo(at(75));
    await w.link().runDue();
    expect(await item(job)).toMatchObject({ state: 'retrying', tries: 2, next_try_at: new Date(at(90)) });
    const listed = await billingList(w.worker(), { branchId: 'columbus', now: Temporal.Instant.from(at(75)) });
    expect(listed.waiting.map((x) => [x.jobNumber, x.state, x.tries])).toContainEqual([job, 'retrying', 2]);
    await w.setMode('up');
    await w.setDemo(at(90));
    await w.link().runDue();
    expect(await attempts(job)).toEqual([
      { number: 1, result: 'down', http_status: 503 }, { number: 2, result: 'down', http_status: 503 }, { number: 3, result: 'success', http_status: 200 },
    ]);
    expect(await item(job)).toMatchObject({ state: 'in_billing', left_how: 'automatic_retry', left_at: new Date(at(90)) });
    expect(await invoices(job)).toHaveLength(1);
    expect(await due(job)).toEqual([]);
    const after = await billingList(w.worker(), { branchId: 'columbus', now: Temporal.Instant.from(at(90)) });
    expect(after.waiting.map((x) => x.jobNumber)).not.toContain(job);
    expect(after.leftLast7Days.find((x) => x.jobNumber === job)).toMatchObject({ leftHow: 'automatic_retry', tries: 3 });
  });

  // why: FR-BILL-6
  it('turns Not answering into a timeout and a retrying row, and moving the clock 15 minutes gives try 2', async () => {
    await w.setDemo(at(120));
    await w.setMode('not_answering');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    await w.link().runDue();
    expect(await attempts(job)).toEqual([{ number: 1, result: 'timeout', http_status: null }]);
    expect(await item(job)).toMatchObject({ state: 'retrying', next_try_at: new Date(at(135)) });
    await pause(HOLD_MS + 300); // the held request stores late
    await w.setMode('up');
    await w.setDemo(at(135));
    await w.link().runDue();
    // FR-BILL-8: the late success then the retry leaves 1 invoice; the retry answered already_have.
    expect(await attempts(job)).toEqual([{ number: 1, result: 'timeout', http_status: null }, { number: 2, result: 'success', http_status: 200 }]);
    expect(await invoices(job)).toHaveLength(1);
    const calls = await w.rows<{ answer: string }>('SELECT answer FROM pbs."call" WHERE job_number = $1 ORDER BY at, id', [job]);
    expect(calls.map((c) => c.answer).sort()).toEqual(['already_have', 'stored_late']);
  });

  // why: FR-BILL-7, OA-57, OI-12
  it('holds a data error for a person with no automatic retry over the next hour; Send again after the correction gives 1 invoice', async () => {
    await w.setDemo(at(200));
    await w.setMode('reject_next_n', 1);
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    await w.link().runDue();
    expect(await item(job)).toMatchObject({ state: 'waiting_person', reason_key: 'Rejected as a data error by the pretend billing system', next_try_at: null });
    expect(await due(job)).toEqual([]);
    expect((await w.client().getMode()).mode).toBe('up'); // Reject the next 1, then accepts again
    for (const m of [215, 230, 245, 260]) {
      await w.setDemo(at(m));
      await w.link().runDue();
    }
    expect((await attempts(job)).length).toBe(1);
    const listed = await billingList(w.worker(), { branchId: 'columbus', now: Temporal.Instant.from(at(260)) });
    expect(listed.waiting.find((x) => x.jobNumber === job)).toMatchObject({ state: 'waiting_person', reason: 'Rejected as a data error by the pretend billing system' });
    // Retry now and Retry all skip a data error (FR-BILL-10).
    expect(await inTransaction(w.worker(), (tx) => retryNow(tx, { jobNumber: job, at: Temporal.Instant.from(at(260)) }))).toEqual({ ok: false, code: 'not_retrying' });
    // The person corrects the job (the correction write replaces the lines), then Send again.
    const by = await managerId();
    await inTransaction(w.worker(), async (tx) => {
      await tx.query('UPDATE world.job SET labor_minutes = 75, version = version + 1 WHERE job_number = $1', [job]);
      expect(await sendAgain(tx, { jobNumber: job, by, at: Temporal.Instant.from(at(260)) })).toEqual({ ok: true });
    });
    expect(await item(job)).toMatchObject({ state: 'sending', send_cause: 'sent_again' });
    await w.link().runDue();
    expect(await invoices(job)).toHaveLength(1);
    expect(await item(job)).toMatchObject({ state: 'in_billing', left_how: 'sent_again', send_cause: null });
    const changes = await w.rows<{ kind: string; actor_user_id: string | null }>('SELECT kind, actor_user_id FROM world.job_change WHERE job_number = $1 ORDER BY at, kind', [job]);
    expect(changes).toEqual([{ kind: 'billing_sent', actor_user_id: null }, { kind: 'sent_again', actor_user_id: by }]);
  });

  // why: FR-BILL-7, OA-61
  it('resends a corrected finish with send_cause corrected, and left_how says corrected', async () => {
    await w.setDemo(at(300));
    await w.setMode('reject_next_n', 1);
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    await w.link().runDue();
    await inTransaction(w.worker(), (tx) => resendCorrected(tx, { jobNumber: job, by: '00000000-0000-0000-0000-000000000000', at: Temporal.Instant.from(at(301)) }));
    await w.setDemo(at(301));
    await w.link().runDue();
    expect(await item(job)).toMatchObject({ state: 'in_billing', left_how: 'corrected' });
  });

  // why: FR-BILL-10, FR-BILL-8
  it('Retry now sends 1 retrying job at once; Retry all sends every retrying job; each gives 1 invoice', async () => {
    await w.setDemo(at(400));
    await w.setMode('down');
    const jobs = [await w.newJob(), await w.newJob(), await w.newJob()];
    for (const j of jobs) await w.finish(j, { noPartsUsed: true });
    await w.link().runDue();
    for (const j of jobs) expect(await item(j)).toMatchObject({ state: 'retrying' });
    await w.setMode('up');
    await w.setDemo(at(401));
    expect(await inTransaction(w.worker(), (tx) => retryNow(tx, { jobNumber: jobs[0]!, at: Temporal.Instant.from(at(401)) }))).toEqual({ ok: true });
    await w.link().runDue();
    expect(await item(jobs[0]!)).toMatchObject({ state: 'in_billing' });
    expect(await item(jobs[1]!)).toMatchObject({ state: 'retrying' });
    expect(await inTransaction(w.worker(), (tx) => retryAll(tx, { at: Temporal.Instant.from(at(401)), branchId: 'columbus' }))).toBeGreaterThanOrEqual(2);
    await w.link().runDue();
    for (const j of jobs) {
      expect(await item(j)).toMatchObject({ state: 'in_billing' });
      expect(await invoices(j)).toHaveLength(1);
    }
  });
});

describe('Mark fixed', () => {
  // why: FR-BILL-11, invariant 10
  it('records the job once as entered by hand, stops its retries, records who and when, and a later Retry all makes no invoice', async () => {
    await w.setDemo(at(500));
    await w.setMode('down');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    await w.link().runDue();
    const by = await managerId();
    expect(await markFixed({ pool: w.worker(), client: w.client() }, { jobNumber: job, reason: 'Entered in billing by hand', by, at: Temporal.Instant.from(at(505)) }))
      .toEqual({ ok: true });
    expect(await item(job)).toMatchObject({ state: 'marked_fixed', left_how: 'marked_fixed', left_by: by, left_reason: 'Entered in billing by hand', left_at: new Date(at(505)) });
    expect(await due(job)).toEqual([]);
    expect(await invoices(job)).toEqual([{ how: 'entered_by_hand', total_cents: 8900, entered_by_hand_reason: 'Entered in billing by hand' }]);
    await w.setMode('up');
    expect(await inTransaction(w.worker(), (tx) => retryAll(tx, { at: Temporal.Instant.from(at(506)) }))).toBe(0);
    await w.setDemo(at(530));
    await w.link().runDue();
    expect((await attempts(job)).length).toBe(1);
    expect(await invoices(job)).toHaveLength(1);
    // Repeating it changes nothing (re-run safe), and an item that never listed cannot be marked fixed.
    expect(await markFixed({ pool: w.worker(), client: w.client() }, { jobNumber: job, reason: 'again', by, at: Temporal.Instant.from(at(531)) })).toEqual({ ok: true, again: true });
    expect(await markFixed({ pool: w.worker(), client: w.client() }, { jobNumber: job, reason: ' ', by, at: Temporal.Instant.from(at(531)) })).toEqual({ ok: false, code: 'validation_failed' });
  });

  // why: FR-BILL-11, FR-BILL-8
  it('re-marks an invoice a held request already stored late, keeping 1 record', async () => {
    await w.setDemo(at(600));
    await w.setMode('not_answering');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    await w.link().runDue(); // timeout; the request is still held
    await pause(HOLD_MS + 300); // stored late
    expect(await invoices(job)).toEqual([{ how: 'received', total_cents: 8900, entered_by_hand_reason: null }]);
    await w.setMode('up');
    const by = await managerId();
    expect(await markFixed({ pool: w.worker(), client: w.client() }, { jobNumber: job, reason: 'Already in billing', by, at: Temporal.Instant.from(at(601)) })).toEqual({ ok: true });
    expect(await invoices(job)).toEqual([{ how: 'entered_by_hand', total_cents: 8900, entered_by_hand_reason: 'Already in billing' }]);
  });
});

describe('the event dispatcher billing lane (apps/worker/src/jobs.ts eventLanes)', () => {
  const log = createLogger({ process: 'worker', write: () => undefined });
  /** The clock row's world epoch, read fresh (the dispatcher binds each drain to it, F-635). */
  const epochNow = async () => (await w.admin().query<{ world_epoch: number }>('SELECT world_epoch FROM system.demo_clock WHERE id = 1')).rows[0]!.world_epoch;
  /** The worker's real dispatcher with the billing lane only; its timer is held off, so each drain is explicit. */
  function dispatcherWith(lane: ParallelLane<PreparedSend, SendOutcome>, now: Temporal.Instant) {
    return startDispatcher({ pool: w.worker(), clock: { demoNow: async () => now, worldEpoch: epochNow }, handlers: {}, lanes: [lane], log, intervalMs: 3_600_000 });
  }
  const drainAt = async (d: Dispatcher, t: string) => d.drainThrough({ through: Temporal.Instant.from(t), demoNow: Temporal.Instant.from(t), epoch: await epochNow() });

  // why: FR-BILL-2, UC-07, FR-BILL-6
  it('runs the billing kinds in the dispatcher lane: Down retries 15 minutes later, Up sends once', async () => {
    const lane = billingLaneFor({ settings: { PBS_URL: w.pbsUrl() }, log });
    expect([...lane.kinds].sort()).toEqual(['billing.retry', 'billing.send']);
    await w.setDemo(at(1100));
    await w.setMode('down');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    const d = dispatcherWith(lane, Temporal.Instant.from(at(1099)));
    try {
      expect(await drainAt(d, at(1100))).toEqual({ ran: 1, skipped: 0, failed: [] });
      expect((await attempts(job)).map((a) => a.result)).toEqual(['down']);
      expect(await due(job)).toEqual([{ kind: 'billing.retry', due_at: new Date(at(1115)) }]);
      expect(await drainAt(d, at(1110))).toEqual({ ran: 0, skipped: 0, failed: [] });
      await w.setMode('up');
      expect(await drainAt(d, at(1115))).toEqual({ ran: 1, skipped: 0, failed: [] });
      expect(await item(job)).toMatchObject({ state: 'in_billing', tries: 2, left_how: 'automatic_retry' });
      expect(await invoices(job)).toHaveLength(1);
      expect(await drainAt(d, at(1200))).toEqual({ ran: 0, skipped: 0, failed: [] });
    } finally {
      await d.stop();
    }
  });

  // why: FR-BILL-8, FR-BILL-2
  it('leaves nothing and the event due when the worker dies after the send, before the record commits; the re-run converges on 1 invoice', async () => {
    const base = billingLane({ client: w.client(), log });
    let crash = true;
    const crashing: ParallelLane<PreparedSend, SendOutcome> = {
      ...base,
      handler: {
        ...base.handler,
        async record(p, answer, e, ctx) {
          if (crash) throw new Error('the worker died after the send, before commit');
          return base.handler.record(p, answer, e, ctx);
        },
      },
    };
    await w.setDemo(at(1300));
    await w.setMode('up');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    const d = dispatcherWith(crashing, Temporal.Instant.from(at(1299)));
    try {
      const first = await drainAt(d, at(1300));
      expect(first.failed).toHaveLength(1);
      expect(await attempts(job)).toEqual([]);
      expect(await due(job)).toHaveLength(1);
      expect(await invoices(job)).toHaveLength(1); // pbs stored it: the remote write is the only one that survived
      crash = false;
      expect(await drainAt(d, at(1301))).toEqual({ ran: 1, skipped: 0, failed: [] });
      expect(await attempts(job)).toEqual([{ number: 1, result: 'success', http_status: 200 }]);
      expect(await invoices(job)).toHaveLength(1);
    } finally {
      await d.stop();
    }
  });
});

describe('re-run semantics', () => {
  // why: FR-BILL-8, FR-BILL-2
  it('converges after a crash between the send and the record: the event re-runs, pbs answers already_have, 1 invoice', async () => {
    await w.setDemo(at(700));
    await w.setMode('up');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    // The crash: pbs stored the invoice, the worker died before step 3, so the event is still due.
    const { composeFromJob } = await import('./compose.ts');
    const c = await inTransaction(w.worker(), (tx) => composeFromJob(tx, job));
    if (!c.ok) throw new Error(c.reason);
    const first = await w.client().sendInvoice({ jobNumber: job, customerName: c.customerName, doneAt: c.doneAt, sentAt: at(700), lines: c.lines, totalCents: c.totalCents }, { worldEpoch: 1 });
    expect(first).toEqual({ outcome: 'accepted', httpStatus: 200 });
    expect(await due(job)).toHaveLength(1);
    await w.link().runDue();
    expect(await item(job)).toMatchObject({ state: 'in_billing', tries: 1 });
    expect(await invoices(job)).toHaveLength(1);
    expect((await w.rows<{ answer: string }>('SELECT answer FROM pbs."call" WHERE job_number = $1 ORDER BY at, id', [job])).map((x) => x.answer)).toEqual(['stored', 'already_have']);
  });

  // why: FR-BILL-2, FR-BILL-8
  it('runs 1 send per job at a time: a second runner of the same event answers busy and leaves it due', async () => {
    await w.setDemo(at(800));
    await w.setMode('not_answering');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    const ev = (await w.rows<{ id: string; kind: string; subject: string; payload: unknown }>(`SELECT id, kind, subject, payload FROM world.scheduled_event WHERE subject = $1 AND state = 'due'`, [String(job)]))[0]!;
    const now = Temporal.Instant.from(at(800));
    const [a, b] = await Promise.all([w.link().handle(ev, now), pause(50).then(() => w.link().handle(ev, now))]);
    expect([a, b].sort()).toEqual(['busy', 'timeout']);
    expect(await due(job)).toEqual([{ kind: 'billing.retry', due_at: new Date(at(815)) }]);
    expect(await w.link().handle(ev, now)).toBe('not_due');
    await pause(HOLD_MS + 300);
    await w.setMode('up');
  });

  // why: FR-BILL-2
  it('heals an item left with no due event (an outside dispatcher retired it unrun) with 1 retry at demo now', async () => {
    await w.setDemo(at(900));
    await w.setMode('up');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    await w.admin().query(`UPDATE world.scheduled_event SET state = 'done' WHERE subject = $1`, [String(job)]);
    expect(await w.link().heal()).toBe(1);
    expect(await w.link().heal()).toBe(0);
    await w.link().runDue();
    expect(await item(job)).toMatchObject({ state: 'in_billing' });
  });

  // why: SD-12
  it('records nothing into a fresh world when a reset happened during the send', async () => {
    await w.setDemo(at(1000));
    await w.setMode('not_answering');
    const job = await w.newJob();
    await w.finish(job, { noPartsUsed: true });
    const ev = (await w.rows<{ id: string; kind: string; subject: string; payload: unknown }>(`SELECT id, kind, subject, payload FROM world.scheduled_event WHERE subject = $1 AND state = 'due'`, [String(job)]))[0]!;
    const run = w.link().handle(ev, Temporal.Instant.from(at(1000)));
    await pause(50);
    await w.admin().query('UPDATE system.demo_clock SET world_epoch = world_epoch + 1 WHERE id = 1');
    expect(await run).toBe('world_reset');
    expect(await attempts(job)).toEqual([]);
    await w.admin().query('UPDATE system.demo_clock SET world_epoch = world_epoch - 1 WHERE id = 1');
    await pause(HOLD_MS + 300);
    await w.setMode('up');
  });
});
