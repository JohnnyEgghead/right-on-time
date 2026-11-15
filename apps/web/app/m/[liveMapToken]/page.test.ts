// SPDX-License-Identifier: AGPL-3.0-or-later
// F-1160: the live map page reads the branch office number (API-116) on the server as the visitor: with the access code on, the read must carry
// the visitor's cookie, and it must never hand the number to a caller the code refuses. The fake API below answers like the kernel gate
// (authorize.ts: access_code_required without the access cookie; the limiter key is the first X-Forwarded-For address).
import { afterEach, describe, expect, it, vi } from 'vitest';

let incoming: Record<string, string> = {};
vi.mock('next/headers', () => ({ headers: async () => ({ get: (n: string) => incoming[n] ?? null }) }));

import LiveMapPage from './page.tsx';

const seen: Array<{ cookie: string | undefined; xff: string | undefined; hasSignal: boolean }> = [];

function fakeApi(): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ cookie: h.cookie, xff: h['x-forwarded-for'], hasSignal: init?.signal instanceof AbortSignal });
    if (!(h.cookie ?? '').includes('bw_access=ok')) return new Response(JSON.stringify({ error: { code: 'access_code_required' } }), { status: 401 });
    return new Response(JSON.stringify({ data: { officePhone: '+15555550100' } }), { status: 200 });
  }) as typeof fetch;
}

async function phoneFor(): Promise<unknown> {
  const el = (await LiveMapPage({ params: Promise.resolve({ liveMapToken: 'tok' }) })) as { props: { officePhone: unknown } };
  return el.props.officePhone;
}

afterEach(() => {
  vi.unstubAllGlobals();
  seen.length = 0;
  incoming = {};
});

describe('live map page office number with the access code on (F-1160)', () => {
  it('forwards the visitor cookie and address, with a bounded wait, and gets the number', async () => {
    vi.stubGlobal('fetch', fakeApi());
    incoming = { cookie: 'bw_access=ok', 'x-forwarded-for': '203.0.113.9' };
    expect(await phoneFor()).toBe('+15555550100');
    expect(seen).toEqual([{ cookie: 'bw_access=ok', xff: '203.0.113.9', hasSignal: true }]);
  });

  it('gives no number to a visitor the access code refuses', async () => {
    vi.stubGlobal('fetch', fakeApi());
    incoming = { 'x-forwarded-for': '203.0.113.9' };
    expect(await phoneFor()).toBeNull();
  });
});
