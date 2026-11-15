// SPDX-License-Identifier: AGPL-3.0-or-later
// SD-49's route source (SPECIFICATIONS v0.13 SD-49, SD-15, SD-22; owner ruling a923acaa, Nov 9, 2026, "Add live routing"; F-1255;
// P6-LIVE-ROUTING). Every leg a reader needs, API-21, API-104, API-116, API-135 and API-163, the planned arrival and the ETA of SD-15 and
// the van positions of SD-22, comes from {@link legFor} (or {@link legsFor}, its batch, and {@link routedDrive}, its planner form), which
// answers the first of:
//   1. the stop pair's world.van_track row, baked (loaded at setup) or live (written by step 2 earlier in this world);
//   2. 1 request to the `routing` service (osrm-routed on the Compose network, SD-3) with the bake's request options, answered within the
//      transaction's 3 s budget, stored as a row with build_id `live` by the bake's mapping ({@link trackFromOsrm}: the polyline, the
//      cumulative seconds per vertex, distance_m and SD-49's steps), under the pair's advisory lock (storeLiveTrack, @bw/db);
//   3. `approximate` (SD-22's straight line and minutes, no steps) while the service is down, slow, or has no route. Nothing is stored,
//      so the next read asks again; no failure is remembered between reads.
//
// The budget is per transaction, not per leg: the first live ask in a transaction starts it, and every later ask in the same transaction
// (the board's technicians, the sweep's days) shares what is left, so a stalled service costs a read at most 3 s however many legs it
// lacks. Legs are asked in parallel (at most {@link LIVE_ROUTE_CONCURRENCY} at once), and 2 reads of the same pair in this process share 1
// request. The live write runs in the caller's transaction: a refused write rolls it back with everything else, and a reader's GET
// commits it.
//
// The web server's calls run through {@link routedOutside} (F-1504): no call waits on the service while it holds its transaction, so a
// slow service never holds a pooled database connection. Its first pass notes the legs it lacks and answers them approximate; when it
// lacked any, that pass is rolled back, the legs are asked with no transaction open (1 budget of 3 s for the call), and the call runs
// again in a new transaction, which stores each route it got as above. A route is kept by its 2 points, not its stops' job numbers, so a
// leg that names a job the call creates takes its route in the second pass (F-1509), and a job number the call draws is kept for the
// second pass by {@link drawnOnceForCall}. A process that does not use it (the worker's sweep) asks inside its transaction, as before.
//
// Off by default: a process asks the service only after {@link configureRouting} (the web server and the worker call it at start with
// {@link ROUTING_SERVICE_URL}). Setup never does, so the seeded world and its snapshot hold baked rows only, and a unit test that
// configures nothing answers exactly as before live routing.
//
// No outside host is called (NFR-12; docs/planning/OWNER-BRIEF.md line 30): the 1 address is the Compose service's.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from '../../log/src/index.ts';
import { readTracks, storeLiveTrack, type StoredTrack } from '../../db/src/van-tracks.ts';
import type { Queryable } from '../../db/src/client.ts';
import { approximateDriveMinutes, legsAsked, legRef, trackedDriveMinutes, type DriveMinutes, type Point } from '../../domain/src/planner.ts';
import { stepsFromOsrm, type OsrmStep, type TrackStep } from './steps.ts';
import { decodePolyline, encodePolyline } from './tracks.ts';

/** The routing service on the Compose network (SD-3: service `routing`, osrm-routed's port 5000, no published port, no nginx route). */
export const ROUTING_SERVICE_URL = 'http://routing:5000';
/** SD-49 step 2: a live route is answered within 3 s of real time (build-tuned), per transaction. */
export const LIVE_ROUTE_BUDGET_MS = 3_000;
/** At most this many live requests of 1 transaction in flight at once. */
export const LIVE_ROUTE_CONCURRENCY = 8;

