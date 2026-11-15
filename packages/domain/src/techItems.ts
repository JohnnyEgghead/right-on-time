// SPDX-License-Identifier: AGPL-3.0-or-later
// The technician item rules (SPECIFICATIONS section 5.1 steps 4 to 9, SD-16; REQUIREMENTS FR-TECH-6, FR-DEMO-9,
// FR-TEXT-19; invariant 1). Pure: the offline conflict table as 1 typed constant, the change classifier over a job's
// history rows, the forward-move rule, the On my way history-only rule and the clock re-base. Times are epoch
// milliseconds, so this package stays free of the clock and of Temporal; the server's applyItem reads the rows and
// writes the results (@bw/api-server tech-items).
import type { JobStatus } from './capacity.ts';

/** The rows of the offline conflict table (REQUIREMENTS section 4.3); a signature follows the Add photo row (FR-TECH-14). */
export const ITEM_ACTIONS = ['note', 'photo', 'on_my_way', 'arrived', 'finished', 'no_one_home'] as const;
export type ItemAction = (typeof ITEM_ACTIONS)[number];

/** The columns of the table: what changed on the job after the version the app last saw (section 5.1 step 5). */
export const CHANGE_COLUMNS = ['no_change', 'details', 'rescheduled', 'assigned', 'canceled', 'status_set'] as const;
export type ChangeColumn = (typeof CHANGE_COLUMNS)[number];

export type Verdict = 'apply' | 'flag';

const ALWAYS: Readonly<Record<ChangeColumn, Verdict>> = {
  no_change: 'apply', details: 'apply', rescheduled: 'apply', assigned: 'apply', canceled: 'apply', status_set: 'apply',
};
const STATUS_ROW: Readonly<Record<ChangeColumn, Verdict>> = {
  no_change: 'apply', details: 'apply', rescheduled: 'flag', assigned: 'flag', canceled: 'flag', status_set: 'flag',
};

/**
 * The offline conflict table of FR-TECH-6, the only copy in code: notes and photos always apply; a status item applies
 * under No change or Details only and is flagged for the dispatcher in every other column. The server and every
 * cell test read this constant (section 5.1 step 6).
 */
export const OFFLINE_CONFLICT_TABLE: Readonly<Record<ItemAction, Readonly<Record<ChangeColumn, Verdict>>>> = {
  note: ALWAYS,
  photo: ALWAYS,
  on_my_way: STATUS_ROW,
  arrived: STATUS_ROW,
  finished: STATUS_ROW,
  no_one_home: STATUS_ROW,
};

/** The table's verdict for 1 cell; an unlisted pair is a defect and throws (FR-TECH-6 acceptance: it fails). */
export function conflictVerdict(action: string, column: string): Verdict {
  const row = (OFFLINE_CONFLICT_TABLE as Record<string, Record<string, Verdict> | undefined>)[action];
  const verdict = row?.[column];
  if (verdict === undefined) throw new Error(`the offline conflict table has no cell (${action}, ${column})`);
  return verdict;
}

/** The status item kinds and the job status each moves the job to (section 5.1 step 7). */
export const STATUS_ITEM_TARGET = {
  on_my_way: 'on_the_way', arrived: 'on_site', finished: 'done', no_one_home: 'no_one_home',
} as const satisfies Record<string, JobStatus>;
export type StatusItemKind = keyof typeof STATUS_ITEM_TARGET;

export const isStatusItem = (kind: string): kind is StatusItemKind => Object.hasOwn(STATUS_ITEM_TARGET, kind);

/** The forward order scheduled -> on_the_way -> on_site -> done | no_one_home; canceled is outside it. */
const RANK: Readonly<Partial<Record<JobStatus, number>>> = { scheduled: 0, on_the_way: 1, on_site: 2, done: 3, no_one_home: 3 };

