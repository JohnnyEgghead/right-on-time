// SPDX-License-Identifier: AGPL-3.0-or-later
// The day planner (SPECIFICATIONS SD-15) and the block overlap rule (section 5.3 step 2, FR-DISP-34). Pure: the
// technician's day in, planned arrivals out. Times are epoch milliseconds; the caller turns local times into instants.
//
// Planned arrival: the technician's live jobs that day in window-start then booked-at order (job number breaks a tie,
// so the order is total); the first = max(window start, shift start + drive from the depot); each next =
// max(window start, previous planned arrival + previous expected minutes + drive). Derived: writing it never bumps a
// job's version (D15), so a recompute never causes a conflict.

export interface Point {
  lon: number;
  lat: number;
}

/**
 * Minutes of driving between 2 points. `fromJob` and `toJob` name the stops (null: the depot), so a drive function
 * that holds baked tracks can find the leg's track (SD-15); a function that ignores them measures the points only.
 */
export type DriveMinutes = (from: Point, to: Point, fromJob?: number | null, toJob?: number) => number;

/** A baked leg's key in the map {@link trackedDriveMinutes} reads: `<from job number or depot>|<to job number>`. */
export const legRef = (fromJob: number | null, toJob: number): string => `${fromJob ?? 'depot'}|${toJob}`;

/**
 * The drive minutes of a leg (SD-15): the baked track's last cumulative second / 60, rounded up, else SD-22's approximate minutes.
 * `trackSeconds` maps {@link legRef} to a track's last cumulative second; a leg absent from it has no baked track.
 */
export const trackedDriveMinutes = (trackSeconds: ReadonlyMap<string, number>): DriveMinutes => (a, b, fromJob, toJob) => {
  const seconds = toJob === undefined ? undefined : trackSeconds.get(legRef(fromJob ?? null, toJob));
  return seconds === undefined ? approximateDriveMinutes(a, b) : Math.ceil(seconds / 60);
};

/** 1 leg a planner run asks for: its 2 points and the stops they are (null: the depot). */
export interface LegAsk {
  from: Point;
  to: Point;
  fromJob: number | null;
  toJob: number;
}

/**
 * The legs a planner run asks for (SPECIFICATIONS v0.13 SD-49, SD-15; P6-LIVE-ROUTING), each once, in the order first asked. `run` calls
 * {@link planDay} or {@link etaDay} with the drive function it is handed; that function records each named leg and answers SD-22's
 * approximate minutes. The route source then answers only these legs (the stored row, else a live route), never every pair of the day.
 * Sound because neither planner chooses its legs by drive minutes: both walk the day in window-start, booked-at, job-number order, and
 * etaDay's on-the-way leg is the previous ended stop's, so the second run, with the routed minutes, asks for the same legs.
 */
export function legsAsked(run: (drive: DriveMinutes) => unknown): LegAsk[] {
  const asks = new Map<string, LegAsk>();
  run((a, b, fromJob, toJob) => {
    if (toJob !== undefined) {
      const key = legRef(fromJob ?? null, toJob);
      if (!asks.has(key)) asks.set(key, { from: { lon: a.lon, lat: a.lat }, to: { lon: b.lon, lat: b.lat }, fromJob: fromJob ?? null, toJob });
    }
    return approximateDriveMinutes(a, b);
  });
  return [...asks.values()];
}

const EARTH_KM = 6371;

/** SD-22's approximate minutes for a leg with no baked track: ceil(haversine km x 1.4 / 35 km per h x 60) + 2. */
export const approximateDriveMinutes: DriveMinutes = (a, b) => {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  const km = 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.ceil(((km * 1.4) / 35) * 60) + 2;
};

export interface PlanStop {
  jobNumber: number;
  windowStart: number;
  bookedAt: number;
  expectedMinutes: number;
  point: Point;
}

export interface PlannedStop {
  jobNumber: number;
  plannedArrival: number;
  /** plannedArrival + expected minutes: the end of the job's planned time. */
  plannedEnd: number;
}

const MINUTE = 60_000;

/** SD-15's planned arrivals for 1 technician-day. `stops` are the day's live jobs, in any order. */
export function planDay(input: { shiftStart: number; depot: Point; stops: readonly PlanStop[]; drive?: DriveMinutes }): PlannedStop[] {
  const drive = input.drive ?? approximateDriveMinutes;
  const ordered = [...input.stops].sort((x, y) => x.windowStart - y.windowStart || x.bookedAt - y.bookedAt || x.jobNumber - y.jobNumber);
  const out: PlannedStop[] = [];
  let ready = input.shiftStart;
  let at = input.depot;
  let from: number | null = null;
  for (const s of ordered) {
    const arrival = Math.max(s.windowStart, ready + drive(at, s.point, from, s.jobNumber) * MINUTE);
    const end = arrival + s.expectedMinutes * MINUTE;
    out.push({ jobNumber: s.jobNumber, plannedArrival: arrival, plannedEnd: end });
    ready = end;
    at = s.point;
    from = s.jobNumber;
  }
  return out;
}

/** Whether the half-open spans [aStart, aEnd) and [bStart, bEnd) share any time. Touching ends do not overlap. */
export const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => aStart < bEnd && bStart < aEnd;

/** The first (job, block) pair whose times overlap, in job then block order; null when none does. */
export function firstOverlap<B extends { start: number; end: number }>(
  jobs: readonly PlannedStop[], blocks: readonly B[],
): { job: PlannedStop; block: B } | null {
  for (const job of jobs) {
    for (const block of blocks) if (overlaps(job.plannedArrival, job.plannedEnd, block.start, block.end)) return { job, block };
  }
  return null;
}