/** A stop of a leg: a job (its number) or the depot (null), at its point. */
export interface LegStop extends Point {
  job: number | null;
}

/** A track a leg is answered from: the stored row's parts, its steps typed. */
export interface RouteTrack {
  polyline: string;
  seconds: number[];
  distance_m: number;
  steps: TrackStep[];
}

/** The route source's answer for 1 leg. */
export interface LegAnswer {
  /** `baked` or `live`: the track below; `approximate`: SD-22's straight line, no track and no steps. */
  source: 'baked' | 'live' | 'approximate';
  track: RouteTrack | null;
  /** SD-15's drive minutes: the track's last cumulative second / 60 rounded up, else SD-22's approximate minutes. */
  minutes: number;
}

/** The routing service as the route source uses it: 1 route between 2 points, or null for no route. Never throws. */
export interface RoutingService {
  route(from: Point, to: Point): Promise<RouteTrack | null>;
}

/** The slice of an OSRM route answer (`overview=full&geometries=geojson&annotations=duration&steps=true`) the mapping reads. */
export interface OsrmRoute {
  distance: number;
  duration: number;
  geometry: { coordinates: [number, number][] };
  legs: { annotation?: { duration?: number[] }; steps: OsrmStep[] }[];
}

/**
 * 1 OSRM route as a track, exactly as the bake writes one (infra/data/maps/bake.mjs `route`): the full geometry encoded at precision 5,
 * the cumulative drive seconds per vertex from the duration annotation (spread evenly over the route's duration when the annotation does
 * not match the geometry), each rounded, the distance rounded, and SD-49's steps over the decoded polyline. Throws the step mapping's
 * error on a route it refuses (the caller treats that as no route).
 */
export function trackFromOsrm(rt: OsrmRoute): RouteTrack {
  const coords = rt.geometry.coordinates;
  const leg = rt.legs[0];
  if (!leg) throw new Error('an OSRM route with no leg');
  let cum = [0];
  for (const x of leg.annotation?.duration ?? []) cum.push((cum[cum.length - 1] as number) + x);
  if (cum.length !== coords.length) {
    const n = coords.length;
    cum = n > 1 ? coords.map((_, i) => (rt.duration * i) / (n - 1)) : [0];
  }
  const polyline = encodePolyline(coords);
  const distance_m = Math.round(rt.distance);
  const steps = stepsFromOsrm(leg.steps, decodePolyline(polyline), distance_m);
  return { polyline, seconds: cum.map((c) => Math.round(c)), distance_m, steps };
}

/** The request the bake makes (bake.mjs `route`), for the live client and the tests that compare with it. */
export const osrmRouteUrl = (base: string, a: Point, b: Point): string =>
  `${base}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson&annotations=duration&steps=true`;

/** Why a live ask failed, as the operator's line names it (F-1306): the service refused, its name did not resolve, it timed out, it answered what is not a route answer, it has no route, or the mapping refused a step. */
export type RouteFailure = 'refused' | 'unresolved' | 'timed out' | 'bad answer' | 'no route' | 'step refused';

/** The cause class of a thrown fetch: a timeout, an unresolved name (DNS), else a refused or reset connection. */
function failureOfFetch(e: unknown): RouteFailure {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timed out';
  const code = (e as { cause?: { code?: string } } | null)?.cause?.code ?? (e as { code?: string } | null)?.code;
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'unresolved' : 'refused';
}

/** At most 1 line per this much real time per process. */
export const ROUTE_SIGNAL_INTERVAL_MS = 60_000;

/**
 * The operator's signal (F-1306): 1 warn line through @bw/log at the first failure of each minute of real time, naming its cause class
 * and the failures since the last line. Never the demo clock; no point, address, phone or job number (the @bw/log allowlist admits none).
 * The user sees nothing new (SD-49 step 3).
 */
