// SPDX-License-Identifier: AGPL-3.0-or-later
// The eta.sweep handler (SPECIFICATIONS section 2 background-work table, SD-15; REQUIREMENTS FR-TEXT-5, UC-05, OA-53):
// every 5 demo minutes it recomputes the ETA and timing of today's open jobs (computed, never stored, except as texted)
// and writes the late text of section 6.4: 1 text per visit when the ETA is 20 or more minutes after the last arrival
// time texted, else after the planned arrival. ETA and drive minutes are @bw/domain's etaDay over the route source (SD-49)
// (routedDrive: the stored tracks, baked or live, else a live route), so they agree with the planner's planned arrivals.
// The successor event is written 5 demo minutes after the run, only when no other eta.sweep is due, so the chain converges to exactly 1 due event (the alert.check
// chain's rule, F-444): the first event is the seed's (packages/setup/src/world-seed.ts) and the worker never starts one.
// During a clock jump's replay the successor collapses to the jump's target (F-538; alert.check's rule, F-435, shared in
// ../clock/chain.ts): a replay runs the sweep at its own due time and once at the target, never once per skipped 5 minutes.
import type { Queryable } from '@bw/db';
import { etaDay, ETA_SWEEP_EVERY_MINUTES, isLateEnoughToText, type EtaStatus, type EtaStop } from '@bw/domain';
import type { Logger } from '@bw/log';
import { sendLate, type TextContext } from '@bw/outbox';
import { atLocal, Temporal, type Instant } from '@bw/time';
import { routedDrive } from '../../../../packages/maps/src/route-source.ts';
import { chainSuccessorDue } from '../clock/chain.ts';
import type { EventHandler, GiveUp } from '../dispatcher.ts';

export const ETA_SWEEP = 'eta.sweep';

/** pg_advisory_xact_lock key of the successor write (alert.check's is 7_301_701). */
const CHAIN_LOCK = 7_301_702;

interface DayJob {
  job_number: number;
  branch_id: string;
  technician_id: string;
  zone: string;
  date: string;
  status: EtaStatus;
  window_start: Date;
  window_end: Date;
  booked_at: Date;
  expected_minutes: number;
  on_the_way_at: Date | null;
  arrived_at: Date | null;
  ended_at: Date | null;
  planned_arrival: Date | null;
  texted_arrival: Date | null;
  late_text_sent_at: Date | null;
  lon: number;
  lat: number;
  shift_start: string;
  depot_lon: number;
  depot_lat: number;
}

export interface SweepReport {
  open: number;
  late: number;
  atRisk: number;
  lateTexts: number;
  /** Late texts that could not be made (a throw from one job's sendLate, rolled back to its savepoint) or that were too long (F-514). */
  skipped: number;
}

const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());

/**
 * The error's own code (a PostgreSQL SQLSTATE or a Node code), shape-checked as the import runner's failureCode is, else the fixed
 * word late_text_failed: never the message, since free text in a log line is where a phone number or address slips in (F-561).
 */
export function errorCodeOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-zA-Z0-9_]{2,40}$/.test(code) ? code : 'late_text_failed';
}

