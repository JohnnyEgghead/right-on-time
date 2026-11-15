// SPDX-License-Identifier: AGPL-3.0-or-later
// One contract row (UI-SPECIFICATION 12.2): a Zod request/response pair plus the facts the harness checks.
import { z } from 'zod';
import type { ErrorCode } from './errors.ts';
import { CODE_FREE_CONTRACTS, COMMON_ERRORS, RATE_LIMITED_CONTRACTS, SESSIONLESS_CONTRACTS } from './errors.ts';
import type { Label } from './envelope.ts';
import { mountedPath } from './mount.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** JSON Schema keyword that tags an address field (SPECIFICATIONS 7.2 Labels: `fictional_addresses`). */
export const ADDRESS_TAG = 'x-bw-address';

/** A string field that holds a customer address. The kernel adds `fictional_addresses` to any answer holding one. */
export const addressField = () => z.string().meta({ [ADDRESS_TAG]: true });

/** A request the contract-tests harness sends to a running stack, with the status it must answer. */
export interface Example {
  name: string;
  /** Path parameters, query values and body fields, flat (the client splits them by the row's path and method). */
  input?: Record<string, unknown>;
  headers?: Record<string, string>;
  expectStatus: number;
}

export interface ContractRow<Req extends z.ZodType = z.ZodType, Res extends z.ZodType = z.ZodType> {
  id: `API-${number}`;
  name: string;
  method: HttpMethod;
  /** The row's path as UI-SPECIFICATION 12.2 prints it (under the API base, except the root exceptions of mount.ts). */
  path: string;
  request: Req;
  /** The fields of the answer's `data`. */
  response: Res;
  /** Success statuses; default [200]. */
  successStatus?: readonly number[];
  /** Codes particular to this row; the common ones (COMMON_ERRORS) are implied. */
  errors: readonly ErrorCode[];
  /**
   * The refusals whose Problem body carries more than its code (UI-SPECIFICATION 12.2 names them in brackets, e.g.
   * `version_conflict` (by, change, at, currentVersion)): code -> the schema of the extension members (SPECIFICATIONS
   * 7.2, RFC 9457). The kernel puts a handler's detail into the body only through this schema, and answers
   * server_error when a refusal of such a code carries no valid detail (F-261). Each code must be in `errors`.
   */
  errorDetails?: Partial<Record<ErrorCode, z.ZodObject>>;
  /** Labels the kernel must put on every success answer (section 7.2 Labels), beyond `fictional_addresses` for address fields. */
  labels: readonly Label[];
  /** false when the row answers a plain body (API-171, OI-46) or no body (204). Default true. */
  envelope?: boolean;
  /**
   * A row that answers a file, not JSON (API-83, the problem list as a spreadsheet file): its `data` is the file's text,
   * served with this media type as an attachment of this name. Such a row has `envelope: false`.
   */
  file?: { contentType: 'text/csv'; name: string };
  /**
   * A row that answers a server-sent event stream (API-09, SPECIFICATIONS 7.3): its `data` is the stream body, served as
   * text/event-stream with no length, no caching and no transform. The kernel opens no transaction for it (the stream
   * outlives the call). Such a row has `envelope: false`.
   */
  stream?: true;
  /**
   * For rows that share 1 method and path (UI-SPECIFICATION 12.2 has 1 such route: API-80 and API-84, POST /import/runs
   * "with kind dry_run" and "with kind real"): the body field and value that select this row. The kernel serves a shared
   * route only when every row on it names the same field with a different value.
   */
  selector?: { field: string; value: string };
  /**
   * A row whose body is 1 file, not JSON (API-103, a photo or signature; SPECIFICATIONS SD-32): the kernel reads the raw
   * bytes, at most `maxBytes` (a larger body answers validation_failed, too_large), of 1 of `contentTypes`, and hands
   * them to the handler as the request body; `request` then validates the path and query values only. The native
   * app's background upload sends a file as the whole body (section 4.6), so the item's facts travel in the query.
   */
  upload?: {
    maxBytes: number; contentTypes: readonly string[];
    /** F-978: a body the cap refuses reaches the handler as no bytes, so the handler answers it under its key (API-103). */
    handlerJudgesRefused?: true;
  };
  /**
   * A row that answers 1 stored image, not JSON (API-175, a photo or signature file; F-707, F-727): its `data` is
   * { type, bytes }, and the kernel writes the bytes as the body with that media type, inline. Such a row has `envelope: false`.
   */
  image?: true;
  /** Requests `contract-tests` runs against the stack. A row with none fails the live suite. */
  examples: readonly Example[];
}

export function defineContract<Req extends z.ZodType, Res extends z.ZodType>(row: ContractRow<Req, Res>): ContractRow<Req, Res> {
  return row;
}

export const servedPath = (row: ContractRow): string => mountedPath(row.id, row.path);

/**
 * A link-token route: a row whose path carries a link token (12.2 names those parameters `bookingToken`, `inboxToken`,
 * `oneTimeToken`, `passwordToken`; the SD-17 link paths name theirs `...Token` or `token` too). SPECIFICATIONS 7.1
 * rate-limits every one of them.
 */