function routeSignal(log: Logger, now: () => number): (cause: RouteFailure) => void {
  let last = Number.NEGATIVE_INFINITY;
  let failures = 0;
  return (cause) => {
    failures += 1;
    const t = now();
    if (t - last < ROUTE_SIGNAL_INTERVAL_MS) return;
    last = t;
    log.warn({ status: 'live route failed', errorCode: cause, failures });
    failures = 0;
  };
}

/**
 * The live client: osrm-routed at `base`. Each request is cut at `timeoutMs`; a request already in flight for the same 2 points is
 * shared. Any failure (refused, unresolved, timed out, not JSON, no route, a step the mapping refuses) answers null, and with `log` set
 * is signalled to the operator at most once a minute ({@link routeSignal}); `now` is the real-time clock in ms (default performance.now).
 */
export function osrmRoutingService(base: string, opts: { timeoutMs?: number; fetch?: typeof fetch; log?: Logger; now?: () => number; signal?: (cause: RouteFailure) => void } = {}): RoutingService {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? LIVE_ROUTE_BUDGET_MS;
  const inflight = new Map<string, Promise<RouteTrack | null>>();
  const signal = opts.signal ?? (opts.log ? routeSignal(opts.log, opts.now ?? (() => performance.now())) : () => undefined);
  const ask = async (url: string): Promise<RouteTrack | null> => {
    let r: Response;
    try {
      r = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      signal(failureOfFetch(e));
      return null;
    }
    let d: { code?: string; routes?: OsrmRoute[] };
    try {
      // The body is read whatever the status: osrm-routed answers NoRoute and NoSegment as HTTP 400 with a JSON body (F-1337).
      d = (await r.json()) as { code?: string; routes?: OsrmRoute[] };
    } catch (e) {
      // A body read cut by the timeout is a timeout; a body that is not JSON is a bad answer.
      signal(['TimeoutError', 'AbortError'].includes((e as { name?: string }).name ?? '') ? 'timed out' : 'bad answer');
      return null;
    }
    // A route counts only from a 2xx; NoRoute and NoSegment (no road near a point) are both a leg with no route, at any status.
    const rt = r.ok && d.code === 'Ok' ? d.routes?.[0] : undefined;
    if (!rt) {
      signal(d.code === 'NoRoute' || d.code === 'NoSegment' || (r.ok && d.code === 'Ok') ? 'no route' : 'bad answer');
      return null;
    }
    try {
      return trackFromOsrm(rt);
    } catch {
      signal('step refused');
      return null;
    }
  };
  return {
    route(from, to) {
      const url = osrmRouteUrl(base, from, to);
      let p = inflight.get(url);
      if (!p) {
        p = ask(url).finally(() => inflight.delete(url));
        inflight.set(url, p);
      }
      return p;
    },
  };
}

let service: RoutingService | null = null;
let budgetMs = LIVE_ROUTE_BUDGET_MS;
/** F-1338: the process's operator signal, shared by the live client and the budget cut, so an ask cut while pending is signalled too. */
let cutSignal: ((cause: RouteFailure) => void) | null = null;

/**
 * Turn live routing on for this process: `{ url }` for osrm-routed (with the process's `log`, its failures are signalled, F-1306), `{ service }` for a test's own, or null to turn it off (stored rows
 * and the approximate line only). `budgetMs` is the per-transaction budget (default {@link LIVE_ROUTE_BUDGET_MS}). With `log`, an ask the
 * budget cuts while its request is still pending is signalled as timed out (F-1338), through the same once-a-minute line as the client's
 * own failures; a cut request that later fails on its own is then counted twice in that line's failures.
 */
export function configureRouting(opts: { url: string; budgetMs?: number; log?: Logger } | { service: RoutingService; budgetMs?: number; log?: Logger } | null): void {
  if (opts === null) {
    service = null;
    budgetMs = LIVE_ROUTE_BUDGET_MS;
    cutSignal = null;
    return;
  }
  budgetMs = opts.budgetMs ?? LIVE_ROUTE_BUDGET_MS;
  cutSignal = opts.log ? routeSignal(opts.log, () => performance.now()) : null;
  service = 'service' in opts ? opts.service : osrmRoutingService(opts.url, { timeoutMs: budgetMs, ...(cutSignal ? { signal: cutSignal } : {}) });
}

