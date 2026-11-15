// SPDX-License-Identifier: AGPL-3.0-or-later
// The finish screen's reading of a refused finish (model.ts refusedFinish, draftFromRefused; F-1025): the screen corrects the item
// the server refused for want of parts, rebuilt as the entries the technician sent, rather than entering a second finish.
import type { QueuedItem } from '@bw/outbox/src/items/index.ts';
import { describe, expect, it } from 'vitest';
import { draftFromRefused, enteredWords, refusedFinish, rowLink, shownAsToday, shownStatus } from './model.ts';

const PARTS = [{ partId: 'p-1', name: 'Pleated filter 16x25x4', code: 'FLT-16254' }, { partId: 'p-2', name: 'Flame sensor', code: 'IGN-FS1' }] as never[];
const fin = (o: Partial<QueuedItem> = {}) => ({
  key: 'k-1', jobNumber: 24830, kind: 'finished', payload: { parts: [{ partId: 'p-2', quantity: 2 }, { partId: 'gone', quantity: 1 }], noPartsUsed: false, laborMinutes: 129, workDone: ['Cleaned the flame sensor'] }, ...o,
}) as unknown as QueuedItem;

describe('SCR-TEC-09 refused finish row', () => {
  // why: FR-BILL-3, F-1048 the refused-finish row (SCR-TEC-09) keeps role link, tabIndex 0, and a click or Enter reaching /tech/jobs/n/finish, while a plain row stays no link
  it('is a link to the job\'s finish screen for click and Enter, and a waiting row is not', () => {
    const refused = fin({ lastTry: { atRealMs: 1, outcome: 'refused', code: 'parts_required' } });
    const went: string[] = [];
    const l = rowLink(refused, (h) => went.push(h));
    expect(l).toMatchObject({ role: 'link', tabIndex: 0 });
    l.onClick!();
    l.onKeyDown!({ key: 'Enter' });
    l.onKeyDown!({ key: 'a' });
    expect(went).toEqual(['/tech/jobs/24830/finish', '/tech/jobs/24830/finish']);
    expect(rowLink(fin(), () => undefined)).toEqual({});
    expect(rowLink(fin({ lastTry: { atRealMs: 1, outcome: 'refused', code: 'other' } as never }), () => undefined)).toEqual({});
  });
});

describe('a refused finish on the finish screen', () => {
  // why: FR-BILL-3, F-1025 only this job's finish refused parts_required is the one a corrected finish replaces
  it('finds the job\'s finish refused for parts, and no other', () => {
    const refused = fin({ lastTry: { atRealMs: 1, outcome: 'refused', code: 'parts_required' } });
    expect(refusedFinish(24830, [fin(), refused])?.key).toBe('k-1');
    expect(refusedFinish(24830, [fin()])).toBeNull(); // waiting, not refused
    expect(refusedFinish(24830, [fin({ lastTry: { atRealMs: 1, outcome: 'network' } })])).toBeNull();
    expect(refusedFinish(24871, [refused])).toBeNull();
  });

  // why: FR-TECH-14, F-1025 the screen reopens with what was sent: listed parts named, labor in hours and minutes, the work-done lines
  it('rebuilds the entries from the refused payload, leaving out a part no longer on the list', () => {
    const p = (fin() as QueuedItem & { payload: never }).payload;
    expect(draftFromRefused(24830, p, PARTS)).toEqual({
      jobNumber: 24830, parts: [{ partId: 'p-2', name: 'Flame sensor', code: 'IGN-FS1', quantity: 2 }], noPartsUsed: false,
      hours: '2', minutes: '9', workDone: ['Cleaned the flame sensor'], signature: null,
    });
  });
});

describe('when a waiting item was entered', () => {
  // why: FR-TECH-7 an item entered on another demo day than today says the day (DK-111 Old items: "entered Mon, Sep 14, 11:01 AM")
  it('says the time for today, and the short date with it for another day', () => {
    const now = Date.parse('2026-09-15T10:28:00-04:00');
    expect(enteredWords('2026-09-15T11:04:00-04:00[America/New_York]', now, 'en')).toBe('11:04 AM');
    expect(enteredWords('2026-09-14T11:01:00-04:00[America/New_York]', now, 'en')).toBe('Mon, Sep 14, 11:01 AM');
    expect(enteredWords('2026-09-14T11:01:00-04:00[America/New_York]', null, 'en')).toBe('11:01 AM'); // no clock read yet
  });
});

describe('the phone number only for today\'s jobs on a kept copy', () => {
  const job = (today: boolean) => ({ job: { today, window: { start: '2026-09-15T10:00:00-04:00[America/New_York]' } } }) as never;
  const sep15 = Date.parse('2026-09-15T16:00:00Z');
  const sep16 = Date.parse('2026-09-16T16:00:00Z');

  // why: FR-AUTH-4 (F-1034) a Sep 15 copy opened on a later demo day does not offer the customer's number
  it('is today only while the phone\'s own demo date is the job\'s day', () => {
    expect(shownAsToday(job(true), sep15, true)).toBe(true);
    expect(shownAsToday(job(true), sep16, true)).toBe(false);
    expect(shownAsToday(job(false), sep15, false)).toBe(false);
  });

  it('trusts the server\'s word on a fresh read, and not a kept copy, while the demo date is unknown', () => {
    expect(shownAsToday(job(true), null, false)).toBe(true);
    expect(shownAsToday(job(true), null, true)).toBe(false);
  });
});

describe('a refused finish keeps the job On site (F-1025)', () => {
  const job = { job: { jobNumber: 24830, status: 'on_site', version: 3 } } as never;
  const refused = fin({ lastTry: { atRealMs: 1, outcome: 'refused', code: 'parts_required' } });
  // why: FR-BILL-3, F-1025 UI-SPECIFICATION 4.5 rule 10: the finish screen reopens, so the job must still show its Finish link (On site), not Done
  it('shows the job On site, not Done, while its finish is refused for parts', () => {
    expect(shownStatus(job, [refused]).status).toBe('on_site');
    expect(shownStatus(job, [fin()]).status).toBe('done'); // a finish merely waiting still shows Done
    expect(shownStatus(job, [fin({ lastTry: { atRealMs: 1, outcome: 'network' } })]).status).toBe('done');
  });
});
