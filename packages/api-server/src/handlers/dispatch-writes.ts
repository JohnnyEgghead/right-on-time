// SPDX-License-Identifier: AGPL-3.0-or-later
// The office writes (UI-SPECIFICATION 12.2 API-22, API-24, API-25, API-27, API-28, API-136 to API-138): each handler is the HTTP face of
// 1 function of the office write service (../office-writes/service.ts, SPECIFICATIONS section 5.3). A WriteRefused is
// answered with its code and, for the codes whose row names members (version_conflict, time_overlap), its detail; the
// kernel then rolls the transaction back.
import type {
  assignJob as assignJobRow, cancelJob as cancelJobRow, createBlock as createBlockRow, createJob as createJobRow, editJob as editJobRow, moveBlock as moveBlockRow,
  rescheduleJob as rescheduleJobRow,
} from '@bw/api';
import { catalogs } from '@bw/i18n/src/catalog.ts';
import { cancelUnsentReminders, planReminder, sendConfirmation, type TextContext } from '@bw/outbox';
import type { z } from 'zod';
import {
  assignJob, cancelJob, createBlock, createJob, deleteBlock, editJob, moveBlock, rescheduleJob, WriteRefused, type WriteContext,
} from '../office-writes/service.ts';
import type { ApiRequest, ApiResult, Handler, HandlerContext, Tx } from '../types.ts';

const DEFAULT_LINK_HOST = 'bw.j7l.io';
/** The text pipeline's inputs: the shipped catalogs (never a test's own) and TEXT_LINK_HOST (FR-TEXT-18). */
const textContext = (hctx: HandlerContext): TextContext => ({ catalogs, linkHost: hctx.settings.TEXT_LINK_HOST ?? DEFAULT_LINK_HOST });

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;

function context(req: ApiRequest): WriteContext {
  if (req.caller.kind !== 'staff') throw new Error('an office write reached its handler without a signed-in caller');
  return { actor: { kind: 'office', userId: req.caller.userId }, at: new Date(req.demoNow.epochMilliseconds) };
}

/** Run 1 write; a WriteRefused becomes the refusal (status is the kernel's, from the code). */
async function answer<T>(fn: () => Promise<{ status: 200 | 201 | 204; data: T }>): Promise<ApiResult<T>> {
  try {
    const r = await fn();
    return { ok: true, ...r };
  } catch (e) {
    if (e instanceof WriteRefused) return { ok: false, status: 409, code: e.code, ...(e.detail === undefined ? {} : { detail: e.detail }) };
    throw e;
  }
}

export const assignJobHandler: Handler<Out<typeof assignJobRow>> = (req, tx: Tx) => answer(async () => {
  const p = req.params as In<typeof assignJobRow>;
  return { status: 200, data: { job: await assignJob(tx, context(req), p) } };
});

export const rescheduleJobHandler: Handler<Out<typeof rescheduleJobRow>> = (req, tx: Tx, hctx) => answer(async () => {
  const p = req.params as In<typeof rescheduleJobRow>;
  const was = (await tx.query<{ date: string; window_id: string }>('SELECT date::text AS date, window_id FROM world.job WHERE job_number = $1', [p.jobNumber])).rows[0];
  const data = await rescheduleJob(tx, context(req), p);
  // SD-45 (F-671): a reschedule sends a new confirmation for the new day and window, in the customer's text language; the answer says whether 1 was made.
  // F-828: the same day and window sends none; the visit's confirmation stands.
  const sameVisit = was !== undefined && was.date === p.date && was.window_id === p.windowId;
  const sent = sameVisit ? { ok: false as const } : await sendConfirmation(tx, textContext(hctx), { jobNumber: data.job.jobNumber, now: req.demoNow });
  // The reminder moves with the visit (section 6.4); one moved after its 6:00 PM goes out at once (F-446, owner ruling 86ecd5ae).
  const reminder = await planReminder(tx, { jobNumber: data.job.jobNumber, now: req.demoNow });
  // F-831: the planned reminder is the 1 the visit keeps. With none planned (the visit's own day has begun), an unsent one is the customer's only one and stays.
  if (reminder.planned) await cancelUnsentReminders(tx, data.job.jobNumber);
  return { status: 200, data: { ...data, outcome: { ...data.outcome, textSent: sent.ok } } };
});

export const createJobHandler: Handler<Out<typeof createJobRow>> = (req, tx: Tx, hctx) => answer(async () => {
  const p = req.params as In<typeof createJobRow>;
  const job = await createJob(tx, context(req), p);
  // SD-45, FR-DISP-29 (F-671): an office-created job sends the confirmation at creation, like a booking, in the customer's text language.
  const sent = await sendConfirmation(tx, textContext(hctx), { jobNumber: job.jobNumber, now: req.demoNow });
  // The reminder for the new visit (section 6.4); one booked after its 6:00 PM goes out at once (F-446, owner ruling 86ecd5ae).
  await planReminder(tx, { jobNumber: job.jobNumber, now: req.demoNow });
  return { status: 201, data: { job, confirmationText: sent.ok ? { status: sent.status } : null } };
});

export const createBlockHandler: Handler<Out<typeof createBlockRow>> = (req, tx: Tx) => answer(async () => {
  const p = req.params as In<typeof createBlockRow>;
  return { status: 201, data: { block: await createBlock(tx, context(req), p) } };
});

export const moveBlockHandler: Handler<Out<typeof moveBlockRow>> = (req, tx: Tx) => answer(async () => {
  const p = req.params as In<typeof moveBlockRow>;
  return { status: 200, data: { block: await moveBlock(tx, context(req), p) } };
});

export const deleteBlockHandler: Handler<Record<string, never>> = (req, tx: Tx) => answer(async () => {
  await deleteBlock(tx, context(req), req.params as { blockId: string });
  return { status: 204, data: {} };
});

export const cancelJobHandler: Handler<Out<typeof cancelJobRow>> = (req, tx: Tx) => answer(async () => {
  const p = req.params as In<typeof cancelJobRow>;
  return { status: 200, data: { job: await cancelJob(tx, context(req), p) } };
});

export const editJobHandler: Handler<Out<typeof editJobRow>> = (req, tx: Tx) => answer(async () => {
  const p = req.params as In<typeof editJobRow>;
  return { status: 200, data: { job: await editJob(tx, context(req), p) } };
});
