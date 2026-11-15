// SPDX-License-Identifier: AGPL-3.0-or-later
// The pretend billing service's HTTP interface (SPECIFICATIONS section 6.6 FR-BILL-4: a separate module reached only
// over HTTP, like a remote system; section 4.5 the BillingClient seam). It listens on pbs:8090 inside the Compose
// network only and serves:
//   POST /invoices                         1 invoice, Idempotency-Key job-<n> and X-World-Epoch (FR-BILL-5, FR-BILL-8, SD-12)
//   POST /invoices/{jobNumber}/entered-by-hand   Mark fixed's record (FR-BILL-11)
//   GET  /invoices, GET /invoices/{jobNumber}    the invoices received and 1 invoice with its calls (API-65, API-66)
//   GET  /mode, PUT /mode                  the failure mode (API-67, API-68; SD-44)
//   POST /reset                            apply a world reset once per epoch (SD-12)
//   GET  /healthz
// Answers to POST /invoices: 200 {answer: stored | stored_late | already_have}; 422 {answer: data_error, reason};
// 503 {answer: down | wrong_epoch}; 400 for a request that breaks the protocol (no key, no epoch, a body whose job
// number is not the key's), which records no call.
import http from 'node:http';
import { EPOCH_HEADER, IDEMPOTENCY_HEADER, NOT_ANSWERING_HOLD_MS, type InvoiceLine } from '@bw/domain';
import type { Logger } from '@bw/log';
import type pg from 'pg';
import { enterByHand, getInvoice, getMode, listInvoices, receive, reset, setMode, SnapshotUnreadableError, storeLate } from './store.ts';

export interface PbsOptions {
  pool: pg.Pool;
  log: Logger;
  /** How long Not answering holds a request before it stores and answers, in real ms (FR-BILL-5: 60 s). */
  holdMs?: number;
}

export interface PbsServer {
  server: http.Server;
  /** Stop accepting, cancel every pending hold (nothing is stored for it), and wait for running requests. */
  close(): Promise<void>;
}

const MAX_BODY = 256 * 1024;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > MAX_BODY) throw new HttpError(413, 'the body is too large');
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'the body is not JSON');
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return; // a client that timed out is gone (FR-BILL-6); pbs still stored
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const jobOf = (s: string | undefined): number | null => {
  if (s === undefined || !/^[1-9]\d{0,9}$/.test(s)) return null;
  const n = Number(s);
  return n <= 2_147_483_647 ? n : null;
};

