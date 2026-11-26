// SPDX-License-Identifier: AGPL-3.0-or-later
// The event dispatcher (SPECIFICATIONS section 5.2 step 7; section 3 `scheduled_event`). It claims due side-effect
// events in (due_at, id) order with FOR UPDATE SKIP LOCKED and runs each in its own transaction:
//
//   claim 1 row  ->  run its kind's handler in the same transaction  ->  mark it done or skipped  ->  commit
//
// Re-run semantics, at every durable write:
//   - The claim, every write the handler makes (a text's attempt, its inbox row, the next event) and the done mark
//     commit together. A crash or a handler error before commit leaves nothing, and the event is still `due`: the
//     next pass runs it again from the start, so an event's effects happen exactly once.
//   - Concurrent dispatchers (2 workers, or the clock-jump replay beside the normal loop) never run 1 event twice:
//     SKIP LOCKED hands a locked row to no one else, and a row marked done is never claimed again.
//   - A handler that throws is left due and excluded for the rest of that pass, so 1 bad row never blocks the rows
//     behind it; the next pass (1 s later) tries it again. Each failed run is 1 error line with the event's kind, id and
//     cause code, never its subject, payload or message (section 11.4, F-1844); a kind with a give-up ends the event
//     after MAX_HANDLER_FAILURES failed runs (noteHandlerFailure).
//   - Only kinds with a handler here are claimed. A kind no handler serves yet (a lane that has not joined) stays due,
//     untouched, never marked done or skipped by a dispatcher that cannot run it.
//
// "Now" for an event is max(its due_at, demo now): in normal running demo now (the clock has passed due_at), and during
// a replay, whose clock is paused at the old time, the event's own due_at (step 6: a 6:00 PM reminder is stamped 6:00
// PM). Its effects are written at that time, never before the event's own due time.
//
// A drain is bound to the world epoch its bound was read in (F-635). A reset (SD-12) refills scheduled_event with the
// fresh world's events, which an older drain's bound (the old demo now, or a replay's old jump batch) would otherwise
// run at the old world's time. Each claim therefore reads the clock row's world_epoch after it holds its event row, and
// a drain whose epoch is gone stops. No lock on the clock row is needed: the claim holds a lock on world.scheduled_event,
// and the reset's restore_world takes every world table ACCESS EXCLUSIVE before it writes the new epoch, so a reset
// either commits before the claim's epoch read (the read sees the new epoch) or waits for the claim to commit (the claim
// ran an event of its own world).
import { inTransaction, type createPool, type Queryable } from '@bw/db';
import { causeCodeOf, type Logger } from '@bw/log';
import { Temporal, toWire, type Clock, type Instant } from '@bw/time';
import { failingStep } from './failing.ts';

type Pool = ReturnType<typeof createPool>;

export interface DueEvent {
  id: string;
  dueAt: Instant;
  kind: string;
  subject: string;
  payload: Record<string, unknown>;
}

interface EventContext {
  /** The event's transaction: every write of the handler joins it. */
  tx: Queryable;
  /** The demo time the event runs at: max(due_at, demo now). */
  now: Instant;
  /**
   * During a replay (section 5.2 step 6), the jump's target T; absent in normal running. A self-rescheduling chain uses
   * it to collapse the skipped intervals (alert.check, F-435).
   */
  replayTarget?: Instant;
}

/** `skipped`: the handler's precondition failed (a text no longer sendable, a canceled job); `done`: it ran. */
export interface EventOutcome {
  state: 'done' | 'skipped';
  /** The outcome word stored in scheduled_event.result. */
  result: string;
}

export type EventHandler = (event: DueEvent, ctx: EventContext) => Promise<EventOutcome>;
export type EventHandlers = Readonly<Record<string, EventHandler>>;

/**
 * What a kind does when its handler has failed MAX_HANDLER_FAILURES runs in a row (F-368): it writes the event's end
 * record in its own transaction (a text gives up, which opens its alert) and answers the outcome to mark, normally
 * `skipped` with the result `handler_failed`. A kind with no give-up keeps retrying, as before.
 */
