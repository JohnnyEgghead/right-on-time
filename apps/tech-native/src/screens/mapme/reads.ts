// SPDX-License-Identifier: AGPL-3.0-or-later
// The native Map, Parts and Me screens' reads of the day (P6-NATIVE-MAP-ME; SPECIFICATIONS 6.3 "Map tab", "Me screen"): API-100, API-163 and the
// parts list (API-107), read with signal on open, on focus and every 60 s (GAP-7), each answer kept on the phone so the Me screen, the Map tab's
// stop list and the Parts search work with no signal. The rules are the web app's data.ts (TechReads); this one is platform-free over a StoreDir
// (the phone's Documents folder; the tests use node:fs), so it runs in the unit tests as it runs on the phone.
//
// Copies are kept the way settings.ts keeps its record: a new file per change, written whole then renamed into place, the old one removed after,
// the highest that reads back wins. Each copy names the person it belongs to; a copy of another person is no copy (F-1017: a day read for one
// person is never shown to the next).
//
// Since P6-NATIVE-TODAY these are the app's only reads of API-100 and the only owner of the day-changed notices (CTL-TEC-02-14, under the Me
// screen's Notifications switch, CTL-TEC-10-08): the Today screen draws the same day, so the phone reads it once per round.
import { ApiError, dayRoute, partsList, todayJobs, type ApiClient } from '@bw/api';
import { TEMP_PREFIX, type StoreDir } from '@bw/outbox/src/items/native.ts';
import { dayChanges, isTextSize, snapshotOf, type DayChange, type DayData, type DaySnapshot, type Part, type RouteData, type TextSize } from './model.ts';
import { routeRead, type RouteRead, type ShownRoute } from './steps.ts';

export const READ_EVERY_MS = 60_000;
/** The parts list is read again every this many rounds, about 10 minutes (a fixed list, OA-54). */
const PARTS_EVERY_ROUNDS = 40;

export interface Saved<T> { at: string; data: T }
export interface Notice { id: number; change: DayChange | null; n: number }

/**
 * The last route read for each destination (UI-SPECIFICATION 4.5 rule 11; P6-NATIVE-STEPS), by its job number, kept with the saved day
 * of `date`: each new read of a destination's route replaces its entry, and the whole set goes when the saved day goes (another date,
 * sign-out). Directions shows it with no signal (SCR-TEC-08 Offline, steps saved).
 */
export interface KeptRoutes { date: string; routes: Record<string, ShownRoute> }

export interface MapMeData {
  day: Saved<DayData> | null;
  route: Saved<RouteData> | null;
  parts: Saved<Part[]> | null;
  routes: KeptRoutes | null;
  /** The last read answered (false: the last call failed for want of a connection). */
  online: boolean;
  /** The first read has settled, answered or not. */
  settled: boolean;
  failed: boolean;
  /** The last read was refused with 401: the session ended. */
  signedOut: boolean;
  /** The demo time the last read answered at. */
  now: string | null;
  notices: Notice[];
  noticesOn: boolean;
  textSize: TextSize;
  /** The read found another date than the one the phone showed: the list is being read again for the new today (SCR-TEC-02 New day). */
  newDay: boolean;
}

const EMPTY: MapMeData = { day: null, route: null, parts: null, routes: null, online: true, settled: false, failed: false, signedOut: false, now: null, notices: [], noticesOn: true, textSize: 'standard', newDay: false };

type Key = 'day' | 'route' | 'parts' | 'snapshot' | 'prefs' | 'routes';
interface Prefs { noticesOn: boolean; textSize: TextSize }

/** One kept record per key, for 1 person: written as a new revision, read as the highest that parses and names the person. */
export class KeptRecords {
  private readonly dir: StoreDir;
  private readonly user: string;

  constructor(dir: StoreDir, user: string) {
    this.dir = dir;
    this.user = user;
    for (const n of dir.list()) if (n.startsWith(TEMP_PREFIX)) dir.remove(n);
  }

