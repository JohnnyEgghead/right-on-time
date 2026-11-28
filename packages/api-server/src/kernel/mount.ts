// SPDX-License-Identifier: AGPL-3.0-or-later
// mount (SPECIFICATIONS section 4.1, SD-6, SD-7; FR-AUTH-1; invariant 7). The policy table is the only route
// registry: mount serves only its API entries, refuses to start when a handler has no entry, an entry has no handler,
// 2 entries claim 1 route (unless both name a selector: the 1 shared route of 12.2, API-80 and API-84), or a token entry
// has no token check, and wraps every handler so that `authorize` runs inside the wrapper (never only in a middleware a
// route could skip). Every call, in order:
//   match the route (none: 404, deny by default; a shared route: its row by the body's selector field) ->
//   rate limit by address -> resolve the caller (session) ->
//   Origin check on a cookie-carrying write -> authorize (access code, then access) -> validate the request ->
//   rate limit by login -> 1 transaction: token check, the handler -> validate and wrap the answer.
// Only this file writes a response body for an API call, so no answer leaves without its envelope or Problem shape
// (section 7.2), its labels, and the 11.5 headers. The rows without an envelope: the health check's plain body
// (API-171, OI-46), the text/csv files (the import problem list, API-83, is one), which the kernel writes from the handler's
// text, the stored photo or signature file (API-175), and the event stream (API-09; a stream row, F-344: authorized
// like every row, then answered as text/event-stream from the handler's stream, with no transaction).
// F-1845: a server_error the kernel makes (a throw, or an answer outside the row's contract) logs the call's line at error
// level with its cause code (KernelCause): the caller's answer is the same server_error as before.
import {
  allowedErrors, errorDetailProblems, errorMessageKey, ERROR_STATUS, hasEnvelope, problemType, requiredLabels, rowJsonSchema,
  type ErrorCode, type Label, type Meta,
} from '@bw/api';
import { causeCodeOf, type Logger } from '@bw/log';
import { Temporal, toWire, type Clock, type Instant } from '@bw/time';
import type { ApiPolicyEntry, ApiRequest, Caller, EventBusPort, Handler, KernelSettings, PolicyEntry, TokenCheck, TokenKind, Tx } from '../types.ts';
import { ACCESS_COOKIE, accessCookieValid, requestIsHttps } from './access-code.ts';
import { authorize, type GateState } from './authorize.ts';
import { applySecurityHeaders } from './headers.ts';
import { RateLimiter, rateRules, type RateRule } from './rate-limit.ts';
import { compilePath, specificity, tokenParam, type CompiledPath } from './route.ts';
import { clearedSessionCookie, secureCookies, parseCookies, presentedToken, resolveCaller, SESSION_COOKIE, type SessionStore } from './sessions.ts';

export class MountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MountError';
  }
}

export interface KernelDb {
  /** Run fn in 1 transaction: commit when it returns, roll back when it throws. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface KernelDeps {
  db: KernelDb;
  sessions: SessionStore;
  clock: Clock;
  log: Logger;
  settings: KernelSettings;
  /** The bw_access signing key (ACCESS_COOKIE_KEY, or generated at start). */
  accessKey: string;
  /** Link-token and one-time-link checks, 1 per kind the table uses; mount refuses a table entry with none. */
  tokens?: Partial<Record<TokenKind | 'one_time', TokenCheck>>;
  /** The process's event bus, handed to a stream row's handler and to the board delay sample's (API-172; the seq's emit time, SD-43). */
  events?: EventBusPort;
}

export interface CallInfo {
  /** The client address, when the adapter knows it and no proxy header names it. */
  address?: string;
}

export interface Router {
  handle(request: Request, info?: CallInfo): Promise<Response>;
  /** The routes this router serves: exactly the table's API entries. */
  readonly routes: readonly { contract: string; method: string; path: string }[];
  /**
   * Does this request belong to the kernel: the API base, or a root route of the table whose method the request has? A path and a method
   * the table has no row for is a page (F-219): a page and a JSON contract may share 1 path, as the reschedule page (GET) and API-118 (POST)
   * share the reschedule link path, each answered by its own side. With no method, any row at the path claims it.
   */
  owns(pathname: string, method?: string): boolean;
}

/** The zone demo time is written in (the branches' zone; handlers share it). */
export const DEFAULT_ZONE = 'America/New_York';