export type GiveUp = EventHandler;
export type GiveUps = Readonly<Record<string, GiveUp>>;

/** A serial-lane event whose handler threw this many runs is given up (F-368). */
export const MAX_HANDLER_FAILURES = 5;

/**
 * F-1844: the line of 1 event (its kind and id, never its subject or payload), at the demo time it ran at. The cause, when
 * the line has one, is @bw/log causeCodeOf: the error's code or class name, never its message.
 */
const eventLine = (event: Pick<DueEvent, 'id' | 'kind'>, now: Instant) => ({ eventKind: event.kind, eventId: event.id, demoTime: toWire(now, 'UTC') });

/**
 * 1 failed run of a serial-lane event (its transaction rolled back, the event is still due): count it on the event's
 * payload (`failures`, committed on its own), and at MAX_HANDLER_FAILURES run the kind's give-up and mark the event.
 * Every step is logged at error level (F-1844): the failed run ('event failed', with the count once written), a count
 * that could not be written ('event failure not counted': the run is still failed, the next pass tries again), the
 * give-up ('event gave up'), and a give-up that itself threw ('event give-up failed': it changes nothing, and the event
 * is tried again next pass). A kind with no give-up is not counted. Returns true when the event was given up.
 *
 * Re-run semantics: the count is 1 committed UPDATE per failed run, guarded by `state = 'due'`, so it only grows and
 * stops when the event leaves due. The give-up, its end record and the mark commit in 1 transaction that holds the row
 * (SKIP LOCKED: a second dispatcher that reaches the limit at the same time finds no row and gives nothing up twice).
 */
async function noteHandlerFailure(
  pool: Pool, event: DueEvent, ctx: { now: Instant; replayTarget?: Instant }, giveUps: GiveUps, log: Logger, cause: unknown,
): Promise<boolean> {
  const line = eventLine(event, ctx.now);
  const errorCode = causeCodeOf(cause);
  const giveUp = giveUps[event.kind];
  if (!giveUp) {
    log.error({ status: 'event failed', ...line, errorCode });
    return false;
  }
  let failures: number;
  try {
    const counted = await pool.query<{ failures: number }>(
      `UPDATE world.scheduled_event SET payload = jsonb_set(payload, '{failures}', to_jsonb(coalesce((payload->>'failures')::int, 0) + 1))
        WHERE id = $1 AND state = 'due' RETURNING (payload->>'failures')::int AS failures`,
      [event.id],
    );
    failures = counted.rows[0]?.failures ?? 0;
  } catch (e) {
    log.error({ status: 'event failed', ...line, errorCode });
    log.error({ status: 'event failure not counted', ...line, errorCode: causeCodeOf(e) });
    return false;
  }
  log.error({ status: 'event failed', ...line, errorCode, failures });
  if (failures < MAX_HANDLER_FAILURES) return false;
  try {
    const gaveUp = await inTransaction(pool, async (tx) => {
      const lock = await tx.query(`SELECT 1 FROM world.scheduled_event WHERE id = $1 AND state = 'due' FOR UPDATE SKIP LOCKED`, [event.id]);
      if (lock.rows.length === 0) return false;
      const outcome = await giveUp(event, ctx.replayTarget ? { tx, now: ctx.now, replayTarget: ctx.replayTarget } : { tx, now: ctx.now });
      await markEvent(tx, event.id, ctx.now, outcome);
      return true;
    });
    if (gaveUp) log.error({ status: 'event gave up', ...line, errorCode, failures });
    return gaveUp;
  } catch (e) {
    log.error({ status: 'event give-up failed', ...line, errorCode: causeCodeOf(e), failures });
    return false;
  }
}

export interface DrainReport {
  ran: number;
  skipped: number;
  /** Ids of events whose handler threw this pass; they stay due. */
  failed: string[];
}

interface EventRow {
  id: string;
  due_at: Date;
  kind: string;
  subject: string;
  payload: Record<string, unknown>;
}

const later = (a: Instant, b: Instant): Instant => (Temporal.Instant.compare(a, b) >= 0 ? a : b);

