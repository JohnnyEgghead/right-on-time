// SPDX-License-Identifier: AGPL-3.0-or-later
// The successor time of a periodic, self-rescheduling event chain (alert.check, SD-30; eta.sweep, SD-15): `every`
// demo minutes after the run. During a clock jump's replay (section 5.2 step 6) a successor that would fall before the
// jump's target is written AT the target instead (F-435, F-538): the replay runs the chain at its own due time and once
// more at the target, never once per skipped interval. Both chains read the world's state at their run time, which the
// run at the target reads again, so the skipped runs add nothing; and a jump to Sun, Mar 14, 2027 would otherwise
// replay about 52,000 runs of each chain.
import { Temporal, type Instant } from '@bw/time';

export function chainSuccessorDue(now: Instant, everyMinutes: number, replayTarget: Instant | undefined): Instant {
  const step = now.add({ minutes: everyMinutes });
  return replayTarget && Temporal.Instant.compare(step, replayTarget) < 0 ? replayTarget : step;
}
