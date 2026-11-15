// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createLatest } from './search-latest.ts';

/** A read that answers when the test says so. */
function slow<T>(): { read: () => Promise<T>; answer: (v: T) => void } {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => (resolve = r));
  return { read: () => p, answer: (v) => resolve(v) };
}

// why: F-229 a slow answer to an older query must never replace the answer to a newer one
describe('the top-bar search shows the newest query only (F-229)', () => {
  it("drops an older query's answer that lands after the newer query's", async () => {
    const latest = createLatest();
    const shown: string[] = [];
    const first = slow<string>();
    const second = slow<string>();
    const a = latest.run(first.read, (v) => shown.push(v));
    const b = latest.run(second.read, (v) => shown.push(v));
    second.answer('answer to hi');
    first.answer('answer to h'); // lands last, but is the older query's
    expect(await Promise.all([a, b])).toEqual([false, true]);
    expect(shown).toEqual(['answer to hi']);
  });

  it('drops an answer that lands after the box was cleared or the query changed', async () => {
    const latest = createLatest();
    const shown: string[] = [];
    const first = slow<string>();
    const a = latest.run(first.read, (v) => shown.push(v));
    latest.invalidate();
    first.answer('late');
    expect(await a).toBe(false);
    expect(shown).toEqual([]);
  });

  it('shows the answer when nothing newer began', async () => {
    const latest = createLatest();
    const shown: string[] = [];
    expect(await latest.run(async () => 'ok', (v) => shown.push(v))).toBe(true);
    expect(shown).toEqual(['ok']);
  });
});