export function createPbsServer(opts: PbsOptions): PbsServer {
  const { pool, log } = opts;
  const holdMs = opts.holdMs ?? NOT_ANSWERING_HOLD_MS;
  const holds = new Set<{ timer: NodeJS.Timeout; cancel: () => void }>();
  const running = new Set<Promise<void>>();

  /** Wait out a Not answering hold; false when pbs is closing (the hold is abandoned and stores nothing). */
  const hold = () => new Promise<boolean>((resolve) => {
    const h = {
      timer: setTimeout(() => {
        holds.delete(h);
        resolve(true);
      }, holdMs),
      cancel: () => {
        clearTimeout(h.timer);
        holds.delete(h);
        resolve(false);
      },
    };
    holds.add(h);
  });

  async function postInvoice(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const key = String(req.headers[IDEMPOTENCY_HEADER] ?? '');
    const keyJob = /^job-(\d+)$/.exec(key);
    const jobNumber = jobOf(keyJob?.[1]);
    const epochText = String(req.headers[EPOCH_HEADER] ?? '');
    if (jobNumber === null) throw new HttpError(400, 'the Idempotency-Key header must be job-<job number>');
    if (!/^\d{1,9}$/.test(epochText)) throw new HttpError(400, 'the X-World-Epoch header must be the world epoch');
    const body = await readJson(req);
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    if (b.jobNumber !== jobNumber) throw new HttpError(400, 'the body job number is not the Idempotency-Key job number');
    if (typeof b.sentAt !== 'string' || !RFC3339.test(b.sentAt)) throw new HttpError(400, 'sentAt must be the RFC 3339 demo time of the send');
    const epoch = Number(epochText);
    const receipt = await receive(pool, { jobNumber, epoch, sentAt: b.sentAt, body });
    if (receipt.answer === 'hold') {
      // Not answering (FR-BILL-5): the link worker times out at 30 s; this request stores at 60 s anyway, the late
      // success of FR-BILL-8, unless a reset changed the epoch meanwhile (checked again at store, SD-12).
      if (!(await hold())) return;
      const late = await storeLate(pool, receipt.invoice, epoch);
      log.info({ route: '/invoices', status: late === 'wrong_epoch' ? 503 : 200, jobNumber, errorCode: late });
      send(res, late === 'wrong_epoch' ? 503 : 200, { answer: late });
      return;
    }
    const status = { stored: 200, already_have: 200, data_error: 422, down: 503, wrong_epoch: 503 }[receipt.answer];
    log.info({ route: '/invoices', status, jobNumber, errorCode: receipt.answer });
    send(res, status, receipt.reason === undefined ? { answer: receipt.answer } : { answer: receipt.answer, reason: receipt.reason });
  }

  async function postEnteredByHand(req: http.IncomingMessage, res: http.ServerResponse, jobNumber: number): Promise<void> {
    const body = await readJson(req);
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const str = (k: string) => (typeof b[k] === 'string' && (b[k] as string).trim() !== '' ? (b[k] as string) : null);
    const reason = str('reason');
    const by = str('by');
    const at = str('at');
    const customerName = str('customerName');
    const doneAt = str('doneAt');
    if (!Number.isInteger(b.epoch) || reason === null || by === null || at === null || !RFC3339.test(at) || customerName === null
      || doneAt === null || !RFC3339.test(doneAt) || !Number.isInteger(b.totalCents) || !Array.isArray(b.lines)) {
      throw new HttpError(400, 'entered-by-hand needs epoch, reason, by, at, customerName, doneAt, lines and totalCents');
    }
    const r = await enterByHand(pool, {
      jobNumber, epoch: b.epoch as number, reason, by, at, customerName, doneAt, lines: b.lines as InvoiceLine[], totalCents: b.totalCents as number,
    });
    log.info({ route: '/invoices/{jobNumber}/entered-by-hand', status: r === 'entered' ? 200 : 503, jobNumber });
    send(res, r === 'entered' ? 200 : 503, { answer: r });
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://pbs');
    const parts = url.pathname.split('/').filter((p) => p !== '');
    const m = req.method ?? 'GET';
    if (m === 'GET' && url.pathname === '/healthz') return send(res, 200, { status: 'ok' });
    if (parts[0] === 'invoices') {
      if (parts.length === 1 && m === 'POST') return postInvoice(req, res);
      if (parts.length === 1 && m === 'GET') {
        const after = url.searchParams.get('cursor');
        const n = after === null ? null : jobOf(after);
        if (after !== null && n === null) throw new HttpError(400, 'cursor must be a job number');
        return send(res, 200, await listInvoices(pool, n));
      }
      const job = jobOf(parts[1]);
      if (job !== null && parts.length === 2 && m === 'GET') {
        const inv = await getInvoice(pool, job);
        return inv ? send(res, 200, inv) : send(res, 404, { error: 'not_found' });
      }
      if (job !== null && parts.length === 3 && parts[2] === 'entered-by-hand' && m === 'POST') return postEnteredByHand(req, res, job);
    }
    if (url.pathname === '/mode' && m === 'GET') return send(res, 200, await getMode(pool));
    if (url.pathname === '/mode' && m === 'PUT') {
      const b = (await readJson(req)) as Record<string, unknown> | null;
      const r = await setMode(pool, { mode: b?.mode, n: b?.n, setBy: b?.setBy, setAt: b?.setAt });
      return r.ok ? send(res, 200, r.mode) : send(res, 422, { error: 'validation_failed', reason: r.reason });
    }
    if (url.pathname === '/reset' && m === 'POST') {
      const b = (await readJson(req)) as Record<string, unknown> | null;
      if (!Number.isInteger(b?.epoch) || (b?.epoch as number) < 1) throw new HttpError(400, 'epoch must be a world epoch');
      const r = await reset(pool, b?.epoch as number);
      log.info({ route: '/reset', status: 200 });
      return send(res, 200, r);
    }
    send(res, 404, { error: 'not_found' });
  }

  const server = http.createServer((req, res) => {
    const p = route(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) {
        log.warn({ route: new URL(req.url ?? '/', 'http://pbs').pathname.replace(/\/\d+(?=\/|$)/g, '/{jobNumber}'), status: e.status, errorCode: 'bad_request' });
        send(res, e.status, { error: 'bad_request', reason: e.message });
        return;
      }
      log.error({ status: 500, errorCode: e instanceof SnapshotUnreadableError ? 'snapshot_unreadable' : 'server_error' });
      send(res, 500, { error: e instanceof SnapshotUnreadableError ? 'snapshot_unreadable' : 'server_error' });
    });
    running.add(p);
    void p.finally(() => running.delete(p));
  });

  return {
    server,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const h of [...holds]) h.cancel();
        server.closeAllConnections();
      });
      await Promise.allSettled([...running]);
    },
  };
}

/** Start pbs on host:port (production: 0.0.0.0:8090; tests: 127.0.0.1 and port 0, a free port). */
export async function startPbs(opts: PbsOptions & { host: string; port: number }): Promise<PbsServer & { url: string }> {
  const s = createPbsServer(opts);
  await new Promise<void>((resolve, reject) => {
    s.server.once('error', reject);
    s.server.listen(opts.port, opts.host, () => resolve());
  });
  const addr = s.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
  return { ...s, url: `http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${port}` };
}