/** A transaction's live budget: its deadline, and `spent` once an ask has been cut at it. */
interface Budget {
  tx: string;
  deadline: number;
  spent: boolean;
}

/** The budget of each transaction, by its connection and its start (transaction_timestamp() differs for each transaction on a connection). */
const budgets = new WeakMap<object, Budget>();

async function budgetOf(tx: Queryable): Promise<Budget> {
  const id = (await tx.query<{ id: string }>('SELECT transaction_timestamp()::text AS id')).rows[0]?.id ?? '';
  const b = budgets.get(tx);
  if (b && b.tx === id) return b;
  const fresh = { tx: id, deadline: performance.now() + budgetMs, spent: false };
  budgets.set(tx, fresh);
  return fresh;
}

/**
 * 1 live route within the budget, else null; the shared request itself runs to its own cut. The cut spends the budget at that moment,
 * before the read returns (F-1328): Node fires the timer up to about 2 ms before performance.now() reaches the deadline, so the clock
 * alone would leave a later ask of the same transaction a sliver in which to ask a stalled service again.
 */
async function routeBy(s: RoutingService, from: Point, to: Point, b: Budget): Promise<RouteTrack | null> {
  const left = b.deadline - performance.now();
  if (b.spent || left <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      b.spent = true;
      // F-1338: the request may still answer later, and nothing would then say this leg went approximate.
      cutSignal?.('timed out');
      resolve(null);
    }, left);
  });
  try {
    return await Promise.race([s.route(from, to), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 1 pass of a {@link routedOutside} call. The first pass notes each leg it lacks (`noting`); the second answers from the routes asked
 * between the passes (`routed`). Neither pass asks the service.
 */
interface OutsidePass {
  noting: boolean;
  /** The lacked legs by {@link askKey}, and the same legs grouped by the legsFor call that first lacked them, in call order. */
  wanted: Map<string, { from: LegStop; to: LegStop }>;
  groups: { key: string; leg: { from: LegStop; to: LegStop } }[][];
  routed: Map<string, RouteTrack | null>;
  /** What the first pass drew through {@link drawnOnceForCall}, by name, in draw order; the second pass takes them in the same order. */
  drawn: Map<string, unknown[]>;
}

const outsidePass = new AsyncLocalStorage<OutsidePass>();

/**
 * A lacked leg by its 2 points only (F-1509): a route depends on nothing else. A stop's job number can differ between the passes (a job the
 * call creates draws its number from a sequence the rollback does not return); a stop that moves has new points, so its route is not used.
 * The second pass stores a route under its own stop pair, and storeLiveTrack still refuses a point that is not the routed one.
 */
const askKey = (l: { from: LegStop; to: LegStop }): string => `${l.from.lon},${l.from.lat}|${l.to.lon},${l.to.lat}`;

/**
 * F-1509: a value the call draws outside its transaction's rollback, such as a new job's number from its identity sequence, drawn once for
 * both passes of a {@link routedOutside} call. `draw(prior)` answers the value to use: in the first pass, outside such a call, or past
 * what the first pass drew, `prior` is undefined; in the second pass it is what the first pass's draw of this name answered, in draw order,
 * for draw to reuse when it still can. The first pass records each value draw answers.
 */
export async function drawnOnceForCall<T>(name: string, draw: (prior: T | undefined) => Promise<T>): Promise<T> {
  const pass = outsidePass.getStore();
  if (!pass) return draw(undefined);
  const drawn = pass.drawn.get(name) ?? [];
  pass.drawn.set(name, drawn);
  if (!pass.noting) return draw(drawn.shift() as T | undefined);
  const value = await draw(undefined);
  drawn.push(value);
  return value;
}

/** Thrown inside the first pass's transaction to roll it back when it lacked legs: its answer used approximate legs about to be routed. */
class LegsLacked extends Error {}

/**
 * F-1504: run 1 call (`fn` in `transaction`, which commits when fn returns and rolls back when it throws) so that it never waits on the
 * routing service while its transaction, and so its pooled connection, is open. With routing on, fn first runs with every leg it lacks
 * noted and answered approximate. If it lacked none, that outcome stands: 1 transaction, as before. Otherwise its transaction is rolled
 * back whatever it answered (a refusal can hang on a drive time), the lacked legs are asked with no transaction open, as the call would
 * have asked them inside it: the legs of each legsFor call together (at most {@link LIVE_ROUTE_CONCURRENCY} at once), the calls one after
 * another, within 1 budget for the call (SD-49's 3 s); asking a whole board's legs at once instead drove osrm-routed at its 320 MiB cap
 * into rereading its files (P7-LOAD-CAUSE run f320s). Then fn runs again in a new transaction: it stores
 * each route it got as a live row in that transaction (step 2), its legs matched to the routes by their points ({@link askKey}), and
 * answers a leg still lacking approximate without asking (step 3). fn must be safe to run twice: its writes are the transaction's own,
 * and a value it draws outside its transaction (a sequence) is drawn through {@link drawnOnceForCall}. With routing off it is
 * `transaction(fn)`.
 */
export async function routedOutside<T>(transaction: (fn: (tx: Queryable) => Promise<T>) => Promise<T>, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const s = service;
  if (!s) return transaction(fn);
  const pass: OutsidePass = { noting: true, wanted: new Map(), groups: [], routed: new Map(), drawn: new Map() };
  let first: { value: T } | { error: unknown };
  try {
    first = {
      value: await outsidePass.run(pass, () => transaction(async (tx) => {
        const out = await fn(tx);
        if (pass.wanted.size > 0) throw new LegsLacked();
        return out;
      })),
    };
  } catch (error) {
    first = { error };
  }
  if (pass.wanted.size === 0) {
    if ('value' in first) return first.value;
    throw first.error;
  }
  const budget: Budget = { tx: '', deadline: performance.now() + budgetMs, spent: false };
  for (const group of pass.groups) {
    const answers = await askEach(s, group.map((g) => g.leg), budget);
    group.forEach((g, i) => pass.routed.set(g.key, answers[i] ?? null));
  }
  pass.noting = false;
  return outsidePass.run(pass, () => transaction(fn));
}

/** Each leg asked within the budget, at most {@link LIVE_ROUTE_CONCURRENCY} at once; the answers in the order given. */
async function askEach(s: RoutingService, legs: readonly { from: LegStop; to: LegStop }[], budget: Budget): Promise<(RouteTrack | null)[]> {
  const out: (RouteTrack | null)[] = new Array(legs.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < legs.length) {
      const i = next++;
      const l = legs[i]!;
      out[i] = await routeBy(s, l.from, l.to, budget);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIVE_ROUTE_CONCURRENCY, legs.length) }, worker));
  return out;
}

