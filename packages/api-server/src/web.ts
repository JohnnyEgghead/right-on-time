// SPDX-License-Identifier: AGPL-3.0-or-later
// The production kernel of the web process: the real policy table and handlers over the real database, sessions and
// clock. `router.handle` is a Fetch-API Request to Response function: the plain node:http server of apps/web/src/server.ts
// calls it through node.ts for the API base and the root routes of the policy table (no Next.js route file serves them).
// `pages` is the page gate; `pageVerdict` asks it for 1 page request,
// with the caller and the access-code state resolved from the request's cookies as the API routes resolve them.
import type { Settings } from '@bw/config';
import { createClient, createPool, hashPassword, inTransaction, SERVICE_TIMEOUTS, verifyPassword, type Queryable } from '@bw/db';
import { causeCodeOf, logErrorEvents, type Logger } from '@bw/log';
import { DbClock, Temporal, toWire } from '@bw/time';
import { routedOutside } from '../../maps/src/route-source.ts';
import { PgNotifyBus } from './events/bus.ts';
import { handlers, tokenChecks } from './handlers/index.ts';
import { liveMapLinkEnded } from './handlers/live-map.ts';
import { generatedAccessKey } from './kernel/access-code.ts';
import { DEFAULT_ZONE, mount, problem, type Router } from './kernel/mount.ts';
import { pageGate, pageRequestVerdict, type PageGate, type PageVerdict } from './kernel/pages.ts';
import { compilePath, specificity } from './kernel/route.ts';
import { SqlSessionStore } from './kernel/sessions.ts';
import { policyTable } from './policy.ts';

export interface WebKernel {
  router: Router;
  pages: PageGate;
  /** The page gate's verdict for 1 page request: its path and its headers (the session and access cookies). */
  pageVerdict(path: string, headers: Headers): Promise<PageVerdict>;
  close(): Promise<void>;
}

export interface WebKernelOptions {
  settings: Readonly<Settings>;
  /** The database password of this process (from DATABASE_PASSWORD_FILE), when the URL carries none. */
  databasePassword?: string | undefined;
  log: Logger;
  /** F-1872: a test seam. The access code sync's run and waits, so a test drives the kernel's own sync to a recovery (never set in production). */
  syncSeam?: { run: () => Promise<void>; delaysMs: readonly number[]; recoverEveryMs: number };
}

/** The waits between the tries of the start-up access code sync (5 tries in all). */
const SYNC_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000];

/** Run `fn`; on a throw wait each delay in turn and try again; the last throw is rethrown. */
export async function syncWithRetry(fn: () => Promise<void>, delaysMs: readonly number[]): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const wait = delaysMs[i];
      if (wait === undefined) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** The wait between the background tries once every start-up try has failed (F-316). */
const RECOVER_EVERY_MS = 10_000;

export interface SyncState {
  /** Settles when the start-up tries are over (done or given up); a call waits on it. */
  readonly ready: Promise<void>;
  /** True from the last failed start-up try until a try answers (only with the access code on). */
  failed(): boolean;
  /** The last failed try's cause code (@bw/log causeCodeOf, never the message); undefined before any failure (F-1848). */
  cause(): string | undefined;
  stop(): void;
}

export interface SyncOptions {
  run: (() => Promise<void>) | null;
  codeOn: boolean;
  delaysMs: readonly number[];
  recoverEveryMs: number;
  /** Once, when every start-up try has failed: the last try's error (F-1848: the caller logs its cause code). */
  onFail: (error: unknown) => void;
  /** Once, when a background try answers after onFail (F-1848: the recovery line). */
  onRecover?: () => void;
}