  private revs(key: Key): { rev: number; name: string }[] {
    const re = new RegExp(`^${key}-(\\d{6,})\\.json$`);
    return this.dir.list().flatMap((name) => {
      const m = re.exec(name);
      return m ? [{ rev: Number(m[1]), name }] : [];
    }).sort((a, b) => b.rev - a.rev);
  }

  read<T>(key: Key): T | null {
    for (const r of this.revs(key)) {
      const text = this.dir.readText(r.name);
      if (text === null) continue;
      try {
        const v = JSON.parse(text) as { user?: string; value?: T };
        if (v.user === this.user && v.value !== undefined) return v.value;
        return null;
      } catch {
        // a damaged record: the one below it is the last good one
      }
    }
    return null;
  }

  write(key: Key, value: unknown): void {
    const old = this.revs(key);
    this.dir.create(`${key}-${String((old[0]?.rev ?? 0) + 1).padStart(6, '0')}.json`, JSON.stringify({ user: this.user, value }));
    for (const o of old) this.dir.remove(o.name);
  }

  /** Sign-out: every copy of every person goes (a copy kept for the next person to find is a leak). */
  static forgetAll(dir: StoreDir): void {
    for (const n of dir.list()) dir.remove(n);
  }
}

export class MapMeReads {
  private s: MapMeData;
  private readonly listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private rounds = 0;
  private nextId = 1;
  private cancelled = false;
  private readonly client: ApiClient;
  private readonly kept: KeptRecords;

  constructor(client: ApiClient, dir: StoreDir, user: string) {
    this.client = client;
    this.kept = new KeptRecords(dir, user);
    const prefs = this.kept.read<Prefs>('prefs');
    const day = this.kept.read<Saved<DayData>>('day');
    this.s = {
      ...EMPTY, day, route: this.kept.read<Saved<RouteData>>('route'), parts: this.kept.read<Saved<Part[]>>('parts'), now: day?.at ?? null,
      routes: this.kept.read<KeptRoutes>('routes'),
      noticesOn: prefs?.noticesOn !== false, textSize: isTextSize(prefs?.textSize) ? prefs.textSize : 'standard',
    };
  }