export const isLinkTokenRoute = (row: Pick<ContractRow, 'path'>): boolean => /\{\w*[tT]oken\}/.test(row.path);

/**
 * Every code a row may answer (UI-SPECIFICATION 12.1 item 7): its own, the 5 common ones (none of the session ones for a
 * sessionless call), `access_code_required` unless the call answers without the code, and `rate_limited` on the calls
 * SPECIFICATIONS 7.1 rate-limits.
 */
export function allowedErrors(row: ContractRow): ReadonlySet<ErrorCode> {
  const out = new Set<ErrorCode>(row.errors);
  for (const c of COMMON_ERRORS) {
    if (SESSIONLESS_CONTRACTS.has(row.id) && (c === 'unauthenticated' || c === 'forbidden')) continue;
    out.add(c);
  }
  if (!CODE_FREE_CONTRACTS.has(row.id)) out.add('access_code_required');
  if (RATE_LIMITED_CONTRACTS.has(row.id) || isLinkTokenRoute(row)) out.add('rate_limited');
  return out;
}
export const hasEnvelope = (row: ContractRow): boolean => row.envelope !== false;

/** The members every Problem body owns (SPECIFICATIONS 7.2); a detail schema may not name any of them. */
export const PROBLEM_OWN_MEMBERS: readonly string[] = ['type', 'title', 'status', 'code', 'fields', 'meta'];

/** Defects of a row's errorDetails: a code the row does not list, or a member that would overwrite a Problem's own. */
export function errorDetailProblems(row: ContractRow): string[] {
  const out: string[] = [];
  for (const [code, schema] of Object.entries(row.errorDetails ?? {})) {
    if (!row.errors.includes(code as ErrorCode)) out.push(`${row.id}: errorDetails names ${code}, which is not in its errors`);
    for (const member of Object.keys(schema?.shape ?? {})) {
      if (PROBLEM_OWN_MEMBERS.includes(member)) out.push(`${row.id}: the ${code} detail member ${member} is a Problem's own member`);
    }
  }
  return out;
}

/** Property names that read as an address and must carry the tag. */
const ADDRESS_NAME = /address|street|^zip$|postal/i;

type Json = { [k: string]: unknown };

function* walk(node: unknown, path: string): Generator<{ path: string; name: string; schema: Json }> {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) yield* walk(v, `${path}[${i}]`);
    return;
  }
  const obj = node as Json;
  const props = obj.properties;
  if (props && typeof props === 'object') {
    for (const [name, schema] of Object.entries(props as Json)) {
      if (schema && typeof schema === 'object') yield { path: `${path}.${name}`, name, schema: schema as Json };
    }
  }
  for (const [k, v] of Object.entries(obj)) if (k !== 'properties') yield* walk(v, `${path}.${k}`);
  if (props && typeof props === 'object') for (const [name, v] of Object.entries(props as Json)) yield* walk(v, `${path}.${name}`);
}

/** Paths of response fields tagged as addresses, from the row's JSON Schema export. */
export function addressFields(responseSchema: unknown): string[] {
  const out: string[] = [];
  for (const f of walk(responseSchema, '$')) if (f.schema[ADDRESS_TAG] === true) out.push(f.path);
  return out;
}

/** Fields whose name reads as an address but carry no tag (a contract test fails on any). */
export function untaggedAddressFields(responseSchema: unknown): string[] {
  const out: string[] = [];
  for (const f of walk(responseSchema, '$')) if (ADDRESS_NAME.test(f.name) && f.schema[ADDRESS_TAG] !== true) out.push(f.path);
  return out;
}

/** JSON Schema keyword that tags a customer phone field (NFR-05: never in a path, a query string or a log). */
export const PHONE_TAG = 'x-bw-phone';

/** A string field that holds a customer phone number. */
export const phoneField = () => z.string().meta({ [PHONE_TAG]: true });

/** Field names that read as a phone number, or as a free-text search that could hold a phone or an address. */
const PHONE_NAME = /phone|mobile/i;
const SEARCH_NAME = /^(q|query|search|text)$/i;

/**
 * Request fields of a row that UI-SPECIFICATION 12.1 item 6 keeps out of any query string: address- or phone-tagged,
 * address- or phone-named, or a free-text search. A GET or DELETE row sends every non-path field in the query string,
 * so such a row must have none (a search that could hold one is a POST body, SPECIFICATIONS 7.1).
 */
export function queryUnsafeFields(requestJsonSchema: unknown): string[] {
  const out: string[] = [];
  for (const f of walk(requestJsonSchema, '$')) {
    const tagged = f.schema[ADDRESS_TAG] === true || f.schema[PHONE_TAG] === true;
    if (tagged || ADDRESS_NAME.test(f.name) || PHONE_NAME.test(f.name) || SEARCH_NAME.test(f.name)) out.push(f.path);
  }
  return out;
}

/** Labels a success answer of this row must carry. */
export function requiredLabels(row: ContractRow, responseJsonSchema: unknown): Label[] {
  const set = new Set<Label>(row.labels);
  if (addressFields(responseJsonSchema).length > 0) set.add('fictional_addresses');
  return [...set];
}
