// SPDX-License-Identifier: AGPL-3.0-or-later
// The billing test world (database tests only; the merge set excludes *.db.test.ts): a fresh migrated PostgreSQL 18
// database, the real pbs HTTP service signed in as bw_pbs (role pbs), and the real billing link signed in as
// bw_worker (role app), so every privilege is checked at the real access wall and every send crosses real HTTP.
//
// `finish` is the stand-in for the finish paths, which other lanes build (API-26 office finish P4-JOB, API-102's
// finish item P3-ITEMS): it does what section 6.6 says each path does, in 1 transaction as role app: run the
// finishLines validator, write the finish lines and status, then billFinishedJob.
import { afterAll, beforeAll } from 'vitest';
import { createPool, inTransaction, type Queryable } from '@bw/db';
import { finishLines, type FinishLinesCode, type PbsModeName } from '@bw/domain';
import { createLogger, type Logger } from '@bw/log';
import { DbClock, Temporal } from '@bw/time';
import type pg from 'pg';
import { startPbs, type PbsServer } from '../../../pbs/src/server.ts';
import { ensureModeRow } from '../../../pbs/src/store.ts';
import { insertJob, seedReference, useMigratedDatabase } from '../../../../packages/db/src/testing/fixture.ts';
import { PARTS, SERVICES } from '../../../../packages/db/src/seed/reference-data.ts';
import { HttpBillingClient } from './client.ts';
import { LaneRunner, type DueEvent, type ParallelLane } from '../dispatcher.ts';
import { BillingBusyError, billingLane, billingLaneFor, healBillingItems, WORKER_POOL_MAX, type BillingEvent, type HandleResult, type PreparedSend } from './link.ts';
import type { SendOutcome } from './client.ts';
import { billFinishedJob, type BillFinishedResult } from './queue.ts';

export const DEMO_START = '2026-09-15T14:00:00Z';

export interface WorldOptions {
  /** pbs's Not answering hold, real ms (production 60,000). */
  holdMs: number;
  /**
   * The link's timeout, real ms. Absent: the link is the production lane (billingLaneFor, the factory the worker's
   * registry wires), so the client's own default timeout (30,000) is the one under test (F-383).
   */
  timeoutMs?: number;
}

/**
 * The billing link as the tests drive it: the worker dispatcher's real billing lane runner (dispatcher.ts LaneRunner,
 * the same tx 1, call, tx 2 the worker runs), without the dispatcher's timer.
 */
export interface BillingLink {
  readonly runner: LaneRunner<PreparedSend, SendOutcome>;
  /** Run 1 billing event now: its result, busy when its job is in flight, not_due when it is no longer due. */
  handle(event: BillingEvent, now: Temporal.Instant): Promise<HandleResult>;
  /** Drain the billing lane through demo now. Answers how many events it ran (done, skipped or failed). */
  runDue(): Promise<number>;
  /** The healer at demo now. Answers how many retries it wrote. */
  heal(): Promise<number>;
  stop(): Promise<void>;
}

function billingLinkOver(
  pool: pg.Pool,
  clock: DbClock,
  lane: ParallelLane<PreparedSend, SendOutcome>,
  log: Logger = createLogger({ process: 'worker', write: () => undefined }),
): BillingLink {
  const runner = new LaneRunner(pool, lane, log);
  return {
    runner,
    async handle(event, now) {
      const due: DueEvent = { id: event.id, dueAt: now, kind: event.kind, subject: event.subject, payload: event.payload as Record<string, unknown> };
      const r = await runner.run(due, now);
      if ('outcome' in r) return r.outcome.result as HandleResult;
      if ('busy' in r) return 'busy';
      if ('gone' in r || 'stale' in r) return 'not_due'; // stale: only with an epoch, which this run passes none of
      if (r.failed instanceof BillingBusyError) return 'busy';
      throw r.failed;
    },
    async runDue() {
      const now = await clock.demoNow();
      const r = await runner.drain({ through: now, demoNow: now });
      return r.ran + r.skipped + r.failed.length;
    },
    async heal() {
      return healBillingItems(pool, await clock.demoNow());
    },
    stop: () => runner.settled(),
  };
}

