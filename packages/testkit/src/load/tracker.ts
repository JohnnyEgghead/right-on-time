// SPDX-License-Identifier: AGPL-3.0-or-later
// The board delay instrument (P4-LOAD, NFR-01). 1 change is shown on 1 board when a finished API-20 read on that board
// carries the change's job at the version the write makes, or a later one: the words of NFR-01 ("show any change") are about
// what the board holds, so the event's arrival alone never counts. All times are 1 monotonic clock in 1 process
// (performance.now() in the driver), so the delay needs no clock sync; it starts just before the write is sent, so it holds
// the write's way up and the board read's way back (an upper bound on the server's part, as in G-S1-SSE).

interface Open { change: number; jobNumber: number; version: number; sentAt: number }

export class DelayTracker {
  readonly #boardsOf: ReadonlyMap<string, readonly string[]>;
  readonly #open = new Map<string, Map<number, Open[]>>();
  #nextChange = 1;
  #cancelled = new Set<number>();
  /** Every measured delay, ms. */
  readonly delaysMs: number[] = [];

  /** boardsByBranch: the board session ids open on each branch. */
  constructor(boardsByBranch: ReadonlyMap<string, readonly string[]>) {
    this.#boardsOf = boardsByBranch;
    for (const boards of boardsByBranch.values()) for (const b of boards) this.#open.set(b, new Map());
  }

  /** A write is about to go out: every open board of its branch now owes this change. Answers the change id. */
  expect(branch: string, jobNumber: number, version: number, sentAt: number): number {
    const change = this.#nextChange++;
    for (const board of this.#boardsOf.get(branch) ?? []) {
      const byJob = this.#open.get(board) as Map<number, Open[]>;
      const list = byJob.get(jobNumber);
      const open = { change, jobNumber, version, sentAt };
      if (list) list.push(open);
      else byJob.set(jobNumber, [open]);
    }
    return change;
  }

  /** The write was refused or failed: no board owes it. Delays it already earned stay out too, since nothing changed. */
  cancel(change: number): void {
    this.#cancelled.add(change);
    for (const byJob of this.#open.values()) {
      for (const [job, list] of byJob) {
        const left = list.filter((o) => o.change !== change);
        if (left.length === 0) byJob.delete(job);
        else byJob.set(job, left);
      }
    }
  }

  /** A read of `board` finished at `at`, holding these job versions. */
  seen(board: string, versions: ReadonlyMap<number, number>, at: number): void {
    const byJob = this.#open.get(board);
    if (!byJob) throw new Error(`no such board session: ${board}`);
    for (const [job, list] of byJob) {
      const held = versions.get(job);
      if (held === undefined) continue;
      const left: Open[] = [];
      for (const o of list) {
        if (held >= o.version) this.delaysMs.push(at - o.sentAt);
        else left.push(o);
      }
      if (left.length === 0) byJob.delete(job);
      else byJob.set(job, left);
    }
  }

  /** Change-board pairs still owed. */
  get owed(): number {
    let n = 0;
    for (const byJob of this.#open.values()) for (const list of byJob.values()) n += list.length;
    return n;
  }
}

/** The job versions an API-20 answer holds. */
export function boardVersions(board: { technicians: readonly { jobs: readonly { jobNumber: number; version: number }[] }[]; unassigned: readonly { jobNumber: number; version: number }[] }): Map<number, number> {
  const out = new Map<number, number>();
  for (const j of board.unassigned) out.set(j.jobNumber, j.version);
  for (const t of board.technicians) for (const j of t.jobs) out.set(j.jobNumber, j.version);
  return out;
}
