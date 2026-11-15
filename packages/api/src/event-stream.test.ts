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
});