export interface FinishInput {
  parts?: readonly { code: string; quantity: number }[];
  noPartsUsed?: boolean;
  laborMinutes?: number;
  workDone?: readonly string[];
  /** Override the status written (No one home is an ending status with no finish lines). */
  status?: 'done' | 'no_one_home';
}

export interface BillingWorld {
  admin(): Queryable;
  /** The test database's URL (superuser), for a probe that mounts the production kernel on its own login (F-384). */
  url(): string;
  worker(): pg.Pool;
  pbsUrl(): string;
  client(): HttpBillingClient;
  link(): BillingLink;
  /** Move the demo clock (paused) to t. */
  setDemo(t: string): Promise<void>;
  demoNow(): Promise<Temporal.Instant>;
  setMode(mode: PbsModeName, n?: number): Promise<void>;
  newJob(opts?: { member?: boolean; serviceId?: string }): Promise<number>;
  finish(jobNumber: number, f: FinishInput): Promise<BillFinishedResult | { refused: FinishLinesCode }>;
  /** Restart pbs (a new process) with another hold, or stop it (Down by a stopped process). */
  restartPbs(holdMs?: number): Promise<void>;
  stopPbs(): Promise<void>;
  rows<R>(sql: string, values?: unknown[]): Promise<R[]>;
}

const asLogin = (url: string, user: string) => {
  const u = new URL(url);
  u.username = user;
  return u.toString();
};

