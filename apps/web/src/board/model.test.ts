// SPDX-License-Identifier: AGPL-3.0-or-later
// The day board's pure rules (model.ts): labels, block classes, where a drop lands and the conflict message's parts.
import { catalogs } from '@bw/i18n';
import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { ClientT } from '../shell/intl.tsx';
import { blockDrop, boardSkills, conflictWords, entryLines, filtered, flagValues, hourOf, jobClass, jobDrop, jobMarkerState, noRoomText, place, shortName, shortWindow, spanText, statusKey, stepDate, tabCounts, tabJobs, timeText, vanState, windowText, type BoardBlock, type BoardJob, type Van } from './model.ts';
import { sampleBoard } from './preview-fixtures.ts';

const Z = '-04:00[America/New_York]';
const at = (hm: string) => `2026-09-15T${hm}:00${Z}`;
const job = (over: Partial<BoardJob> = {}): BoardJob => ({
  jobNumber: 24825, version: 2, customerName: 'Carmen Reyes', area: 'Dublin', serviceId: 'water_heater', serviceLabelKey: 'service.water_heater.screen',
  windowId: 'w', window: { start: at('10:00'), end: at('12:00') }, technicianId: 't1', plannedArrival: at('10:20'), eta: at('10:20'), expectedMinutes: 80,
  status: 'scheduled', timing: 'onTime', lateTextSent: false, confirmed: true, position: { lon: -83, lat: 40 }, technicianSkill: 'plumbing', ...over,
});
const block: BoardBlock = { blockId: 'b1', version: 1, label: 'Supply run', place: 'Supply house', start: at('13:00'), end: at('13:30') };

describe('labels (UD-16)', () => {
  // why: FR-DISP-1 windows and block times read as the frames write them, AM and PM in both languages
  it('writes windows, block spans and times as the board frames do', () => {
    expect(windowText(at('08:00'), at('10:00'))).toBe('8-10 AM');
    expect(windowText(at('10:00'), at('12:00'))).toBe('10 AM-12 PM');
    expect(windowText(at('12:00'), at('14:00'))).toBe('12-2 PM');
    expect(spanText(at('14:00'), at('14:30'))).toBe('2:00-2:30 PM');
    expect(spanText(at('11:30'), at('12:15'))).toBe('11:30 AM-12:15 PM');
    expect(timeText(at('10:40'))).toBe('10:40 AM');
    expect(hourOf(at('10:30'))).toBe(10.5);
    const p = place(8, 10, { start: 7, end: 18 });
    expect([p.left, p.width].map((x) => x.toFixed(6))).toEqual([((1 / 11) * 100).toFixed(6), ((2 / 11) * 100).toFixed(6)]);
  });
});

describe('status words (FR-DISP-14, FR-DISP-4)', () => {
  // why: FR-DISP-4 a late or at-risk open job is drawn and named by its timing word as well as its color
  it('gives an open late or at-risk job its timing class, an on-site job its status, and an unassigned job its own', () => {
    expect(jobClass(job({ timing: 'late' }))).toBe('late');
    expect(jobClass(job({ timing: 'atRisk', status: 'on_the_way' }))).toBe('risk');
    expect(jobClass(job({ timing: 'late', status: 'on_site' }))).toBe('site');
    expect(jobClass(job({ status: 'done', timing: null }))).toBe('done');
    expect(jobClass(job({ technicianId: null, timing: null }))).toBe('unas');
    expect(statusKey(job({ status: 'on_site' }))).toBe('status.job.onSite');
    expect(statusKey(job({ status: 'done' }))).toBe('status.job.done');
  });
});

describe('drops (FR-DISP-2, FR-DISP-17, FR-DISP-34)', () => {
  // why: FR-DISP-17 released outside any row, or on its own row, no move is made
  it('moves a job only to another row, and to nobody on the Unassigned row', () => {
    expect(jobDrop(job(), { kind: 'none' })).toBeNull();
    expect(jobDrop(job(), { kind: 'tech', id: 't1' })).toBeNull();
    expect(jobDrop(job(), { kind: 'tech', id: 't2' })).toEqual({ technicianId: 't2' });
    expect(jobDrop(job(), { kind: 'unassigned' })).toEqual({ technicianId: null });
  });

  // why: FR-DISP-34 a block keeps its length, snaps to 5 minutes, and is refused on the Unassigned row with no call
  it('moves a block along its row or to another, keeping its length, and refuses the Unassigned row', () => {
    expect(blockDrop(block, 't1', { kind: 'tech', id: 't1' }, 14.02)).toEqual({ technicianId: 't1', start: '14:00', end: '14:30' });
    expect(blockDrop(block, 't1', { kind: 'tech', id: 't2' }, 13)).toEqual({ technicianId: 't2', start: '13:00', end: '13:30' });
    expect(blockDrop(block, 't1', { kind: 'tech', id: 't1' }, 13.01)).toBeNull();
    expect(blockDrop(block, 't1', { kind: 'unassigned' }, 14)).toBe('needs_technician');
    expect(blockDrop(block, 't1', { kind: 'none' }, 14)).toBeNull();
  });
});