/**
 * Section 5.1 step 7: a status item applies only as a forward move (a step may be skipped: Arrived with no On my way);
 * a repeat, a backward move, a second ending, and any move from or to a status outside the order answer duplicate.
 */
export function isForwardMove(from: string, to: string): boolean {
  const a = RANK[from as JobStatus];
  const b = RANK[to as JobStatus];
  return a !== undefined && b !== undefined && b > a;
}

/** The statuses that record an arrival or an ending (section 5.1 step 9). */
export const ARRIVED_OR_ENDED: ReadonlySet<string> = new Set(['on_site', 'done', 'no_one_home']);
/** The item kinds that enter an arrival or an ending. */
export const ARRIVAL_OR_ENDING_ITEMS: ReadonlySet<string> = new Set(['arrived', 'finished', 'no_one_home']);

/**
 * Section 5.1 step 9 (FR-TEXT-19, OI-3): an On my way is history only when the job already records an arrival or an
 * ending, or when the same batch holds an Arrived, Finished or No one home item for that job. It holds in every
 * column of the table: the arrival item carries any conflict to the dispatcher.
 *
 * 1 exception keeps the table's (On my way, Status set by the office) cell: when the office set the status since the
 * app's version and no arrival or ending of this technician is in the batch or already applied on the job, the ending
 * is the office's, no item of the technician carries the conflict, so the On my way is flagged as the table says (a
 * flag changes no status and sends no text either, so FR-TEXT-19 holds). An arrival or ending of the technician
 * applied before the office's status set (`arrivalApplied`, F-472; REQUIREMENTS 4.3, FR-TEXT-19) is history only: the
 * arrival was entered first.
 */
export function onMyWayIsHistoryOnly(jobStatus: string, batchKindsForJob: readonly string[], column: ChangeColumn = 'no_change', arrivalApplied = false): boolean {
  const arrivalInBatch = batchKindsForJob.some((k) => ARRIVAL_OR_ENDING_ITEMS.has(k));
  if (arrivalInBatch || arrivalApplied) return true;
  return ARRIVED_OR_ENDED.has(jobStatus) && column !== 'status_set';
}

/** A job_change row as the classifier reads it (section 3 job_change). */
export interface HistoryRow {
  kind: string;
  actorKind: 'office' | 'technician' | 'customer' | 'system';
  fromVersion: number;
  /** The row's data: for a move, `from` and `to` with technicianId, date and windowId (office write service). */
  data: Record<string, unknown>;
}

/** The counted kinds, strongest first (section 5.1 step 5). */
export const COUNTED_ORDER: readonly Exclude<ChangeColumn, 'no_change'>[] = ['canceled', 'status_set', 'assigned', 'rescheduled', 'details'];

const technicianOf = (side: unknown): unknown =>
  side !== null && typeof side === 'object' && 'technicianId' in side ? (side as { technicianId: unknown }).technicianId : undefined;

/**
 * The column 1 history row counts in, or null when it does not count. A move of the job's technician or day counts
 * whoever made it (the office, time off, the customer): `assigned` for a change of technician (a reschedule that also
 * changed the technician included, and `unassigned_time_off`), `rescheduled` for a new date or window. `canceled`,
 * `status_set` and `details` count only when the office made them. Rows by the technician's own apps never count.
 */
export function columnOf(row: HistoryRow): Exclude<ChangeColumn, 'no_change'> | null {
  if (row.actorKind === 'technician') return null;
  switch (row.kind) {
    case 'assigned':
    case 'unassigned_time_off':
      return 'assigned';
    case 'rescheduled': {
      const from = technicianOf(row.data['from']);
      const to = technicianOf(row.data['to']);
      return from !== undefined && to !== undefined && from !== to ? 'assigned' : 'rescheduled';
    }
    case 'canceled':
    case 'status_set':
    case 'details':
      return row.actorKind === 'office' ? row.kind : null;
    default:
      return null;
  }
}

