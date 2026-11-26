// SPDX-License-Identifier: AGPL-3.0-or-later
// The office pages that follow the demo clock's today (P9-CLIENT-FAULTS, F-1930): 1 set of cases for the Messages, Call list and Week suites.
// The page is the real one over the real API; the suite owns 2 things in it. API-10's answer is the server's with this rig's demo time, and
// API-09 is a stream the rig holds open, speaks on and drops, so a case says what reached the page and what it missed.
import type { Page } from 'playwright';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const STREAM = `(() => {
  const real = window.fetch.bind(window);
  const st = { opens: 0, push: null, drop: null };
  window.__bwStream = st;
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input), location.href);
    if (url.pathname !== '/api/v1/events') return real(input, init);
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(': open\\n\\n'));
        st.push = (text) => c.enqueue(enc.encode(text));
        st.drop = () => { try { c.close(); } catch { /* it has ended */ } };
        init?.signal?.addEventListener('abort', () => { try { c.error(new DOMException('aborted', 'AbortError')); } catch { /* it has ended */ } });
      },
    });
    st.opens += 1;
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  };
})();`;

export interface DemoDayCases {
  origin: string;
  /** A signed-in page with nothing loaded yet. */
  page: () => Promise<Page>;
  close: () => Promise<void>;
  /** The page with no day in its URL, the same page on a picked day, and that day. */
  path: string;
  pickedPath: string;
  picked: string;
  /** The list read: its API path, and its field that names the day (or the week) it asks for. */
  list: string;
  key: 'date' | 'week';
  /** The day (or the week's Monday) the page shows. */
  shown: (p: Page) => Promise<string>;
  /** 4 days for the clock, in order; `shown` answers each of them. */
  days: readonly [string, string, string, string];
}

