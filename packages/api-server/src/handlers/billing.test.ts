// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HandlerContext } from '../types.ts';
import { pbsClientFor } from './billing.ts';

const ctxOf = (PBS_URL: string): HandlerContext => ({ settings: { PBS_URL } }) as unknown as HandlerContext;

afterEach(() => vi.unstubAllGlobals());

describe('the pbs client of a kernel (F-509)', () => {
  // why: F-509 the handlers are built once per process and cached 1 client from the first call's PBS_URL, so a second kernel with another
  // PBS_URL sent its calls to the first kernel's pbs with no error
  it('reaches the PBS_URL of each kernel, not the first caller\'s', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ mode: 'normal', n: null, setBy: null, setAt: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const pbs = pbsClientFor();
    await pbs(ctxOf('http://pbs-a:8090')).getMode();
    await pbs(ctxOf('http://pbs-b:9000/')).getMode();
    await pbs(ctxOf('http://pbs-a:8090')).getMode();
    expect(urls.map((u) => new URL(u).origin)).toEqual(['http://pbs-a:8090', 'http://pbs-b:9000', 'http://pbs-a:8090']);
    expect(pbs(ctxOf('http://pbs-a:8090'))).toBe(pbs(ctxOf('http://pbs-a:8090')));
  });
});
