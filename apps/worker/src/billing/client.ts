// SPDX-License-Identifier: AGPL-3.0-or-later
// The billing client seam (SPECIFICATIONS section 4.5, SD-19): HTTP to the pbs service, never a direct database call
// (FR-BILL-4). 1 implementation, HttpBillingClient to PBS_URL (default http://pbs:8090); the only billing service it
// can reach is pbs (OOS-02).
//
// Outcome mapping of POST /invoices: 200 stored or stored_late -> accepted; 200 already_have -> already_have (the link
// treats it as success, FR-BILL-8); 422 -> data_error with pbs's reason (FR-BILL-7); 503 (down or wrong_epoch, SD-12)
// and a refused connection -> down; the real-time timeout -> timeout (FR-BILL-6; a timeout is a retry, never a drop,
// invariant 2); a 400 (a request that breaks the protocol) -> data_error, so a person sees it instead of a retry loop.
import {
  BILLING_TIMEOUT_MS, EPOCH_HEADER, PBS_MODES, IDEMPOTENCY_HEADER, idempotencyKey, type InvoiceLine, type InvoiceRequest, type PbsMode,
} from '@bw/domain';

export type SendOutcome =
  | { outcome: 'accepted' | 'already_have'; httpStatus: number }
  | { outcome: 'data_error'; httpStatus: number | null; reason: string }
  | { outcome: 'down'; httpStatus: number | null; reason: string }
  | { outcome: 'timeout' };

export interface SendOptions {
  /** Real milliseconds (FR-BILL-6: 30,000; tests shorten it). */
  timeoutMs?: number;
  worldEpoch: number;
}

export interface EnterByHandRequest {
  jobNumber: number;
  reason: string;
  /** The person's user id. */
  by: string;
  /** The demo time of the Mark fixed. */
  at: string;
  worldEpoch: number;
  customerName: string;
  doneAt: string;
  lines: InvoiceLine[];
  totalCents: number;
}

export interface BillingClient {
  sendInvoice(inv: InvoiceRequest, opts: SendOptions): Promise<SendOutcome>;
  /** Mark fixed's record (FR-BILL-11). Throws BillingUnavailableError when pbs does not take it. */
  enterByHand(req: EnterByHandRequest): Promise<void>;
  getMode(): Promise<PbsMode>;
  setMode(m: { mode: PbsMode['mode']; n?: number | null; setBy?: string | null; setAt?: string | null }): Promise<PbsMode>;
  reset(epoch: number): Promise<{ applied: boolean; epoch: number }>;
  listInvoices(cursor?: string): Promise<{ items: unknown[]; next: string | null }>;
  getInvoice(jobNumber: number): Promise<unknown>;
}

/** pbs did not answer a call that has no retry of its own (enterByHand, the mode, reset): the caller says so to the person. */
export class BillingUnavailableError extends Error {
  readonly httpStatus: number | null;
  constructor(what: string, httpStatus: number | null) {
    super(`the billing service did not take ${what}${httpStatus === null ? '' : ` (HTTP ${httpStatus})`}`);
    this.name = 'BillingUnavailableError';
    this.httpStatus = httpStatus;
  }
}

/**
 * The wait for a call with no retry of its own (Mark fixed's record, the mode, the reads and the reset), in real milliseconds (F-508).
 * Far shorter than the send's 30 s: a web handler holds a pooled connection while it waits, so a wedged pbs must not hold 10 presses for
 * 30 s each. pbs answers these routes at once in every designed mode (apps/pbs/src/server.ts); only a wedged pbs reaches the limit.
 */
export const PBS_CALL_TIMEOUT_MS = 5_000;

/**
 * F-2006 J-22: the send's answer fields, each kept only when it is a string: a body of null, a number or an array, or an
 * answer of another type, reads as no answer (the HTTP status then decides), never as a TypeError from the send.
 */