const MAX_BODY = 1 << 20;
const SIGN_OUT = 'API-06';
const ENTER_CODE = 'API-01';
/** API-171: its every unhealthy answer, a thrown database read included, is a 503 (SPECIFICATIONS 7.4, F-215, F-99). */
const HEALTH_CHECK = 'API-171';

/** API-172 reads the bus's emit time of the posted seq (SD-43). */
const BOARD_DELAY_SAMPLE = 'API-172';

/** F-289: the Set-Cookie names a row's handler may put on a success. Any other row, or any other name, is a defect (server_error). */
const COOKIE_ALLOW: Readonly<Record<string, readonly string[]>> = { [ENTER_CODE]: [ACCESS_COOKIE], 'API-03': [SESSION_COOKIE], 'API-05': [SESSION_COOKIE] };
const API_PREFIX = '/api/';
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** The kernel stamps system.demo_clock.last_write_real at most once per this many real seconds (SD-12 idle reset). */
const WRITE_STAMP_EVERY_S = 10;

class Refusal {
  readonly code: ErrorCode;
  readonly fields: { field: string; problem: string }[] | undefined;
  /** The handler's detail for a code whose row names one (ContractRow.errorDetails; F-261). */
  readonly detail: unknown;
  constructor(code: ErrorCode, fields?: { field: string; problem: string }[], detail?: unknown) {
    this.code = code;
    this.fields = fields;
    this.detail = detail;
  }
}

interface Route {
  entry: ApiPolicyEntry;
  compiled: CompiledPath;
  guarded: (call: Call) => Promise<Response>;
}

interface Call {
  request: Request;
  params: Record<string, string>;
  url: URL;
  address: string;
  started: number;
}

/** The checks mount makes before it serves anything; each failure is named. */
export function checkTable(table: readonly PolicyEntry[], handlers: Readonly<Record<string, unknown>>, tokens: KernelDeps['tokens'] = {}): void {
  const api = table.filter((e): e is ApiPolicyEntry => e.kind === 'api');
  const problems: string[] = [];
  const seen = new Map<string, ApiPolicyEntry>();
  const ids = new Set<string>();
  for (const e of api) {
    if (ids.has(e.contract)) problems.push(`${e.contract} has 2 policy entries`);
    ids.add(e.contract);
    const key = routeKey(e);
    const other = seen.get(key);
    // 2 rows may share a route only when both name the same selector field with different values (contract.ts selector).
    if (other && !selectable(other, e)) problems.push(`${e.contract} and ${other.contract} claim the same route ${key}`);
    if (!other) seen.set(key, e);
    if (!Object.hasOwn(handlers, e.contract)) problems.push(`policy entry ${e.contract} (${e.method} ${e.path}) has no handler`);
    if (e.access.kind === 'token' && !tokens[e.access.tokenKind]) problems.push(`${e.contract} needs a ${e.access.tokenKind} token check`);
    if (e.access.kind === 'one_time' && !tokens.one_time) problems.push(`${e.contract} needs a one_time link check`);
    if ((e.access.kind === 'token' || e.access.kind === 'one_time') && !tokenParam(e.path)) problems.push(`${e.contract} has token access but no token in its path`);
    if (e.access.kind === 'roles' && e.access.roles.length === 0) problems.push(`${e.contract} admits no role`);
    problems.push(...errorDetailProblems(e.row));
  }
  for (const id of Object.keys(handlers)) if (!ids.has(id)) problems.push(`handler ${id} has no policy entry`);
  // Every row on a shared route names a selector, all with 1 field and distinct values (a third row is checked against the first).
  const byKey = new Map<string, ApiPolicyEntry[]>();
  for (const e of api) byKey.set(routeKey(e), [...(byKey.get(routeKey(e)) ?? []), e]);
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const values = group.map((e) => e.row.selector?.value);
    if (new Set(values).size !== values.length) problems.push(`the rows on ${key} (${group.map((e) => e.contract).join(', ')}) repeat a selector value`);
  }
  if (problems.length > 0) throw new MountError(`mount refused: ${problems.join('; ')}`);
}

const routeKey = (e: ApiPolicyEntry): string => `${e.method} ${e.path.replace(/\{\w+\}/g, '{}')}`;

