// SPDX-License-Identifier: AGPL-3.0-or-later
// PgNotifyBus, the LISTEN side of the event bus (SPECIFICATIONS 4.3, SD-13): 1 `LISTEN bw_events` connection per web
// process fans each notification out to that process's subscribers (the SSE streams). Ids only (D1). A delivered event
// gets a rising seq; the process keeps each seq's emit time for 60 s (SD-43, the board delay measurement).
//
// When the LISTEN connection drops, notifications may have been missed and are never replayed (D1): every subscriber is
// told it is lost (its stream closes, the page reconnects and re-reads in full) and the connection is retried with a
// growing wait. The publish side is publishEvent in @bw/db.
import { BUS_CHANNEL, createClient, decodeNotification, type BusEvent, type EventName } from '@bw/db';
import type { Clock } from '@bw/time';
import type { Role } from '../types.ts';

type ListenClient = ReturnType<typeof createClient>;

export type Unsubscribe = () => void;

export interface BusFilter {
  /** Deliver only events of this branch (an event with no branch id goes to every branch). */
  branch?: string | undefined;
  role: Role;
}

export interface PgNotifyBusOptions {
  /** Makes a connected-on-demand client; the bus calls connect() and LISTEN itself. */
  newClient: () => ListenClient;
  /** Real time for the SD-43 emit times (the named use board_delay_window, SPECIFICATIONS 11.3). */
  clock: Pick<Clock, 'realNow'>;
  /** The first seq is `firstSeq`+1; default the start time in microseconds, so a restart still rises. */
  firstSeq?: number;
  /** Waits between reconnect tries; default 500 ms growing to 10 s. */
  retryWaitMs?: (attempt: number) => number;
  onError?: (e: unknown) => void;
  /**
   * F-347: every livenessMs real ms the LISTEN connection answers a SELECT 1, or it is treated as lost (a connection that
   * died without a TCP close otherwise leaves every stream heartbeating as Live with no events). Default HEARTBEAT 15 s;
   * false: no check.
   */
  livenessMs?: number | false;
}

/** The default liveness interval: the stream's heartbeat (SPECIFICATIONS 4.3: an SSE comment every 15 s). */
export const LIVENESS_MS = 15_000;

/** SD-43: how long each seq's emit time is kept. */
export const EMIT_KEEP_MS = 60_000;

/** Which events a role may see (SPECIFICATIONS 7.3: filtered by role). Office and manager see all; technicians the field events. */
const TECH_EVENTS: ReadonlySet<EventName> = new Set<EventName>(['job.changed', 'block.changed', 'clock.changed', 'world.reset']);
export const roleSees = (role: Role, name: EventName): boolean => role !== 'technician' || TECH_EVENTS.has(name);

interface Subscriber {
  filter: BusFilter;
  onEvent: (e: BusEvent) => void;
  onLost: () => void;
}

export class PgNotifyBus {
  readonly #opts: PgNotifyBusOptions;
  readonly #subs = new Set<Subscriber>();
  readonly #emitted = new Map<number, number>();
  #seq: number;
  #client: ListenClient | null = null;
  #started = false;
  #closed = false;
  #retry: NodeJS.Timeout | null = null;
  #probe: NodeJS.Timeout | null = null;
  #attempt = 0;

  constructor(opts: PgNotifyBusOptions) {
    this.#opts = opts;
    this.#seq = opts.firstSeq ?? this.#now() * 1000;
  }

