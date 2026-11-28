// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDraft, isBookingKey, newBookingKey, openKept, writeKept, type Kept } from './model.ts';

/** This tab's session storage, as the page keeps the draft in it (UIS.FR-STATE-4). */
function storage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k),
  };
}
const g = globalThis as { window?: unknown };
beforeEach(() => {
  g.window = { sessionStorage: storage() };
});
afterEach(() => {
  delete g.window;
});

/** The address bar of the page: `/book?new=1` after Book another visit. */
function address(start: string) {
  const a = { url: start };
  return { a, fresh: () => new URL(a.url, 'http://x').searchParams.get('new') === '1', drop: () => { a.url = '/book'; } };
}

describe('the kept draft as the page opens (K-08.14)', () => {
  // why: K-08 item 14: Book another visit's ?new=1 stayed in the address, so every reload of the new draft wiped it again
  it('wipes once on ?new=1 and keeps the new draft on the next reload', () => {
    writeKept({ draft: { ...emptyDraft('en'), name: 'Old Visit' }, step: 6, taken: null });
    const bar = address('/book?new=1');
    expect(openKept(bar.fresh(), bar.drop)).toBeNull();
    expect(bar.a.url).toBe('/book');
    const next: Kept = { draft: { ...emptyDraft('en'), name: 'New Visit' }, step: 2, taken: null };
    writeKept(next);
    // The reload: the page opens again from the address it now has.
    expect(openKept(bar.fresh(), bar.drop)).toEqual(next);
  });
});

describe('the draft booking key (K-01; SPECIFICATIONS 6.1 Booking write)', () => {
  // why: K-01 the key is a UUID v4 from crypto.getRandomValues, and each new draft has its own
  it('makes a UUID v4 per draft, with the version and variant bits set', () => {
    expect(newBookingKey(() => new Uint8Array(16).fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(newBookingKey(() => new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000');
    const a = emptyDraft('en').bookingKey;
    expect([isBookingKey(a), a === emptyDraft('en').bookingKey]).toEqual([true, false]);
  });

  // why: K-01 the key stays with the draft across a reload, and a draft kept before it had a key gets one
  it('keeps the kept key on reopen and gives a keyless kept draft a new key', () => {
    const kept: Kept = { draft: emptyDraft('en'), step: 3, taken: null };
    writeKept(kept);
    expect(openKept(false, () => undefined)?.draft.bookingKey).toBe(kept.draft.bookingKey);
    const { bookingKey: _old, ...keyless } = kept.draft;
    void _old;
    writeKept({ ...kept, draft: keyless as Kept['draft'] });
    expect(isBookingKey(openKept(false, () => undefined)?.draft.bookingKey)).toBe(true);
  });
});
