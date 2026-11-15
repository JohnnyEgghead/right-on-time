// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: SD-47 (the resource cache keyed by contract and parameters, emptied on any worldEpoch change)
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ApiClient } from './client.ts';
import { defineContract } from './contract.ts';
import { cacheKey, createResourceCache } from './resource-cache.ts';

const row = defineContract({ id: 'API-900', name: 'x', method: 'GET', path: '/x', request: z.object({ a: z.string().optional() }), response: z.object({ n: z.number() }), errors: [], labels: [], examples: [] });

function fakeClient(answers: { n: number; epoch: number }[]) {
  const call = vi.fn(async () => {
    const a = answers.shift()!;
    return { status: 200, data: { n: a.n }, envelope: { data: { n: a.n }, meta: { worldEpoch: a.epoch } } };
  });
  return { client: { call, raw: vi.fn() } as unknown as ApiClient, call };
}

describe('the resource cache', () => {
  it('keys by contract and parameters, whatever the key order', () => {
    expect(cacheKey('API-1', { a: 1, b: 2 })).toBe(cacheKey('API-1', { b: 2, a: 1 }));
    expect(cacheKey('API-1', { a: 1 })).not.toBe(cacheKey('API-2', { a: 1 }));
    expect(cacheKey('API-1', { a: 1 })).not.toBe(cacheKey('API-1', { a: 2 }));
  });

  it('answers a peek from what a read stored, and a read refreshes the entry', async () => {
    const { client } = fakeClient([{ n: 1, epoch: 1 }, { n: 2, epoch: 1 }]);
    const cache = createResourceCache(client);
    expect(cache.peek(row, { a: 'x' })).toBeUndefined();
    await cache.read(row, { a: 'x' });
    expect(cache.peek(row, { a: 'x' })).toEqual({ n: 1 });
    await cache.read(row, { a: 'x' });
    expect(cache.peek(row, { a: 'x' })).toEqual({ n: 2 });
  });

  it('empties on any worldEpoch change seen in an answer or announced by a world.reset event', async () => {
    const { client } = fakeClient([{ n: 1, epoch: 1 }, { n: 2, epoch: 1 }, { n: 3, epoch: 2 }]);
    const changed = vi.fn();
    const cache = createResourceCache(client, changed);
    await cache.read(row, { a: 'x' });
    await cache.read(row, { a: 'y' });
    expect(cache.size).toBe(2);
    expect(cache.observeEpoch(1)).toBe(false);
    expect(cache.size).toBe(2);
    await cache.read(row, { a: 'z' });
    // the answer with epoch 2 emptied the cache, then stored itself
    expect(cache.size).toBe(1);
    expect(cache.peek(row, { a: 'x' })).toBeUndefined();
    expect(changed).toHaveBeenCalledWith(2);
    expect(cache.observeEpoch(3)).toBe(true);
    expect(cache.size).toBe(0);
  });

  // why: F-346
  it('drops an old world answer that lands after the re-read: the epoch stays, the new entry stays, the old answer is not stored', async () => {
    let release: (v: unknown) => void = () => undefined;
    const late = new Promise((r) => { release = r; });
    const answers = [
      { n: 1, epoch: 1, wait: late }, // sent before the reset, answered after the page re-read
      { n: 2, epoch: 2, wait: Promise.resolve() },
    ];
    const call = vi.fn(async () => {
      const a = answers.shift()!;
      await a.wait;
      return { status: 200, data: { n: a.n }, envelope: { data: { n: a.n }, meta: { worldEpoch: a.epoch } } };
    });
    const changed = vi.fn();
    const cache = createResourceCache({ call, raw: vi.fn() } as unknown as ApiClient, changed);
    cache.seed(row, { a: 'x' }, { n: 0 }, 1);
    const old = cache.read(row, { a: 'x' });
    expect(cache.observeEpoch(2)).toBe(true); // the world.reset event
    expect(await cache.read(row, { a: 'x' })).toEqual({ n: 2 });
    release(undefined);
    expect(await old).toEqual({ n: 1 }); // the caller still gets its answer
    expect(cache.epoch).toBe(2);
    expect(cache.peek(row, { a: 'x' })).toEqual({ n: 2 });
    expect(changed).toHaveBeenCalledTimes(1);
    // A lower epoch announced or seeded is ignored the same way.
    expect(cache.observeEpoch(1)).toBe(false);
    cache.seed(row, { a: 'y' }, { n: 9 }, 1);
    expect(cache.peek(row, { a: 'y' })).toBeUndefined();
    expect(cache.epoch).toBe(2);
  });
});
