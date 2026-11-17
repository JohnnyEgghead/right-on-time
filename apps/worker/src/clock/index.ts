// SPDX-License-Identifier: AGPL-3.0-or-later
// The worker's clock job (SPECIFICATIONS section 2 background work, section 5.2 step 6, SD-12): 1 loop that runs, one
// at a time and never side by side,
//   - the replay of a forward jump, continuously while one runs (./replay.ts),
//   - the reset confirmer at start-up and every 5 real seconds (./confirmer.ts),
//   - the idle reset watcher and the nightly reset, every 1 real minute (./resets.ts),
//   - Cleanup after each confirmed reset and hourly (./cleanup.ts).
// One loop keeps the resets off a running replay and the confirmer off a reset it has not seen commit; the event
// dispatcher still runs its own 1 s passes beside it (the replay drains through the dispatcher's drainThrough).
// A step that throws (no database, no clock row before setup) is logged with its cause, again every 10 real minutes while
// it keeps throwing, and once when it succeeds again (F-1846), and the loop goes on.
import type { createPool } from '@bw/db';
import type { Logger } from '@bw/log';
import type { Clock } from '@bw/time';
import { HttpBillingClient, type BillingClient } from '../billing/client.ts';
import type { Dispatcher } from '../dispatcher.ts';
import { failingStep, type FailingStep } from '../failing.ts';
import { cleanup, CLEANUP_EVERY_MS } from './cleanup.ts';
import { confirmStep, ConfirmerState, RESET_CONFIRM_EVERY_MS } from './confirmer.ts';
import { replayStep, ReplayState } from './replay.ts';
import { autoResetStep, IDLE_CHECK_EVERY_MS } from './resets.ts';

export { cleanup, CLEANUP_MIN_AGE_MS } from './cleanup.ts';
export { confirmStep, ConfirmerState, RESET_CONFIRM_ALERT_AFTER } from './confirmer.ts';
export { REPLAY_BATCH, replayStep, ReplayState } from './replay.ts';
export { autoResetStep, idleDue, nightlyDue, nightlyInstant } from './resets.ts';

/** How often the loop looks for a replay to run (real ms): a jump starts replaying within this. */
export const CLOCK_TICK_MS = 250;

export interface ClockJobDeps {
  pool: ReturnType<typeof createPool>;
  clock: Clock;
  log: Logger;
  settings: { PBS_URL: string; PHOTOS_DIR: string; IDLE_RESET_MINUTES: number; NIGHTLY_RESET: boolean };
  dispatcher: Pick<Dispatcher, 'drainThrough' | 'kinds'>;
  /** The billing service (default: the HTTP client to PBS_URL). */
  billing?: Pick<BillingClient, 'reset'>;
  /** The real-time source of a failing step's repeat (F-1846); default performance.now. */
  realMs?: () => number;
}

type StepName = 'clock_replay' | 'reset_confirmer' | 'auto_reset' | 'cleanup';

const date = (i: { epochMilliseconds: number }): Date => new Date(i.epochMilliseconds);

export function startClockJobs(d: ClockJobDeps): { readonly name: string; stop(): Promise<void> } {
  const billing = d.billing ?? new HttpBillingClient(d.settings.PBS_URL);
  const replay = new ReplayState();
  const confirmer = new ConfirmerState();
  const real = () => date(d.clock.realNow('clock_anchor'));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  let nextConfirm = 0;
  let nextIdle = 0;
  let nextCleanup = 0;
  // F-1846: each step's failure is logged with its cause at once, again every 10 real minutes while it keeps failing,
  // and once when the step succeeds again (./failing.ts).
  const steps: Record<StepName, FailingStep> = {
    clock_replay: failingStep(d.log, { failed: 'clock replay failed', recovered: 'clock replay recovered' }, d.realMs),
    reset_confirmer: failingStep(d.log, { failed: 'reset confirmer failed', recovered: 'reset confirmer recovered' }, d.realMs),
    auto_reset: failingStep(d.log, { failed: 'auto reset failed', recovered: 'auto reset recovered' }, d.realMs),
    cleanup: failingStep(d.log, { failed: 'cleanup failed', recovered: 'cleanup recovered' }, d.realMs),
  };
  const guarded = async (name: StepName, f: () => Promise<void>): Promise<void> => {
    try {
      await f();
      steps[name].ok();
    } catch (e) {
      steps[name].failed(e);
    }
  };
  const runCleanup = () =>
    guarded('cleanup', async () => {
      await cleanup({ pool: d.pool, photosDir: d.settings.PHOTOS_DIR, real: date(d.clock.realNow('record_stamp')) });
    });

  const tick = async (): Promise<void> => {
    const t = performance.now();
    await guarded('clock_replay', async () => {
      while (!stopped && (await replayStep({ pool: d.pool, dispatcher: d.dispatcher, real, state: replay })) === 'batch') { /* next batch */ }
    });
    if (t >= nextConfirm) {
      nextConfirm = t + RESET_CONFIRM_EVERY_MS;
      let confirmed = false;
      await guarded('reset_confirmer', async () => {
        confirmed = (await confirmStep({ pool: d.pool, client: billing, clock: d.clock, real, state: confirmer })) === 'confirmed';
      });
      if (confirmed) {
        d.log.info({ status: 'world reset confirmed' });
        await runCleanup();
      }
    }
    if (t >= nextIdle) {
      nextIdle = t + IDLE_CHECK_EVERY_MS;
      await guarded('auto_reset', async () => {
        const nightly = d.settings.NIGHTLY_RESET;
        const realAt = date(nightly ? d.clock.realNow('nightly_reset') : d.clock.realNow('idle_reset'));
        const which = await autoResetStep({ pool: d.pool, real: realAt, idleMinutes: d.settings.IDLE_RESET_MINUTES, nightly });
        if (which) {
          d.log.info({ status: which === 'idle' ? 'world reset idle' : 'world reset nightly' });
          nextConfirm = 0; // confirm it at once
        }
      });
    }
    if (t >= nextCleanup) {
      nextCleanup = t + CLEANUP_EVERY_MS;
      await runCleanup();
    }
  };
  const loop = (): void => {
    if (stopped) return;
    running = tick().finally(() => {
      if (!stopped) timer = setTimeout(loop, CLOCK_TICK_MS);
    });
  };
  timer = setTimeout(loop, 0);
  return {
    name: 'clock-jobs',
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
