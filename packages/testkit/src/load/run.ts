// SPDX-License-Identifier: AGPL-3.0-or-later
// 1 run of the load day (P4-LOAD, D16). Built-in fetch and the pages' own SSE client (@bw/api connectEventStream): 14 dispatcher
// boards and 85 technician streams against the stack through its proxy. A board here does what apps/web/src/board/BoardScreen.tsx
// does: on a board event it waits 50 ms and re-reads API-20, 1 read at a time (a read asked for during a read runs once after
// it), then posts each event's seq to API-172; with the map shown it reads API-21 every 10 s. The technician app's reads do not
// exist until phase 6, so a technician session is its stream and its API-102 sends.
import { randomUUID } from 'node:crypto';
import { loadavg } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { connectEventStream, type EventStreamHandle, type StreamEvent } from '@bw/api';
import type { ItemKind, LoadWorld, Step } from './plan.ts';
import { PageProber, type PageProbeOptions, type PageRun } from './pages.ts';
import { endStateOf, spread, type EndState, type RunCounts, type Spread } from './stats.ts';
import { boardVersions, DelayTracker } from './tracker.ts';

/** The events a board re-reads on (BoardScreen.tsx BOARD_EVENTS; a unit test holds the 2 lists equal). */
export const BOARD_EVENTS: ReadonlySet<string> = new Set(['job.changed', 'board.refresh', 'clock.changed', 'world.reset', 'settings.changed', 'block.changed']);
/** BoardScreen.tsx: the wait from an event to its re-read, and the map panel's read interval. */
export const REREAD_WAIT_MS = 50;
export const VAN_READ_MS = 10_000;
/** A dispatcher's refusals the day allows for: the target technician has no room or a block in the way. */
/** A failed send is tried again by the phone; the script gives up after this many tries, 1 s apart. */
const ITEM_TRIES = 5;
const ITEM_RETRY_WAIT_MS = 1_000;
const ALLOWED_REFUSALS = new Set(['technician_no_room', 'time_overlap', 'version_conflict', 'rule_refused']);

export interface RunOptions {
  origin: string;
  world: LoadWorld;
  timeline: readonly Step[];
  /** Read API-21 every 10 s on every board (F-817 compares with and without). */
  vans: boolean;
  /** How long after the last write a board may still show a change before it counts as lost. */
  settleMs: number;
  /** P7-LOAD (NFR-02): office pages probed in a browser on the office profile through the run; null: none. */
  pages?: Omit<PageProbeOptions, 'log'> | null;
  log: (line: string) => void;
}

/**
 * F-1495: a failed read keeps its cause, as writes keep failedBy and pages errorsBy: errorsBy counts each cause (the status, or the
 * thrown error's name and message), and errorsAt holds the first {@link READ_ERRORS_KEPT} with their time, seconds after the run's
 * start (the summary's startedAt), so a cause lines up with the server's samplers.
 */
export interface ReadStats { count: number; errors: number; errorsBy: Record<string, number>; errorsAt: { atS: number; why: string }[]; bytes: number; ms: Spread }
export const READ_ERRORS_KEPT = 200;

/**
 * F-1498: the route member of each API-21 answer, over the run: a van on the way with a track (stored, baked or live, SD-49) or
 * with none (the map's Approximate route). Counted per read, so a leg read 10 times counts 10 times.
 */
export interface VanRoutes { tracked: number; approximate: number }

/** The route members of 1 API-21 answer's body. */
export function vanRoutesOf(body: string): VanRoutes {
  const vans = (JSON.parse(body) as { data?: { vans?: { route?: { track?: unknown } | null }[] } }).data?.vans ?? [];
  const out = { tracked: 0, approximate: 0 };
  for (const v of vans) {
    if (!v.route) continue;
    if (v.route.track) out.tracked += 1;
    else out.approximate += 1;
  }
  return out;
}

export interface RunResult extends RunCounts {
  startedAt: string;
  endedAt: string;
  loadAvg1Start: number;
  loadAvg1End: number;
  clientLoopDelayMs: { p50: number; p99: number; max: number };
  worldEpoch: number;
  streams: { opened: number; reconnects: number; closed: number; events: number };
  board: ReadStats;
  vans: ReadStats;
  vanRoutes: VanRoutes;
  writes: { itemMs: Spread; assignMs: Spread; itemRetries: number; refusedBy: Record<string, number>; failedBy: Record<string, number> };
  durationMs: number;
  /** P7-LOAD (NFR-03): failed map reads, failed page loads, and each job's version on the board after the run against the script's. */
  vanReadErrors: number;
  pageErrors: number;
  pages: PageRun | null;
  endState: EndState;
  endStateErrors: number;
}

