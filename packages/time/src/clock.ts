// SPDX-License-Identifier: AGPL-3.0-or-later
// The clock seam (SPECIFICATIONS section 4.2, SD-10). DbClock is production: demo time comes from the 1
// system.demo_clock row (D11). FixedClock is for tests: every test sets its time and never reads the wall.
import { Temporal } from 'temporal-polyfill';
import { realNow } from './real.ts';
import { assertRealTimeUse, type RealTimeUse } from './uses.ts';

export type Instant = Temporal.Instant;

export interface Clock {
  /** The demo clock's now. */
  demoNow(): Promise<Instant>;
  /** Real time, for 1 named use of section 11.3 only. */
  realNow(use: RealTimeUse): Instant;
  /** The world epoch of the clock row (+1 at every reset, SD-12). */
  worldEpoch(): Promise<number>;
  /** Drop a cached copy of the clock row, when the clock keeps one (DbClock): the next read goes to the row (F-543). */
  invalidate?(): void;
}

/** What DbClock needs from a database connection: pg.Client, pg.Pool and @bw/db's Queryable all satisfy it. */
export interface ClockDb {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/** The columns of system.demo_clock the clock reads (section 3 `demo_clock`). */
export interface ClockRow {
  demo_anchor: Date | string;
  real_anchor: Date | string;
  /** PostgreSQL numeric arrives as a string. */
  rate: string | number;
  paused: boolean;
  world_epoch: number;
}

export const CLOCK_ROW_SQL =
  'SELECT demo_anchor, real_anchor, rate, paused, world_epoch FROM system.demo_clock WHERE id = 1';

/** Per-process cache of the clock row (section 4.2: cached 250 ms per process). */
export const CLOCK_CACHE_MS = 250;

interface Anchors {
  demoAnchor: Instant;
  realAnchor: Instant;
  rate: number;
  paused: boolean;
  worldEpoch: number;
}

function toInstant(v: Date | string, column: string): Instant {
  if (v instanceof Date) {
    const ms = v.getTime();
    if (Number.isNaN(ms)) throw new Error(`system.demo_clock.${column} is not a valid time`);
    return Temporal.Instant.fromEpochMilliseconds(ms);
  }
  return Temporal.Instant.from(v);
}

function parseRow(row: ClockRow): Anchors {
  const rate = typeof row.rate === 'number' ? row.rate : Number(row.rate);
  if (!Number.isFinite(rate) || rate < 0) throw new Error(`system.demo_clock.rate ${String(row.rate)} is not a rate`);
  return {
    demoAnchor: toInstant(row.demo_anchor, 'demo_anchor'),
    realAnchor: toInstant(row.real_anchor, 'real_anchor'),
    rate,
    paused: row.paused,
    worldEpoch: row.world_epoch,
  };
}

/** now = demo_anchor + (real - real_anchor) x rate, or demo_anchor while paused (section 3 `demo_clock`, SD-10). */
export function demoTimeAt(a: Pick<Anchors, 'demoAnchor' | 'realAnchor' | 'rate' | 'paused'>, real: Instant): Instant {
  if (a.paused) return a.demoAnchor;
  const elapsedMs = real.epochMilliseconds - a.realAnchor.epochMilliseconds;
  return Temporal.Instant.fromEpochMilliseconds(a.demoAnchor.epochMilliseconds + Math.round(elapsedMs * a.rate));
}

export interface DbClockOptions {
  /** Cache lifetime of the clock row in real milliseconds (default 250). */
  cacheMs?: number;
  /**
   * The real-time source for the clock's own reading (use `clock_anchor`). Tests inject one; production keeps the
   * default, so DbClock is never run against wall time in a test (section 4.2 fallback rule).
   */
  real?: () => Instant;
}

export class DbClock implements Clock {
  readonly #db: ClockDb;
  readonly #cacheMs: number;
  readonly #real: () => Instant;
  #cached: { anchors: Anchors; readAt: Instant } | undefined;
  #inFlight: { read: Promise<Anchors>; readAt: Instant } | undefined;
  /** Bumped by invalidate(): a read that started before it must not fill the cache (F-181). */
  #generation = 0;