/** May these 2 rows share their route? Only when both name a selector on the same body field, with different values. */
function selectable(a: ApiPolicyEntry, b: ApiPolicyEntry): boolean {
  const x = a.row.selector;
  const y = b.row.selector;
  return x !== undefined && y !== undefined && x.field === y.field && x.value !== y.value && a.method !== 'GET' && a.method !== 'DELETE';
}

/**
 * The row of a shared route a request selects: the one whose selector value its JSON body's field holds. A body that
 * names none (absent, not JSON, too large, another value) goes to the first row, whose own pipeline then answers it
 * (authorization first, then validation_failed), so a shared route refuses exactly as a single one does. The body is
 * read from a clone: the chosen row's pipeline reads the request itself.
 */
async function selectRoute(group: readonly Route[], request: Request): Promise<Route> {
  const first = group[0] as Route;
  const field = first.entry.row.selector?.field;
  const len = Number(request.headers.get('content-length') ?? '0');
  if (field === undefined || len > MAX_BODY) return first;
  let value: unknown;
  try {
    const text = await request.clone().text();
    if (text.length > MAX_BODY) return first;
    value = (JSON.parse(text) as Record<string, unknown> | null)?.[field];
  } catch {
    return first;
  }
  return group.find((r) => r.entry.row.selector?.value === value) ?? first;
}

export function mount(table: readonly PolicyEntry[], handlers: Readonly<Record<string, Handler<unknown>>>, deps: KernelDeps): Router {
  checkTable(table, handlers, deps.tokens);
  const limiter = new RateLimiter(deps.clock);
  const routes: Route[] = table
    .filter((e): e is ApiPolicyEntry => e.kind === 'api')
    .sort((a, b) => specificity(a.path) - specificity(b.path))
    .map((entry) => ({ entry, compiled: compilePath(entry.path), guarded: wrap(entry, handlers[entry.contract]!, deps, limiter) }));
  // 1 entry per route, except a shared route (checkTable admitted it), whose rows are chosen per request by selectRoute.
  const served = new Map<string, Route[]>();
  for (const r of routes) served.set(routeKey(r.entry), [...(served.get(routeKey(r.entry)) ?? []), r]);
  const dispatch = [...served.values()];

  return {
    routes: routes.map((r) => ({ contract: r.entry.contract, method: r.entry.method, path: r.entry.path })),
    owns: (pathname, method) =>
      pathname === '/api' || pathname.startsWith(API_PREFIX) ||
      routes.some((r) => r.compiled.match(pathname) !== null && (method === undefined || r.entry.method === (method === 'HEAD' ? 'GET' : method))),
    async handle(request, info = {}) {
      const started = performance.now();
      const url = new URL(request.url);
      const method = request.method === 'HEAD' ? 'GET' : request.method;
      for (const group of dispatch) {
        const head = group[0] as Route;
        if (head.entry.method !== method) continue;
        const params = head.compiled.match(url.pathname);
        if (!params) continue;
        const r = group.length === 1 ? head : await selectRoute(group, request);
        return r.guarded({ request, params, url, address: clientAddress(request.headers, info), started });
      }
      // Deny by default: no entry, no route.
      const res = problem(404, 'not_found', { contract: '', worldEpoch: 0, demoNow: '' }, request);
      deps.log.info({ status: 404, errorCode: 'not_found', durationMs: Math.round(performance.now() - started) });
      return res;
    },
  };
}

/**
 * J-28: whether the connection's peer is the proxy in front of the web port. nginx runs on the host or the Compose network, so its
 * peer address is loopback or private; a caller on any other address reached the port directly and its own header is not trusted.
 * No peer address (an in-process call with no socket) has no caller to distrust.
 */
function isProxyPeer(address: string | undefined): boolean {
  if (address === undefined) return true;
  const a = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (a === '::1' || /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(a);
  if (!m) return false;
  const [o1, o2] = [Number(m[1]), Number(m[2])];
  return o1 === 127 || o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 169 && o2 === 254);
}

/** nginx sets X-Forwarded-For to the peer address it sees (infra/nginx/routes-open.conf, routes-locked.conf); the header is read only from nginx's own peer. */
function clientAddress(h: Headers, info: CallInfo): string {
  const fwd = isProxyPeer(info.address) ? h.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined;
  return fwd || info.address || 'unknown';
}