/**
 * F-635: true when the world is still at `epoch` (always, when no epoch is given). Read inside a claim transaction that
 * already holds its world.scheduled_event row, so no reset can commit between this read and the claim's commit.
 */
async function sameWorld(tx: Queryable, epoch: number | undefined): Promise<boolean> {
  if (epoch === undefined) return true;
  const { rows } = await tx.query<{ world_epoch: number }>('SELECT world_epoch FROM system.demo_clock WHERE id = 1');
  return rows[0]?.world_epoch === epoch;
}

/**
 * Claim and run the first due event (due_at <= through, a handled kind, not excluded). Returns null when none is due,
 * or when `epoch` is given and the world is no longer at it (F-635: a reset since the bound was read; nothing runs),
 * else the outcome, or `failed` when the handler threw (its transaction rolled back; the event stays due).
 */
export async function runNextDue(
  pool: Pool,
  handlers: EventHandlers,
  opts: { through: Instant; demoNow: Instant; exclude?: readonly string[]; giveUps?: GiveUps; replayTarget?: Instant; epoch?: number; log: Logger },
): Promise<null | { id: string; outcome: EventOutcome } | { id: string; failed: unknown }> {
  const kinds = Object.keys(handlers);
  if (kinds.length === 0) return null;
  let claimed: DueEvent | undefined;
  try {
    return await inTransaction(pool, async (tx) => {
      const { rows } = await tx.query<EventRow>(
        `SELECT id, due_at, kind, subject, payload FROM world.scheduled_event
          WHERE state = 'due' AND due_at <= $1 AND kind = ANY($2::text[]) AND NOT (id = ANY($3::uuid[]))
          ORDER BY due_at, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        [opts.through.toString(), kinds, opts.exclude ?? []],
      );
      const row = rows[0];
      if (!row) return null;
      if (!(await sameWorld(tx, opts.epoch))) return null;
      const event: DueEvent = {
        id: row.id,
        dueAt: Temporal.Instant.fromEpochMilliseconds(row.due_at.getTime()),
        kind: row.kind,
        subject: row.subject,
        payload: row.payload,
      };
      claimed = event;
      const now = later(event.dueAt, opts.demoNow);
      const outcome = await handlers[event.kind]!(event, opts.replayTarget ? { tx, now, replayTarget: opts.replayTarget } : { tx, now });
      await tx.query(`UPDATE world.scheduled_event SET state = $2, run_at = $3, result = $4 WHERE id = $1`, [
        event.id, outcome.state, now.toString(), outcome.result,
      ]);
      return { id: event.id, outcome };
    });
  } catch (e) {
    if (claimed) {
      // F-368: count the failure; the 5th gives the event up (the kind's end record), and a pass does not report it failed.
      // F-1844: every step is logged there, and it never throws (a count it cannot write is logged, never swallowed).
      const now = later(claimed.dueAt, opts.demoNow);
      const ctx = opts.replayTarget ? { now, replayTarget: opts.replayTarget } : { now };
      const gaveUp = await noteHandlerFailure(pool, claimed, ctx, opts.giveUps ?? {}, opts.log, e);
      return gaveUp ? { id: claimed.id, outcome: { state: 'skipped', result: 'handler_failed' } } : { id: claimed.id, failed: e };
    }
    throw e;
  }
}

/**
 * Run every due event up to `through`, in (due_at, id) order, including events the runs themselves make due. The caller
 * names the `epoch` it read with or before its bound, and the drain stops at the first claim after a reset (F-635, F-642:
 * required, so no caller can pair an old bound with a new epoch or claim unguarded).
 */
export async function drainDue(
  pool: Pool,
  handlers: EventHandlers,
  opts: { through: Instant; demoNow: Instant; giveUps?: GiveUps; replayTarget?: Instant; epoch: number; log: Logger },
): Promise<DrainReport> {
  const report: DrainReport = { ran: 0, skipped: 0, failed: [] };
  for (;;) {
    const r = await runNextDue(pool, handlers, { ...opts, exclude: report.failed });
    if (r === null) return report;
    if ('failed' in r) report.failed.push(r.id);
    else if (r.outcome.state === 'skipped') report.skipped += 1;
    else report.ran += 1;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The parallel claim lane (F-357, F-382). 1 dispatcher claims in 2 lanes from the same scheduled_event table:
//
//   serial lane    every kind in `handlers`, 1 event at a time, handler inside the claim transaction (above, unchanged);
//   parallel lane  the kinds of 1 ParallelLane (billing.send, billing.retry), whose handler makes a slow outside call
//                  (up to 30 s real time). Its events run concurrently across keys (jobs) and 1 at a time per key, at
//                  most `concurrency` in flight, and never inside an open transaction:
//
//     tx 1 (short)  claim the row FOR UPDATE SKIP LOCKED, `prepare` reads what the call needs, or settles the event
//                   without a call (marked here, in tx 1). Commit: the event is still `due`, no lock is kept.
//     call          `call` with no transaction and no pooled connection held.
//     tx 2 (short)  re-lock the event row, `record` writes the outcome and the dispatcher marks the event (when still
//                   due) in the same transaction: 1 transaction per event outcome.
//
// Re-run semantics: a crash or an error before tx 2 commits leaves the event due and its effects unwritten, so it runs
// again from tx 1 (the billing link converges through pbs already_have). The key's in-flight guard keeps a second run of
// the same key off while a call is out; `record` must refuse an outcome it can no longer apply (the billing link checks
// the item's try count and the world epoch), so 2 dispatchers can at worst make 2 calls, never 2 outcomes.
// No spec rule orders a serial-lane event against a parallel-lane one (they share no rows), so every order the spec
// names is kept: the serial lane in (due_at, id) order, and each key of the parallel lane in (due_at, id) order.
// A drain (a pass, or a replay through T) ends only when both lanes have nothing due through T and nothing in flight.

/** The 3 steps of a handler whose side effect is a slow outside call (P: what the call needs, R: its answer). */
export interface SplitHandler<P, R> {
  /** In tx 1, holding the event's row: what the call needs, or the event's outcome with no call. */
  prepare(event: DueEvent, ctx: EventContext): Promise<{ settle: EventOutcome } | { call: P }>;
  /** Outside every transaction. `replay` holds the jump's target while a replay runs (FR-BILL-6 jump wait, F-386). */
  call(prepared: P, event: DueEvent, now: Instant, replay?: { target: Instant }): Promise<R>;
  /**
   * In tx 2, before the dispatcher re-locks the event row: the handler's own row locks, so tx 2 takes its locks in the
   * order the handler's other writers do (billing: the job's lock and its item row, then the event rows).
   */
  lock?(prepared: P, event: DueEvent, tx: Queryable): Promise<void>;
  /**
   * In tx 2, holding the event's row again; `due` is false when the event left `due` meanwhile (another writer
   * retired it). Answers the outcome to mark, or null when the answer no longer applies (nothing is marked).
   */
  record(prepared: P, answer: R, event: DueEvent, ctx: EventContext & { due: boolean }): Promise<EventOutcome | null>;
}

export interface ParallelLane<P = unknown, R = unknown> {
  readonly name: string;
  readonly kinds: readonly string[];
  /** Events with the same key run 1 at a time (billing: the job number). */
  keyOf(event: DueEvent): string;
  /** At most this many events of the lane in flight in this dispatcher (kept below the pool, F-382). */
  readonly concurrency: number;
  readonly handler: SplitHandler<P, R>;
}

/**
 * What 1 run of a parallel-lane event did. `busy`: its key is in flight here; `gone`: it was no longer due; `stale`: the
 * world left the run's epoch before tx 1 (F-635), so nothing ran.
 */
export type LaneRun =
  | { id: string; outcome: EventOutcome } | { id: string; failed: unknown } | { id: string; busy: true } | { id: string; gone: true }
  | { id: string; stale: true };

/** The in-flight state of 1 lane in 1 dispatcher: the per-key guard and the running events. */
export class LaneRunner<P = unknown, R = unknown> {
  readonly lane: ParallelLane<P, R>;
  readonly #pool: Pool;
  readonly #inFlight = new Map<string, Promise<LaneRun>>();
  readonly #log: Logger;

  constructor(pool: Pool, lane: ParallelLane<P, R>, log: Logger) {
    this.#pool = pool;
    this.lane = lane;
    this.#log = log;
  }

  /** F-1844: 1 failed run of the lane (its handler threw, or its key could not be read), logged with its kind, id and cause. */
  #failed(event: DueEvent, now: Instant, e: unknown): LaneRun {
    this.#log.error({ status: 'event failed', ...eventLine(event, now), errorCode: causeCodeOf(e) });
    return { id: event.id, failed: e };
  }

  /** F-1847: the event's key, or the failed run of that event when keyOf throws (a payload with no job number). */
  #keyOf(event: DueEvent, demoNow: Instant): { key: string } | { run: LaneRun } {
    try {
      return { key: this.lane.keyOf(event) };
    } catch (e) {
      return { run: this.#failed(event, later(event.dueAt, demoNow), e) };
    }
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** Wait for every event in flight. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#inFlight.values()]);
  }

  /** Run 1 event of the lane now (tx 1, the call, tx 2). `demoNow` gives the run time max(due_at, demo now). */
  run(event: DueEvent, demoNow: Instant, replayTarget?: Instant, epoch?: number): Promise<LaneRun> {
    const k = this.#keyOf(event, demoNow);
    if ('run' in k) return Promise.resolve(k.run);
    const { key } = k;
    if (this.#inFlight.has(key)) return Promise.resolve({ id: event.id, busy: true });
    const p = this.#runOnce(event, later(event.dueAt, demoNow), replayTarget, epoch).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, p);
    return p;
  }

  async #runOnce(event: DueEvent, now: Instant, replayTarget?: Instant, epoch?: number): Promise<LaneRun> {
    const { handler } = this.lane;
    try {
      const first = await inTransaction(this.#pool, async (tx) => {
        const { rows } = await tx.query<{ state: string }>(
          `SELECT state FROM world.scheduled_event WHERE id = $1 AND state = 'due' FOR UPDATE SKIP LOCKED`, [event.id]);
        if (!rows[0]) return { gone: true as const };
        if (!(await sameWorld(tx, epoch))) return { stale: true as const };
        const step = await handler.prepare(event, { tx, now });
        if ('settle' in step) await markEvent(tx, event.id, now, step.settle);
        return step;
      });
      if ('gone' in first) return { id: event.id, gone: true };
      if ('stale' in first) return { id: event.id, stale: true };
      if ('settle' in first) return { id: event.id, outcome: first.settle };
      const answer = replayTarget ? await handler.call(first.call, event, now, { target: replayTarget }) : await handler.call(first.call, event, now);
      const outcome = await inTransaction(this.#pool, async (tx) => {
        await handler.lock?.(first.call, event, tx);
        const { rows } = await tx.query<{ state: string }>('SELECT state FROM world.scheduled_event WHERE id = $1 FOR UPDATE', [event.id]);
        const due = rows[0]?.state === 'due';
        const out = await handler.record(first.call, answer, event, { tx, now, due });
        if (out && due) await markEvent(tx, event.id, now, out);
        return out;
      });
      return outcome ? { id: event.id, outcome } : { id: event.id, gone: true };
    } catch (e) {
      return this.#failed(event, now, e);
    }
  }

  /**
   * Start due events of the lane (due_at <= through, in (due_at, id) order) until `concurrency` are in flight, skipping
   * a key already in flight and every excluded id. Answers the runs it started.
   */
  async fill(opts: { through: Instant; demoNow: Instant; exclude?: readonly string[]; replayTarget?: Instant; epoch?: number }): Promise<Promise<LaneRun>[]> {
    const room = this.lane.concurrency - this.#inFlight.size;
    if (room <= 0) return [];
    const { rows } = await this.#pool.query<EventRow>(
      `SELECT id, due_at, kind, subject, payload FROM world.scheduled_event
        WHERE state = 'due' AND due_at <= $1 AND kind = ANY($2::text[]) AND NOT (id = ANY($3::uuid[]))
        ORDER BY due_at, id
        LIMIT $4`,
      [opts.through.toString(), this.lane.kinds, opts.exclude ?? [], 200],
    );
    const started: Promise<LaneRun>[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (this.#inFlight.size >= this.lane.concurrency) break;
      const event = toDueEvent(row);
      // F-1847: an event whose key cannot be read is 1 failed run of that event (logged, and excluded for the rest of a
      // drain), never a throw that would end the pass before the serial lane's drain runs.
      const k = this.#keyOf(event, opts.demoNow);
      if ('run' in k) {
        started.push(Promise.resolve(k.run));
        continue;
      }
      const { key } = k;
      // Per key in (due_at, id) order: a key's later event never starts before its earlier one.
      if (seen.has(key) || this.#inFlight.has(key)) {
        seen.add(key);
        continue;
      }
      seen.add(key);
      started.push(this.run(event, opts.demoNow, opts.replayTarget, opts.epoch));
    }
    return started;
  }

  /**
   * Run every due event of the lane through `through`, including events the runs make due, until none is in flight.
   * A `stale` run (a reset since `epoch`, F-635) ends it: no more runs start, and the ones in flight finish.
   */
  async drain(opts: { through: Instant; demoNow: Instant; replayTarget?: Instant; epoch?: number }): Promise<DrainReport> {
    const report: DrainReport = { ran: 0, skipped: 0, failed: [] };
    let stale = false;
    // Excluded for the rest of this drain: a failed run (as in the serial lane) and an event another runner holds.
    const exclude: string[] = [];
    const tally = (r: LaneRun) => {
      if ('failed' in r) {
        report.failed.push(r.id);
        exclude.push(r.id);
      } else if ('gone' in r) exclude.push(r.id);
      else if ('stale' in r) stale = true;
      else if ('outcome' in r) {
        if (r.outcome.state === 'skipped') report.skipped += 1;
        else report.ran += 1;
      }
    };
    for (;;) {
      if (stale) {
        await this.settled();
        await Promise.resolve();
        return report;
      }
      const started = await this.fill({ ...opts, exclude });
      for (const p of started) void p.then(tally);
      if (this.#inFlight.size === 0) {
        if (started.length === 0) return report;
        // Every run started is already settled (a key that could not be read, F-1847): let their tallies land first, so
        // the next fill excludes them.
        await Promise.all(started);
        continue;
      }
      await Promise.race(this.#inFlight.values());
      // Let the finished run's tally land before the next fill reads `failed`.
      await Promise.resolve();
    }
  }
}

async function markEvent(tx: Queryable, id: string, now: Instant, outcome: EventOutcome): Promise<void> {
  await tx.query(`UPDATE world.scheduled_event SET state = $2, run_at = $3, result = $4 WHERE id = $1`, [id, outcome.state, now.toString(), outcome.result]);
}

const toDueEvent = (row: EventRow): DueEvent => ({
  id: row.id,
  dueAt: Temporal.Instant.fromEpochMilliseconds(row.due_at.getTime()),
  kind: row.kind,
  subject: row.subject,
  payload: row.payload,
});

const merge = (a: DrainReport, b: DrainReport): DrainReport => ({ ran: a.ran + b.ran, skipped: a.skipped + b.skipped, failed: [...a.failed, ...b.failed] });

export interface Dispatcher {
  readonly name: string;
  /** Every event kind this dispatcher claims: the serial lane's, then each parallel lane's. */
  readonly kinds: readonly string[];
  /** Run 1 pass now through demo now, in both lanes, until neither has anything due or in flight, and report it. */
  drain(): Promise<DrainReport>;
  /**
   * Run every event due through `through` in both lanes, each at max(due_at, demoNow) (the replay of a forward clock jump: the clock
   * paused at the old time; `replayTarget` is the jump's target, handed to each handler). Ends only when both lanes
   * are empty through `through`, or at the first claim after the world leaves `epoch` (F-635). The caller passes the
   * epoch it read with or before its bound (the replay does), and it is required (F-642).
   */
  drainThrough(opts: { through: Instant; demoNow: Instant; replayTarget?: Instant; epoch: number }): Promise<DrainReport>;
  stop(): Promise<void>;
}

/** Normal running (step 7): every `intervalMs` real milliseconds, run every event due at demo now. */
export function startDispatcher(opts: {
  pool: Pool;
  /** worldEpoch is read before demoNow, so a pass's bound is never from a newer world than its epoch (F-635). */
  clock: Pick<Clock, 'demoNow' | 'worldEpoch'>;
  handlers: EventHandlers;
  /** Per kind, what to do after MAX_HANDLER_FAILURES failed runs (F-368). */
  giveUps?: GiveUps;
  /** The parallel lanes (the billing link); their kinds must not also be in `handlers`. */
  lanes?: readonly ParallelLane[];
  log: Logger;
  intervalMs?: number;
  /** The real-time source of the failing pass's repeat (F-1846); default performance.now. */
  realMs?: () => number;
}): Dispatcher {
  const { pool, clock, handlers, log } = opts;
  const giveUps = opts.giveUps ?? {};
  const intervalMs = opts.intervalMs ?? 1000;
  const runners = (opts.lanes ?? []).map((lane) => {
    const overlap = lane.kinds.filter((k) => k in handlers);
    if (overlap.length > 0) throw new Error(`event kinds ${overlap.join(', ')} are in both the serial and the ${lane.name} lane`);
    return new LaneRunner(pool, lane, log);
  });
  let chain: Promise<unknown> = Promise.resolve();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const passes = failingStep(log, { failed: 'dispatcher pass failed', recovered: 'dispatcher pass recovered' }, opts.realMs);

  // A timer tick: the serial lane runs its pass (serialized with the other passes) while each parallel lane only tops up
  // its free slots, so a call held 30 s never holds up the serial lane's next pass. Each failed run of an event is logged
  // where it failed (noteHandlerFailure, LaneRunner), with its kind and id (F-1844).
  const pass = async (): Promise<DrainReport> => {
    const epoch = await clock.worldEpoch();
    const now = await clock.demoNow();
    for (const r of runners) await r.fill({ through: now, demoNow: now, epoch });
    return drainDue(pool, handlers, { through: now, demoNow: now, giveUps, epoch, log });
  };
  const serialize = <T>(f: () => Promise<T>): Promise<T> => {
    const p = chain.then(f);
    chain = p.catch(() => undefined);
    return p;
  };
  // Both lanes until a round runs nothing: the serial lane's drains stay serialized with the timer's passes, the parallel
  // lanes drain beside them, and a round repeats while either lane ran something (a serial event can make a billing
  // event due, the finish item for one). A round with only failures ends it: a failing event waits for the next pass.
  const drainBoth = async (o: { through: Instant; demoNow: Instant; replayTarget?: Instant; epoch: number }): Promise<DrainReport> => {
    let total: DrainReport = { ran: 0, skipped: 0, failed: [] };
    for (;;) {
      const [serial, ...parallel] = await Promise.all([serialize(() => drainDue(pool, handlers, { ...o, giveUps, log })), ...runners.map((r) => r.drain(o))]);
      const round = parallel.reduce(merge, serial);
      total = merge(total, round);
      if (round.ran + round.skipped === 0) return total;
    }
  };
  const drainThrough = (o: { through: Instant; demoNow: Instant; replayTarget?: Instant; epoch: number }): Promise<DrainReport> => drainBoth(o);
  const loop = (): void => {
    if (stopped) return;
    serialize(pass)
      .then(() => passes.ok())
      .catch((e: unknown) => {
        // A pass that cannot start (no database yet, no clock row before setup), F-1846: logged with its cause at once,
        // again every 10 real minutes while passes keep failing, and once when a pass succeeds again.
        passes.failed(e);
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, intervalMs);
      });
  };
  timer = setTimeout(loop, 0);
  return {
    name: 'event-dispatcher',
    kinds: Object.freeze([...Object.keys(handlers), ...runners.flatMap((r) => r.lane.kinds)]),
    async drain() {
      const epoch = await clock.worldEpoch();
      const now = await clock.demoNow();
      return drainThrough({ through: now, demoNow: now, epoch });
    },
    drainThrough,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await chain;
      await Promise.all(runners.map((r) => r.settled()));
    },
  };
}
