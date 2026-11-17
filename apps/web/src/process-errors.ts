// SPDX-License-Identifier: AGPL-3.0-or-later
import { causeCodeOf, type Logger } from '@bw/log';

/**
 * F-1870, F-1871: what the web process does with an error no code handled. Next.js (16.4.2) is built to keep serving through one
 * (process-error-handlers.js: a late-awaited promise must not take a render down), so web keeps serving too, as before P9-AUDIT-SERVER.
 * Unlike Next's own listeners, which print the full reason (its message and stack, which can quote a record's text) to the log's stream,
 * the listeners here write 1 error-level line with the safe cause code (the log allowlist, PRIVACY.md).
 *
 * Next adds its own printing listeners at 2 times, and this undoes both:
 *  - unhandledRejection: Next adds the function it finds at globalThis[Symbol.for('next.unhandledRejectionListener')], at start and again
 *    each time a route module loads. Set to this module's listener before Next starts, it adds ours (which is already there) and never its own.
 *  - uncaughtException: Next adds 2 console.error listeners while it starts. afterNext() removes every listener but ours.
 * Worker and pbs have no Next: they exit on both (exitOnUnhandledRejection, exitOnUncaughtException in @bw/log).
 */
export interface ErrorProcess {
  on(event: 'unhandledRejection' | 'uncaughtException', listener: (reason: unknown) => void): unknown;
  listeners(event: 'unhandledRejection' | 'uncaughtException'): ((reason: unknown) => void)[];
  removeListener(event: 'unhandledRejection' | 'uncaughtException', listener: (reason: unknown) => void): unknown;
}

export const NEXT_REJECTION_LISTENER = Symbol.for('next.unhandledRejectionListener');

export function logProcessErrorsAndKeepServing(
  log: Logger,
  proc: ErrorProcess = process as unknown as ErrorProcess,
  shared: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>,
): { afterNext(): void } {
  const onRejection = (reason: unknown): void => log.error({ status: 'unhandled rejection', errorCode: causeCodeOf(reason) });
  const onException = (error: unknown): void => log.error({ status: 'uncaught exception', errorCode: causeCodeOf(error) });
  shared[NEXT_REJECTION_LISTENER] = onRejection;
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return {
    afterNext() {
      for (const [event, ours] of [['unhandledRejection', onRejection], ['uncaughtException', onException]] as const) {
        for (const l of proc.listeners(event)) if (l !== ours) proc.removeListener(event, l);
      }
    },
  };
}
