// SPDX-License-Identifier: AGPL-3.0-or-later
// The web technician app's reads of the day (P5-TWA-MAP-ME; SPECIFICATIONS 6.3 "Map tab", "Me screen"): API-100, API-163 and the parts list
// (API-107), read with signal on open, on focus, when the connection is back and every 60 s while a technician page is open (SPECIFICATIONS
// GAP-7), each answer
// kept on the phone (local.ts) so the Me screen, the Map tab's stop list and the Parts search work with no signal.
//
// The day-changed notices (CTL-TEC-02-14, UD-43, OI-34) are raised here, on the phone: each read of the day is compared with the day the
// phone last saw (the snapshot), and a job added, one that left the day or one with a new window raises 1 notice per read when the Me screen's
// notifications switch is on. The switch is kept on the phone; no push service is contacted. Results of the technician's own actions are not
// governed by it (UD-43): they are CMP-10's.
import { ApiError, createClient, dayRoute, partsList, todayJobs, whoAmI, type ApiClient } from '@bw/api';
import { realNow } from '@bw/time';
import { useEffect, useSyncExternalStore } from 'react';
import {
  forgetCount, noticesOn, savedDay, savedParts, savedProfile, savedRoute, savedRoutes, savedSnapshot, saveDay, saveParts, saveProfile, saveRoute, saveRoutes, saveSnapshot, setNoticesOn, setTextSize, textSize,
  type KeptRoutes, type Profile, type Saved,
} from './local.ts';
import { routeRead, type RouteRead, type ShownRoute } from './steps.ts';
import { dayChanges, profileOf, snapshotOf, type DayChange, type DayData, type Part, type RouteData, type TextSize } from './model.ts';

/** GAP-7: technician apps read the day on open, on focus, after each send and every 60 s. This is the only read loop of the day (Today, Me, Map, Directions). */
export const READ_EVERY_MS = 60_000;
/** The parts list is read again every this many rounds, about 10 minutes (it is a fixed list, OA-54; the copy only needs to be there). */
const PARTS_EVERY_ROUNDS = 40;

/** One day-changed notice: 1 cause, or how many jobs changed when a read found several. */
export interface Notice {
  id: number;
  change: DayChange | null;
  n: number;
}

export interface TechData {
  day: Saved<DayData> | null;
  route: Saved<RouteData> | null;
  parts: Saved<Part[]> | null;
  /** The last route read for each destination, kept with the saved day (rule 11; SCR-TEC-08 Offline, steps saved). */
  routes: KeptRoutes | null;
  /** The last read answered (false: the last call failed for want of a connection). */
  online: boolean;
  /** The first read has settled, answered or not. */
  settled: boolean;
  /** The last read failed (no connection, or a refusal): a saved day, if any, is what the screen shows (CMP-12). */
  failed: boolean;
  /** When the last failed round ended, the phone's own stamp in ms (F-1777: the panels' Last try time); null before any failure. */
  failedAt?: number | null;
  /** The last read was refused with 401: the session ended (the idle limit), so the screen opens the sign-in page (UI-SPECIFICATION Session ended). */
  signedOut: boolean;
  /** The demo time the last read answered at (the envelope's demoNow), the clock "On the clock" counts to. */
  now: string | null;
  notices: Notice[];
  noticesOn: boolean;
  textSize: TextSize;
  /** The signed-in person's name and skill kept on the phone (API-07): Me's profile on Reading the phone and the no-day states (F-1740). */
  profile?: Profile | null;
  /** The page was drawn on the server, or is still hydrating: it has not read the phone's copy yet (UI-SPECIFICATION 4.5 rule 12, Reading the phone; F-1434). */
  reading?: true;
}

const EMPTY: TechData = { day: null, route: null, parts: null, routes: null, online: true, settled: false, failed: false, signedOut: false, now: null, notices: [], noticesOn: true, textSize: 'standard' };