  constructor(db: ClockDb, opts: DbClockOptions = {}) {
    this.#db = db;
    this.#cacheMs = opts.cacheMs ?? CLOCK_CACHE_MS;
    this.#real = opts.real ?? (() => realNow('clock_anchor'));
  }

  async demoNow(): Promise<Instant> {
    const anchors = await this.#anchors();
    return demoTimeAt(anchors, this.#real());
  }

  realNow(use: RealTimeUse): Instant {
    return realNow(use);
  }

  async worldEpoch(): Promise<number> {
    return (await this.#anchors()).worldEpoch;
  }

  /** Drop the cached row: the process that just moved the clock reads it fresh. */
  invalidate(): void {
    this.#generation += 1;
    this.#cached = undefined;
    this.#inFlight = undefined;
  }

  /** A row read (or sent for) at `readAt` is still young enough to hand to a caller at `now`. */
  #young(readAt: Instant, now: Instant): boolean {
    const ageMs = now.epochMilliseconds - readAt.epochMilliseconds;
    return ageMs >= 0 && ageMs < this.#cacheMs;
  }

  async #anchors(): Promise<Anchors> {
    const now = this.#real();
    const c = this.#cached;
    if (c && this.#young(c.readAt, now)) return c.anchors;
    // Concurrent callers share 1 query while it is as young as a cached row may be (F-569): a read sent longer ago can hold the
    // row from before a move committed since, and with the cache off (cacheMs 0) every caller reads the row itself.
    const f = this.#inFlight;
    if (f && this.#young(f.readAt, now)) return f.read;
    const read: Promise<Anchors> = this.#read(now, this.#generation).finally(() => {
      if (this.#inFlight?.read === read) this.#inFlight = undefined;
    });
    this.#inFlight = { read, readAt: now };
    return read;
  }

  async #read(readAt: Instant, generation: number): Promise<Anchors> {
    const { rows } = await this.#db.query<ClockRow>(CLOCK_ROW_SQL);
    if (rows.length !== 1) throw new Error(`system.demo_clock holds ${rows.length} rows with id 1; it must hold exactly 1 (D11)`);
    const anchors = parseRow(rows[0]!);
    // A read that began before an invalidate() carries the pre-move row: its caller gets it, the cache does not.
    if (generation === this.#generation) this.#cached = { anchors, readAt };
    return anchors;
  }
}

type InstantLike = Instant | string;
const instant = (v: InstantLike): Instant => (typeof v === 'string' ? Temporal.Instant.from(v) : v);

export interface FixedClockInit {
  demo: InstantLike;
  /** Real now; defaults to the demo instant. */
  real?: InstantLike;
  worldEpoch?: number;
  paused?: boolean;
}

/** The test clock (section 4.2): set, advance, pause. It never reads the system clock. */
export class FixedClock implements Clock {
  #demo: Instant;
  #real: Instant;
  #epoch: number;
  #paused: boolean;

  constructor(init: FixedClockInit) {
    this.#demo = instant(init.demo);
    this.#real = instant(init.real ?? init.demo);
    this.#epoch = init.worldEpoch ?? 1;
    this.#paused = init.paused ?? false;
  }

  async demoNow(): Promise<Instant> {
    return this.#demo;
  }

  realNow(use: RealTimeUse): Instant {
    assertRealTimeUse(use);
    return this.#real;
  }

  async worldEpoch(): Promise<number> {
    return this.#epoch;
  }

  /** Set demo time (a jump). Real time does not move. */
  set(demo: InstantLike): this {
    this.#demo = instant(demo);
    return this;
  }

  setReal(real: InstantLike): this {
    this.#real = instant(real);
    return this;
  }

  setWorldEpoch(epoch: number): this {
    this.#epoch = epoch;
    return this;
  }

  /** Real time passes; demo time follows at rate 1 unless paused. */
  advance(by: Temporal.DurationLike | string): this {
    this.#real = this.#real.add(by);
    if (!this.#paused) this.#demo = this.#demo.add(by);
    return this;
  }

  pause(): this {
    this.#paused = true;
    return this;
  }

  resume(): this {
    this.#paused = false;
    return this;
  }

  get paused(): boolean {
    return this.#paused;
  }
}