/** One sweep at `now`: the ETA and timing of every technician's day today, and the late texts that follow. */
export async function runEtaSweep(tx: Queryable, ctx: TextContext, now: Instant, log?: Logger): Promise<SweepReport> {
  const r = await tx.query<DayJob>(
    `SELECT j.job_number, j.branch_id, j.technician_id, j.zone, j.date::text AS date, j.status, j.window_start, j.window_end, j.booked_at,
            j.expected_minutes, j.on_the_way_at, j.arrived_at, j.ended_at, j.planned_arrival, j.texted_arrival, j.late_text_sent_at,
            c.lon, c.lat, t.shift_start::text AS shift_start, b.depot_lon, b.depot_lat
       FROM world.job j
       JOIN world.customer c ON c.id = j.customer_id
       JOIN world.technician t ON t.id = j.technician_id
       JOIN world.branch b ON b.id = j.branch_id
      WHERE j.status <> 'canceled' AND j.date = ($1::timestamptz AT TIME ZONE j.zone)::date
      ORDER BY j.technician_id, j.job_number`, [now.toString()]);
  const days = new Map<string, DayJob[]>();
  for (const j of r.rows) days.set(j.technician_id, [...(days.get(j.technician_id) ?? []), j]);

  const report: SweepReport = { open: 0, late: 0, atRisk: 0, lateTexts: 0, skipped: 0 };
  for (const jobs of days.values()) {
    const first = jobs[0] as DayJob;
    const stops: EtaStop[] = jobs.map((j) => ({
      jobNumber: j.job_number, status: j.status, windowStart: j.window_start.getTime(), windowEnd: j.window_end.getTime(), bookedAt: j.booked_at.getTime(),
      expectedMinutes: j.expected_minutes, point: { lon: j.lon, lat: j.lat }, onTheWayAt: ms(j.on_the_way_at), arrivedAt: ms(j.arrived_at), endedAt: ms(j.ended_at),
    }));
    const shiftStart = atLocal(first.date, first.shift_start.slice(0, 5), first.zone, 'compatible').epochMilliseconds;
    const day = { now: now.epochMilliseconds, shiftStart, depot: { lon: first.depot_lon, lat: first.depot_lat }, stops };
    // SD-49: the legs from the route source (the stored track, else a live route stored as a row, else approximate); the sweep's 1
    // transaction shares 1 live budget across every technician's day.
    const results = etaDay({ ...day, drive: await routedDrive(tx, first.branch_id, (drive) => etaDay({ ...day, drive })) });
    const byJob = new Map(jobs.map((j) => [j.job_number, j]));
    for (const e of results) {
      const j = byJob.get(e.jobNumber) as DayJob;
      if (j.status !== 'scheduled' && j.status !== 'on_the_way') continue;
      report.open += 1;
      if (e.timing === 'late') report.late += 1;
      if (e.timing === 'at_risk') report.atRisk += 1;
      // The candidate check reads the sweep's snapshot; sendLate re-reads the baseline under the job's lock and decides again.
      const baseline = ms(j.texted_arrival) ?? ms(j.planned_arrival);
      if (j.late_text_sent_at !== null || baseline === null || !isLateEnoughToText(e.eta, baseline)) continue;
      // F-514: one savepoint per late text. A throw from one job's sendLate rolls back that job's text only, is counted as a skip, and the
      // rest of the sweep and the next event still run (it was the whole sweep's rollback, retried every pass with no customer texted).
      await tx.query('SAVEPOINT late_text');
      try {
        const sent = await sendLate(tx, ctx, {
          jobNumber: j.job_number, eta: Temporal.Instant.fromEpochMilliseconds(e.eta), now,
          isLate: (b) => isLateEnoughToText(e.eta, b.epochMilliseconds),
        });
        if (sent.sent) report.lateTexts += 1;
        else if (sent.reason === 'message_too_long') report.skipped += 1;
      } catch (e) {
        await tx.query('ROLLBACK TO SAVEPOINT late_text');
        report.skipped += 1;
        // F-558: a skip is seen. The job number and the error's code (else its message, cut short) are the only fields; no text, name or address.
        log?.warn({ status: 'unhandled error', errorCode: errorCodeOf(e), jobNumber: j.job_number, demoTime: now.toString() });
      }
      await tx.query('RELEASE SAVEPOINT late_text');
    }
  }
  return report;
}

/** The next eta.sweep, 5 demo minutes on, only when no other eta.sweep is due (the alert.check chain's rule, F-444). */
async function writeEtaSweepSuccessor(tx: Queryable, event: { id: string }, now: Instant, replayTarget: Instant | undefined): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [CHAIN_LOCK]);
  await tx.query(
    `INSERT INTO world.scheduled_event (due_at, kind, subject, payload, state)
     SELECT $1, $2, 'eta', '{}'::jsonb, 'due'
      WHERE NOT EXISTS (SELECT 1 FROM world.scheduled_event WHERE kind = $2 AND state = 'due' AND id <> $3)`,
    [chainSuccessorDue(now, ETA_SWEEP_EVERY_MINUTES, replayTarget).toString(), ETA_SWEEP, event.id]);
}

/**
 * F-1844: an eta.sweep that failed MAX_HANDLER_FAILURES runs is ended (skipped, handler_failed), and the next one is
 * written as a run would write it, so late jobs keep being swept after 1 event that cannot run.
 */
export const giveUpEtaSweep: GiveUp = async (event, { tx, now, replayTarget }) => {
  await writeEtaSweepSuccessor(tx, event, now, replayTarget);
  return { state: 'skipped', result: 'handler_failed' };
};

/** The eta.sweep event handler: one sweep at the event's time, then the next event 5 demo minutes on. */
export function etaSweepHandler(ctx: TextContext, log?: Logger): EventHandler {
  return async (event, { tx, now, replayTarget }) => {
    const report = await runEtaSweep(tx, ctx, now, log);
    await writeEtaSweepSuccessor(tx, event, now, replayTarget);
    return { state: 'done', result: `open ${report.open}, late ${report.late}, at risk ${report.atRisk}, late texts ${report.lateTexts}, skipped ${report.skipped}` };
  };
}
