// SPDX-License-Identifier: AGPL-3.0-or-later
// The pure technician item rules (SPECIFICATIONS section 5.1 steps 4 to 9). The 36 server cases of the conflict table
// run on PostgreSQL in gate G-CI1 (ci/gates/G-CI1/cells.db.test.ts), and G-CI1 holds the constant to REQUIREMENTS'
// own table (ci/gates/G-CI1/table.test.ts).
import { describe, expect, it } from 'vitest';
import {
  batchOrder, classifyChange, columnOf, conflictVerdict, demoTimeAtRealMs, entryRealMs, isForwardMove,
  onMyWayIsHistoryOnly, placeItem, type ClockMoveRow, type HistoryRow, type JobChangeKind,
} from './techItems.ts';

describe('the offline conflict table constant (FR-TECH-6)', () => {
  // why: FR-TECH-6
  it('fails an unlisted pair', () => {
    expect(() => conflictVerdict('signature', 'no_change')).toThrow(/no cell/);
    expect(() => conflictVerdict('note', 'merged')).toThrow(/no cell/);
  });
});

const row = (kind: JobChangeKind, actorKind: HistoryRow['actorKind'], fromVersion: number, data: Record<string, unknown> = {}): HistoryRow =>
  ({ kind, actorKind, fromVersion, data });

describe('the job_change kind is a closed union (K-18; F-2009)', () => {
  // why: K-18 a misspelled job_change kind fails tsc (the directive below is an error on its own if the kind is a plain string), and a known kind compiles
  it('refuses a misspelled kind at compile time and still reads a known one', () => {
    // @ts-expect-error 'cancelled' is not a job_change kind (the spelling is 'canceled')
    const typo: HistoryRow = { kind: 'cancelled', actorKind: 'office', fromVersion: 1, data: {} };
    expect(columnOf({ ...typo, kind: 'canceled' })).toBe('canceled');
  });
});

describe('classifying the change since the app last read the job (section 5.1 step 5)', () => {
  // why: FR-TECH-6
  it('counts moves by anyone and cancel, status set and details only by the office, strongest first', () => {
    expect(columnOf(row('assigned', 'office', 3))).toBe('assigned');
    expect(columnOf(row('unassigned_time_off', 'office', 3))).toBe('assigned');
    expect(columnOf(row('rescheduled', 'customer', 3, { from: { technicianId: 'a' }, to: { technicianId: 'a' } }))).toBe('rescheduled');
    expect(columnOf(row('rescheduled', 'office', 3, { from: { technicianId: 'a' }, to: { technicianId: null } }))).toBe('assigned');
    expect(columnOf(row('canceled', 'customer', 3))).toBeNull();
    expect(columnOf(row('details', 'office', 3))).toBe('details');
    expect(columnOf(row('status', 'technician', 3))).toBeNull();
    expect(columnOf(row('billing_sent', 'system', 3))).toBeNull();
    const rows = [row('details', 'office', 4), row('rescheduled', 'office', 5), row('assigned', 'office', 6), row('note_added', 'technician', 7)];
    expect(classifyChange(rows, 4).column).toBe('assigned');
    expect(classifyChange(rows, 7).column).toBe('no_change');
    expect(classifyChange([...rows, row('canceled', 'office', 8)], 4).column).toBe('canceled');
    expect(classifyChange(rows, null).column).toBe('no_change');
  });

  // why: FR-TECH-6
  it('ignores rows before the base version and names the last row of the strongest kind', () => {
    const a = row('assigned', 'office', 2);
    const b = row('assigned', 'office', 5);
    expect(classifyChange([a, b], 3)).toEqual({ column: 'assigned', row: b });
    expect(classifyChange([a], 3)).toEqual({ column: 'no_change', row: null });
  });
});

