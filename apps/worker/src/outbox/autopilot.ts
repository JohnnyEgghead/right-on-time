// SPDX-License-Identifier: AGPL-3.0-or-later
// The autopilot.step handler (SPECIFICATIONS SD-21, OA-78): 1 seeded step of the sample day, run through the technician
// item path as that technician at the event's time, skipped when a person touched the job or the job is not in the
// step's expected prior status. The step logic is the item path's own module (packages/api-server/src/tech-items/
// autopilot.ts); the worker reaches it by path because @bw/api-server already depends on this package (bw-worker/billing),
// and a package dependency back would be a cycle.
import type { TextContext } from '@bw/outbox';
import { AUTOPILOT_STEP, runAutopilotStep } from '../../../../packages/api-server/src/tech-items/autopilot.ts';
import type { EventHandler } from '../dispatcher.ts';

export { AUTOPILOT_STEP };

export function autopilotStepHandler(ctx: TextContext): EventHandler {
  return (event, { tx, now }) => runAutopilotStep(tx, ctx, { id: event.id, payload: event.payload }, now);
}
