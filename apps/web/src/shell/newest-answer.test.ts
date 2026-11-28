// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Latest } from './search-latest.ts';
import { useNewestAnswer } from './newest-answer.ts';

/** The hook's object, taken from inside a render (a hook runs only in a component). */
function held(): Latest {
  let got: Latest | null = null;
  function Probe() {
    got = useNewestAnswer();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (got === null) throw new Error('the hook returned nothing');
  return got;
}

/** A read that answers when the test says so. */
function slow<T>(): { read: () => Promise<T>; answer: (v: T) => void } {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => (resolve = r));
  return { read: () => p, answer: (v) => resolve(v) };
}

// why: F-2007 an office read whose request changes showed the answer that landed last, not the answer to the newest request (K-05)
describe('useNewestAnswer (F-2007)', () => {
  it("drops an older read's answer that lands after the newer read's", async () => {
    const newest = held();
    const shown: string[] = [];
    const first = slow<string>();
    const second = slow<string>();
    const a = newest.run(first.read, (v) => shown.push(v));
    const b = newest.run(second.read, (v) => shown.push(v));
    second.answer('answer to the second request');
    first.answer('answer to the first request'); // lands last, but is the older request's
    expect(await Promise.all([a, b])).toEqual([false, true]);
    expect(shown).toEqual(['answer to the second request']);
  });

  // why: F-2007 a read that answered with a failure is still an answer: an older read's late failure must not replace a newer read's data (K-05)
  it('drops an older read that answers with its own failure after the newer read answered', async () => {
    const newest = held();
    const shown: (string | null)[] = [];
    const first = slow<string | null>();
    const second = slow<string | null>();
    const a = newest.run(first.read, (v) => shown.push(v));
    const b = newest.run(second.read, (v) => shown.push(v));
    second.answer('data');
    first.answer(null);
    await Promise.all([a, b]);
    expect(shown).toEqual(['data']);
  });

  // why: F-2007 an answer that lands after the screen has gone must not set state on it (K-05)
  it('drops an answer that lands after invalidate, which the hook calls when the screen goes', async () => {
    const newest = held();
    const shown: string[] = [];
    const first = slow<string>();
    const a = newest.run(first.read, (v) => shown.push(v));
    newest.invalidate();
    first.answer('late');
    expect(await a).toBe(false);
    expect(shown).toEqual([]);
  });

  // why: F-2007 a read nothing newer replaced is shown as before
  it('shows the answer when no newer read began', async () => {
    const newest = held();
    const shown: string[] = [];
    expect(await newest.run(async () => 'ok', (v) => shown.push(v))).toBe(true);
    expect(shown).toEqual(['ok']);
  });
});
