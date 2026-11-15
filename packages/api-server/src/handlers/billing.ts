// SPDX-License-Identifier: AGPL-3.0-or-later
// The billing write handlers (UI-SPECIFICATION 12.2 API-61, API-62, API-68, API-156, API-157, API-158; SPECIFICATIONS
// section 6.6). Each is the HTTP face of 1 service: the queue writes of ../billing-writes/service.ts (which call the
// services bw-worker exports from `./billing`), Mark fixed and the pretend billing mode through the BillingClient to pbs
// (FR-BILL-4: HTTP, never a direct database call). They run in the kernel's 1 transaction (SD-6); a refusal rolls it back.
import type {
  correctFinish as correctFinishRow, markFixed as markFixedRow, retryAll as retryAllRow, retryNow as retryNowRow,
  sendAgain as sendAgainRow, setPretendBillingMode as setModeRow,
} from '@bw/api';
import { REJECT_N_MAX, REJECT_N_MIN } from '@bw/domain';
import { toWire } from '@bw/time';
import { HttpBillingClient, markFixedInTx, type BillingClient } from 'bw-worker/billing';
import type { z } from 'zod';
import {
  BillingRefused, correctFinishWrite, retryAllWrite, retryNowWrite, sendAgainWrite, type BillingActor,
} from '../billing-writes/service.ts';
import { WriteRefused } from '../office-writes/service.ts';
import type { ApiRequest, ApiResult, Handler, HandlerContext, Tx } from '../types.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;

const DEFAULT_PBS_URL = 'http://pbs:8090';

function actorOf(req: ApiRequest): BillingActor {
  if (req.caller.kind !== 'staff') throw new Error('a billing write reached its handler without a signed-in caller');
  return { userId: req.caller.userId, at: req.demoNow };
}

const refuse = (code: 'validation_failed' | 'not_on_billing_list'): ApiResult<never> =>
  ({ ok: false, status: code === 'validation_failed' ? 422 : 409, code });

/** Run 1 write; a BillingRefused or WriteRefused becomes the refusal (the kernel owns the status, from the code). */
async function answer<T>(status: 200 | 202, fn: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, status, data: await fn() };
  } catch (e) {
    if (e instanceof BillingRefused) return { ok: false, status: 409, code: e.code };
    if (e instanceof WriteRefused) return { ok: false, status: 409, code: e.code, ...(e.detail === undefined ? {} : { detail: e.detail }) };
    throw e;
  }
}

/**
 * The pbs client of a kernel's PBS_URL, made on first use. The cache is keyed on the URL (F-509): handlers/index.ts builds the handlers once
 * per process, so 2 kernels with different PBS_URL settings must each reach their own pbs, not the first caller's.
 */
export function pbsClientFor(): (ctx: HandlerContext) => BillingClient {
  const made = new Map<string, BillingClient>();
  return (ctx) => {
    const url = ctx.settings.PBS_URL ?? DEFAULT_PBS_URL;
    let c = made.get(url);
    if (!c) made.set(url, (c = new HttpBillingClient(url)));
    return c;
  };
}

/**
 * The billing handlers. `client` is the pbs client of the kernel, made from its PBS_URL on first use; a test passes its own.
 * pbs not taking a call that has no retry of its own (Mark fixed, the mode) is a server_error: the kernel rolls back, the
 * item stays listed, and the same press repeats pbs's record harmlessly (fixed.ts).
 */
export function billingHandlers(client?: (ctx: HandlerContext) => BillingClient): Record<'API-61' | 'API-62' | 'API-68' | 'API-156' | 'API-157' | 'API-158', Handler<unknown>> {
  const pbs = client ?? pbsClientFor();

  const sendAgain: Handler<Out<typeof sendAgainRow>> = (req, tx: Tx) => answer(202, async () => ({
    item: await sendAgainWrite(tx, actorOf(req), req.params as In<typeof sendAgainRow>),
  }));

  const correctFinish: Handler<Out<typeof correctFinishRow>> = (req, tx: Tx) => answer(202, async () =>
    correctFinishWrite(tx, actorOf(req), req.params as In<typeof correctFinishRow>));

  const retryNow: Handler<Out<typeof retryNowRow>> = (req, tx: Tx) => answer(202, async () => ({
    item: await retryNowWrite(tx, actorOf(req), req.params as In<typeof retryNowRow>),
  }));

  const retryAll: Handler<Out<typeof retryAllRow>> = (req, tx: Tx) => answer(202, async () => ({
    retried: await retryAllWrite(tx, actorOf(req), req.params as In<typeof retryAllRow>),
  }));

  const markFixed: Handler<Out<typeof markFixedRow>> = async (req, tx: Tx, ctx) => {
    const actor = actorOf(req);
    const p = req.params as In<typeof markFixedRow>;
    const r = await markFixedInTx(tx, { client: pbs(ctx) }, { jobNumber: p.jobNumber, reason: p.reason, by: actor.userId, at: actor.at });
    if (!r.ok) {
      if (r.code === 'validation_failed') return refuse('validation_failed');
      if (r.code === 'billing_unavailable') throw new Error('the billing service did not take the entered-by-hand record');
      return refuse('not_on_billing_list'); // not_found, not_listed, world_reset
    }
    // A second press finds the item already fixed: it is no longer on the list (UI-SPECIFICATION CTL-OFC-47-03).
    if (r.again) return refuse('not_on_billing_list');
    const j = (await tx.query<{ zone: string; by: string }>(
      `SELECT j.zone, u.name AS by FROM world.job j, world."user" u WHERE j.job_number = $1 AND u.id = $2`, [p.jobNumber, actor.userId])).rows[0];
    return {
      ok: true, status: 200,
      data: { left: { jobNumber: p.jobNumber, by: j?.by ?? actor.userId, at: toWire(actor.at, j?.zone ?? 'America/New_York'), reason: p.reason.trim() } },
    };
  };

  const setMode: Handler<Out<typeof setModeRow>> = async (req, _tx: Tx, ctx) => {
    const actor = actorOf(req);
    const p = req.params as In<typeof setModeRow>;
    // SD-44: n is a whole number from 1 to 20 for reject_next_n and absent for the other modes.
    const n = p.n ?? null;
    if (p.mode === 'reject_next_n' ? n === null || n < REJECT_N_MIN || n > REJECT_N_MAX : n !== null) return refuse('validation_failed');
    const mode = await pbs(ctx).setMode({ mode: p.mode, n, setBy: actor.userId, setAt: actor.at.toString() });
    return { ok: true, status: 200, data: { mode: mode.mode, nLeft: mode.nLeft } };
  };

  return {
    'API-61': sendAgain as Handler<unknown>, 'API-62': correctFinish as Handler<unknown>, 'API-68': setMode as Handler<unknown>,
    'API-156': retryNow as Handler<unknown>, 'API-157': retryAll as Handler<unknown>, 'API-158': markFixed as Handler<unknown>,
  };
}
