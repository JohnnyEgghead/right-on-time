// SPDX-License-Identifier: AGPL-3.0-or-later
// The job page's routes (P4-JOB; UI-SPECIFICATION SCR-OFC-03 and its dialogs). Reads are this lane's (BUILD_PLAN D-7);
// each write is the HTTP face of 1 service: API-26 the office finish (office-writes/finish.ts, D-17), API-140 an office
// note, API-142 an equipment edit and API-143 an office text (enqueueText, @bw/outbox: the only way a text is made).
import type { finishJobOffice as finishJobOfficeRow, sendOfficeText as sendOfficeTextRow } from '@bw/api';
import type { z } from 'zod';
import { finishJobOffice } from '../office-writes/finish.ts';
import { OfficeTextRefused, sendOfficeText } from '../office-writes/office-text.ts';
import { WriteRefused, type WriteContext } from '../office-writes/service.ts';
import type { ApiRequest, ApiResult, Handler, Tx } from '../types.ts';
import {
  addEquipmentHandler, addOfficeNoteHandler, editEquipmentHandler, inboxLinkHandler, jobDetailHandler, jobOnTheWayHandler, officeAvailabilityHandler, partsListHandler,
  servicesHandler,
} from './job-reads.ts';

type Out<T extends { response: z.ZodType }> = z.infer<T['response']>;
type In<T extends { request: z.ZodType }> = z.infer<T['request']>;

export function officeContext(req: ApiRequest): WriteContext {
  if (req.caller.kind !== 'staff') throw new Error('an office write reached its handler without a signed-in caller');
  return { actor: { kind: 'office', userId: req.caller.userId }, at: new Date(req.demoNow.epochMilliseconds) };
}

/** Run 1 write; a WriteRefused becomes the refusal with its detail (the kernel owns the status, from the code). */
async function answerWrite<T>(fn: () => Promise<{ status: 200 | 201 | 204; data: T }>): Promise<ApiResult<T>> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (e) {
    if (e instanceof WriteRefused) return { ok: false, status: 409, code: e.code, ...(e.detail === undefined ? {} : { detail: e.detail }) };
    throw e;
  }
}

const finishJobOfficeHandler: Handler<Out<typeof finishJobOfficeRow>> = (req, tx: Tx) => answerWrite(async () => {
  const p = req.params as In<typeof finishJobOfficeRow>;
  const done = await finishJobOffice(tx, officeContext(req), p);
  return { status: 200, data: { job: done.job, billing: { state: done.billing.state as Out<typeof finishJobOfficeRow>['billing']['state'] } } };
});

const sendOfficeTextHandler: Handler<Out<typeof sendOfficeTextRow>> = async (req, tx: Tx) => {
  try {
    return await answerWrite(async () => ({ status: 201, data: { text: await sendOfficeText(tx, officeContext(req), req.params as In<typeof sendOfficeTextRow>) } }));
  } catch (e) {
    if (e instanceof OfficeTextRefused) return { ok: false, status: 409, code: e.code, ...(e.detail === undefined ? {} : { detail: e.detail }) };
    throw e;
  }
};

export const jobPageHandlers: Readonly<Record<string, Handler<unknown>>> = {
  'API-23': jobDetailHandler as Handler<unknown>,
  'API-29': officeAvailabilityHandler as Handler<unknown>,
  'API-37': inboxLinkHandler as Handler<unknown>,
  'API-107': partsListHandler as Handler<unknown>,
  'API-110': servicesHandler as Handler<unknown>,
  'API-135': jobOnTheWayHandler as Handler<unknown>,
  'API-140': addOfficeNoteHandler as Handler<unknown>,
  'API-141': addEquipmentHandler as Handler<unknown>,
  'API-142': editEquipmentHandler as Handler<unknown>,
  'API-26': finishJobOfficeHandler as Handler<unknown>,
  'API-143': sendOfficeTextHandler as Handler<unknown>,
};