  get snapshot(): MapMeData {
    return this.s;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<MapMeData>): void {
    this.s = { ...this.s, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** A round that began before this saves nothing after it (the person is gone). */
  stop(): void {
    this.cancelled = true;
  }

  /** One read round; a call made while one runs joins it. */
  refresh(): Promise<void> {
    this.running ??= this.round().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async round(): Promise<void> {
    this.rounds += 1;
    try {
      const shown = this.s.day?.data.date ?? null;
      let day = await this.client.call(todayJobs, {});
      if (this.cancelled) return;
      // The clock passed midnight: the day just read is another date than the one the phone showed, so the list is read again for the new
      // today (the frames' New day state shows while it is, under the new date).
      if (shown !== null && day.data.date !== shown) {
        this.set({ day: { at: day.envelope?.meta.demoNow ?? this.s.now ?? '', data: day.data }, newDay: true });
        try {
          day = await this.client.call(todayJobs, {});
        } finally {
          this.set({ newDay: false });
        }
        if (this.cancelled) return;
      }
      const at = day.envelope?.meta.demoNow ?? this.s.now ?? '';
      const saved = { at, data: day.data };
      this.kept.write('day', saved);
      // The notices: this read against the day the phone last saw.
      const prev = this.kept.read<DaySnapshot>('snapshot');
      const changes = dayChanges(prev, snapshotOf(day.data));
      this.kept.write('snapshot', snapshotOf(day.data));
      const notices = changes.length > 0 && this.s.noticesOn
        ? [...this.s.notices, { id: this.nextId++, change: changes.length === 1 ? (changes[0] as DayChange) : null, n: changes.length }]
        : this.s.notices;
      // Settled with the day: the Today screen draws it while the route and the parts are still being read.
      this.set({ day: saved, now: at, online: true, failed: false, signedOut: false, settled: true, notices });
      // Rule 11: the kept routes go with the saved day they were read on.
      if (this.s.routes !== null && this.s.routes.date !== day.data.date) this.keepRoutes(null);
      const route = await this.client.call(dayRoute, {});
      if (this.cancelled) return;
      const savedR = { at, data: route.data };
      this.kept.write('route', savedR);
      this.set({ route: savedR });
      if (this.s.parts === null || this.rounds === 1 || this.rounds % PARTS_EVERY_ROUNDS === 0) {
        const parts = await this.client.call(partsList, {});
        if (this.cancelled) return;
        const savedP = { at, data: parts.data.parts };
        this.kept.write('parts', savedP);
        this.set({ parts: savedP });
      }
      this.set({ settled: true });
    } catch (e) {
      // Only a call that never reached the server is a lost connection (a TypeError: core.ts answeredOrNetwork gives every rejected fetch
      // that type). A refusal (401, 5xx) and an answer that does not parse (a contract drift, a JSON failure) leave the connection as it was.
      if (this.cancelled) return;
      this.set({ online: e instanceof TypeError ? false : this.s.online, settled: true, failed: true, signedOut: e instanceof ApiError && e.status === 401 });
    }
  }

  /**
   * API-104 for SCR-TEC-08 and the Directions buttons: the leg into a job (from the job `from`, else the van's position or the last ended
   * stop, else the depot) with its steps; a 404 is a job that is no longer this technician's (Job moved). Each answer is kept on the phone
   * as this destination's last route read (rule 11), with the saved day it was read on, so Directions has it with no signal.
   */
  async leg(toJob: number, from?: number): Promise<RouteRead> {
    try {
      const r = await this.client.call(routeRead, { toJob, ...(from !== undefined ? { fromJob: from } : {}) });
      const shown: ShownRoute = { leg: r.data.leg, branch: r.data.branch, steps: r.data.steps, at: r.envelope?.meta.demoNow ?? this.s.now ?? '' };
      const date = this.s.day?.data.date;
      if (!this.cancelled && date !== undefined) {
        const same = this.s.routes?.date === date ? this.s.routes.routes : {};
        this.keepRoutes({ date, routes: { ...same, [String(toJob)]: shown } });
      }
      return { kind: 'leg', ...shown };
    } catch (e) {
      // A call that never reached the server is no signal, as in a round (the screen then shows the kept route, rule 11); anything else
      // with signal is Route not loaded.
      if (e instanceof TypeError && !this.cancelled) this.set({ online: false });
      return e instanceof ApiError && e.status === 404 ? { kind: 'moved' } : { kind: 'failed' };
    }
  }

  /** The last route read for this destination on the saved day (rule 11), or null: none read, or read on another day. */
  keptRoute(toJob: number): ShownRoute | null {
    const r = this.s.routes;
    if (r === null || r.date !== this.s.day?.data.date) return null;
    return r.routes[String(toJob)] ?? null;
  }

  private keepRoutes(routes: KeptRoutes | null): void {
    this.kept.write('routes', routes);
    this.set({ routes });
  }

  dismiss(id: number): void {
    this.set({ notices: this.s.notices.filter((n) => n.id !== id) });
  }

  private writePrefs(): void {
    this.kept.write('prefs', { noticesOn: this.s.noticesOn, textSize: this.s.textSize } satisfies Prefs);
  }

  /** CTL-TEC-10-08: kept on the phone at once; turning it off also drops any notice still showing. */
  setNotices(on: boolean): void {
    this.set({ noticesOn: on, ...(on ? {} : { notices: [] }) });
    this.writePrefs();
  }

  /** CTL-TEC-10-09: kept on the phone at once. */
  setSize(size: TextSize): void {
    this.set({ textSize: size });
    this.writePrefs();
  }
}