const refOf = (job: number | null): string => (job === null ? 'depot' : String(job));
const minutesOf = (t: Pick<RouteTrack, 'seconds'>): number => Math.ceil((t.seconds[t.seconds.length - 1] ?? 0) / 60);
const asTrack = (t: StoredTrack): RouteTrack => ({ polyline: t.polyline, seconds: t.seconds, distance_m: t.distance_m, steps: t.steps as TrackStep[] });

/**
 * The route source's answer for each leg (SD-49), in the order given: 1 read of the stored rows, then, with routing configured, the
 * missing pairs routed in parallel within the transaction's budget and each stored as a live row (storeLiveTrack). A routed leg that
 * another transaction is storing, or whose stop has just moved, is answered from the route but not stored by this read.
 */
export async function legsFor(tx: Queryable, branch: string, legs: readonly { from: LegStop; to: LegStop }[]): Promise<LegAnswer[]> {
  const key = (l: { from: LegStop; to: LegStop }) => `${refOf(l.from.job)}|${refOf(l.to.job)}`;
  const unique = new Map<string, { from: LegStop; to: LegStop }>();
  for (const l of legs) if (!unique.has(key(l))) unique.set(key(l), l);
  const stored = await readTracks(tx, branch, [...unique.values()].map((l) => ({ from: refOf(l.from.job), to: refOf(l.to.job) })));
  const answers = new Map<string, LegAnswer>();
  for (const [k, t] of stored) answers.set(k, { source: t.build_id === 'live' ? 'live' : 'baked', track: asTrack(t), minutes: minutesOf(t) });
  const missing = [...unique.entries()].filter(([k]) => !answers.has(k));
  const s = service;
  if (missing.length > 0 && s) {
    const pass = outsidePass.getStore();
    let routed: (RouteTrack | null)[];
    if (pass) {
      // F-1504 (routedOutside): no ask inside the transaction. The first pass notes what it lacks, as 1 group per call; the second takes
      // the routes asked between the passes.
      const group: OutsidePass['groups'][number] = [];
      routed = missing.map(([, l]) => {
        const key = askKey(l);
        if (pass.noting && !pass.wanted.has(key)) {
          pass.wanted.set(key, l);
          group.push({ key, leg: l });
        }
        return pass.routed.get(key) ?? null;
      });
      if (group.length > 0) pass.groups.push(group);
    } else {
      routed = await askEach(s, missing.map(([, l]) => l), await budgetOf(tx));
    }
    // 1 client, 1 statement at a time: the writes run in order, after every request has answered or been cut.
    for (const [i, [k, l]] of missing.entries()) {
      const r = routed[i];
      if (!r) continue;
      const out = await storeLiveTrack(tx, branch, { from: refOf(l.from.job), to: refOf(l.to.job), fromPoint: l.from, toPoint: l.to }, r);
      const t = out.kind === 'stored' || out.kind === 'present' ? asTrack(out.track) : r;
      const source = out.kind === 'present' && out.track.build_id !== 'live' ? 'baked' : 'live';
      answers.set(k, { source, track: t, minutes: minutesOf(t) });
    }
  }
  return legs.map((l) => answers.get(key(l)) ?? { source: 'approximate', track: null, minutes: approximateDriveMinutes(l.from, l.to) });
}