function answerOf(body: unknown): { answer?: string; reason?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
  const { answer, reason } = body as { answer?: unknown; reason?: unknown };
  return { ...(typeof answer === 'string' ? { answer } : {}), ...(typeof reason === 'string' ? { reason } : {}) };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTextOrNull = (v: unknown): boolean => v === null || typeof v === 'string';

/** F-2006 J-22: pbs's mode answer has PbsMode's shape (a mode name, nLeft, setBy, setAt, epoch), checked field by field. */
function isPbsMode(v: unknown): v is PbsMode {
  return isObject(v) && (PBS_MODES as readonly unknown[]).includes(v.mode) && (v.nLeft === null || Number.isInteger(v.nLeft))
    && isTextOrNull(v.setBy) && isTextOrNull(v.setAt) && Number.isInteger(v.epoch);
}

const isTimeout = (e: unknown): boolean => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

export class HttpBillingClient implements BillingClient {
  readonly #base: string;
  readonly #callTimeoutMs: number;

  constructor(baseUrl: string, opts: { callTimeoutMs?: number } = {}) {
    this.#base = baseUrl.replace(/\/$/, '');
    this.#callTimeoutMs = opts.callTimeoutMs ?? PBS_CALL_TIMEOUT_MS;
  }

  async sendInvoice(inv: InvoiceRequest, opts: SendOptions): Promise<SendOutcome> {
    // FR-BILL-6: the 30-second timer is real time (section 11.3 billing_timeout: a timer, not a reading of now). It
    // covers the whole exchange, the answer's body included.
    const signal = AbortSignal.timeout(opts.timeoutMs ?? BILLING_TIMEOUT_MS);
    let res: Response;
    let body: { answer?: string; reason?: string };
    try {
      res = await fetch(`${this.#base}/invoices`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [IDEMPOTENCY_HEADER]: idempotencyKey(inv.jobNumber), [EPOCH_HEADER]: String(opts.worldEpoch) },
        body: JSON.stringify(inv),
        signal,
      });
      const text = await res.text(); // an abort while the body arrives is the timeout too
      try {
        body = answerOf(JSON.parse(text));
      } catch {
        body = {};
      }
    } catch (e) {
      if (isTimeout(e) || signal.aborted) return { outcome: 'timeout' };
      return { outcome: 'down', httpStatus: null, reason: 'connection_failed' };
    }
    if (res.status === 200 && (body.answer === 'stored' || body.answer === 'stored_late')) return { outcome: 'accepted', httpStatus: 200 };
    if (res.status === 200 && body.answer === 'already_have') return { outcome: 'already_have', httpStatus: 200 };
    if (res.status === 422 || res.status === 400) {
      return { outcome: 'data_error', httpStatus: res.status, reason: body.reason ?? `the billing service refused the invoice (HTTP ${res.status})` };
    }
    return { outcome: 'down', httpStatus: res.status, reason: body.answer ?? `http_${res.status}` };
  }

  /**
   * 1 call with no retry of its own. F-2006 J-22: with `shape`, a 2xx answer of any other shape (null, an error page) is
   * BillingUnavailableError too, so a caller's catch reads it as no answer, never as a value of the wrong type.
   */
  async #call(what: string, path: string, init: RequestInit = {}, shape?: (body: unknown) => boolean): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.#base}${path}`, { ...init, signal: AbortSignal.timeout(this.#callTimeoutMs) });
    } catch {
      throw new BillingUnavailableError(what, null);
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new BillingUnavailableError(what, res.status);
    if (shape && !shape(body)) throw new BillingUnavailableError(`${what} (an answer of the wrong shape)`, res.status);
    return body;
  }

  async enterByHand(req: EnterByHandRequest): Promise<void> {
    const { jobNumber, worldEpoch, ...rest } = req;
    await this.#call('the entered-by-hand record', `/invoices/${jobNumber}/entered-by-hand`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...rest, epoch: worldEpoch }),
    });
  }

  async getMode(): Promise<PbsMode> {
    return (await this.#call('the mode read', '/mode', {}, isPbsMode)) as PbsMode;
  }

  async setMode(m: { mode: PbsMode['mode']; n?: number | null; setBy?: string | null; setAt?: string | null }): Promise<PbsMode> {
    return (await this.#call('the mode', '/mode', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) }, isPbsMode)) as PbsMode;
  }

  async reset(epoch: number): Promise<{ applied: boolean; epoch: number }> {
    return (await this.#call('the reset', '/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ epoch }) },
      (b) => isObject(b) && typeof b.applied === 'boolean' && Number.isInteger(b.epoch))) as {
      applied: boolean; epoch: number;
    };
  }

  async listInvoices(cursor?: string): Promise<{ items: unknown[]; next: string | null }> {
    return (await this.#call('the invoice list', cursor === undefined ? '/invoices' : `/invoices?cursor=${encodeURIComponent(cursor)}`, {},
      (b) => isObject(b) && Array.isArray(b.items) && isTextOrNull(b.next))) as {
      items: unknown[]; next: string | null;
    };
  }

  async getInvoice(jobNumber: number): Promise<unknown> {
    return this.#call('the invoice', `/invoices/${jobNumber}`);
  }
}
