// SPDX-License-Identifier: AGPL-3.0-or-later
// The load day's shape and its timeline (P4-LOAD; REQUIREMENTS section 5.2). The world file is what infra/load/world.sql read
// from the stack; the timeline maps each job's real day onto 1 run: a technician's On my way, Arrived and Finished happen at
// their places in the day, squeezed by 1 stated factor, so the run keeps the day's own morning and afternoon shape. A share of
// the jobs is first moved to another technician by a dispatcher. Same seed, same world: same timeline.

/** REQUIREMENTS section 5.2. */
export const LOAD_DAY = { jobs: 600, branches: 3, dispatchers: 14, technicians: 85 } as const;

export interface WorldJob {
  jobNumber: number;
  branch: string;
  technicianId: string;
  version: number;
  /** Real ms of the planned arrival on the demo day. */
  plannedMs: number;
  expectedMinutes: number;
}
export interface WorldTechnician { id: string; branch: string; token: string }
export interface WorldDispatcher { id: string; branch: string; token: string }
export interface LoadWorld {
  /** The manager session that resets the world between runs. */
  managerToken: string;
  jobs: WorldJob[];
  technicians: WorldTechnician[];
  dispatchers: WorldDispatcher[];
}

export type ItemKind = 'on_my_way' | 'arrived' | 'finished';
export type Step =
  | { at: number; kind: 'item'; item: ItemKind; jobNumber: number }
  | { at: number; kind: 'assign'; jobNumber: number; toTechnicianId: string };

export interface TimelineOptions {
  /** The run's length in ms; the working day is squeezed into it. */
  durationMs: number;
  /** The share of jobs a dispatcher moves to another technician first. */
  reassignShare: number;
  seed: number;
}

/** The day the timeline squeezes: the drive to the day's first stop to the end of its last visit. */
export const DRIVE_MINUTES = 20;

/** mulberry32: a small seeded generator, so a timeline repeats exactly. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Throws unless the world is the load day of section 5.2. */
export function checkLoadDay(w: LoadWorld): void {
  const branches = new Set(w.jobs.map((j) => j.branch));
  const wrong: string[] = [];
  if (w.jobs.length !== LOAD_DAY.jobs) wrong.push(`${w.jobs.length} jobs, not ${LOAD_DAY.jobs}`);
  if (branches.size !== LOAD_DAY.branches) wrong.push(`${branches.size} branches, not ${LOAD_DAY.branches}`);
  if (w.dispatchers.length !== LOAD_DAY.dispatchers) wrong.push(`${w.dispatchers.length} dispatcher sessions, not ${LOAD_DAY.dispatchers}`);
  if (w.technicians.length !== LOAD_DAY.technicians) wrong.push(`${w.technicians.length} technician sessions, not ${LOAD_DAY.technicians}`);
  const known = new Set(w.technicians.map((t) => t.id));
  const orphan = w.jobs.filter((j) => !known.has(j.technicianId)).length;
  if (orphan > 0) wrong.push(`${orphan} jobs of a technician with no session`);
  if (wrong.length > 0) throw new Error(`not the load day: ${wrong.join('; ')}`);
}

/** How many times faster than the real day 1 run is. */
export function squeeze(w: LoadWorld, durationMs: number): number {
  const { start, end } = daySpan(w);
  return (end - start) / durationMs;
}

function daySpan(w: LoadWorld): { start: number; end: number } {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const j of w.jobs) {
    start = Math.min(start, j.plannedMs - DRIVE_MINUTES * 60_000);
    end = Math.max(end, j.plannedMs + j.expectedMinutes * 60_000);
  }
  return { start, end };
}

export function buildTimeline(w: LoadWorld, o: TimelineOptions): Step[] {
  const { start, end } = daySpan(w);
  const scale = o.durationMs / (end - start);
  const place = (t: number): number => Math.max(0, Math.min(o.durationMs, (t - start) * scale));
  const random = seeded(o.seed);
  const steps: Step[] = [];
  for (const j of w.jobs) {
    const onMyWay = place(j.plannedMs - DRIVE_MINUTES * 60_000);
    const arrived = place(j.plannedMs);
    const finished = place(j.plannedMs + j.expectedMinutes * 60_000);
    steps.push({ at: onMyWay, kind: 'item', item: 'on_my_way', jobNumber: j.jobNumber });
    steps.push({ at: arrived, kind: 'item', item: 'arrived', jobNumber: j.jobNumber });
    steps.push({ at: finished, kind: 'item', item: 'finished', jobNumber: j.jobNumber });
  }
  // The dispatcher's moves: every n-th job in a seeded order, at a point before that job's On my way.
  const techs = new Map<string, string[]>();
  for (const t of w.technicians) techs.set(t.branch, [...(techs.get(t.branch) ?? []), t.id]);
  const order = w.jobs.map((j) => ({ j, r: random() })).sort((a, b) => a.r - b.r).map((x) => x.j);
  const moves = Math.round(w.jobs.length * o.reassignShare);
  const loadOf = new Map<string, number>();
  for (const j of w.jobs) loadOf.set(j.technicianId, (loadOf.get(j.technicianId) ?? 0) + 1);
  for (const j of order.slice(0, moves)) {
    // A dispatcher moves a job to someone with room: the lighter half of the branch's technicians.
    const others = (techs.get(j.branch) as string[]).filter((id) => id !== j.technicianId).sort((a, b) => (loadOf.get(a) ?? 0) - (loadOf.get(b) ?? 0) || a.localeCompare(b));
    const to = others[Math.floor(random() * Math.ceil(others.length / 2))] as string;
    steps.push({ at: place(j.plannedMs - DRIVE_MINUTES * 60_000) * random(), kind: 'assign', jobNumber: j.jobNumber, toTechnicianId: to });
  }
  return steps.sort((a, b) => a.at - b.at);
}