describe('the conflict message (FR-DISP-6, owner ruling 8ef38e83)', () => {
  // why: FR-DISP-6 the message names who changed it, the change and when; with no name, who is named by kind
  it('takes who, the change and when from the version_conflict answer', () => {
    expect(conflictWords({ by: 'Keisha Thompson', byKind: 'office', change: 'moved', technician: 'Kevin Doyle', at: at('13:12'), currentVersion: 3 }))
      .toEqual({ who: { name: 'Keisha T.' }, change: 'moved', at: '1:12 PM' });
    expect(conflictWords({ by: null, byKind: 'customer', change: 'rescheduled', technician: null, at: at('09:00'), currentVersion: 2 }).who)
      .toEqual({ key: 'board.conflict.customer' });
    expect(conflictWords({ by: null, byKind: null, change: null, technician: 'Kevin Doyle', at: null, currentVersion: 1 }))
      .toEqual({ who: { key: 'board.conflict.someone' }, change: 'other', at: null });
    expect(shortName('Ana Gutierrez')).toBe('Ana G.');
    expect([stepDate('2026-09-15', 1), stepDate('2026-11-01', -1)]).toEqual(['2026-09-16', '2026-10-31']);
  });
});

describe('the map panel lists (P4-BOARD-MAP)', () => {
  const b = sampleBoard();

  // why: FR-DISP-22 each tab's count equals its listed rows and an independent count by status
  it('counts each tab by what it lists', () => {
    const f = filtered(b, null);
    const c = tabCounts(f);
    const every = [...b.technicians.flatMap((x) => x.jobs), ...b.unassigned];
    expect(c.all).toBe(every.length);
    expect(c.onTheWay).toBe(every.filter((j) => j.status === 'on_the_way').length);
    expect(c.onSite).toBe(every.filter((j) => j.status === 'on_site').length);
    expect(tabJobs(f, 'onSite').length).toBe(c.onSite);
    expect(c.attention).toBe(f.attention.rows.length + f.attention.flagged.length);
    expect(c.attention).toBe(5);
  });

  // why: FR-DISP-22 a skill leaves only the jobs of technicians with it; an unassigned job has no technician, so it goes too
  it('leaves only that skill\'s jobs, on the list and in Needs attention', () => {
    const f = filtered(b, 'plumbing');
    const ids = new Set(b.technicians.filter((x) => x.skills.includes('plumbing')).map((x) => x.id));
    expect(f.jobs.length).toBeGreaterThan(0);
    expect(f.jobs.every((j) => j.technicianId !== null && ids.has(j.technicianId))).toBe(true);
    expect(f.attention.rows.map((r) => r.customerName).sort()).toEqual(['Hale', 'Reyes']);
    expect(f.attention.flagged.map((r) => r.jobNumber)).toEqual([24791]);
  });

  // why: FR-DISP-22 the filter offers each skill of the day's technicians, once
  it('lists each skill once', () => {
    expect(boardSkills(b).sort()).toEqual(['heating_cooling', 'install', 'plumbing']);
  });

  // why: FR-DISP-19 the marker's state is the legend's word: a van on the way that runs late is red, an on-site one stays green
  it('takes a van\'s state from its current job\'s timing', () => {
    const job = { timing: 'late' } as BoardJob;
    const van = (status: Van['status']) => ({ status }) as Van;
    expect(vanState(van('on_the_way'), job)).toBe('late');
    expect(vanState(van('on_site'), job)).toBe('site');
    expect(vanState(van('on_the_way'), { timing: 'onTime' } as BoardJob)).toBe('way');
    expect(vanState(van('between_jobs'), undefined)).toBe('free');
  });

  // why: FR-DISP-19 each job marker's state names a kind the Jobs legend words
  it('takes a job marker\'s state from its timing, or from having no technician', () => {
    expect(jobMarkerState({ technicianId: null, timing: null } as BoardJob)).toBe('unas');
    expect(jobMarkerState({ technicianId: 'a', timing: 'atRisk' } as BoardJob)).toBe('risk');
    expect(jobMarkerState({ technicianId: 'a', timing: 'late' } as BoardJob)).toBe('late');
    // why: F-816 (FR-DISP-19: a begun or closed job is drawn and worded as what it is, never Scheduled job)
    for (const [status, state] of [['scheduled', 'sched'], ['on_the_way', 'way'], ['on_site', 'site'], ['done', 'closed'], ['no_one_home', 'closed']] as const) {
      expect(jobMarkerState({ technicianId: 'a', timing: null, status } as BoardJob)).toBe(state);
    }
    expect(jobMarkerState({ technicianId: 'a', timing: null, status: 'scheduled' } as BoardJob)).toBe('sched');
  });

  // why: FR-DISP-22 the list's short window column, as the frame writes it
  it('writes a short window', () => {
    expect(shortWindow('2026-09-15T10:00:00-04:00[America/New_York]', '2026-09-15T12:00:00-04:00[America/New_York]')).toBe('10-12');
    expect(shortWindow('2026-09-15T12:00:00-04:00[America/New_York]', '2026-09-15T14:00:00-04:00[America/New_York]')).toBe('12-2');
  });
});

