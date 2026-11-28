// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookingApi } from './api.ts';
import type { StreetState } from './BookingView.tsx';
import { createStreetSearch } from './street-search.ts';

type Answer = Awaited<ReturnType<BookingApi['streets']>>;
const MAPLE: Answer = { ok: true, data: { streets: [{ streetId: 's1', name: 'Maple Hollow Ct', city: 'Westerville', zip: '43081', branch: 'columbus' }] } };

/** A street search whose answers land when the test says so. */
function rig() {
  const waiting: ((a: Answer) => void)[] = [];
  const asked: string[] = [];
  const shown: StreetState['kind'][] = [];
  const streets: BookingApi['streets'] = (q) => {
    asked.push(q);
    return new Promise<Answer>((r) => waiting.push(r));
  };
  const search = createStreetSearch(streets, (s) => shown.push(s.kind), 200);
  return { search, asked, shown, answer: (i: number, a: Answer) => waiting[i]?.(a) };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the street field search (API-111; K-08.15)', () => {
  // why: FR-BOOK-12 K-08 item 15: the idle branch did not bump the street sequence, so a slow answer to a cleared text showed results under an empty field
  it('leaves the field idle when the text is typed and then cleared before the answer lands', async () => {
    const r = rig();
    r.search.typed('Ma');
    await vi.advanceTimersByTimeAsync(200);
    expect(r.asked).toEqual(['Ma']);
    r.search.typed('');
    r.answer(0, MAPLE);
    await flush();
    expect(r.shown).toEqual(['loading', 'idle']);
  });

  // why: FR-BOOK-12 K-08 item 15: the search shows its newest text's answer only; an older text's late answer is dropped
  it("shows the newest text's answer, not an older one that lands later", async () => {
    const r = rig();
    r.search.typed('Ma');
    await vi.advanceTimersByTimeAsync(200);
    r.search.typed('Map');
    await vi.advanceTimersByTimeAsync(200);
    r.answer(1, MAPLE);
    r.answer(0, { ok: true, data: { streets: [] } });
    await flush();
    expect(r.asked).toEqual(['Ma', 'Map']);
    expect(r.shown).toEqual(['loading', 'loading', 'results']);
  });

  // why: FR-BOOK-12 K-08 item 15: picking a street ends the search: an answer still waiting must not reopen the result list
  it('drops a waiting answer once a street is picked', async () => {
    const r = rig();
    r.search.typed('Ma');
    await vi.advanceTimersByTimeAsync(200);
    r.search.stop();
    r.answer(0, MAPLE);
    await flush();
    expect(r.shown).toEqual(['loading']);
  });
});