/** SD-15's at-risk margin: an open job whose ETA is within this many minutes before its window end is at risk. Build-tuned (SD-27). */
export const AT_RISK_MARGIN_MINUTES = 15;

/** SD-15 timing of an open, not-arrived job from its ETA. */
export function timingOf(eta: number, windowEnd: number, marginMinutes = AT_RISK_MARGIN_MINUTES): 'late' | 'at_risk' | 'on_time' {
  if (eta > windowEnd) return 'late';
  if (eta >= windowEnd - marginMinutes * MINUTE) return 'at_risk';
  return 'on_time';
}

export type EtaStatus = 'scheduled' | 'on_the_way' | 'on_site' | 'done' | 'no_one_home';

export interface EtaStop {
  jobNumber: number;
  status: EtaStatus;
  windowStart: number;
  windowEnd: number;
  bookedAt: number;
  expectedMinutes: number;
  point: Point;
  onTheWayAt: number | null;
  arrivedAt: number | null;
  endedAt: number | null;
}

export interface EtaResult {
  jobNumber: number;
  /** The arrival time for an arrived job, the estimate for an open one (epoch milliseconds). */
  eta: number;
  timing: 'late' | 'at_risk' | 'on_time';
}

const ENDED_STATUSES: ReadonlySet<string> = new Set(['done', 'no_one_home']);

/**
 * SD-22's previous stop of a leg: the technician's last ended job that day (latest end, then job number), else null for the
 * depot. The 1 resolver (F-515): the ETA of a job on the way, the on-the-way text's ETA and the van's position all measure
 * the same leg. `except` leaves out the job the leg goes to.
 */
export function previousStop<S extends { jobNumber: number; status: string; endedAt: number | null }>(stops: readonly S[], except: number | null): S | null {
  let best: S | null = null;
  for (const s of stops) {
    if (!ENDED_STATUSES.has(s.status) || s.jobNumber === except) continue;
    if (best === null || (s.endedAt ?? 0) > (best.endedAt ?? 0) || ((s.endedAt ?? 0) === (best.endedAt ?? 0) && s.jobNumber > best.jobNumber)) best = s;
  }
  return best;
}

/** SD-15: the ETA sweep (event `eta.sweep`) runs every 5 demo minutes. */
export const ETA_SWEEP_EVERY_MINUTES = 5;

/** SD-15: an on-the-way estimate that has passed becomes demo now + this many minutes. */
export const PASSED_ETA_MINUTES = 2;

/**
 * SD-15's ETA and timing for 1 technician-day, computed on read and by the sweep, never stored. On site or ended = the
 * arrival time; on the way = on_the_way_at + the leg's drive, or demo now + 2 minutes once that has passed; otherwise
 * max(window start, ready + drive), where ready is demo now (never before shift start) with no open job before this
 * one, else the previous open job's ETA + its expected minutes. The leg's drive is whole minutes, as the planner's is,
 * so a van that leaves when the plan says arrives when the plan says. Timing of an open job: `timingOf`; an arrived
 * job is late if it arrived after its window end.
 */
export function etaDay(input: { now: number; shiftStart: number; depot: Point; stops: readonly EtaStop[]; drive?: DriveMinutes }): EtaResult[] {
  const drive = input.drive ?? approximateDriveMinutes;
  const ordered = [...input.stops].sort((x, y) => x.windowStart - y.windowStart || x.bookedAt - y.bookedAt || x.jobNumber - y.jobNumber);
  const out: EtaResult[] = [];
  let at = input.depot;
  let from: number | null = null;
  let openEnd: number | null = null;
  for (const s of ordered) {
    const leg = (): number => drive(at, s.point, from, s.jobNumber) * MINUTE;
    if (s.status === 'on_site' || s.status === 'done' || s.status === 'no_one_home') {
      const arrived = s.arrivedAt ?? s.endedAt ?? s.onTheWayAt ?? input.now;
      out.push({ jobNumber: s.jobNumber, eta: arrived, timing: arrived > s.windowEnd ? 'late' : 'on_time' });
      openEnd = s.status === 'on_site' ? arrived + s.expectedMinutes * MINUTE : null;
    } else {
      let eta: number;
      if (s.status === 'on_the_way' && s.onTheWayAt !== null) {
        // The van's own leg (SD-22), whatever the window order says: it is on the road from its last ended job.
        const prev = previousStop(ordered, s.jobNumber);
        eta = s.onTheWayAt + drive(prev?.point ?? input.depot, s.point, prev?.jobNumber ?? null, s.jobNumber) * MINUTE;
        if (eta < input.now) eta = input.now + PASSED_ETA_MINUTES * MINUTE;
      } else {
        // SD-15: ready is never before demo now (F-516): an on-site job that has run past its expected minutes ends no earlier than now.
        const ready = Math.max(openEnd ?? input.now, input.now, input.shiftStart);
        eta = Math.max(s.windowStart, ready + leg());
      }
      out.push({ jobNumber: s.jobNumber, eta, timing: timingOf(eta, s.windowEnd) });
      openEnd = eta + s.expectedMinutes * MINUTE;
    }
    at = s.point;
    from = s.jobNumber;
  }
  return out;
}

/** FR-TEXT-5: a technician 20 or more minutes later than the baseline gets the customer 1 late text. */
export const LATE_TEXT_MINUTES = 20;

/** Whether the estimate is {@link LATE_TEXT_MINUTES} or more after the baseline (the last arrival time texted, else the planned arrival; OA-53). */
export const isLateEnoughToText = (eta: number, baseline: number): boolean => eta - baseline >= LATE_TEXT_MINUTES * MINUTE;