describe('the forward-move rule and the late On my way (section 5.1 steps 7 and 9)', () => {
  // why: FR-TECH-6, FR-TEXT-19
  it('applies forward moves only, skipping allowed', () => {
    expect(isForwardMove('scheduled', 'on_the_way')).toBe(true);
    expect(isForwardMove('scheduled', 'on_site')).toBe(true);
    expect(isForwardMove('on_site', 'done')).toBe(true);
    expect(isForwardMove('on_site', 'on_the_way')).toBe(false);
    expect(isForwardMove('done', 'no_one_home')).toBe(false);
    expect(isForwardMove('on_the_way', 'on_the_way')).toBe(false);
    expect(isForwardMove('canceled', 'on_site')).toBe(false);
  });

  // why: FR-TEXT-19
  it('makes an On my way history only after an arrival or ending, or beside one in the same batch', () => {
    expect(onMyWayIsHistoryOnly('on_site', [])).toBe(true);
    expect(onMyWayIsHistoryOnly('no_one_home', [])).toBe(true);
    expect(onMyWayIsHistoryOnly('scheduled', ['on_my_way', 'arrived'])).toBe(true);
    expect(onMyWayIsHistoryOnly('scheduled', ['on_my_way', 'note'])).toBe(false);
    expect(onMyWayIsHistoryOnly('on_site', [], 'assigned')).toBe(true);
  });

  // why: FR-TECH-6, FR-TEXT-19
  it('keeps the table\'s Flag when the ending is the office\'s status set and no arrival of the technician carries it', () => {
    expect(onMyWayIsHistoryOnly('done', ['on_my_way'], 'status_set')).toBe(false);
    expect(onMyWayIsHistoryOnly('done', ['on_my_way', 'arrived'], 'status_set')).toBe(true);
    // F-472: an arrival applied before the office's status set (not in this batch) is entered first, so the late On my way is history only.
    expect(onMyWayIsHistoryOnly('done', ['on_my_way'], 'status_set', true)).toBe(true);
  });

  // why: FR-TEXT-19
  it('orders a batch per job by demo time, jobs in first-seen order', () => {
    const items = [{ jobNumber: 2, demoMs: 50, id: 'a' }, { jobNumber: 1, demoMs: 40, id: 'b' }, { jobNumber: 2, demoMs: 10, id: 'c' }];
    expect(batchOrder(items).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });
});

const M = 60_000;
const H = 60 * M;

describe('the re-base on the server clock (FR-DEMO-9, section 5.1 step 4)', () => {
  // Real times count from the offset's save at real 0; the demo clock read 10:00 (as ms) then.
  const TEN = 10 * H;
  const running: ClockMoveRow = { kind: 'resume', atRealMs: -30 * M, toDemoMs: TEN - 30 * M };

  // why: FR-DEMO-9
  it('keeps a note entered at 10:41 then sent after a 2-hour jump at 10:41 (no re-base)', () => {
    const moves = [running, { kind: 'jump' as const, atRealMs: 50 * M, toDemoMs: TEN + 50 * M + 2 * H }];
    const rebuilt = demoTimeAtRealMs(entryRealMs(0, 41 * M), moves, 1);
    expect(rebuilt).toBe(TEN + 41 * M);
    expect(placeItem({ phoneDemoMs: TEN + 41 * M, rebuiltMs: rebuilt, receivedDemoMs: TEN + 3 * H })).toEqual({ atMs: TEN + 41 * M, rebased: false });
  });

  // why: FR-DEMO-9
  it('re-bases by 2 hours a note whose entry follows a jump the phone never saw', () => {
    const moves = [running, { kind: 'jump' as const, atRealMs: 20 * M, toDemoMs: TEN + 20 * M + 2 * H }];
    const rebuilt = demoTimeAtRealMs(41 * M, moves, 1);
    expect(rebuilt).toBe(TEN + 41 * M + 2 * H);
    expect(placeItem({ phoneDemoMs: TEN + 41 * M, rebuiltMs: rebuilt, receivedDemoMs: TEN + 3 * H }).rebased).toBe(true);
  });

  // why: FR-DEMO-9
  it('holds the time across a pause in force at the save and across the post-reset pause', () => {
    expect(demoTimeAtRealMs(41 * M, [{ kind: 'pause', atRealMs: -5 * M, toDemoMs: TEN }], 1)).toBe(TEN);
    expect(demoTimeAtRealMs(41 * M, [{ kind: 'reset', atRealMs: -1 * M, toDemoMs: 7 * H }], 1)).toBe(7 * H);
    expect(demoTimeAtRealMs(41 * M, [{ kind: 'reset', atRealMs: -1 * M, toDemoMs: 7 * H }, { kind: 'resume', atRealMs: 30 * M, toDemoMs: 7 * H }], 1)).toBe(7 * H + 11 * M);
  });

  // why: FR-DEMO-9
  it('cancels a phone clock set 5 minutes off: both terms of the entry instant come from 1 clock each', () => {
    // The phone reads 5 minutes fast at the save and at entry; sinceSaveMs is its own difference.
    const phoneAtSave = 5 * M;
    const phoneAtEntry = 41 * M + 5 * M;
    expect(entryRealMs(0, phoneAtEntry - phoneAtSave)).toBe(41 * M);
    expect(demoTimeAtRealMs(41 * M, [running], 1)).toBe(TEN + 41 * M);
  });

  // why: FR-DEMO-9
  it('leaves the phone time when no move is that early, and never places an item after it arrived', () => {
    expect(demoTimeAtRealMs(-H, [running], 1)).toBeNull();
    expect(placeItem({ phoneDemoMs: TEN, rebuiltMs: null, receivedDemoMs: TEN + M })).toEqual({ atMs: TEN, rebased: false });
    expect(placeItem({ phoneDemoMs: TEN + 2 * H, rebuiltMs: null, receivedDemoMs: TEN + M })).toEqual({ atMs: TEN + M, rebased: true });
  });
});