  /** Is the LISTEN connection up right now? */
  #now(): number {
    return this.#opts.clock.realNow('board_delay_window').epochMilliseconds;
  }

  get listening(): boolean {
    return this.#client !== null;
  }

  subscribe(filter: BusFilter, onEvent: (e: BusEvent) => void, onLost: () => void = () => undefined): Unsubscribe {
    const sub: Subscriber = { filter, onEvent, onLost };
    this.#subs.add(sub);
    this.#start();
    return () => {
      this.#subs.delete(sub);
    };
  }

  /** The real time (ms) a seq was emitted, while it is within the 60 s the process keeps (SD-43); undefined after. */
  emitTime(seq: number): number | undefined {
    this.#prune();
    return this.#emitted.get(seq);
  }

  /**
   * Resolves once the LISTEN connection is up (start it first if nothing has subscribed), or once `withinMs` real ms have
   * passed (F-345: a timed-out wait stops polling). Answers whether it is listening.
   */
  async ready(withinMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    this.#start();
    const until = performance.now() + withinMs;
    while (!this.listening && !this.#closed && performance.now() < until) await new Promise((r) => setTimeout(r, 25));
    return this.listening;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#stopProbe();
    const c = this.#client;
    this.#client = null;
    this.#subs.clear();
    if (c) await c.end().catch(() => undefined);
  }

  #start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    void this.#connect();
  }

  async #connect(): Promise<void> {
    if (this.#closed) return;
    const client = this.#opts.newClient();
    // An 'error' event with no listener would crash the process: the loss path below handles it.
    client.on('error', (e: unknown) => this.#lost(client, e));
    client.on('end', () => this.#lost(client, undefined));
    client.on('notification', (m: { channel: string; payload?: string | undefined }) => {
      if (m.channel === BUS_CHANNEL) this.#deliver(m.payload);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${BUS_CHANNEL}`);
    } catch (e) {
      this.#lost(client, e);
      return;
    }
    if (this.#closed) {
      await client.end().catch(() => undefined);
      return;
    }
    this.#client = client;
    this.#attempt = 0;
    this.#startProbe(client);
  }

  /** F-347: a SELECT 1 on the LISTEN connection every livenessMs; a failure, or no answer by the next probe, is a loss. */
  #startProbe(client: ListenClient): void {
    const every = this.#opts.livenessMs ?? LIVENESS_MS;
    if (every === false) return;
    this.#stopProbe();
    let pending = false;
    this.#probe = setInterval(() => {
      if (this.#client !== client) return;
      if (pending) {
        this.#lost(client, new Error('the LISTEN connection did not answer its liveness check'));
        return;
      }
      pending = true;
      client.query('SELECT 1').then(
        () => {
          pending = false;
        },
        (e: unknown) => this.#lost(client, e),
      );
    }, every);
    this.#probe.unref();
  }

  #stopProbe(): void {
    if (this.#probe) clearInterval(this.#probe);
    this.#probe = null;
  }

  #lost(client: ListenClient, e: unknown): void {
    if (e !== undefined) this.#opts.onError?.(e);
    if (this.#client === client) {
      this.#client = null;
      this.#stopProbe();
    } else if (this.#client !== null) return; // an old client's late event
    void client.end().catch(() => undefined);
    if (this.#closed || this.#retry) return;
    // Missed notifications are never replayed (D1): every stream closes and its page re-reads on reconnect.
    for (const s of [...this.#subs]) {
      this.#subs.delete(s);
      s.onLost();
    }
    const wait = (this.#opts.retryWaitMs ?? ((n) => Math.min(10_000, 500 * 2 ** n)))(this.#attempt++);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#started = true;
      void this.#connect();
    }, wait);
    this.#retry.unref();
  }

  #deliver(payload: string | undefined): void {
    const d = decodeNotification(payload);
    if (!d) return;
    const seq = ++this.#seq;
    this.#emitted.set(seq, this.#now());
    this.#prune();
    const event: BusEvent = { seq, name: d.name, ids: d.ids };
    for (const s of [...this.#subs]) {
      if (!roleSees(s.filter.role, d.name)) continue;
      const branch = d.ids.branch;
      if (s.filter.branch !== undefined && branch !== undefined && String(branch) !== s.filter.branch) continue;
      try {
        s.onEvent(event);
      } catch {
        // one stream's failure never reaches another
      }
    }
  }

  #prune(): void {
    const cutoff = this.#now() - EMIT_KEEP_MS;
    for (const [seq, at] of this.#emitted) {
      if (at >= cutoff) break;
      this.#emitted.delete(seq);
    }
  }
}
