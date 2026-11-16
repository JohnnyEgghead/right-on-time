// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createBellSeen } from './bell-seen.ts';

type A = { id: string };
const list = (...ids: string[]): A[] => ids.map((id) => ({ id }));

/** The CMP-11 "New alert" announcements a run of landings makes. */
function announced(landings: { added: A | undefined; announce: boolean; stale?: boolean }[]): string[] {
  return landings.filter((l) => l.announce && l.added).map((l) => l.added!.id);
}

// why: F-1809 1 alert check transaction publishes alert.created and alert.dismissed together; the bell re-reads on both, and the
// non-announcing re-read of alert.dismissed must not swallow the New alert announcement when it lands first
describe('the bell announces a new alert once, whatever order its re-reads land in (F-1809)', () => {
  it('announces once when the alert.dismissed re-read lands before the alert.created one', () => {
    const seen = createBellSeen<A>();
    seen.begin(false)(list('a1', 'a0')); // the first read: records, no diff
    const created = seen.begin(true); // alert.created
    const dismissed = seen.begin(false); // alert.dismissed, same transaction
    const landings = [dismissed(list('a2', 'a1', 'a0')), created(list('a2', 'a1', 'a0'))];
    expect(announced(landings)).toEqual(['a2']);
  });

  it('announces once when the alert.created re-read lands first', () => {
    const seen = createBellSeen<A>();
    seen.begin(false)(list('a1'));
    const created = seen.begin(true);
    const dismissed = seen.begin(false);
    const landings = [created(list('a2', 'a1')), dismissed(list('a2', 'a1'))];
    expect(announced(landings)).toEqual(['a2']);
  });

  it('keeps alert.dismissed silent when no new alert arrived', () => {
    const seen = createBellSeen<A>();
    seen.begin(false)(list('a1'));
    const landing = seen.begin(false)(list('a1'));
    expect(landing.announce).toBe(false);
    // A silent read that finds a new alert with no alert.created out (the panel opening) marks it fresh but does not announce.
    const opened = seen.begin(false)(list('a2', 'a1'));
    expect(opened).toEqual({ added: { id: 'a2' }, announce: false, stale: false });
  });

  it('owes nothing after the alert.created read lands, even when it failed', () => {
    const seen = createBellSeen<A>();
    seen.begin(false)(list('a1'));
    seen.begin(true)(null);
    expect(seen.begin(false)(list('a2', 'a1')).announce).toBe(false);
  });

  it('a fresh world owes nothing for reads begun before it', () => {
    const seen = createBellSeen<A>();
    seen.begin(false)(list('a1'));
    seen.begin(true); // out when the world resets
    seen.reset();
    seen.begin(false)(list('b1'));
    expect(seen.begin(false)(list('b2', 'b1')).announce).toBe(false);
  });
});

// why: F-1812 a read that began in another world, or before 1 that already landed, brings a list the panel must not draw
describe('a landing that is out of date is flagged stale (F-1812)', () => {
  it('flags a read from the world left, and keeps its list out of the seen set', () => {
    const seen = createBellSeen<A>();
    const old = seen.begin(false);
    seen.reset();
    expect(seen.begin(false)(list('b1')).stale).toBe(false);
    expect(old(list('a1', 'a2')).stale).toBe(true);
    // the seen set is still the new world's: b2 is new, a1 is not what it was compared with
    const next = seen.begin(false)(list('b2', 'b1'));
    expect(next.added?.id).toBe('b2');
  });

  it('flags a read older than 1 that already landed, not one that began later', () => {
    const seen = createBellSeen<A>();
    const first = seen.begin(false);
    const second = seen.begin(false);
    expect(second(list('a1')).stale).toBe(false);
    expect(first(list()).stale).toBe(true);
    expect(seen.begin(false)(list('a1')).stale).toBe(false);
  });
});
