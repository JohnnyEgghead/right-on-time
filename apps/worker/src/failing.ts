// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1846: the line of a background loop step that keeps failing (the dispatcher's pass, each clock job step). A failure
// that lasts is seen as it lasts and when it ends: the first failed run logs at error level with its cause code, the line
// repeats once every REPEAT_FAILING_EVERY_MS real ms while runs keep failing (with the count of failed runs since the
// previous line), and the first run that succeeds afterwards logs 1 recovery line (with the count of the whole outage).
// Real elapsed time, not demo time: a paused or jumping demo clock must not silence or flood the line. /healthz is not
// touched (D-27): it is the monitored instrument (NFR-11) and keeps its own rule.
import { causeCodeOf, type Logger, type ProcessState } from '@bw/log';

/** 10 real minutes. */
export const REPEAT_FAILING_EVERY_MS = 10 * 60_000;

export interface FailingStep {
  /** 1 failed run: logged at once when the step was healthy, else when REPEAT_FAILING_EVERY_MS passed since the last line. */
  failed(e: unknown): void;
  /** 1 run that succeeded: after failed runs, 1 recovery line. */
  ok(): void;
}

export function failingStep(
  log: Logger,
  states: { failed: ProcessState; recovered: ProcessState },
  realMs: () => number = () => performance.now(),
  everyMs: number = REPEAT_FAILING_EVERY_MS,
): FailingStep {
  let lastLineAt: number | null = null;
  let sinceLine = 0;
  let outage = 0;
  return {
    failed(e) {
      const t = realMs();
      sinceLine += 1;
      outage += 1;
      if (lastLineAt === null || t - lastLineAt >= everyMs) {
        log.error({ status: states.failed, errorCode: causeCodeOf(e), failures: sinceLine });
        lastLineAt = t;
        sinceLine = 0;
      }
    },
    ok() {
      if (outage > 0) log.info({ status: states.recovered, failures: outage });
      lastLineAt = null;
      sinceLine = 0;
      outage = 0;
    },
  };
}
