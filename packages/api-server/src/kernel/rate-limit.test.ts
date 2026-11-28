// SPDX-License-Identifier: AGPL-3.0-or-later
// The 7.1 rate rules of API-01 and API-03 (F-1851, audit J-04; owner answer c456ba21, "Per address"): API-01 carries no
// login, so its hourly cap of 20 is keyed by address; API-03 keeps its hourly cap of 20 per login. Both run through the
// real kernel (mount) with the real API-01 handler, which verifies each code against a stored scrypt hash.
import { enterAccessCode } from '@bw/api';
import { hashPassword, type Queryable, type QueryResultLike } from '@bw/db';
import { createLogger } from '@bw/log';
import { FixedClock } from '@bw/time';
import { describe, expect, it } from 'vitest';
import { enterAccessCodeHandler } from '../handlers/auth.ts';
import { api, PUBLIC } from '../policy/entry.ts';
import { ACCESS_KEY, NO_PBS_URL, ORIGIN } from '../testing.ts';
import type { Handler } from '../types.ts';
import { mount, type KernelDb } from './mount.ts';
import { RateLimiter, rateRules } from './rate-limit.ts';
import { MemorySessionStore } from './sessions.ts';

/** A database holding 1 active access code, the only query API-01 runs. */
function codeDb(codeHash: string): KernelDb {
  return {
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const tx: Queryable = {
        query: async <R>(text: string): Promise<QueryResultLike<R>> =>
          (text.includes('system.access_code') ? { rows: [{ code_hash: codeHash }] as R[], rowCount: 1 } : { rows: [], rowCount: 0 }),
      };
      return fn(tx);
    },
  };
}

async function accessCodeKit() {
  const clock = new FixedClock({ demo: '2026-09-15T14:28:00Z', real: '2026-11-01T12:00:00Z', worldEpoch: 3 });
  const router = mount([api(enterAccessCode, PUBLIC)], { 'API-01': enterAccessCodeHandler as Handler<unknown> }, {
    db: codeDb(await hashPassword('RIGHT6')), sessions: new MemorySessionStore(), clock, accessKey: ACCESS_KEY,
    log: createLogger({ process: 'web', clock, level: 'error', write: () => {} }),
    settings: { APP_ORIGIN: ORIGIN, DEMO_MODE: false, ACCESS_CODE_ON: true, PBS_URL: NO_PBS_URL },
  });
  const enter = async (address: string, code: string) => {
    const r = await router.handle(new Request('http://web:3000/api/v1/access-code', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ code }),
    }), { address });
    const body = r.status === 204 ? {} : (JSON.parse(await r.text()) as { code?: string });
    return { status: r.status, code: body.code };
  };
  return { clock, enter };
}

describe('API-01 hourly cap per address (F-1851)', () => {
  // why: FR-AUTH-6, F-1851 an access-code request has no login, so the 20 an hour cap is per address (owner answer c456ba21):
  // 20 wrong codes spread over the hour, never 2 in a minute, leave the 21st refused, and a second address still gets a verdict
  it('refuses the 21st wrong code within the hour from 1 address while another address still gets code_invalid', async () => {
    const { clock, enter } = await accessCodeKit();
    for (let i = 0; i < 20; i++) {
      expect(await enter('203.0.113.7', `WRONG${i}`), `try ${i}`).toEqual({ status: 403, code: 'code_invalid' });
      clock.advance({ minutes: 2 });
    }
    // 40 minutes in: the per-minute rule (10) has never been near, so only the hourly rule can refuse this one.
    expect(await enter('203.0.113.7', 'WRONG20')).toEqual({ status: 429, code: 'rate_limited' });
    expect(await enter('198.51.100.9', 'WRONG21')).toEqual({ status: 403, code: 'code_invalid' });
    // At 63 minutes the tries at 0 and 2 have left the hour (the refused 21st still counts), so the right code opens the gate.
    clock.advance({ minutes: 23 });
    expect(await enter('203.0.113.7', 'RIGHT6')).toEqual({ status: 204, code: undefined });
  });

  // why: FR-AUTH-6, FR-AUTH-11, F-1851 the access code call's rules (API-01) are both per address, and sign-in (API-03) keeps its per-login hourly rule
  it('gives API-01 2 address rules and API-03 its login rule', () => {
    const MIN = 60_000;
    expect(rateRules({ id: 'API-01', path: '/access-code' })).toEqual([
      { scope: 'address', limit: 10, windowMs: MIN }, { scope: 'address', limit: 20, windowMs: 60 * MIN },
    ]);
    expect(rateRules({ id: 'API-03', path: '/sessions' })).toEqual([
      { scope: 'address', limit: 10, windowMs: MIN }, { scope: 'login', limit: 20, windowMs: 60 * MIN },
    ]);
  });

  // why: SD-4 K-07 F-2013 the reset request (API-165) is capped at 5 an hour per address and every link-token route at 60 a minute per address; no test held either number
  it('gives API-165 5 an hour and a link-token route 60 a minute, each per address, and no other row any rule', () => {
    expect(rateRules({ id: 'API-165', path: '/password-resets' })).toEqual([{ scope: 'address', limit: 5, windowMs: 60 * 60_000 }]);
    expect(rateRules({ id: 'API-116', path: '/live-map/{token}' })).toEqual([{ scope: 'address', limit: 60, windowMs: 60_000 }]);
    expect(rateRules({ id: 'API-04', path: '/sessions/current' })).toEqual([]);
  });

  // why: SD-4 K-07 F-2013 the numbers bite: the 6th reset request in an hour and the 61st link-token hit in a minute are refused, and a new hour or minute lets the address in
  it('refuses the 6th reset request in an hour and the 61st link-token hit in a minute', () => {
    const clock = new FixedClock({ demo: '2026-09-15T14:28:00Z', real: '2026-11-01T12:00:00Z', worldEpoch: 3 });
    const limiter = new RateLimiter(clock);
    const reset = rateRules({ id: 'API-165', path: '/password-resets' })[0]!;
    const link = rateRules({ id: 'API-116', path: '/live-map/{token}' })[0]!;
    const hits = (rule: typeof reset, n: number) => Array.from({ length: n }, () => limiter.hit('x', rule, '203.0.113.7'));
    expect(hits(reset, 6)).toEqual([true, true, true, true, true, false]);
    expect(hits(link, 61).filter((ok) => !ok)).toHaveLength(1);
    expect(limiter.hit('x', link, '198.51.100.9')).toBe(true);
    clock.advance({ minutes: 2 });
    expect(limiter.hit('x', link, '203.0.113.7')).toBe(true);
    expect(limiter.hit('x', reset, '203.0.113.7')).toBe(false);
    clock.advance({ minutes: 61 });
    expect(limiter.hit('x', reset, '203.0.113.7')).toBe(true);
  });
});
