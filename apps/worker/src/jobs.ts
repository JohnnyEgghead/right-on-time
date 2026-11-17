// SPDX-License-Identifier: AGPL-3.0-or-later
// The worker's job registry (F-269): main.ts starts every entry of `jobs` and stops them on SIGTERM, and the event
// dispatcher runs every handler of `eventHandlers`. main.ts never changes when a job joins.
//
// How a later lane joins (1 line each, nothing else in this file or in main.ts):
//   - a job with its own loop: export a starter `(deps: WorkerDeps) => RunningJob` from its folder and add
//       startMyJob,
//     to `jobs` below;
//   - a scheduled_event kind (billing.send, alert.check, eta.sweep, ...): export a handler factory
//     `(deps: WorkerDeps) => EventHandler` and add
//       ['billing.send', billingSendHandler],
//     to `eventHandlers` below. The dispatcher claims only kinds listed here, so a kind with no line is never touched;
//   - a scheduled_event kind whose handler makes a slow outside call (billing): a ParallelLane factory in
//     `eventLanes` below. The dispatcher claims its kinds in a second claim lane, in parallel across its keys, 1 at a
//     time per key, and never across an open transaction (F-357, F-382).
import type { Settings } from '@bw/config';
import type { createPool } from '@bw/db';
import type { Logger } from '@bw/log';
import { catalogs } from '@bw/i18n/src/catalog.ts';
import { TEXT_REMINDER, TEXT_TRY, textGatewayFrom } from '@bw/outbox';
import type { Clock } from '@bw/time';
import { alertCheckHandler, ALERT_CHECK, giveUpAlertCheck, startAlertJobs } from './alerts/index.ts';
import { billingLaneFor, startBillingHealer } from './billing/link.ts';
import { startClockJobs } from './clock/index.ts';
import { startImportJob } from './import/index.ts';
import { startDispatcher, type Dispatcher, type EventHandler, type EventHandlers, type GiveUp, type GiveUps, type ParallelLane } from './dispatcher.ts';
import { AUTOPILOT_STEP, autopilotStepHandler } from './outbox/autopilot.ts';
import { ETA_SWEEP, etaSweepHandler, giveUpEtaSweep } from './outbox/eta-sweep.ts';
import { reminderHandler } from './outbox/reminder.ts';
import { giveUpTextHandler, tryTextHandler } from './outbox/tryText.ts';

export interface WorkerDeps {
  /** The worker's pool, signed in as bw_worker (role app). */
  pool: ReturnType<typeof createPool>;
  clock: Clock;
  log: Logger;
  settings: Readonly<Settings>;
}

export interface RunningJob {
  readonly name: string;
  stop(): Promise<void>;
}

/** `started`: the jobs already started, in list order (the clock job finds the event dispatcher there). */
export type JobStarter = (deps: WorkerDeps, started: readonly RunningJob[]) => RunningJob | Promise<RunningJob>;

/** Each scheduled_event kind and the factory of its handler. */
export const eventHandlers: readonly (readonly [kind: string, make: (deps: WorkerDeps) => EventHandler])[] = [
  // P3-OUTBOX: a text's numbered try (SPECIFICATIONS section 5.2 step 3), through the gateway composed at start-up.
  [TEXT_TRY, (d) => tryTextHandler({ gateway: textGatewayFrom(), clock: d.clock, catalogs })],
  // P3-ALERTS: every alert rule of SD-30, every 5 demo minutes (the scheduler job keeps 1 due).
  [ALERT_CHECK, (d) => alertCheckHandler({ clock: d.clock, backupTarget: d.settings.BACKUP_TARGET, log: d.log })],
  // P3-TEXTS: the 6:00 PM reminder of the evening before a visit, in the customer's zone (section 6.4; FR-TEXT-2).
  [TEXT_REMINDER, (d) => reminderHandler({ catalogs, linkHost: d.settings.TEXT_LINK_HOST })],
  // P3-POSITIONS: the ETA sweep every 5 demo minutes and its late text (SD-15; FR-TEXT-5), and the sample day's autopilot steps (SD-21).
  [ETA_SWEEP, (d) => etaSweepHandler({ catalogs, linkHost: d.settings.TEXT_LINK_HOST }, d.log)],
  [AUTOPILOT_STEP, (d) => autopilotStepHandler({ catalogs, linkHost: d.settings.TEXT_LINK_HOST })],
];

