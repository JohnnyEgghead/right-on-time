// SPDX-License-Identifier: AGPL-3.0-or-later
// The typed client's time limit (F-1746): ClientOptions.timeoutMs and withTimeLimit, the bound a technician app's sync calls run under.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallTimeout, createClient, readClock, withTimeLimit } from './index.ts';

const never = () => new Promise<never>(() => undefined);

describe('the time limit of 1 call (F-1746)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // why: F-1746 a call that never answers ends at its limit with CallTimeout, a TypeError (read as no signal), and its request is cancelled
  it('rejects a call with no answer at its limit with CallTimeout, and aborts the request, even when the fetch ignores the abort', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = ((_: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return never(); // ignores its signal: the limit cannot lean on the abort
    }) as typeof globalThis.fetch;
    const client = createClient({ baseUrl: 'http://phone.test', fetch, timeoutMs: 30_000 });
    let settled: unknown = 'pending';
    void client.call(readClock, {}).then((v) => (settled = v), (e: unknown) => (settled = e));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBeInstanceOf(CallTimeout);
    expect(settled).toBeInstanceOf(TypeError);
    expect(settled).toMatchObject({ contract: 'API-10', limitMs: 30_000 });
    expect(signal?.aborted).toBe(true);
  });

  // why: F-1746 a call whose headers came but whose body never ends is bounded too: the limit covers the whole answer read
  it('bounds the answer body read, not only the headers', async () => {
    vi.useFakeTimers();
    const fetch = (async () => ({ status: 200, headers: new Headers(), text: never }) as unknown as Response) as typeof globalThis.fetch;
    const client = createClient({ baseUrl: 'http://phone.test', fetch, timeoutMs: 50 });
    const call = client.call(readClock, {});
    const seen = expect(call).rejects.toBeInstanceOf(CallTimeout);
    await vi.advanceTimersByTimeAsync(50);
    await seen;
  });

  // why: F-1746 a call that answers in time is untouched: same answer, no signal left aborted, no timer left behind
  it('returns an answer in time as it came and clears its timer', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const got = await withTimeLimit('API-10', 1_000, async (s) => {
      signal = s;
      return 'answer';
    });
    expect([got, signal?.aborted, vi.getTimerCount()]).toEqual(['answer', false, 0]);
  });

  // why: F-1746 with no limit set (a page's own reads) nothing changes: no signal is added and nothing ends the call
  it('adds no signal and no timer when no limit is set', async () => {
    vi.useFakeTimers();
    let init: RequestInit | undefined;
    const fetch = (async (_: unknown, i?: RequestInit) => {
      init = i;
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    await createClient({ baseUrl: 'http://phone.test', fetch }).raw(readClock, {});
    expect(['signal' in (init ?? {}), vi.getTimerCount()]).toEqual([false, 0]);
  });
});