export function useBillingWorld(opts: WorldOptions): BillingWorld {
  const db = useMigratedDatabase();
  let worker: pg.Pool | undefined;
  let pbsPool: pg.Pool | undefined;
  let pbs: (PbsServer & { url: string }) | undefined;
  let client: HttpBillingClient | undefined;
  let link: BillingLink | undefined;
  let clock: DbClock | undefined;
  let customerId = '';
  let memberId = '';
  let windowId = '';
  const partIds = new Map<string, string>();
  const log = createLogger({ process: 'worker', clock: { realNow: () => Temporal.Instant.from(DEMO_START) }, write: () => undefined });
  let port = 0;

  async function startPbsAt(holdMs: number) {
    pbs = await startPbs({ pool: pbsPool!, log: createLogger({ process: 'pbs', write: () => undefined }), host: '127.0.0.1', port, holdMs });
    port = Number(new URL(pbs.url).port); // a restart keeps the address, as the Compose service name does
  }

  beforeAll(async () => {
    const a = db.admin();
    const ref = await seedReference(a);
    windowId = ref.windowId;
    customerId = ref.customerId;
    for (const s of SERVICES) {
      await a.query(`INSERT INTO world.service_type (id, screen_label_key, text_label_key, price_text_key, typical_length_key, invoice_price_cents, job_type, expected_minutes, skill, bookable_online)
                     VALUES ($1, 's', 't', 'p', 'l', $2, $3, $4, $5, $6)`, [s.id, s.cents, s.jobType, s.minutes, s.skill, s.online]);
    }
    // F-415: 1 unnest insert for the whole catalog, not 1 query for each of its 1,240 parts.
    const parts = await a.query<{ id: string; code: string }>(
      'INSERT INTO world.part (code, name, name_search, price_cents) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[]) RETURNING id, code',
      [PARTS.map((p) => p.code), PARTS.map((p) => p.name), PARTS.map((p) => p.name.toLowerCase()), PARTS.map((p) => p.cents)]);
    for (const r of parts.rows) partIds.set(r.code, r.id);
    const m = await a.query<{ id: string }>(`INSERT INTO world.customer (branch_id, name, name_search, texts_on, text_language, zone, street_id, house_number, lon, lat, customer_since, source, status, inbox_token)
                   VALUES ('columbus', 'Whitaker', 'whitaker', true, 'en', 'America/New_York', $1, 40, -83.0, 39.96, '2019-04-01', 'office', 'active', 'zyxwvutsrqponmlkjihgfe') RETURNING id`, [ref.streetId]);
    memberId = m.rows[0]!.id;
    await a.query(`INSERT INTO world.membership (customer_id, since, renews, benefits_key) VALUES ($1, '2024-04-01', '2027-04-01', 'membership.benefits')`, [memberId]);
    await a.query(`INSERT INTO system.demo_clock (id, demo_anchor, real_anchor, rate, paused, world_epoch, pbs_epoch, last_reset_real, last_write_real)
                   VALUES (1, $1, $1, 1, true, 1, 1, $1, $1)`, [DEMO_START]);
    // The worker's production pool shape (apps/worker/src/main.ts): 4 connections, 5 s connect timeout (F-382).
    worker = createPool({ connectionString: asLogin(db.url(), 'bw_worker'), max: WORKER_POOL_MAX, connectionTimeoutMillis: 5_000 });
    pbsPool = createPool({ connectionString: asLogin(db.url(), 'bw_pbs'), max: 16 });
    await ensureModeRow(pbsPool);
    await startPbsAt(opts.holdMs);
    client = new HttpBillingClient(pbs!.url);
    await client.reset(1); // pbs applies world epoch 1, as the reset confirmer has it do after setup (SD-12)
    clock = new DbClock(worker, { cacheMs: 0 });
    const lane = opts.timeoutMs === undefined
      ? billingLaneFor({ settings: { PBS_URL: pbs!.url }, log })
      : billingLane({ client, log, timeoutMs: opts.timeoutMs });
    link = billingLinkOver(worker, clock, lane);
  });

  afterAll(async () => {
    await link?.stop();
    await pbs?.close();
    await worker?.end();
    await pbsPool?.end();
  });

  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`the billing world has no ${what} yet (beforeAll has not run)`);
    return v;
  };

  return {
    admin: () => db.admin(),
    url: () => db.url(),
    worker: () => need(worker, 'worker pool'),
    pbsUrl: () => need(pbs, 'pbs').url,
    client: () => need(client, 'client'),
    link: () => need(link, 'link'),
    async setDemo(t) {
      await db.admin().query('UPDATE system.demo_clock SET demo_anchor = $1 WHERE id = 1', [t]);
    },
    demoNow: () => need(clock, 'clock').demoNow(),
    async setMode(mode, n) {
      await need(client, 'client').setMode(n === undefined ? { mode } : { mode, n });
    },
    async newJob(o = {}) {
      return insertJob(db.admin(), { customerId: o.member ? memberId : customerId, windowId }, {
        service_id: o.serviceId ?? 'furnace_tune_up', status: 'on_site', arrived_at: '2026-09-15T13:00:00Z',
      });
    },
    async finish(jobNumber, f) {
      const now = await need(clock, 'clock').demoNow();
      return inTransaction(need(worker, 'worker pool'), async (tx) => {
        const parts = (f.parts ?? []).map((p) => ({ partId: partIds.get(p.code) ?? `unknown-${p.code}`, quantity: p.quantity }));
        const status = f.status ?? 'done';
        if (status === 'done') {
          const v = finishLines({ parts, noPartsUsed: f.noPartsUsed ?? false, laborMinutes: f.laborMinutes ?? 60 }, (id) => [...partIds.values()].includes(id));
          if (!v.ok) return { refused: v.code };
          for (const p of v.lines.parts) await tx.query('INSERT INTO world.job_part (job_number, part_id, quantity) VALUES ($1, $2, $3)', [jobNumber, p.partId, p.quantity]);
          let seq = 0;
          for (const text of f.workDone ?? []) await tx.query('INSERT INTO world.work_done_line (job_number, seq, text) VALUES ($1, $2, $3)', [jobNumber, ++seq, text]);
          await tx.query(`UPDATE world.job SET status = 'done', ended_at = $2, labor_minutes = $3, no_parts_used = $4, version = version + 1 WHERE job_number = $1`,
            [jobNumber, now.toString(), v.lines.laborMinutes, v.lines.noPartsUsed]);
        } else {
          await tx.query(`UPDATE world.job SET status = 'no_one_home', ended_at = $2, version = version + 1 WHERE job_number = $1`, [jobNumber, now.toString()]);
        }
        return billFinishedJob(tx, { jobNumber, at: now });
      });
    },
    async restartPbs(holdMs = opts.holdMs) {
      await pbs?.close();
      await startPbsAt(holdMs);
    },
    async stopPbs() {
      await pbs?.close();
    },
    async rows<R>(sql: string, values: unknown[] = []) {
      return (await db.admin().query<R>(sql, values)).rows;
    },
  };
}
