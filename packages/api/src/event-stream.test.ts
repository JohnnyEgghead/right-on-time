// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: SD-13, SD-47 (GAP-7: a stream lost after 30 s without a byte reconnects and the page re-reads in full)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEventStream, parseSse } from './event-stream.ts';

describe('parseSse', () => {
  it('reads frames, skips comments and keeps a partial frame as the rest', () => {
    const r = parseSse(': heartbeat\n\nevent: job.changed\nid: 7\ndata: {"ids":{"jobNumber":1}}\n\nevent: board.re');
    expect(r.frames).toEqual([{ event: 'job.changed', id: '7', data: '{"ids":{"jobNumber":1}}' }]);
    expect(r.rest).toBe('event: board.re');
  });
});

/** A fetch whose bodies the test writes into by hand. */
function fakeStreams() {
  const enc = new TextEncoder();
  const opened: { push: (t: string) => void; end: () => void; aborted: () => boolean }[] = [];
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    let aborted = false;
    const body = new ReadableStream<Uint8Array>({ start: (c) => { ctl = c; } });
    init?.signal?.addEventListener('abort', () => {
      aborted = true;
      try { ctl.error(new Error('aborted')); } catch { /* closed */ }
    });
    opened.push({ push: (t) => ctl.enqueue(enc.encode(t)), end: () => ctl.close(), aborted: () => aborted });
    return new Response(body, { status: 200 });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, opened };
}

describe('connectEventStream', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('marks the stream lost after 30 s without a byte, reconnects, and re-reads once', async () => {
    const { fetchFn, opened } = fakeStreams();
    const events: unknown[] = [];
    const states: string[] = [];
    const reread = vi.fn();
    const h = connectEventStream({ url: 'http://x/events', fetch: fetchFn, onEvent: (e) => events.push(e), onReconnect: reread, onState: (s) => states.push(s), retryWaitMs: () => 100 });
    await vi.advanceTimersByTimeAsync(10);
    opened[0]!.push('event: job.changed\nid: 5\ndata: {"ids":{"jobNumber":9}}\n\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(events).toEqual([{ seq: 5, name: 'job.changed', ids: { jobNumber: 9 } }]);
    expect(reread).not.toHaveBeenCalled();
    // a heartbeat at 15 s keeps it live past 30 s of wall time
    await vi.advanceTimersByTimeAsync(15_000);
    opened[0]!.push(': heartbeat\n\n');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(states).toEqual(['live']);
    // no byte for 30 s: lost
    await vi.advanceTimersByTimeAsync(2_000);
    expect(opened[0]!.aborted()).toBe(true);
    expect(states).toContain('reconnecting');
    await vi.advanceTimersByTimeAsync(200);
    expect(opened).toHaveLength(2);
    expect(reread).toHaveBeenCalledTimes(1);
    expect(h.state).toBe('live');
    h.close();
  });

  it('never sends Last-Event-ID and stops for good on a 401', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const h = connectEventStream({ url: 'http://x/events', fetch: f, onEvent: () => undefined, retryWaitMs: () => 10 });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.state).toBe('closed');
    expect(f).toHaveBeenCalledTimes(1);
    const init = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
    expect(JSON.stringify(init.headers)).not.toMatch(/last-event-id/i);
  });

  /** A fetch that refuses with this status and reports whether the refusal's body was cancelled. */
  function refusing(status: number) {
    const cancelled = vi.fn();
    const f = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), { status })) as unknown as typeof fetch;
    return { f, cancelled };
  }

  // why: SPECIFICATIONS 7.3 the stream closes on unauthenticated: the refusal ends there, its body cancelled, so no request stays open (F-690)
  it.each([401, 403])('cancels the body of a %i and opens nothing more', async (status) => {
    const { f, cancelled } = refusing(status);
    const h = connectEventStream({ url: 'http://x/events', fetch: f, onEvent: () => undefined, retryWaitMs: () => 10 });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.state).toBe('closed');
    expect(f).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  // why: GAP-7 a stream refused for another reason retries, and each refusal's body is cancelled, so the retries leave no request open (F-690)
  it('cancels the body of every refusal it retries', async () => {
    const { f, cancelled } = refusing(503);
    const h = connectEventStream({ url: 'http://x/events', fetch: f, onEvent: () => undefined, retryWaitMs: () => 10 });
    await vi.advanceTimersByTimeAsync(35);
    h.close();
    const calls = (f as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    expect(cancelled).toHaveBeenCalledTimes(calls);
  });

  // why: SD-13, SD-47 replaces the events stack case "reconnects a stream that was dropped for 30 s, re-reads API-10 through the cache once, and keeps delivering with a higher seq" (its real 30 s sleep, P10-NIGHTLY-SPEED, F-2091)
  it('retries through a 30 s outage, reconnects once, re-reads once, asks for no replay of the gap (no Last-Event-ID on any request), and keeps delivering with a higher seq', async () => {
    const { fetchFn, opened } = fakeStreams();
    let down = false;
    const doFetch = ((url: string, init?: RequestInit) => (down ? Promise.reject(new Error('refused')) : (fetchFn as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init))) as unknown as typeof fetch;
    const events: { seq: number }[] = [];
    const states: string[] = [];
    const reread = vi.fn();
    // The retry wait the stack case used: 0.5 s growing to 2 s.
    const h = connectEventStream({ url: 'http://x/events', fetch: doFetch, onEvent: (e) => events.push(e), onReconnect: reread, onState: (s) => states.push(s), retryWaitMs: (n) => Math.min(2_000, 500 * 2 ** n) });
    await vi.advanceTimersByTimeAsync(10);
    opened[0]!.push('event: clock.changed\nid: 4\ndata: {"ids":{}}\n\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(events.map((e) => e.seq)).toEqual([4]);
    expect(reread).not.toHaveBeenCalled();

    // The connection is cut and the server stays unreachable for 30 s: the stream says reconnecting the whole time and never re-reads.
    down = true;
    opened[0]!.end();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.state).toBe('reconnecting');
    expect(reread).not.toHaveBeenCalled();
    expect(opened).toHaveLength(1);

    // The server is back: the next retry opens the stream, the page re-reads once, and the event of the gap (id 5) is not asked for again.
    down = false;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(h.state).toBe('live');
    expect(opened).toHaveLength(2);
    expect(reread).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    // The client asks for no replay on any request it made, so the gap (id 5) cannot be sent back; the events stack holds the server half (events.stack.ts).
    const sent = (fetchFn as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls;
    expect(sent.length).toBeGreaterThan(1);
    for (const [, init] of sent) expect(JSON.stringify(init?.headers)).not.toMatch(/last-event-id/i);
    opened[1]!.push('event: clock.changed\nid: 6\ndata: {"ids":{}}\n\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(events.map((e) => e.seq)).toEqual([4, 6]);
    expect(reread).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['live', 'reconnecting', 'live']);
    h.close();
  });
});