/**
 * F-1845: why the kernel answered server_error, the call line's errorCode at error level. A throw anywhere in the call
 * logs @bw/log causeCodeOf (the error's code or class name, never its message). An answer outside the row's contract logs
 * its own code: 'response_shape' (a status, body, image, stream, error code or error detail the row does not allow) or
 * 'cookie_not_allowed' (a Set-Cookie name the row may not set, F-289).
 */
type KernelCause = 'response_shape' | 'cookie_not_allowed' | (string & {});

function wrap(entry: ApiPolicyEntry, handler: Handler<unknown>, deps: KernelDeps, limiter: RateLimiter): (call: Call) => Promise<Response> {
  const row = entry.row;
  const rules = rateRules(row);
  const byAddress = rules.filter((r) => r.scope === 'address');
  const byLogin = rules.filter((r) => r.scope === 'login');
  const allowed = allowedErrors(row);
  const labelsAlways = requiredLabels(row, rowJsonSchema(row.response, 'output'));
  const tokenName = tokenParam(entry.path);
  const okStatuses = row.successStatus ?? [200];

  return async (call) => {
    const { request } = call;
    let meta: Pick<Meta, 'contract' | 'worldEpoch' | 'demoNow'> = { contract: entry.contract, worldEpoch: 0, demoNow: '' };
    let caller = { kind: 'anonymous' } as Caller;
    let status = 500;
    let errorCode: ErrorCode | undefined;
    let cause: KernelCause | undefined;
    const refuse = (code: ErrorCode, fields?: { field: string; problem: string }[], detail?: unknown): Response => {
      // A code the row may not answer is itself a defect: the caller sees server_error, the log names nothing private.
      let c: ErrorCode = allowed.has(code) ? code : 'server_error';
      // F-261: a code whose row names a detail schema carries those members, and only through it. A refusal of such a code
      // with no valid detail, or a detail for a code whose row names none, is a defect too: server_error, no members.
      const schema = row.errorDetails?.[c];
      let members: Record<string, unknown> | undefined;
      if (schema) {
        const parsed = schema.safeParse(detail);
        if (parsed.success) members = parsed.data as Record<string, unknown>;
        else c = 'server_error';
      } else if (detail !== undefined) {
        c = 'server_error';
      }
      // SPECIFICATIONS 7.4: the health check answers 503, never 500, when it is not healthy (the deploy rolls back at once on 500).
      if (c === 'server_error' && code !== 'server_error') cause ??= 'response_shape';
      status = c === 'server_error' && entry.contract === HEALTH_CHECK ? 503 : ERROR_STATUS[c];
      errorCode = c;
      return problem(status, c, meta, request, fields, members);
    };
    /** A handler's answer the kernel replaces with server_error (F-1845: logged with its own code). */
    const substitute = (why: 'response_shape' | 'cookie_not_allowed'): Response => {
      cause = why;
      return refuse('server_error');
    };
    const readClock = async (): Promise<Instant> => {
      const [demoNow, worldEpoch] = await Promise.all([deps.clock.demoNow(), deps.clock.worldEpoch()]);
      meta = { contract: entry.contract, worldEpoch, demoNow: toWire(demoNow, DEFAULT_ZONE) };
      return demoNow;
    };

    let res: Response;
    let setCookies: string[] = [];
    try {
      res = await (async (): Promise<Response> => {
        // Demo time and the world epoch for meta (section 7.2). When the clock row cannot be read, as on a fresh database
        // before setup (F-244), no row's auth check, validation or answer waits on it: meta carries the epoch instant and
        // world epoch 0, and a handler that reads req.demoNow or req.worldEpoch then fails closed (server_error), so no
        // invented time is acted on. API-10 reads the row itself and answers 500, as specified.
        let clockRead = true;
        // F-543: a write is stamped from the clock row itself, not this process's copy (cached up to 250 ms): a replay or jump made by
        // another process (the worker ends a replay) is then already in the time the write runs at.
        if (WRITES.has(request.method)) deps.clock.invalidate?.();
        const demoNow = await readClock().catch((e: unknown) => {
          // K-10.3: a failed clock-row read is logged once, at error level, with its cause code (never its message).
          deps.log.error({ contract: entry.contract, route: entry.path, errorCode: causeCodeOf(e) });
          clockRead = false;
          const epoch = Temporal.Instant.fromEpochMilliseconds(0);
          meta = { contract: entry.contract, worldEpoch: 0, demoNow: toWire(epoch, DEFAULT_ZONE) };
          return epoch;
        });
        if (!limited(limiter, entry.contract, byAddress, call.address)) return refuse('rate_limited');
        const cookies = parseCookies(request.headers.get('cookie'));
        const gate: GateState = { codeOn: deps.settings.ACCESS_CODE_ON, codeEntered: accessCookieValid(cookies.get(ACCESS_COOKIE), deps.accessKey, deps.clock) };
        const presented = presentedToken(request.headers);
        caller = await resolveCaller(deps.sessions, deps.clock, presented, !gate.codeOn || gate.codeEntered);
        // SD-8: a cookie-carrying write must come from the app's own origin.
        const cookieCarrying = presented?.via === 'cookie' || cookies.has(SESSION_COOKIE) || cookies.has(ACCESS_COOKIE);
        if (WRITES.has(request.method) && cookieCarrying && request.headers.get('origin') !== deps.settings.APP_ORIGIN) return refuse('forbidden');
        const verdict = authorize(entry, caller, gate);
        if (!verdict.ok) return refuse(verdict.code);

        const parsed = await readInput(entry, call);
        if (parsed instanceof Refusal) return refuse(parsed.code, parsed.fields);
        const login = (parsed.value as { login?: unknown } | null)?.login;
        if (typeof login === 'string' && !limited(limiter, entry.contract, byLogin, login.trim().toLowerCase())) return refuse('rate_limited');

        const unread = (): never => { throw new Error('the clock row could not be read'); };
        const req: ApiRequest = {
          contract: entry.contract, params: parsed.value, body: parsed.raw, caller,
          get worldEpoch(): number { return clockRead ? meta.worldEpoch : unread(); },
          get demoNow(): Instant { return clockRead ? demoNow : unread(); },
        };
        const context = {
          settings: deps.settings, clock: deps.clock, log: deps.log,
          // F-289: the signing key goes to the row that issues the access cookie, the presented token to the row that ends the session.
          accessKey: entry.contract === ENTER_CODE ? deps.accessKey : null,
          secure: requestIsHttps(request.url, request.headers),
          codeEntered: gate.codeEntered,
          presented: entry.contract === SIGN_OUT ? presented : null,
          // F-344: the bus goes to a stream row only.
          events: row.stream || entry.contract === BOARD_DELAY_SAMPLE ? deps.events ?? null : null,
        };
        if (row.stream) {
          // A stream row (API-09): no transaction (the stream outlives the call); the body is the handler's stream.
          const r = await handler(req, NO_TX, context);
          if (!r.ok) return refuse(r.code, undefined, r.detail);
          if (r.status !== 200 || !(r.data instanceof ReadableStream)) return substitute('response_shape');
          status = 200;
          return stream(r.data, request);
        }
        const result = await runInTransaction(deps.db, async (tx) => {
          if (verdict.needs !== 'nothing') {
            const check = verdict.needs === 'token' && entry.access.kind === 'token' ? deps.tokens?.[entry.access.tokenKind] : deps.tokens?.one_time;
            const token = tokenName ? call.params[tokenName] : undefined;
            if (!check || token === undefined || !(await check(token, tx))) throw new Refusal('not_found');
          }
          const r = await handler(req, tx, context);
          if (!r.ok) throw new Refusal(r.code, undefined, r.detail);
          // SD-12 idle reset: the kernel stamps each successful write's real time on the clock row, at most once per
          // 10 s (the UPDATE matches nothing, and takes no lock, until the stamp is 10 s old). Last in the transaction,
          // so the clock row is locked after the world rows, the order a reset takes them in.
          if (WRITES.has(request.method)) {
            await tx.query(
              `UPDATE system.demo_clock SET last_write_real = $1 WHERE id = 1 AND last_write_real < $1::timestamptz - interval '${WRITE_STAMP_EVERY_S} seconds'`,
              [deps.clock.realNow('idle_reset').toString()],
            );
          }
          return r;
        });
        if (result instanceof Refusal) return refuse(result.code, result.fields, result.detail);

        if (!okStatuses.includes(result.status)) return substitute('response_shape');
        status = result.status;
        const allowed = COOKIE_ALLOW[entry.contract] ?? [];
        if ((result.cookies ?? []).some((c) => !allowed.includes(c.slice(0, c.indexOf('='))))) return substitute('cookie_not_allowed');
        setCookies = result.cookies ?? [];
        if (result.status === 204) return finish(new Response(null, { status: 204 }), request);
        const data = row.response.safeParse(result.data);
        if (!data.success) return substitute('response_shape');
        if (row.file && typeof data.data === 'string') {
          // A file row (API-83): the kernel writes the file's text as the body; a file carries no envelope (contract.ts file).
          return finish(new Response(data.data, { status, headers: {
            'content-type': `${row.file.contentType}; charset=utf-8`, 'content-disposition': `attachment; filename="${result.fileName !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(result.fileName) ? result.fileName : row.file.name}"`,
          } }), request);
        }
        if (row.image) {
          // An image row (API-175): the stored file itself, inline, with its own media type; never kept by a cache (finish).
          const img = data.data as { type?: unknown; bytes?: unknown };
          if (typeof img.type !== 'string' || !(img.bytes instanceof Uint8Array)) return substitute('response_shape');
          return finish(new Response(img.bytes as Uint8Array<ArrayBuffer>, { status, headers: { 'content-type': img.type, 'content-length': String(img.bytes.byteLength) } }), request);
        }
        if (!hasEnvelope(row)) return json(status, data.data, request, 'application/json');
        const labels = new Set<Label>(labelsAlways);
        if (result.labels?.includes('entered_offline')) labels.add('entered_offline');
        const native = presented?.via === 'bearer' || (caller.kind === 'staff' && caller.client === 'native');
        if (deps.settings.DEMO_MODE && !native) labels.add('demo_mode');
        return json(status, { data: data.data, meta: { ...meta, viewer: viewer(entry, caller), labels: [...labels] } }, request, 'application/json');
      })();
    } catch (e) {
      // Any throw (the session store, the clock, the database, the handler): server_error to the caller, and the log line
      // names its cause code, never its message (F-1845).
      cause = causeCodeOf(e)
      if (meta.demoNow === '') await readClock().catch(() => undefined);
      res = refuse('server_error');
    }
    // F-230: sign out clears the session cookie on every answer, a refusal included (an httpOnly cookie cannot be cleared by script).
    if (entry.contract === SIGN_OUT) setCookies = [clearedSessionCookie(secureCookies(deps.settings.APP_ORIGIN))];
    for (const c of setCookies) res.headers.append('set-cookie', c);
    const line = {
      ...(meta.demoNow ? { demoTime: meta.demoNow } : {}),
      contract: entry.contract, route: entry.path, status, durationMs: Math.round(performance.now() - call.started),
      ...(caller.kind === 'staff' ? { userId: caller.userId } : {}),
    };
    // F-1845: a server_error answer is an error-level line with its cause (a handler's own server_error refusal, such as
    // the health check's stale heartbeat (API-171), has no further cause and logs server_error); every other answer is the info line it was.
    if (errorCode === 'server_error') deps.log.error({ ...line, errorCode: cause ?? 'server_error' });
    else deps.log.info({ ...line, ...(errorCode ? { errorCode } : {}) });
    return res;
  };
}

