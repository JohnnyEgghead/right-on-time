// SPDX-License-Identifier: AGPL-3.0-or-later
// Rate limits (SPECIFICATIONS 7.1): link-token routes 60 per minute per address; API-01 and API-03 10 per minute per
// address; API-03 20 per hour per login; API-01 20 per hour per address; API-165 5 per hour per address.
// API-01's hourly cap is keyed by address because an access-code request carries no login, so a per-login rule never
// applied to it (F-1851, audit J-04). Owner answer c456ba21 (Nov 16, 2026), "Per address": 20 per hour from each
// address, so 1 stranger cannot lock everyone else out, and a caller with many addresses gets 20 an hour from each.
// Windows are real time (realNow('rate_limit'), section 11.3), so a demo clock jump never resets a limit. Over the limit: 429 rate_limited.
// The counters live in this process's memory: 1 web process serves the demo (SD-3). A restart forgets them, which
// errs toward letting a caller in, never toward locking one out.
import { isLinkTokenRoute, type ContractRow } from '@bw/api';
import type { Clock } from '@bw/time';

export interface RateRule {
  scope: 'address' | 'login';
  limit: number;
  windowMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The 7.1 rules of a row (empty for a row 7.1 does not limit). */
export function rateRules(row: Pick<ContractRow, 'id' | 'path'>): RateRule[] {
  if (row.id === 'API-01') return [{ scope: 'address', limit: 10, windowMs: MIN }, { scope: 'address', limit: 20, windowMs: HOUR }];
  if (row.id === 'API-03') return [{ scope: 'address', limit: 10, windowMs: MIN }, { scope: 'login', limit: 20, windowMs: HOUR }];
  if (row.id === 'API-165') return [{ scope: 'address', limit: 5, windowMs: HOUR }];
  if (isLinkTokenRoute(row)) return [{ scope: 'address', limit: 60, windowMs: MIN }];
  return [];
}

/** Sliding-window counters keyed by rule and subject. Bounded: the oldest key goes first past MAX_KEYS. */
export class RateLimiter {
  static readonly MAX_KEYS = 50_000;
  readonly #hits = new Map<string, number[]>();
  readonly #clock: Pick<Clock, 'realNow'>;

  constructor(clock: Pick<Clock, 'realNow'>) {
    this.#clock = clock;
  }

  /** Count 1 hit; false when it is over the limit (the hit is still counted, so hammering keeps the caller out). */
  hit(contract: string, rule: RateRule, subject: string): boolean {
    const now = this.#clock.realNow('rate_limit').epochMilliseconds;
    const key = `${contract}|${rule.scope}|${rule.windowMs}|${subject}`;
    const kept = (this.#hits.get(key) ?? []).filter((t) => now - t < rule.windowMs);
    kept.push(now);
    if (kept.length > rule.limit + 1) kept.splice(0, kept.length - rule.limit - 1);
    this.#hits.delete(key);
    this.#hits.set(key, kept);
    if (this.#hits.size > RateLimiter.MAX_KEYS) this.#hits.delete(this.#hits.keys().next().value as string);
    return kept.length <= rule.limit;
  }

  get size(): number {
    return this.#hits.size;
  }
}
