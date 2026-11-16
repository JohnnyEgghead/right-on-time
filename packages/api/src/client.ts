// SPDX-License-Identifier: AGPL-3.0-or-later
// The typed client every UI surface calls (page code calls only @bw/api, SPECIFICATIONS 4.1).
import type { z } from 'zod';
import { fillPath } from './mount.ts';
import { servedPath, hasEnvelope, queryUnsafeFields, type ContractRow } from './contract.ts';
import { rowJsonSchema } from './export.ts';
import { envelopeSchema, problemSchema, type Envelope, type Problem } from './envelope.ts';
import { errorMessageKey, problemType } from './errors.ts';
import type { RawAnswer } from './check.ts';

export class ApiError extends Error {
  readonly problem: Problem;
  readonly status: number;
  constructor(status: number, problem: Problem) {
    super(`${problem.code} (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.problem = problem;
  }
}

/**
 * F-1746: a call that had no answer within the client's time limit. A TypeError, as fetch's own rejection with no connection is, so every
 * reader that takes a rejected fetch for no signal (the technician apps' wire.ts failureOf) takes this the same way.
 */
export class CallTimeout extends TypeError {
  readonly contract: string;
  readonly limitMs: number;
  constructor(contract: string, limitMs: number) {
    super(`${contract}: no answer within ${limitMs} ms`);
    this.name = 'CallTimeout';
    this.contract = contract;
    this.limitMs = limitMs;
  }
}

export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /**
   * F-1746: the longest 1 call may take, from the request to the whole answer read; past it the request is cancelled and the call rejects with
   * CallTimeout. Absent: no limit (a page's own reads, where the browser gives up). The technician apps' sync sets it (SYNC_CALL_LIMIT_MS).
   */
  timeoutMs?: number;
}

export type CallResult<Res extends z.ZodType> = { status: number; data: z.output<Res>; envelope: Envelope<z.output<Res>> | null; fileName?: string };

export interface ApiClient {
  /** Send the request, validate the answer against the row's schemas, return typed data; a Problem throws ApiError. */
  call<Req extends z.ZodType, Res extends z.ZodType>(row: ContractRow<Req, Res>, input?: z.input<Req>, headers?: Record<string, string>): Promise<CallResult<Res>>;
  /** Send the request and return the answer unparsed (the contract-tests harness checks it itself). */
  raw(row: ContractRow, input?: Record<string, unknown>, headers?: Record<string, string>): Promise<RawAnswer>;
}

function build(row: ContractRow, input: Record<string, unknown>, base: string): { url: string; body: string | undefined } {
  const pathParams = new Set([...row.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string));
  const rest: Record<string, unknown> = {};
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(input)) {
    if (pathParams.has(k)) params[k] = v as string | number;
    else rest[k] = v;
  }
  let url = base.replace(/\/$/, '') + fillPath(servedPath(row), params);
  if (row.method === 'GET' || row.method === 'DELETE') {
    // UI-SPECIFICATION 12.1 item 6 (NFR-05): no phone number or address in a query string, whatever the row declares.
    const unsafe = new Set(queryUnsafeFields(rowJsonSchema(row.request, 'input')).map((p) => p.split('.')[1]));
    for (const k of Object.keys(rest)) {
      if (unsafe.has(k)) throw new Error(`${row.id}: field ${k} may not travel in a query string (contract rule 6); make the row a POST body`);
    }
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null) q.set(k, String(v));
    const s = q.toString();
    if (s) url += `?${s}`;
    return { url, body: undefined };
  }
  return { url, body: Object.keys(rest).length > 0 ? JSON.stringify(rest) : undefined };
}

/**
 * F-1746: runs 1 call under a time limit, when there is one. At the limit the request is cancelled (its signal aborts) and the call rejects with
 * CallTimeout at once, whether or not the fetch honors the signal: the limit never leans on the abort.
 */
export async function withTimeLimit<T>(contract: string, limitMs: number | undefined, run: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  if (limitMs === undefined) return run(undefined);
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new CallTimeout(contract, limitMs)); // first, so the race answers CallTimeout, never the fetch's own AbortError
      ctl.abort();
    }, limitMs);
  });
  const call = run(ctl.signal);
  call.catch(() => undefined); // a call cancelled at the limit rejects after the race is over: never an unhandled rejection
  try {
    return await Promise.race([call, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function createClient(opts: ClientOptions): ApiClient {
  const doFetch = opts.fetch ?? fetch;
  const raw: ApiClient['raw'] = async (row, input = {}, headers = {}) => {
    const { url, body } = build(row, input, opts.baseUrl);
    const init: RequestInit = {
      method: row.method,
      headers: { accept: 'application/json, application/problem+json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers, ...headers },
      ...(body !== undefined ? { body } : {}),
    };
    const { res, text } = await withTimeLimit(row.id, opts.timeoutMs, async (signal) => {
      const r = await doFetch(url, signal ? { ...init, signal } : init);
      return { res: r, text: await r.text() };
    });
    let parsed: unknown = text === '' ? undefined : text;
    // A file row's success answer is the file's text, never JSON (its Problem answers still are).
    const fileAnswer = row.file !== undefined && res.status < 400;
    if (text !== '' && !fileAnswer) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // leave the text: the check reports a non-JSON answer
      }
    }
    const named = fileAnswer ? /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] : undefined;
    return { status: res.status, body: parsed, ...(named !== undefined ? { fileName: named } : {}) };
  };
  return {
    raw,
    async call(row, input, headers) {
      const answer = await raw(row, (input ?? {}) as Record<string, unknown>, headers);
      if (answer.status >= 400) {
        const parsed = problemSchema.safeParse(answer.body);
        if (parsed.success) throw new ApiError(answer.status, parsed.data as Problem);
        // A 5xx that is no Problem (an nginx 502 page, a proxy timeout) is a server_error all the same, never a ZodError
        // (UI-SPECIFICATION 4.3: server_error is any 5xx; F-128). Any other non-Problem error body is a contract defect.
        if (answer.status >= 500) {
          throw new ApiError(answer.status, {
            type: problemType('server_error'), title: errorMessageKey('server_error'), status: answer.status, code: 'server_error',
            meta: { contract: row.id, worldEpoch: 0, demoNow: '' },
          } as Problem);
        }
        problemSchema.parse(answer.body);
      }
      if (answer.status === 204) return { status: 204, data: undefined as z.output<typeof row.response>, envelope: null };
      if (!hasEnvelope(row)) return { status: answer.status, data: row.response.parse(answer.body), envelope: null, ...(answer.fileName !== undefined ? { fileName: answer.fileName } : {}) };
      const env = envelopeSchema(row.response).parse(answer.body) as Envelope<z.output<typeof row.response>>;
      return { status: answer.status, data: env.data, envelope: env };
    },
  };
}
