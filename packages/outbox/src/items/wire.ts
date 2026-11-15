// SPDX-License-Identifier: AGPL-3.0-or-later
// The item calls' wire mapping, shared by both technician apps' transports (SPECIFICATIONS section 5.1 step 2; D2): what API-102
// carries for 1 item, the facts API-103 carries in its query, and how an answer maps to what the send loop does with it: a network
// error, a 5xx, 401 and 403 stop the send; any other 4xx refuses that call's items, which stay waiting (send.ts). The web app sends
// with fetch, the native app with background upload tasks from files; both read the answers here, so they cannot drift.
import { ApiError, uploadBlob } from '@bw/api';
import type { QueuedItem } from './model.ts';
import type { CallFailure, WireAnswer } from './send.ts';

/** The fields API-102 carries for 1 item (the contract's queuedItem): the stamp, the job and the item's own payload. */
export function wireItem(i: QueuedItem): Record<string, unknown> {
  const base = {
    key: i.key, jobNumber: i.jobNumber, baseVersion: i.baseVersion, worldEpoch: i.worldEpoch, kind: i.kind,
    deviceTime: i.deviceTime, offsetSavedReal: i.offsetSavedReal, sinceSaveMs: i.sinceSaveMs, demoTime: i.demoTime,
  };
  return 'payload' in i ? { ...base, payload: i.payload } : base;
}

/** API-103's facts, carried in the query string (the body is the photo's or signature's bytes). */
export function blobQuery(i: QueuedItem): Record<string, string> {
  return {
    kind: i.kind, jobNumber: String(i.jobNumber), worldEpoch: String(i.worldEpoch), deviceTime: i.deviceTime,
    offsetSavedReal: i.offsetSavedReal, sinceSaveMs: String(i.sinceSaveMs), demoTime: i.demoTime,
  };
}

/** The content type an upload carries. */
export const blobContentType = (i: QueuedItem): string => ('contentType' in i ? i.contentType : 'image/jpeg');

/** A failed typed-client call, as the send loop reads it. */
export function failureOf(e: unknown): CallFailure {
  if (e instanceof ApiError) {
    if (e.status === 401) return { ok: false, stop: 'signed_out' };
    if (e.status === 403) return { ok: false, stop: 'forbidden' };
    if (e.status >= 500) return { ok: false, stop: 'server_error' };
    return { ok: false, stop: null, status: e.status, code: e.problem.code };
  }
  // fetch rejects with a TypeError when there is no connection; an answer that does not parse is the server's fault.
  return e instanceof TypeError ? { ok: false, stop: 'network' } : { ok: false, stop: 'server_error' };
}

/** API-103's answer (status and parsed JSON body, or null when the body is not JSON), as the send loop reads it. */
export function uploadAnswer(status: number, body: unknown): { ok: true; answer: WireAnswer } | CallFailure {
  if (status === 401) return { ok: false, stop: 'signed_out' };
  if (status === 403) return { ok: false, stop: 'forbidden' };
  if (status >= 500) return { ok: false, stop: 'server_error' };
  if (status >= 400) {
    const code = body && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : `http_${status}`;
    return { ok: false, stop: null, status, code };
  }
  const env = body && typeof body === 'object' ? (body as { data?: unknown }).data : undefined;
  const parsed = uploadBlob.response.safeParse(env);
  if (!parsed.success) return { ok: false, stop: 'server_error' };
  return { ok: true, answer: parsed.data };
}

/** A body's text as JSON, or null when it is empty or not JSON (the answer is then judged by its status alone). */
export function jsonOrNull(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