/**
 * Section 5.1 step 5: the strongest counted change among the rows with `fromVersion >= baseVersion`, with the row
 * that made it (the last of its kind), or No change. `baseVersion` null (a photo or signature) is always No change.
 */
export function classifyChange<R extends HistoryRow>(rows: readonly R[], baseVersion: number | null): { column: ChangeColumn; row: R | null } {
  if (baseVersion === null) return { column: 'no_change', row: null };
  let best: { column: ChangeColumn; row: R | null } = { column: 'no_change', row: null };
  let bestRank = COUNTED_ORDER.length;
  for (const r of rows) {
    if (r.fromVersion < baseVersion) continue;
    const c = columnOf(r);
    if (c === null) continue;
    const rank = COUNTED_ORDER.indexOf(c);
    if (rank <= bestRank) {
      best = { column: c, row: r };
      bestRank = rank;
    }
  }
  return best;
}

/** A system.clock_move row (section 3): from `atReal` the clock holds or runs as its kind says. */
export interface ClockMoveRow {
  kind: 'jump' | 'pause' | 'resume' | 'reset';
  atRealMs: number;
  toDemoMs: number;
}

/** Section 5.1 step 4: the entry instant on the server's real clock; each term comes from 1 clock. */
export const entryRealMs = (offsetSavedRealMs: number, sinceSaveMs: number): number => offsetSavedRealMs + sinceSaveMs;

/**
 * Section 5.1 step 4: the demo time at `realMs`, rebuilt from the current epoch's clock moves. The last row with
 * `atReal <= realMs` decides: after a pause or a reset the clock was held at its `toDemo`; after a jump or a resume it
 * ran from `toDemo` at `rate`. Null when no row is that early (the item's own demo time stands).
 */
export function demoTimeAtRealMs(realMs: number, moves: readonly ClockMoveRow[], rate: number): number | null {
  let last: ClockMoveRow | undefined;
  for (const m of moves) {
    if (m.atRealMs <= realMs && (last === undefined || m.atRealMs >= last.atRealMs)) last = m;
  }
  if (!last) return null;
  if (last.kind === 'pause' || last.kind === 'reset') return last.toDemoMs;
  return last.toDemoMs + Math.round((realMs - last.atRealMs) * rate);
}

/**
 * The time an item is placed at: the rebuilt demo time when there is one, never after the item reached the server
 * (an item cannot have been entered after it arrived), else the phone's own demo time. `rebased` is true when the
 * placed time differs from the phone's (section 5.1 step 4: stored as demo_time_rebased).
 */
export function placeItem(input: { phoneDemoMs: number; rebuiltMs: number | null; receivedDemoMs: number }): { atMs: number; rebased: boolean } {
  const at = Math.min(input.rebuiltMs ?? input.phoneDemoMs, input.receivedDemoMs);
  return { atMs: at, rebased: at !== input.phoneDemoMs };
}

/**
 * An item counts as entered offline when it reached the server more than this long after its entry: it waited in the
 * phone's store. Judged on the real clock (realNow('offline_entry'), section 3 note.entered_offline, FR-DEMO-9): the server's
 * real time at receipt minus the item's entryReal, never the demo clock (F-866).
 */
export const OFFLINE_AFTER_MS = 60_000;

/** Section 5.1 step 9: each batch is applied per job in demo-time order; jobs keep the order they first appear in. */
export function batchOrder<T extends { jobNumber: number; demoMs: number }>(items: readonly T[]): T[] {
  const firstSeen = new Map<number, number>();
  items.forEach((it, i) => {
    if (!firstSeen.has(it.jobNumber)) firstSeen.set(it.jobNumber, i);
  });
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) =>
      (firstSeen.get(a.it.jobNumber) as number) - (firstSeen.get(b.it.jobNumber) as number)
      || a.it.demoMs - b.it.demoMs
      || a.i - b.i)
    .map((x) => x.it);
}