/** SD-49 for 1 leg: the stored row, else a live route stored as a row, else approximate. */
export async function legFor(tx: Queryable, branch: string, from: LegStop, to: LegStop): Promise<LegAnswer> {
  return (await legsFor(tx, branch, [{ from, to }]))[0] as LegAnswer;
}

/**
 * SD-15's drive function from the route source, for a planner run (planDay or etaDay): `run` is called once to learn the legs it asks
 * for (legsAsked), those legs are answered by {@link legsFor}, and the function returned gives each its track's minutes, else SD-22's.
 * The caller then runs the planner with it: `const drive = await routedDrive(tx, b, (d) => planDay({ ...day, drive: d }))`.
 */
export async function routedDrive(tx: Queryable, branch: string, run: (drive: DriveMinutes) => unknown): Promise<DriveMinutes> {
  const asks = legsAsked(run);
  const answers = await legsFor(tx, branch, asks.map((a) => ({ from: { job: a.fromJob, ...a.from }, to: { job: a.toJob, ...a.to } })));
  const seconds = new Map<string, number>();
  answers.forEach((a, i) => {
    const ask = asks[i]!;
    if (a.track) seconds.set(legRef(ask.fromJob, ask.toJob), a.track.seconds[a.track.seconds.length - 1] ?? 0);
  });
  return trackedDriveMinutes(seconds);
}