/** What the server draws a page with, and what the page's first render shows: the copy on the phone is unread, so a screen draws its skeleton, never an empty answer. */
const UNREAD: TechData = { ...EMPTY, reading: true };

export class TechReads {
  private s: TechData;
  private readonly listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private rounds = 0;
  private nextId = 1;
  /** Counts sign-outs: a read round that started before one never saves what it read after it (F-1017: a copy saved after sign-out is a leak). */
  private signOuts = 0;
  private started = false;

  constructor(private readonly client: ApiClient, private readonly isOnline: () => boolean = () => true) {
    this.s = { ...EMPTY, day: savedDay(), route: savedRoute(), routes: savedRoutes(), profile: savedProfile(), parts: savedParts(), noticesOn: noticesOn(), textSize: textSize(), now: savedDay()?.at ?? null };
  }

  get snapshot(): TechData {
    return this.s;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<TechData>): void {
    this.s = { ...this.s, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** Changes whenever the person's copies are forgotten (sign-out here, or local.ts forgetPerson anywhere): a round that began before saves nothing. */
  private epoch(): number {
    return this.signOuts + forgetCount();
  }

  /** Reads on open and then on the triggers; called once per page by the shell. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const kick = () => void this.refresh();
    window.addEventListener('online', kick);
    window.addEventListener('focus', kick);
    window.addEventListener('pageshow', kick);
    window.addEventListener('offline', () => this.set({ online: false }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') kick();
    });
    window.setInterval(kick, READ_EVERY_MS);
    kick();
  }

  /** API-07: the person's name and skill, kept for Me's profile (F-1740). A refused or lost answer leaves the kept profile as it was. */
  private async readProfile(gen: number): Promise<void> {
    try {
      const who = await this.client.call(whoAmI, {});
      if (gen !== this.epoch()) return;
      const profile = profileOf(who.data);
      saveProfile(profile);
      this.set({ profile });
    } catch {
      // the day read is what decides online or failed; the profile is kept as it was
    }
  }

  /** One read round; a call made while one runs joins it. */
  refresh(): Promise<void> {
    this.running ??= this.round().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async round(): Promise<void> {
    if (!this.isOnline()) {
      this.set({ online: false, settled: true });
      return;
    }
    this.rounds += 1;
    const gen = this.epoch();
    // F-1775: the profile is read beside the day, whatever the day read's outcome, so Loading and Day not loaded name the person on a first open too.
    // F-1778: the name and skill change only at sign-in, so API-07 is read once, when no profile is kept, never on every round.
    const profileRead = this.s.profile ? Promise.resolve() : this.readProfile(gen);
    try {
      const day = await this.client.call(todayJobs, {});
      if (gen !== this.epoch()) return;
      const at = day.envelope?.meta.demoNow ?? this.s.now ?? '';
      const saved = { at, data: day.data };
      saveDay(saved);
      // Rule 11: the kept routes go with the saved day they were read on.
      if (this.s.routes !== null && this.s.routes.date !== day.data.date) this.keepRoutes(null);
      // The notices: this read against the day the phone last saw.
      const changes = dayChanges(savedSnapshot(), snapshotOf(day.data));
      saveSnapshot(snapshotOf(day.data));
      const notices = changes.length > 0 && this.s.noticesOn
        ? [...this.s.notices, { id: this.nextId++, change: changes.length === 1 ? (changes[0] as DayChange) : null, n: changes.length }]
        : this.s.notices;
      this.set({ day: saved, now: at, online: true, failed: false, signedOut: false, notices });
      const route = await this.client.call(dayRoute, {});
      if (gen !== this.epoch()) return;
      const savedR = { at, data: route.data };
      saveRoute(savedR);
      this.set({ route: savedR });
      if (this.s.parts === null || this.rounds === 1 || this.rounds % PARTS_EVERY_ROUNDS === 0) {
        const parts = await this.client.call(partsList, {});
        if (gen !== this.epoch()) return;
        const savedP = { at, data: parts.data.parts };
        saveParts(savedP);
        this.set({ parts: savedP });
      }
      this.set({ settled: true });
    } catch (e) {
      // An answer that is a refusal (401, 5xx) is not a lost connection; only a call that never reached the server is.
      this.set({ online: e instanceof ApiError ? this.s.online : false, settled: true, failed: true, failedAt: realNow('device_stamp').epochMilliseconds, signedOut: e instanceof ApiError && e.status === 401 });
    } finally {
      // readProfile never throws; the round ends with it, so a joined refresh never leaves it running into the next round.
      await profileRead;
    }
  }

  /**
   * API-104 for SCR-TEC-08: the leg into a job (from the job `from`, else the van's position or the last ended stop, else the depot) with its
   * steps; a 404 is a job that is no longer this technician's (Job moved). Each answer is kept on the phone as this destination's last route
   * read (rule 11), with the saved day it was read on, so Directions has it with no signal.
   */
  async leg(toJob: number, from?: number): Promise<RouteRead> {
    const gen = this.epoch();
    try {
      const r = await this.client.call(routeRead, { toJob, ...(from !== undefined ? { fromJob: from } : {}) });
      const shown: ShownRoute = { leg: r.data.leg, branch: r.data.branch, steps: r.data.steps, at: r.envelope?.meta.demoNow ?? this.s.now ?? '' };
      const date = this.s.day?.data.date;
      if (gen === this.epoch() && date !== undefined) {
        const same = this.s.routes?.date === date ? this.s.routes.routes : {};
        this.keepRoutes({ date, routes: { ...same, [String(toJob)]: shown } });
      }
      return { kind: 'leg', ...shown };
    } catch (e) {
      // A call that never reached the server is no signal, as in a round (the screen then shows the kept route, rule 11); anything else
      // with signal is Route not loaded.
      if (e instanceof TypeError && gen === this.epoch()) this.set({ online: false });
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
    saveRoutes(routes);
    this.set({ routes });
  }

  /** The day the server carried in the page (Today's first paint): kept as the saved day at once, unless a newer one is already kept. */
  adopt(day: Saved<DayData>): void {
    if (this.s.day !== null && this.s.day.at >= day.at) return;
    saveDay(day);
    this.set({ day, now: day.at });
  }

  dismiss(id: number): void {
    this.set({ notices: this.s.notices.filter((n) => n.id !== id) });
  }

  /** CTL-TEC-10-08: kept on the phone at once; turning it off also drops any notice still showing. */
  setNotices(on: boolean): void {
    setNoticesOn(on);
    this.set({ noticesOn: on, ...(on ? {} : { notices: [] }) });
  }

  /** Change the text size and keep the choice on the phone at once (CTL-TEC-10-09). */
  setSize(size: TextSize): void {
    setTextSize(size);
    this.set({ textSize: size });
  }

  /** Sign-out: the person's reads are forgotten with the copies on the phone. */
  clear(): void {
    this.signOuts += 1;
    this.set({ day: null, route: null, routes: null, parts: null, profile: null, notices: [] });
  }
}

let client: ApiClient | null = null;
let reads: TechReads | null = null;

/** The page's one API client for the technician reads: every read is sent with `cache: 'no-store'`, so a phone never answers from what it kept. */
function techClient(): ApiClient {
  client ??= createClient({ baseUrl: window.location.origin, fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) });
  return client;
}

export function techReads(): TechReads {
  reads ??= new TechReads(techClient(), () => navigator.onLine);
  return reads;
}

/** The reads' state for a screen; a fixed state is a preview's, and the page starts the reads once. */
export function useTechData(fixed?: TechData): TechData {
  const live = useSyncExternalStore(
    (fn) => (fixed ? () => undefined : techReads().subscribe(fn)),
    () => fixed ?? techReads().snapshot,
    () => fixed ?? UNREAD,
  );
  useEffect(() => {
    if (!fixed) techReads().start();
  }, [fixed]);
  return live;
}

export const EMPTY_DATA = EMPTY;
