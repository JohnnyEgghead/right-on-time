// SPDX-License-Identifier: AGPL-3.0-or-later
// The web resource cache (SPECIFICATIONS SD-47): every page reads through the typed client into a small cache keyed by
// contract and parameters; a read answers from the cache and refreshes it; any `worldEpoch` change in `meta` empties the
// cache. `peek` is the cached answer (what a server-rendered first read hands to the client, so hydration does no second
// fetch); `read` calls the contract and refreshes the entry.
import type { z } from 'zod';
import type { ApiClient } from './client.ts';
import type { ContractRow } from './contract.ts';

export interface ResourceCache {
  /** The cached answer, or undefined. */
  peek<Req extends z.ZodType, Res extends z.ZodType>(row: ContractRow<Req, Res>, input?: z.input<Req>): z.output<Res> | undefined;
  /** Seed an entry (the server's first read of a page), at the epoch the answer carried. */
  seed<Req extends z.ZodType, Res extends z.ZodType>(row: ContractRow<Req, Res>, input: z.input<Req> | undefined, data: z.output<Res>, worldEpoch: number): void;
  /** Call the contract, store the answer, and return it; a changed worldEpoch in the answer's meta empties the cache first. */
  read<Req extends z.ZodType, Res extends z.ZodType>(row: ContractRow<Req, Res>, input?: z.input<Req>): Promise<z.output<Res>>;
  /** Tell the cache the world epoch the page now knows (a `world.reset` event's id); a higher one empties it, a lower one is ignored. Returns true when it emptied. */
  observeEpoch(worldEpoch: number): boolean;
  /** Drop every entry. */
  clear(): void;
  readonly size: number;
  readonly epoch: number | null;
}

/** Key = contract id + the parameters in a fixed key order, so {a,b} and {b,a} are 1 entry. */
export function cacheKey(id: string, input: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, norm(x)]));
    return v;
  };
  return `${id}|${JSON.stringify(norm(input ?? {}))}`;
}

export function createResourceCache(client: ApiClient, onEpochChange?: (epoch: number) => void): ResourceCache {
  const entries = new Map<string, unknown>();
  let epoch: number | null = null;
  // The world epoch only rises (+1 at every reset, SPECIFICATIONS section 3 demo_clock.world_epoch): a higher one empties
  // the cache; a lower one is an answer from the old world that landed late (F-346), which is neither stored nor obeyed.
  const stale = (n: number): boolean => epoch !== null && n < epoch;
  const observe = (n: number): boolean => {
    if (stale(n)) return false;
    const changed = epoch !== null && n > epoch;
    epoch = n;
    if (changed) {
      entries.clear();
      onEpochChange?.(n);
    }
    return changed;
  };
  return {
    peek: (row, input) => entries.get(cacheKey(row.id, input)) as never,
    seed(row, input, data, worldEpoch) {
      if (stale(worldEpoch)) return;
      observe(worldEpoch);
      entries.set(cacheKey(row.id, input), data);
    },
    async read(row, input) {
      const r = await client.call(row, input);
      if (r.envelope) {
        // An old world's answer is still the caller's answer, but the cache keeps only the current world's.
        if (stale(r.envelope.meta.worldEpoch)) return r.data;
        observe(r.envelope.meta.worldEpoch);
      }
      entries.set(cacheKey(row.id, input), r.data);
      return r.data;
    },
    observeEpoch: observe,
    clear: () => entries.clear(),
    get size() {
      return entries.size;
    },
    get epoch() {
      return epoch;
    },
  };
}
