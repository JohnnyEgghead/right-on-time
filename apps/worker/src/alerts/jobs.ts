// SPDX-License-Identifier: AGPL-3.0-or-later
// The worker's alert jobs (SPECIFICATIONS section 2 background-work table, SD-30):
//   - the heartbeat: every 10 real seconds the worker writes system.worker_heartbeat.beat_real, which GET /healthz reads
//     (section 7.4: 503 when it is 60 s old or more);
//   - the alert.check event: runs every alert rule inside the dispatcher's transaction and schedules the next one 5 demo
//     minutes after the run. During a clock jump's replay (section 5.2 step 6) a successor that would fall before the
//     jump's target is written AT the target instead (F-435, P3-REPLAY's decision; ../clock/chain.ts, shared with
//     eta.sweep): the replay runs the check at its own due time and once more at the target, never once per skipped
//     5 minutes.
// The first alert.check event is the seed's (section 3 writer table; packages/setup/src/world-seed.ts), and the worker
// never writes one (F-444: a worker-side first event raced the seed and left 2 chains). Each run writes its successor
// only when no other alert.check is due, so the chain converges to exactly 1 due event: 2 due events (a restored
// snapshot that carries 2) become 1 after both run, and a replayed run writes nothing a converged chain lacks.
import type { createPool, Queryable } from '@bw/db';
import { ALERT_CHECK_EVERY_MINUTES } from '@bw/domain';
import type { Logger } from '@bw/log';
import type { Clock, Instant } from '@bw/time';
import { chainSuccessorDue } from '../clock/chain.ts';
import type { EventHandler, GiveUp } from '../dispatcher.ts';
import { runAlertChecks } from './check.ts';

export const ALERT_CHECK = 'alert.check';
export const HEARTBEAT_EVERY_MS = 10_000;
/**
 * pg_advisory_xact_lock key of the successor write. Held to commit, it orders 2 concurrent runs (2 workers, each with 1
 * of 2 due events): the second one's NOT EXISTS reads after the first committed (READ COMMITTED), so exactly 1 writes.
 */
const CHAIN_LOCK = 7_301_701;

export async function writeHeartbeat(db: Queryable, clock: Pick<Clock, 'realNow'>): Promise<void> {
  await db.query(
    `INSERT INTO system.worker_heartbeat (id, beat_real) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET beat_real = EXCLUDED.beat_real`,
    [clock.realNow('health_heartbeat').toString()],
  );
}

/**
 * The next alert.check, 5 demo minutes on (collapsed during a replay). The claimed event is still due inside this
 * transaction, so it is excluded by id: the successor is written only when no other alert.check is due (F-444).
 */
async function writeAlertCheckSuccessor(tx: Queryable, event: { id: string }, now: Instant, replayTarget: Instant | undefined): Promise<void> {
  const next = chainSuccessorDue(now, ALERT_CHECK_EVERY_MINUTES, replayTarget);
  await tx.query('SELECT pg_advisory_xact_lock($1)', [CHAIN_LOCK]);
  await tx.query(
    `INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state)
     SELECT $1, $2, 'alerts', '{}'::jsonb, 'due'
      WHERE NOT EXISTS (SELECT 1 FROM world.scheduled_event WHERE kind = $2 AND state = 'due' AND id <> $3)`,
    [next.toString(), ALERT_CHECK, event.id],
  );
}

/**
 * F-1844: an alert.check that failed MAX_HANDLER_FAILURES runs is ended (skipped, handler_failed), and the next one is
 * written as a run would write it, so the office's alerts keep being checked after 1 event that cannot run.
 */
export const giveUpAlertCheck: GiveUp = async (event, { tx, now, replayTarget }) => {
  await writeAlertCheckSuccessor(tx, event, now, replayTarget);
  return { state: 'skipped', result: 'handler_failed' };
};

/** The alert.check handler: one run of every rule at the event's time, then the next event 5 demo minutes on. */
export function alertCheckHandler(deps: { clock: Pick<Clock, 'realNow'>; backupTarget: 'none' | 'lightsail'; log?: Logger }): EventHandler {
  return async (event, { tx, now, replayTarget }) => {
    const report = await runAlertChecks(tx, { now, clock: deps.clock, backupTarget: deps.backupTarget });
    // F-498: a rule that throws on every run must say why. The line carries the type, the database code and the constraint, never the message.
    for (const c of report.causes) {
      deps.log?.error({ status: 'unhandled error', errorCode: `alert_rule_failed ${c.type} ${c.code}${c.constraint ? ` ${c.constraint}` : ''}`, demoTime: now.toString() });
    }
    await writeAlertCheckSuccessor(tx, event, now, replayTarget);
    return { state: 'done', result: `opened ${report.opened.length}, resolved ${report.resolved.length}, info ${report.info.length}, emailed ${report.emailed}${report.failed.length > 0 ? `, rules failed ${report.causes.map((c) => `${c.type}(${c.code}${c.constraint ? ` ${c.constraint}` : ''})`).join(' ')}` : ''}` };
  };
}

/** The heartbeat as a worker job. It writes no alert.check event (F-444: the seed writes the first, each run the next). */
export async function startAlertJobs(d: { pool: ReturnType<typeof createPool>; clock: Pick<Clock, 'realNow'>; log: Logger }): Promise<{ readonly name: string; stop(): Promise<void> }> {
  let stopped = false;
  let beating: Promise<unknown> = Promise.resolve();
  const beat = (): void => {
    if (stopped) return;
    beating = writeHeartbeat(d.pool, d.clock).catch(() => d.log.error({ status: 'unhandled error', errorCode: 'heartbeat_failed' }));
  };
  // The first beat is written before the job reports started.
  beat();
  await beating;
  const t = setInterval(beat, HEARTBEAT_EVERY_MS);
  return {
    name: 'alert jobs',
    async stop() {
      stopped = true;
      clearInterval(t);
      await beating;
    },
  };
}