export function handlersFor(deps: WorkerDeps): EventHandlers {
  return Object.fromEntries(eventHandlers.map(([kind, make]) => [kind, make(deps)]));
}

/** F-1844: the end of an event that holds no record of its own past this event: it is skipped as handler_failed. */
const giveUpSkipped: GiveUp = async () => ({ state: 'skipped', result: 'handler_failed' });

/**
 * Per kind, what the dispatcher does after MAX_HANDLER_FAILURES failed runs of one event (F-368): the kind's end record,
 * logged as 'event gave up' (F-1844). Every serial-lane kind has one (eventHandlers; jobs.test.ts holds the 2 lists
 * equal): text.try gives the text up (call list entry and text_gave_up alert, as after its 5th failed try); alert.check
 * and eta.sweep end the event and still write their next event, so the chain goes on; text.reminder and autopilot.step
 * end the event. The billing lane's kinds are not here: they run in the parallel lane, where the healer owns their end.
 */
export function giveUpsFor(deps: WorkerDeps): GiveUps {
  return {
    [TEXT_TRY]: giveUpTextHandler({ clock: deps.clock }),
    [ALERT_CHECK]: giveUpAlertCheck,
    [TEXT_REMINDER]: giveUpSkipped,
    [ETA_SWEEP]: giveUpEtaSweep,
    [AUTOPILOT_STEP]: giveUpSkipped,
  };
}

/** The dispatcher's parallel claim lanes, each with its kinds (never also in eventHandlers). */
export const eventLanes: readonly ((deps: WorkerDeps) => ParallelLane)[] = [
  // P3-BILLING: billing.send and billing.retry (section 6.6), BILLING_CONCURRENCY wide, below the pool (F-357).
  billingLaneFor,
];

export const jobs: readonly JobStarter[] = [
  // P3-OUTBOX: the event dispatcher (section 5.2 step 7), every second, for every kind in eventHandlers (the serial
  // lane) and every lane of eventLanes.
  (d) => startDispatcher({ pool: d.pool, clock: d.clock, log: d.log, handlers: handlersFor(d), giveUps: giveUpsFor(d), lanes: eventLanes.map((make) => make(d)) }),
  // P3-BILLING: the healer, every 30 s: a retry for any item that wants a send and holds no due event (invariant 2).
  (d) => startBillingHealer(d),
  // P3-ALERTS: the worker heartbeat /healthz reads (every 10 s real). The alert.check chain needs no job (F-444).
  (d) => startAlertJobs(d),
  // P3-IMPORT-WORKER: the import runner (section 2), at start-up and whenever an office run is waiting (F-258).
  (d) => startImportJob(d),
  // P3-REPLAY: the clock job (section 5.2 step 6, SD-12): a jump's replay through the dispatcher above, the reset
  // confirmer, the idle and nightly resets and Cleanup.
  (d, started) => startClockJobs({ ...d, dispatcher: dispatcherOf(started) }),
];

function dispatcherOf(started: readonly RunningJob[]): Dispatcher {
  const found = started.find((j) => j.name === 'event-dispatcher');
  if (!found) throw new Error('the clock job needs the event dispatcher started before it');
  return found as Dispatcher;
}

/** Start every job; if one fails to start, stop the ones already started and rethrow. */
export async function startJobs(deps: WorkerDeps, list: readonly JobStarter[] = jobs): Promise<RunningJob[]> {
  const running: RunningJob[] = [];
  try {
    for (const start of list) running.push(await start(deps, running));
  } catch (e) {
    await stopJobs(running);
    throw e;
  }
  return running;
}

export async function stopJobs(running: readonly RunningJob[]): Promise<void> {
  await Promise.allSettled(running.map((j) => j.stop()));
}
