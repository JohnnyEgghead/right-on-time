// SPDX-License-Identifier: AGPL-3.0-or-later
// The worker's billing folder (SPECIFICATIONS section 6.6; invariant 2's billing half, apps/worker/billing/link.ts in
// section 11.6, built under apps/worker/src/billing/ because the image ships apps/worker/src; F-350). The worker's job
// registry (apps/worker/src/jobs.ts, F-269) wires the link as the event dispatcher's billing lane (billingLaneFor in
// eventLanes, F-357) and the healer as a job (startBillingHealer in jobs). The other exports are the writes and reads
// the web handlers of the billing area call (API-60, API-61, API-62, API-156 to API-158).
export { BillingUnavailableError, HttpBillingClient, type BillingClient, type EnterByHandRequest, type SendOptions, type SendOutcome } from './client.ts';
export { composeFromJob, type Composed } from './compose.ts';
export { markFixed, markFixedInTx, type MarkFixedResult } from './fixed.ts';
export {
  BILLING_CONCURRENCY, BILLING_LOCK_CLASS, BillingBusyError, billingLane, billingLaneFor, billingSplitHandler, healBillingItems, jobOfEvent,
  startBillingHealer, WORKER_POOL_MAX, type BillingEvent, type HandleResult, type PreparedSend, type RunDeps,
} from './link.ts';
export {
  billFinishedJob, BillingRefusedError, billingList, billingSubject, busPublish, resendCorrected, retryAll, retryNow, sendAgain,
  type BillFinishedResult, type LeftItem, type ListedItem, type Publish,
} from './queue.ts';