const wireOf = (ms: number): string => new Date(ms).toISOString().replace('Z', '+00:00[UTC]');
const msOf = (wire: string): number => Date.parse(wire.replace(/\[.*\]$/, ''));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Reads {
  readonly ms: number[] = [];
  errors = 0;
  readonly errorsBy: Record<string, number> = {};
  readonly errorsAt: { atS: number; why: string }[] = [];
  bytes = 0;
  /** zeroMs: the performance.now() of the run's start, so errorsAt reads in seconds after the summary's startedAt. */
  readonly zeroMs: number;
  constructor(zeroMs: number) {
    this.zeroMs = zeroMs;
  }
  fail(why: string, at: number = performance.now()): void {
    this.errors += 1;
    this.errorsBy[why] = (this.errorsBy[why] ?? 0) + 1;
    if (this.errorsAt.length < READ_ERRORS_KEPT) this.errorsAt.push({ atS: Math.round((at - this.zeroMs) / 100) / 10, why });
  }
  stats(): ReadStats {
    return { count: this.ms.length, errors: this.errors, errorsBy: this.errorsBy, errorsAt: this.errorsAt, bytes: this.bytes, ms: spread(this.ms) };
  }
}

/** A failed fetch's cause, short: its name and the first line of its message (and the cause's code, as undici puts it). */
export const causeOf = (e: unknown): string => {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  return `${err.name ?? 'Error'}${err.cause?.code ? ` ${err.cause.code}` : ''}: ${(err.message ?? '').split('\n')[0]!.slice(0, 60)}`;
};