function limited(limiter: RateLimiter, contract: string, rules: readonly RateRule[], subject: string): boolean {
  let ok = true;
  for (const rule of rules) ok = limiter.hit(contract, rule, subject) && ok;
  return ok;
}

async function runInTransaction<T>(db: KernelDb, fn: (tx: Tx) => Promise<T>): Promise<T | Refusal> {
  try {
    return await db.transaction(fn);
  } catch (e) {
    if (e instanceof Refusal) return e; // rolled back: a refused call writes nothing
    throw e;
  }
}

/**
 * An upload row's body (API-103; ContractRow.upload): at most maxBytes of 1 accepted media type, read with a cap so a
 * body with no length is never read past it. Too large or another type answers validation_failed with its field.
 */
async function readUploadBody(request: Request, upload: NonNullable<ApiPolicyEntry['row']['upload']>): Promise<Uint8Array | Refusal> {
  const tooLarge = () => new Refusal('validation_failed', [{ field: '$', problem: 'too_large' }]);
  if (Number(request.headers.get('content-length') ?? '0') > upload.maxBytes) return tooLarge();
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!upload.contentTypes.includes(type)) return new Refusal('validation_failed', [{ field: '$', problem: 'not_an_accepted_type' }]);
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > upload.maxBytes) {
        await reader.cancel();
        return tooLarge();
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function readInput(entry: ApiPolicyEntry, call: Call): Promise<{ value: unknown; raw: unknown } | Refusal> {
  const { request } = call;
  const input: Record<string, unknown> = {};
  let raw: unknown = null;
  const upload = entry.row.upload;
  if (upload) {
    // The item's facts travel in the query; the body is the file (handed to the handler as req.body).
    const bytes = await readUploadBody(request, upload);
    // F-978: a body the cap refuses (over the size, or not an accepted type) still reaches the handler, as no bytes, so the
    // handler answers it under its key (API-103: flagged validation_failed, listed for the dispatcher; SPECIFICATIONS 5.1
    // step 10, owner ruling 546d6f1e). A 422 here would keep the photo on the phone forever (the phone keeps a 4xx item).
    if (bytes instanceof Refusal && !upload.handlerJudgesRefused) return bytes;
    raw = bytes instanceof Refusal ? new Uint8Array(0) : bytes;
    for (const [k, v] of call.url.searchParams) input[k] = v;
  } else if (entry.method === 'GET' || entry.method === 'DELETE') {
    for (const [k, v] of call.url.searchParams) input[k] = v;
  } else {
    const len = Number(request.headers.get('content-length') ?? '0');
    if (len > MAX_BODY) return new Refusal('validation_failed', [{ field: '$', problem: 'too_large' }]);
    const text = await request.text();
    if (text.length > MAX_BODY) return new Refusal('validation_failed', [{ field: '$', problem: 'too_large' }]);
    if (text !== '') {
      if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return new Refusal('validation_failed', [{ field: '$', problem: 'not_json' }]);
      try {
        raw = JSON.parse(text);
      } catch {
        return new Refusal('validation_failed', [{ field: '$', problem: 'not_json' }]);
      }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return new Refusal('validation_failed', [{ field: '$', problem: 'not_an_object' }]);
      Object.assign(input, raw);
    }
  }
  Object.assign(input, call.params); // path parameters win over a body field of the same name
  const r = entry.request.safeParse(input);
  if (!r.success) {
    return new Refusal('validation_failed', r.error.issues.map((i) => ({ field: i.path.map(String).join('.') || '$', problem: i.code })));
  }
  return { value: r.data, raw };
}

function viewer(entry: ApiPolicyEntry, caller: Caller): Meta['viewer'] {
  if (entry.access.kind === 'token') return { kind: 'token', tokenKind: entry.access.tokenKind };
  if (entry.access.kind === 'one_time') return { kind: 'token', tokenKind: 'email' };
  if (caller.kind === 'staff') return { kind: 'staff', userId: caller.userId, role: caller.role };
  return { kind: 'public' };
}

function finish(res: Response, request: Request): Response {
  applySecurityHeaders(res.headers);
  res.headers.set('cache-control', 'no-store');
  if (request.method === 'HEAD') return new Response(null, { status: res.status, headers: res.headers });
  return res;
}

/** A stream row's handler gets no transaction: any query on it is a defect (server_error). */
const NO_TX: Tx = {
  query: () => Promise.reject(new Error('a stream row runs outside any transaction')),
} as unknown as Tx;

/**
 * A stream row's answer (API-09, SPECIFICATIONS 7.3): text/event-stream, no length; no-transform and no buffering, so
 * nothing between the process and the page may compress or hold the stream (F-61). HEAD gets the headers only.
 */
function stream(body: ReadableStream<Uint8Array>, request: Request): Response {
  const res = new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  if (request.method === 'HEAD') void body.cancel().catch(() => undefined);
  applySecurityHeaders(res.headers);
  res.headers.set('cache-control', 'no-cache, no-transform');
  res.headers.set('x-accel-buffering', 'no');
  return res;
}

function json(status: number, body: unknown, request: Request, type: string): Response {
  return finish(new Response(JSON.stringify(body), { status, headers: { 'content-type': type } }), request);
}

export function problem(
  status: number,
  code: ErrorCode,
  meta: Pick<Meta, 'contract' | 'worldEpoch' | 'demoNow'>,
  request: Request,
  fields?: { field: string; problem: string }[],
  members?: Record<string, unknown>,
): Response {
  // The extension members come first, so a Problem's own members always win (contract.ts errorDetailProblems refuses a clash at mount).
  const body = { ...members, type: problemType(code), title: errorMessageKey(code), status, code, ...(fields ? { fields } : {}), meta };
  return json(status, body, request, 'application/problem+json');
}