/** The cases of 1 page, in 1 browser page: call it inside a describe. */
export function demoDayCases(o: DemoDayCases): void {
  const at = (day: string) => `${day}T10:00:00-04:00[America/New_York]`;
  let p: Page;
  let now = at(o.days[0]);
  let epoch = 0;
  let shownEpoch = 0;
  let fails = false;
  let hold: Promise<void> | null = null;
  let clocks = 0;
  let seq = 900_000_000;
  const lists: string[] = [];

  const opens = () => p.evaluate<number>('window.__bwStream.opens');
  const event = async (name: string, ids: Record<string, number> = {}) => {
    seq += 1;
    await p.evaluate(`window.__bwStream.push(${JSON.stringify(`event: ${name}\nid: ${seq}\ndata: ${JSON.stringify({ ids })}\n\n`)})`);
  };
  /** The stream is lost and comes back: whatever the server said in between never reaches the page. */
  const reconnect = async () => {
    const before = await opens();
    await p.evaluate('window.__bwStream.drop()');
    await expect.poll(opens, { timeout: 15_000 }).toBeGreaterThan(before);
  };
  /** 12 API reads the case sends one after the other: a page that reads back to back reads many times while they run. */
  const readWindow = () => p.evaluate(`(async () => { for (let n = 0; n < 12; n += 1) await (await fetch('/api/v1/app-info')).text(); })()`);
  /** vi.waitFor, not expect.poll: the first load is in a hook, where expect.poll does not run. */
  const until = (check: () => Promise<void> | void, timeout = 15_000) => vi.waitFor(check, { timeout, interval: 50 });
  const shows = (day: string) => until(async () => expect(await o.shown(p)).toBe(day));
  /**
   * F-1999: the page draws a new day first and sends its list read after (the first-read effect runs after the commit, 1 to 4 ms later on
   * WebKit), and Playwright's request event reaches this side some ms after that. So a list read is waited for, never read at the moment
   * the new day shows.
   */
  const readOf = (day: string, from: number) => until(() => expect(lists.slice(from)).toContain(day));
  const load = async (path: string) => {
    const before = lists.length;
    await p.goto(o.origin + path, { waitUntil: 'load' });
    await until(() => expect(lists.length).toBeGreaterThan(before), 45_000);
    await until(async () => expect(await p.evaluate<boolean>('window.__bwStream.push !== null')).toBe(true));
  };

  beforeAll(async () => {
    p = await o.page();
    await p.addInitScript({ content: STREAM });
    p.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname === o.list) lists.push(u.searchParams.get(o.key) ?? String((r.postDataJSON() as Record<string, unknown> | null)?.[o.key]));
    });
    await p.route((u) => u.pathname === '/api/v1/clock', async (r) => {
      clocks += 1;
      try {
        if (hold) await hold;
        if (fails) return await r.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ type: 'about:blank', title: 'refused', status: 500, code: 'server_error' }) });
        const response = await r.fetch();
        const json = (await response.json()) as { data: { worldEpoch: number } };
        shownEpoch = json.data.worldEpoch + epoch;
        Object.assign(json.data, { demoNow: now, paused: true, worldEpoch: shownEpoch });
        return await r.fulfill({ response, json });
      } catch {
        return undefined; // the page closed under the request
      }
    });
    await load(o.path);
    await shows(o.days[0]);
  }, 90_000);
  afterAll(async () => {
    await o.close();
  });

  // why: UD-18, F-1930 a page that shows the demo clock's today moves to the new day when a clock jump (EVT-05 clock.changed) sets one, with no reset and no reload
  it('shows the new day when the clock moves with no reset', async () => {
    const before = lists.length;
    now = at(o.days[1]);
    await event('clock.changed');
    await shows(o.days[1]);
    await readOf(o.days[1], before);
    expect(lists.at(-1)).toBe(o.days[1]);
  });

  // why: F-1930 a clock event missed while the stream was lost is never sent again, so a page whose stream comes back reads the clock first and then its list, once, on the new day
  it('reads the clock, then its list on the new day, when the stream comes back after a missed clock move', async () => {
    now = at(o.days[2]);
    let release: () => void = () => undefined;
    hold = new Promise((go) => { release = go; });
    const before = { clocks, lists: lists.length };
    try {
      await reconnect();
      await expect.poll(() => clocks, { timeout: 15_000 }).toBeGreaterThan(before.clocks);
      await readWindow();
      expect(lists.slice(before.lists), 'list reads sent before the clock answered').toEqual([]);
    } finally {
      hold = null;
      release();
    }
    await shows(o.days[2]);
    await expect.poll(() => lists.length, { timeout: 15_000 }).toBeGreaterThan(before.lists);
    await readWindow();
    expect(lists.slice(before.lists)).toEqual([o.days[2]]);
  });

  // why: F-1930 a page that follows the clock keeps the day it shows when the clock read fails, and does not read over and over
  it('keeps its day and reads a bounded number of times while the clock does not answer', async () => {
    const day = await o.shown(p);
    const before = { clocks, lists: lists.length };
    fails = true;
    try {
      await event('clock.changed');
      await readWindow();
      await readWindow();
      expect(clocks - before.clocks, 'clock reads').toBeLessThanOrEqual(3);
      expect(lists.length - before.lists, 'list reads').toBeLessThanOrEqual(1);
      expect(await o.shown(p)).toBe(day);
    } finally {
      fails = false;
    }
  });

  // why: UD-18, FR-DEMO-4 a world reset that sets another demo day (EVT-06) moves the page to that day
  it('shows the new day when a world reset sets one', async () => {
    const before = lists.length;
    epoch += 1;
    now = at(o.days[3]);
    await event('world.reset', { worldEpoch: shownEpoch + 1 });
    await shows(o.days[3]);
    await readOf(o.days[3], before);
    expect(lists.at(-1)).toBe(o.days[3]);
  });

  // why: UD-18 a picked date stays: a clock move does not take the page off the day its URL names
  it('stays on a picked day when the clock moves', async () => {
    await load(o.pickedPath);
    await shows(o.picked);
    const before = { clocks, lists: lists.length };
    now = at(o.days[0]);
    await event('clock.changed');
    await reconnect();
    await expect.poll(() => clocks, { timeout: 15_000 }).toBeGreaterThan(before.clocks);
    await expect.poll(() => lists.length, { timeout: 15_000 }).toBeGreaterThan(before.lists);
    await readWindow();
    expect(await o.shown(p)).toBe(o.picked);
    expect(new Set(lists.slice(before.lists))).toEqual(new Set([o.picked]));
  });
}
