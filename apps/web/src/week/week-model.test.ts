// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { WEEK_FIXTURE, WEEK_LIVE_FIXTURE } from './week-fixtures.ts';
import {
  addDays, cellView, changedCells, clockLabel, dayBoardHref, eventIsForBranch, hourLabel, mondayOf, percent, tiles, WEEK_EVENTS, weekHref, weekParamMonday, windowLabel, wireClock,
} from './week-model.ts';

describe('the Week board model (SCR-OFC-34)', () => {
  // why: FR-DISP-23 the week runs Monday to Saturday and is named by its Monday
  it('finds the Monday of any day and steps by days', () => {
    expect(mondayOf('2026-09-15')).toBe('2026-09-14');
    expect(mondayOf('2026-09-14')).toBe('2026-09-14');
    expect(mondayOf('2026-09-20')).toBe('2026-09-14');
    expect(addDays('2026-09-14', 5)).toBe('2026-09-19');
    expect(addDays('2026-09-14', -7)).toBe('2026-09-07');
  });

  // why: UC-15 a day's header, a cell and Assign open the day board on that date, in the branch's board
  it('links to the day board by branch and date, and to a week by its Monday', () => {
    expect(dayBoardHref('columbus', '2026-09-16')).toBe('/office/board?branch=columbus&date=2026-09-16');
    expect(weekHref('dayton', '2026-09-21')).toBe('/office/board/week?branch=dayton&week=2026-09-21');
  });

  // why: FR-DISP-23 CTL-OFC-02-20 Week opens the week that holds the shown day; API-132 refuses a week that is not a Monday (F-1537)
  it('maps any date in a week param to its Monday, and the board link for a Tuesday names the Monday', () => {
    expect(weekParamMonday('2026-09-15')).toBe('2026-09-14');
    expect(weekParamMonday('2026-09-20')).toBe('2026-09-14');
    expect(weekParamMonday('2026-09-14')).toBe('2026-09-14');
    expect(weekParamMonday('2026-02-30')).toBeNull();
    expect(weekParamMonday('soon')).toBeNull();
    expect(weekParamMonday(null)).toBeNull();
    expect(weekHref('columbus', '2026-09-15')).toBe('/office/board/week?branch=columbus&week=2026-09-14');
  });

  // why: FR-DISP-23 times read "8 AM-12 PM" and "12-2 PM", with AM and PM in both languages (UD-16)
  it('writes a window the way the frame does', () => {
    expect(windowLabel({ hour: 8, minute: 0 }, { hour: 12, minute: 0 })).toBe('8 AM-12 PM');
    expect(windowLabel({ hour: 12, minute: 0 }, { hour: 14, minute: 0 })).toBe('12-2 PM');
    expect(windowLabel({ hour: 10, minute: 0 }, { hour: 14, minute: 0 })).toBe('10 AM-2 PM');
    expect(hourLabel('08:00')).toBe('8 AM');
    expect(clockLabel(16, 10)).toBe('4:10 PM');
    expect(wireClock('2026-09-14T16:10:00-04:00[America/New_York]')).toEqual({ date: '2026-09-14', hour: 16, minute: 10 });
  });

  // why: FR-DISP-23 a cell says its booked of capacity, Full or n open, Done on a past day, All day for an install, and Day off
  it('turns an API cell into what the grid shows', () => {
    const w = WEEK_FIXTURE;
    const ortega = w.technicians.find((t) => t.id === 'ortega')!;
    expect(cellView(ortega.cells[0]!, w.days[0]!, w.today, false)).toMatchObject({ kind: 'load', word: 'done', booked: 5, capacity: 5, classes: ' past' });
    expect(cellView(ortega.cells[1]!, w.days[1]!, w.today, false)).toMatchObject({ kind: 'load', word: 'open', open: 1, classes: ' today' });
    expect(cellView(ortega.cells[2]!, w.days[2]!, w.today, false)).toMatchObject({ kind: 'load', word: 'full', full: true, classes: ' peak' });
    const bell = w.technicians.find((t) => t.id === 'bell')!;
    expect(cellView(bell.cells[5]!, w.days[5]!, w.today, false)).toEqual({ kind: 'off' });
    const yoder = w.technicians.find((t) => t.id === 'yoder')!;
    expect(cellView(yoder.cells[1]!, w.days[1]!, w.today, true)).toMatchObject({ kind: 'install', installs: 1 });
  });

  // why: FR-DISP-23 the summary tiles sum the grid's own numbers: jobs, percent of capacity, peak days, Unassigned
  it('sums the week for the 4 tiles from the days', () => {
    const t = tiles(WEEK_FIXTURE);
    expect(t.peakDays).toBe(2);
    expect(t.unassigned).toBe(3);
    expect(t.unassignedDates).toEqual(['2026-09-15']);
    const booked = WEEK_FIXTURE.days.reduce((n, d) => n + d.booked, 0);
    const capacity = WEEK_FIXTURE.days.reduce((n, d) => n + d.capacity, 0);
    expect(t.jobs).toBe(booked);
    expect(t.percent).toBe(percent(booked, capacity));
    expect(t.open).toBe(capacity - booked);
    expect(percent(1, 0)).toBe(0);
  });

  // why: FR-DISP-23 the Live state marks the cells a re-read changed, and only those
  it('marks the cells whose booked count changed between two reads of the same week', () => {
    expect([...changedCells(WEEK_FIXTURE, WEEK_LIVE_FIXTURE)]).toEqual(['ortega|2026-09-17']);
    expect([...changedCells(null, WEEK_LIVE_FIXTURE)]).toEqual([]);
    expect([...changedCells(WEEK_FIXTURE, { ...WEEK_LIVE_FIXTURE, week: '2026-09-21' })]).toEqual([]);
  });

  // why: FR-DISP-23 the grid re-reads on the events its Live row names, for its own branch only (EVT-01, EVT-02, EVT-05, EVT-06, EVT-09, EVT-10)
  it('re-reads on the 6 events and ignores another branch\'s', () => {
    expect([...WEEK_EVENTS].sort()).toEqual(['block.changed', 'board.refresh', 'clock.changed', 'job.changed', 'settings.changed', 'world.reset']);
    expect(eventIsForBranch({ ids: { jobNumber: 24800, branch: 'columbus' } }, 'columbus')).toBe(true);
    expect(eventIsForBranch({ ids: { jobNumber: 24800, branch: 'dayton' } }, 'columbus')).toBe(false);
    expect(eventIsForBranch({ ids: { branch: 'all' } }, 'columbus')).toBe(true);
    expect(eventIsForBranch({ ids: {} }, 'columbus')).toBe(true);
  });
});