/** A staff session's calls. Writes carry the origin the stack was told is its own (SD-8's Origin check). */
function client(origin: string, token: string) {
  const cookie = `bw_session=${token}`;
  return {
    get: (path: string) => fetch(`${origin}/api/v1${path}`, { headers: { cookie, 'accept-encoding': 'gzip, deflate, br' } }),
    send: (method: string, path: string, body?: unknown) => fetch(`${origin}/api/v1${path}`, {
      method,
      headers: { cookie, origin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  };
}

/** Reset the world (API-14, as the manager) and wait for the reset's clock to run. */
export async function resetWorld(origin: string, managerToken: string): Promise<{ epoch: number }> {
  const manager = client(origin, managerToken);
  const r = await manager.send('POST', '/clock/resets', {});
  const text = await r.text();
  if (r.status !== 202) throw new Error(`the reset answered ${r.status}: ${text.slice(0, 200)}`);
  const deadline = performance.now() + 60_000;
  for (;;) {
    const c = await manager.get('/clock');
    const body = await c.json() as { data?: { paused: boolean; worldEpoch: number } };
    if (c.status === 200 && body.data && !body.data.paused) return { epoch: body.data.worldEpoch };
    if (performance.now() > deadline) throw new Error('the clock did not run again within 60 s of the reset');
    await sleep(250);
  }
}

// The /clock answer's field for the server's real time: a field of the response, not a clock read here, so it is named by key
// and G-CI4's realNow scan (F-179) does not take it for a reading outside the seam.
const REAL_NOW_FIELD = 'realNow';

export async function readClock(origin: string, token: string): Promise<{ demoMs: number; realMs: number; worldEpoch: number; localMs: number }> {
  const r = await client(origin, token).get('/clock');
  const body = await r.json() as { data: { demoNow: string; worldEpoch: number } & Record<typeof REAL_NOW_FIELD, string> };
  return { demoMs: msOf(body.data.demoNow), realMs: msOf(body.data[REAL_NOW_FIELD]), worldEpoch: body.data.worldEpoch, localMs: performance.now() };
}

/** 1 open board. */
class Board {
  readonly stream: EventStreamHandle;
  #reading = false;
  #again = false;
  #timer: NodeJS.Timeout | null = null;
  #pending: number[] = [];
  #stopped = false;
  readonly id: string;
  readonly branch: string;
  readonly calls: ReturnType<typeof client>;
  readonly #tracker: DelayTracker;
  readonly #reads: Reads;

  constructor(
    who: { id: string; branch: string; token: string },
    origin: string,
    tracker: DelayTracker,
    reads: Reads,
    streamEvents: { onEvent: (e: StreamEvent) => void; onState: (s: string) => void },
  ) {
    this.id = who.id;
    this.branch = who.branch;
    this.calls = client(origin, who.token);
    this.#tracker = tracker;
    this.#reads = reads;
    this.stream = connectEventStream({
      url: `${origin}/api/v1/events?branch=${who.branch}`,
      // F-61: a browser's Accept-Encoding, so a compressing proxy would hold the stream here as it would in a page.
      headers: { cookie: `bw_session=${who.token}`, 'accept-encoding': 'gzip, deflate, br' },
      onEvent: (e) => {
        streamEvents.onEvent(e);
        if (!BOARD_EVENTS.has(e.name)) return;
        this.#pending.push(e.seq);
        this.#timer ??= setTimeout(() => void this.#flush(), REREAD_WAIT_MS);
      },
      onReconnect: () => void this.read(),
      onState: streamEvents.onState,
    });
  }

  async #flush(): Promise<void> {
    this.#timer = null;
    const seqs = this.#pending;
    this.#pending = [];
    await this.read();
    if (this.#stopped) return;
    await Promise.allSettled(seqs.filter((s) => s > 0).map(async (seq) => {
      const r = await this.calls.send('POST', '/board-delay-samples', { seq });
      await r.text();
    }));
  }

  /** The page's read: 1 at a time; a read asked for during a read runs once after it. */
  async read(): Promise<void> {
    if (this.#reading) {
      this.#again = true;
      return;
    }
    this.#reading = true;
    try {
      do {
        this.#again = false;
        if (this.#stopped) return;
        const started = performance.now();
        try {
          const r = await this.calls.get(`/board?branch=${this.branch}&date=today`);
          const text = await r.text();
          const at = performance.now();
          if (r.status !== 200) {
            this.#reads.fail(`status ${r.status}`, at);
            continue;
          }
          this.#reads.ms.push(at - started);
          this.#reads.bytes += text.length;
          this.#tracker.seen(this.id, boardVersions((JSON.parse(text) as { data: Parameters<typeof boardVersions>[0] }).data), at);
        } catch (e) {
          if (!this.#stopped) this.#reads.fail(causeOf(e));
        }
      } while (this.#again);
    } finally {
      this.#reading = false;
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.stream.close();
  }
}

export async function runLoad(o: RunOptions): Promise<RunResult> {
  const { origin, world } = o;
  const loadAvg1Start = loadavg()[0] as number;
  const { epoch } = await resetWorld(origin, world.managerToken);
  const clock = await readClock(origin, world.managerToken);
  const startedAt = new Date(clock.realMs).toISOString();
  const demoAt = (now: number): number => clock.demoMs + (now - clock.localMs);
  const realAt = (now: number): number => clock.realMs + (now - clock.localMs);

  const boardsByBranch = new Map<string, string[]>();
  for (const d of world.dispatchers) boardsByBranch.set(d.branch, [...(boardsByBranch.get(d.branch) ?? []), d.id]);
  const tracker = new DelayTracker(boardsByBranch);
  const boardReads = new Reads(clock.localMs);
  const vanReads = new Reads(clock.localMs);
  const vanRoutes: VanRoutes = { tracked: 0, approximate: 0 };
  const streams = { opened: 0, reconnects: 0, closed: 0, events: 0 };
  const open = new Set<string>();
  const stateOf = (id: string) => (s: string): void => {
    if (s === 'live' && !open.has(id)) {
      open.add(id);
      streams.opened += 1;
    } else if (s === 'reconnecting') streams.reconnects += 1;
    else if (s === 'closed') streams.closed += 1;
  };
  const onEvent = (): void => {
    streams.events += 1;
  };

  const boards = world.dispatchers.map((d) => new Board(d, origin, tracker, boardReads, { onEvent, onState: stateOf(d.id) }));
  const techStreams = world.technicians.map((t) => connectEventStream({
    url: `${origin}/api/v1/events?branch=${t.branch}`,
    headers: { cookie: `bw_session=${t.token}`, 'accept-encoding': 'gzip, deflate, br' },
    onEvent,
    onState: stateOf(t.id),
  }));
  const want = world.dispatchers.length + world.technicians.length;
  const openBy = performance.now() + 60_000;
  while (open.size < want) {
    if (performance.now() > openBy) throw new Error(`only ${open.size} of ${want} streams opened within 60 s`);
    await sleep(100);
  }
  await Promise.all(boards.map((b) => b.read()));
  o.log(`run ready: ${open.size} streams open, epoch ${epoch}`);

  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const prober = o.pages ? new PageProber({ ...o.pages, log: o.log }) : null;
  await prober?.start();

  // The map panel's read on each board, each board's 10 s starting at its own moment.
  const vanTimers: NodeJS.Timeout[] = [];
  const stopVans: (() => void)[] = [];
  if (o.vans) {
    for (const [i, b] of boards.entries()) {
      const readVans = async (): Promise<void> => {
        const started = performance.now();
        try {
          const r = await b.calls.get(`/vans?branch=${b.branch}`);
          const text = await r.text();
          if (r.status !== 200) {
            vanReads.fail(`status ${r.status}`);
            return;
          }
          vanReads.ms.push(performance.now() - started);
          vanReads.bytes += text.length;
          const routes = vanRoutesOf(text);
          vanRoutes.tracked += routes.tracked;
          vanRoutes.approximate += routes.approximate;
        } catch (e) {
          vanReads.fail(causeOf(e));
        }
      };
      const first = setTimeout(() => {
        void readVans();
        const every = setInterval(() => void readVans(), VAN_READ_MS);
        stopVans.push(() => clearInterval(every));
      }, (i * VAN_READ_MS) / boards.length);
      vanTimers.push(first);
    }
  }

  // The day. Each job's steps run in order, whatever the network does: a step starts at its time or when the step before it ends.
  const jobs = new Map(world.jobs.map((j) => [j.jobNumber, { ...j, tail: Promise.resolve() as Promise<unknown> }]));
  const tokens = new Map(world.technicians.map((t) => [t.id, t.token]));
  const counts = { applied: 0, refused: 0, failed: 0 };
  const refusedBy: Record<string, number> = {};
  const failedBy: Record<string, number> = {};
  const itemMs: number[] = [];
  let itemRetries = 0;
  const assignMs: number[] = [];
  const failed = (why: string): void => {
    counts.failed += 1;
    failedBy[why] = (failedBy[why] ?? 0) + 1;
  };
  const refused = (why: string): void => {
    counts.refused += 1;
    refusedBy[why] = (refusedBy[why] ?? 0) + 1;
  };
  const dispatcherOf = new Map<string, ReturnType<typeof client>>();
  for (const d of world.dispatchers) if (!dispatcherOf.has(d.branch)) dispatcherOf.set(d.branch, client(origin, d.token));

  const sendItem = async (job: NonNullable<ReturnType<typeof jobs.get>>, item: ItemKind): Promise<void> => {
    const calls = client(origin, tokens.get(job.technicianId) as string);
    const sentAt = performance.now();
    const change = tracker.expect(job.branch, job.jobNumber, job.version + 1, sentAt);
    const body = {
      items: [{
        key: randomUUID(), kind: item, jobNumber: job.jobNumber, baseVersion: job.version, worldEpoch: clock.worldEpoch,
        deviceTime: wireOf(realAt(sentAt)), offsetSavedReal: wireOf(clock.realMs), sinceSaveMs: Math.round(sentAt - clock.localMs), demoTime: wireOf(demoAt(sentAt)),
        ...(item === 'finished' ? { payload: { parts: [], noPartsUsed: true, laborMinutes: job.expectedMinutes, workDone: ['Load day visit'] } } : {}),
      }],
    };
    // A phone keeps an item until the server answers it and sends it again under the same key (section 5.1), so a bad gateway or a
    // dropped connection is a retry here, counted, and the change's delay keeps running from the first send.
    let lastWhy = '';
    for (let attempt = 1; attempt <= ITEM_TRIES; attempt++) {
      if (attempt > 1) {
        itemRetries += 1;
        await sleep(ITEM_RETRY_WAIT_MS);
      }
      try {
        const r = await calls.send('POST', '/tech/items', body);
        const text = await r.text();
        if (r.status >= 500) {
          lastWhy = `${r.status} ${text.slice(0, 60)}`;
          continue;
        }
        itemMs.push(performance.now() - sentAt);
        const answer = r.status === 200 ? (JSON.parse(text) as { data: { items: { result: string; code: string | null }[] } }).data.items[0] : undefined;
        if (answer?.result === 'applied' || (attempt > 1 && answer?.result === 'duplicate')) {
          job.version += 1;
          counts.applied += 1;
        } else {
          tracker.cancel(change);
          failed(`item ${item}: ${r.status} ${answer ? `${answer.result}/${answer.code}` : text.slice(0, 80)}`);
        }
        return;
      } catch (e) {
        lastWhy = (e as Error).message.slice(0, 80);
      }
    }
    tracker.cancel(change);
    failed(`item ${item}: ${lastWhy}`);
  };

  const sendAssign = async (job: NonNullable<ReturnType<typeof jobs.get>>, to: string): Promise<void> => {
    const calls = dispatcherOf.get(job.branch) as ReturnType<typeof client>;
    const sentAt = performance.now();
    const change = tracker.expect(job.branch, job.jobNumber, job.version + 1, sentAt);
    try {
      const r = await calls.send('POST', `/jobs/${job.jobNumber}/assignment`, { technicianId: to, baseVersion: job.version });
      const text = await r.text();
      assignMs.push(performance.now() - sentAt);
      if (r.status === 200) {
        job.version = (JSON.parse(text) as { data: { job: { version: number } } }).data.job.version;
        job.technicianId = to;
        counts.applied += 1;
        return;
      }
      tracker.cancel(change);
      const code = (JSON.parse(text) as { code?: string }).code ?? `status ${r.status}`;
      if (ALLOWED_REFUSALS.has(code)) refused(code);
      else failed(`assign: ${r.status} ${code}`);
    } catch (e) {
      tracker.cancel(change);
      failed(`assign: ${(e as Error).message.slice(0, 80)}`);
    }
  };

  const t0 = performance.now();
  for (const step of o.timeline) {
    const wait = t0 + step.at - performance.now();
    if (wait > 0) await sleep(wait);
    const job = jobs.get(step.jobNumber);
    if (!job) throw new Error(`the timeline names job ${step.jobNumber}, which is not in the world`);
    job.tail = job.tail.then(() => (step.kind === 'item' ? sendItem(job, step.item) : sendAssign(job, step.toTechnicianId)));
  }
  await Promise.all([...jobs.values()].map((j) => j.tail));
  const lastWrite = performance.now();
  o.log(`writes done in ${((lastWrite - t0) / 1000).toFixed(1)} s, ${tracker.owed} board changes still owed`);
  while (tracker.owed > 0 && performance.now() - lastWrite < o.settleMs) await sleep(100);
  const durationMs = performance.now() - t0;
  const pages = (await prober?.stop()) ?? null;

  // NFR-03's lost updates: 1 board read per branch, after the settle, holds every job of the day at the version the server keeps.
  const seen = new Map<number, number>();
  let endStateErrors = 0;
  for (const [branch, calls] of dispatcherOf) {
    try {
      const r = await calls.get(`/board?branch=${branch}&date=today`);
      const text = await r.text();
      if (r.status !== 200) throw new Error(`status ${r.status}`);
      for (const [job, v] of boardVersions((JSON.parse(text) as { data: Parameters<typeof boardVersions>[0] }).data)) seen.set(job, v);
    } catch (e) {
      endStateErrors += 1;
      o.log(`end-state read of ${branch} failed: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  const endState = endStateOf(new Map([...jobs.values()].map((j) => [j.jobNumber, j.version])), seen);
  o.log(`end state: ${endState.matched}/${endState.jobs} jobs match, ${endState.behind} behind, ${endState.ahead} ahead, ${endState.missing} missing`);

  loop.disable();
  for (const t of vanTimers) clearTimeout(t);
  for (const stop of stopVans) stop();
  for (const b of boards) b.stop();
  for (const s of techStreams) s.close();
  const ended = await readClock(origin, world.managerToken);

  return {
    startedAt,
    endedAt: new Date(ended.realMs).toISOString(),
    loadAvg1Start,
    loadAvg1End: loadavg()[0] as number,
    clientLoopDelayMs: { p50: loop.percentile(50) / 1e6, p99: loop.percentile(99) / 1e6, max: loop.max / 1e6 },
    worldEpoch: epoch,
    streams,
    board: boardReads.stats(),
    vans: vanReads.stats(),
    vanRoutes,
    writes: { itemMs: spread(itemMs), assignMs: spread(assignMs), itemRetries, refusedBy, failedBy },
    durationMs,
    delaysMs: tracker.delaysMs,
    lost: tracker.owed,
    writesPlanned: o.timeline.length,
    writesApplied: counts.applied,
    writesRefused: counts.refused,
    writesFailed: counts.failed,
    boardReadErrors: boardReads.errors,
    vanReadErrors: vanReads.errors,
    pageErrors: pages?.errors ?? 0,
    pages,
    endState,
    endStateErrors,
  };
}