/** Run the start-up sync with its tries; after the last failure log once, flag the state, and keep trying in the background. */
export function startSync(o: SyncOptions): SyncState {
  let failed = false;
  let stopped = false;
  let cause: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const { run } = o;
  const recover = (): void => {
    if (run === null || stopped) return;
    timer = setTimeout(() => {
      run().then(
        () => { failed = false; o.onRecover?.(); },
        (e: unknown) => { cause = causeCodeOf(e); recover(); },
      );
    }, o.recoverEveryMs);
    timer.unref();
  };
  const ready = run
    ? syncWithRetry(run, o.delaysMs).then(
        () => undefined,
        (e: unknown) => {
          cause = causeCodeOf(e);
          o.onFail(e);
          failed = o.codeOn;
          recover();
        },
      )
    : Promise.resolve();
  return { ready, failed: () => failed, cause: () => cause, stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

/**
 * The router with the failed-sync answer in front: 503 as a kernel Problem (the 11.5 headers and no-store come from `problem`).
 * F-1848: each guarded 503 is logged at error level as the kernel logs a call (contract, route, status), with the sync's cause code.
 */
export function syncGuard(router: Router, sync: SyncState, log: Logger): Router {
  // F-1690: compiled and ordered once (the fewest parameters first; the sort is stable, so ties keep route order), and the constant built once.
  const bySpecificity = router.routes
    .map((r) => ({ route: r, path: compilePath(r.path), specificity: specificity(r.path) }))
    .sort((a, b) => a.specificity - b.specificity);
  const epoch = toWire(Temporal.Instant.fromEpochMilliseconds(0), DEFAULT_ZONE);
  return {
    routes: router.routes,
    owns: (p, method) => router.owns(p, method),
    handle: async (request, info) => {
      await sync.ready;
      const pathname = new URL(request.url).pathname;
      if (sync.failed() && router.owns(pathname, request.method)) {
        // F-1655: the label is the route the router would match (method and path pattern, the fewest parameters first), not a literal path.
        const method = request.method === 'HEAD' ? 'GET' : request.method;
        const matched = bySpecificity.find((c) => c.route.method === method && c.path.match(pathname) !== null)?.route;
        const contract = matched?.contract ?? 'API-171';
        // Every row of the policy table is an API-<n> contract (the kernel logs entry.contract the same way).
        log.error({ contract: contract as `API-${number}`, ...(matched ? { route: matched.path } : {}), status: 503, errorCode: sync.cause() ?? 'server_error' });
        return problem(503, 'server_error', { contract, worldEpoch: 0, demoNow: epoch }, request);
      }
      return router.handle(request, info);
    },
  };
}

export function createWebKernel(opts: WebKernelOptions): WebKernel {
  const { settings, log } = opts;
  if (!settings.DATABASE_URL) throw new Error('invalid setting DATABASE_URL: the web process needs a database');
  // The password goes into the in-memory URL: pg lets the URL's (absent) password override a separate `password` field.
  const url = new URL(settings.DATABASE_URL);
  if (opts.databasePassword !== undefined) url.password = encodeURIComponent(opts.databasePassword);
  const pool = createPool({
    connectionString: url.toString(),
    application_name: 'bw-web',
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // F-2037 K-10.8: a call that waits on a held lock fails with 55P03 within SERVICE_LOCK_TIMEOUT_MS (server_error, 503 for
    // API-171) instead of holding 1 of these 10 connections without end.
    ...SERVICE_TIMEOUTS,
  });
  // F-2046: an idle connection the server ended logs its cause code (logErrorEvents), not a fixed word.
  logErrorEvents(pool, log);
  const clock = new DbClock(pool);
  // F-218: with the code on, the key and the code are the owner's secrets (a key made at each start would end every visitor's
  // code at each restart or deploy); with it off, no cookie is ever checked and a key made at start is enough.
  if (settings.ACCESS_CODE_ON && !settings.ACCESS_COOKIE_KEY) throw new Error('invalid setting ACCESS_COOKIE_KEY: required when ACCESS_CODE_ON=on');
  if (settings.ACCESS_CODE_ON && !settings.ACCESS_CODE) throw new Error('invalid setting ACCESS_CODE: required when ACCESS_CODE_ON=on');
  // F-286: with demo mode on, API-15 lists the sample people from the seed; with no seed it would answer a confident empty list.
  if (settings.DEMO_MODE && !settings.SAMPLE_PASSWORD_SEED) throw new Error('invalid setting SAMPLE_PASSWORD_SEED: required when DEMO_MODE=on');
  const accessKey = settings.ACCESS_COOKIE_KEY ?? generatedAccessKey();
  // C10 (FR-AUTH-5): the demo-mode marker line, written at start with DEMO_MODE=on and never otherwise.
  if (settings.DEMO_MODE) log.info({ status: 'demo mode on' });
  const sessions = new SqlSessionStore(pool);
  // SD-13: 1 LISTEN connection for this process, opened by the first event stream (API-09); it shares the pool's login.
  // F-347: TCP keepAlive on it, and the bus's own liveness query, so a silently dead connection is noticed.
  const bus = new PgNotifyBus({
    clock,
    newClient: () => createClient({ connectionString: url.toString(), application_name: 'bw-web-listen', connectionTimeoutMillis: 5_000, keepAlive: true }),
    onError: (e) => log.error({ status: 'unhandled error', errorCode: causeCodeOf(e) }),
  });
  const router = mount(policyTable, handlers, {
    // F-1504: no call waits on the routing service while it holds a pooled connection (route-source.ts routedOutside).
    db: { transaction: (fn) => routedOutside((f) => inTransaction(pool, f), fn) },
    sessions,
    clock,
    log,
    settings,
    accessKey,
    events: bus,
    // P4-ACCOUNTS: the email links (SCR-EML-01, API-166) and the password links (SCR-EML-02, API-167, API-168).
    tokens: tokenChecks,
  });
  const pages = pageGate(policyTable);
  // The access code is hashed into system.access_code at start (SPECIFICATIONS 11.1); API-01 checks against that row. F-286: a
  // failed sync is retried (SYNC_DELAYS_MS). F-316: if every try fails the process is not healthy: with the code on, every API call
  // (API-171 /healthz among them) answers 503 as a Problem and the log names the cause ('access code sync failed'); the sync then
  // keeps trying in the background (RECOVER_EVERY_MS), so a database that answers late (a host reboot) heals without a restart,
  // which an exited-only restart policy would never give a process that stays up.
  const sync = startSync({
    run: opts.syncSeam?.run ?? (settings.ACCESS_CODE ? () => syncAccessCode(pool, settings.ACCESS_CODE as string, clock) : null),
    codeOn: settings.ACCESS_CODE_ON,
    delaysMs: opts.syncSeam?.delaysMs ?? SYNC_DELAYS_MS,
    recoverEveryMs: opts.syncSeam?.recoverEveryMs ?? RECOVER_EVERY_MS,
    onFail: (e) => log.error({ status: 'access code sync failed', errorCode: causeCodeOf(e) }),
    onRecover: () => log.info({ status: 'access code sync recovered' }),
  });
  const guarded = syncGuard(router, sync, log);
  return {
    router: guarded,
    pages,
    pageVerdict: pageRequestVerdict(pages, {
      sessions, clock, codeOn: settings.ACCESS_CODE_ON, accessKey,
      // FR-TEXT-4: the live map link page answers 410 once its link ended, by the same rule as API-116 (handlers/live-map.ts).
      linkEnded: async (screen, token) => screen === 'SCR-CUS-04' && inTransaction(pool, async (tx) => liveMapLinkEnded(tx, token, (await clock.demoNow()).epochMilliseconds)),
    }),
    close: async () => {
      sync.stop();
      await bus.close();
      await pool.end();
    },
  };
}

/**
 * Store the access code's scrypt hash as the 1 active system.access_code row. A row that already verifies is left alone
 * (a restart rewrites nothing and the web processes agree); a changed code replaces it. The row is the whole table.
 */
export async function syncAccessCode(pool: Parameters<typeof inTransaction>[0], code: string, clock: Pick<DbClock, 'realNow'>): Promise<void> {
  const current = (await pool.query<{ code_hash: string }>('SELECT code_hash FROM system.access_code WHERE active LIMIT 1')).rows[0];
  if (current && (await verifyPassword(code, current.code_hash))) return;
  const hash = await hashPassword(code);
  // J-23: the replace is 1 transaction, so a failed INSERT leaves the old row (and its code) in place, never an empty table.
  await inTransaction(pool, async (tx: Queryable) => {
    await tx.query('DELETE FROM system.access_code');
    await tx.query('INSERT INTO system.access_code (code_hash, active, created_real) VALUES ($1, true, $2::timestamptz)', [hash, clock.realNow('record_stamp').toString()]);
  });
}