describe('flagValues', () => {
  // why: F-933 a flagged line shows the time as the board writes it, never the server's wire time
  it('turns the wire time in a flag line into clock text and leaves every other value alone', () => {
    const v = { tech: 'Marcus', action: 'arrived', job: 24791, by: 'Keisha T.', at: at('10:12') };
    expect(flagValues(v)).toEqual({ ...v, at: '10:12 AM' });
    expect(flagValues({ ...v, at: null })).toEqual({ ...v, at: null });
    expect(flagValues({ ...v, at: '10:12 AM' })).toEqual({ ...v, at: '10:12 AM' });
  });
});

describe('the entry a flagged row shows (CTL-OFC-02-15, F-1139)', () => {
  const en = ((key: string, values?: Record<string, string | number>) =>
    createIntl({ locale: 'en', messages: catalogs.en as Record<string, string>, onError: () => undefined }).formatMessage({ id: key }, values)) as unknown as ClientT;
  // why: FR-DISP-9, owner ruling c4aa4366 the dispatcher re-enters the work without calling the technician: parts with names (the sent id for an unlisted part), labor, work-done lines, or a note's text; a status change shows none
  it('lists a finish\'s parts, labor and work done, a note\'s text, and nothing for a status change', () => {
    const finish = { kind: 'finish' as const, parts: [{ partId: 'p1', name: 'Capacitor', quantity: 2 }, { partId: 'not-a-listed-part', name: null, quantity: 1 }], noPartsUsed: false, laborMinutes: 45, workDone: ['Replaced capacitor', 'Cleaned coil'] };
    expect(entryLines(finish, en)).toEqual(['Parts: Capacitor x 2, not-a-listed-part x 1', 'Labor 45 min', 'Work done: Replaced capacitor; Cleaned coil']);
    expect(entryLines({ ...finish, parts: [], noPartsUsed: true, laborMinutes: 30, workDone: [] }, en)).toEqual(['No parts used', 'Labor 30 min']);
    expect(entryLines({ kind: 'note', text: 'Customer wants a quote' }, en)).toEqual(['Note: Customer wants a quote']);
    expect(entryLines(null, en)).toEqual([]);
  });
});

describe('the no-room refusal names its limit (F-1701)', () => {
  const tIn = (locale: 'en' | 'es') => ((key: string, values?: Record<string, string | number>) =>
    createIntl({ locale, messages: catalogs[locale] as Record<string, string>, onError: () => undefined }).formatMessage({ id: key }, values)) as unknown as ClientT;
  const text = (locale: 'en' | 'es', detail: Record<string, unknown>) => noRoomText(tIn(locale), detail, 'Chris Yoder', '12-2 PM');
  // why: F-1701 the owner moved a job to the installer and the refusal did not say why; the installer's 1 job a day is named, in both languages
  it('names the installer\'s 1 job a day', () => {
    expect(text('en', { limit: 'installer_day', max: 1 })).toBe('Chris Yoder has the installer\'s limit of 1 job a day, and that day already has one. Pick another technician.');
    expect(text('es', { limit: 'installer_day', max: 1 })).toBe('Chris Yoder es instalador y toma 1 trabajo al día, y ese día ya tiene uno. Elija otro técnico.');
  });
  // why: F-1701 a technician at the day's limit is refused by the day, with that day's number, in both languages
  it('names the day\'s limit and its number', () => {
    expect(text('en', { limit: 'day', max: 5 })).toBe('Chris Yoder already has 5 jobs that day, the most 1 day holds. Pick another technician.');
    expect(text('es', { limit: 'day', max: 5 })).toBe('Chris Yoder ya tiene 5 trabajos ese día, el máximo que cabe en 1 día. Elija otro técnico.');
  });
  // why: F-1701 a technician at the window's limit is refused by the window, named as the block shows it, in both languages
  it('names the window and its limit', () => {
    expect(text('en', { limit: 'window', max: 2 })).toBe('Chris Yoder already has 2 jobs in that window, 12-2 PM, the most 1 window holds. Pick another technician.');
    expect(text('es', { limit: 'window', max: 2 })).toBe('Chris Yoder ya tiene 2 trabajos en esa ventana, 12-2 PM, el máximo que cabe en 1 ventana. Elija otro técnico.');
  });
  // why: F-1813 the kernel always sends the limit, so an answer without one is a server fault and names no limit
  it('gives no text when the answer names no limit', () => {
    expect(noRoomText(((k: string) => k) as never, {}, 'Chris Yoder', '12-2 PM')).toBeNull();
  });
});
