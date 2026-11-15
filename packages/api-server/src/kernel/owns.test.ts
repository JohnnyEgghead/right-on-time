// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TEXT-4, FR-TEXT-8 (F-219: the kernel router claims a request by path AND method, so a link page and a JSON contract may share 1 path)
// A page and a contract row on 1 path: the reschedule link page (SCR-CUS-06, GET) and API-118 (POST) share /r/{token}; the live map page
// (SCR-CUS-04, GET) and API-116 sit under /m/{token}. owns() decides which side answers.
import { defineContract, liveMapData, z, type ContractRow } from '@bw/api';
import { describe, expect, it } from 'vitest';
import { pageGate } from './pages.ts';
import { api, page, PUBLIC, token } from '../policy/entry.ts';
import { kit } from '../testing.ts';
import type { Handler } from '../types.ts';

const rescheduleToken = z.string().min(1).max(64);
// A stand-in for API-118 (P5-INBOX builds the real row): a POST at the reschedule link path, served at the origin root (ROOT_CONTRACTS).
const confirm: ContractRow = defineContract({
  id: 'API-118', name: 'Confirm a new time', method: 'POST', path: '/r/{rescheduleToken}',
  request: z.object({ rescheduleToken }), response: z.object({ ok: z.boolean() }), errors: [], labels: [], examples: [],
});
const okHandler: Handler<unknown> = async () => ({ ok: true, status: 200, data: { ok: true } });
const gone: Handler<unknown> = async () => ({ ok: false, status: 410, code: 'gone', detail: { reason: 'changed', arrivedAt: null, visit: null, technician: null, officePhone: null } });

const table = [
  page('SCR-CUS-06', '/r/{rescheduleToken}', token('reschedule')),
  api(confirm, token('reschedule')),
  page('SCR-CUS-04', '/m/{liveMapToken}', token('live_map')),
  api(liveMapData, token('live_map')),
  page('SCR-GATE-02', '/', PUBLIC),
];
const k = () => kit(table, { 'API-118': okHandler, 'API-116': gone }, {}, { reschedule: async () => true, live_map: async () => true });

describe('Router.owns is method-aware (F-219)', () => {
  // why: FR-TEXT-8
  it('leaves the GET of a link path to its page and gives the POST of the same path to the contract', () => {
    const { router } = k();
    expect(router.owns('/r/Ab3dE5gH', 'GET')).toBe(false);
    expect(router.owns('/r/Ab3dE5gH', 'HEAD')).toBe(false);
    expect(router.owns('/r/Ab3dE5gH', 'POST')).toBe(true);
    // No method named: any row at the path claims it (the old, path-only answer).
    expect(router.owns('/r/Ab3dE5gH')).toBe(true);
    // The live map: the page path is a page, the data path under it is the contract.
    expect(router.owns('/m/7Hk2Zq9P', 'GET')).toBe(false);
    expect(router.owns('/m/7Hk2Zq9P/data', 'GET')).toBe(true);
    expect(router.owns('/m/7Hk2Zq9P/data', 'POST')).toBe(false);
    // The API base is the kernel's whatever the method.
    expect(router.owns('/api/v1/anything', 'GET')).toBe(true);
    expect(router.owns('/api/v1/anything', 'DELETE')).toBe(true);
    expect(router.owns('/office/board', 'GET')).toBe(false);
  });

  // why: FR-TEXT-8
  it('answers the page path through the page gate and the same path\'s POST through the kernel, each correctly', async () => {
    const kitted = k();
    const gate = pageGate(table);
    // The page side: the gate renders SCR-CUS-06 at the path (a token page's shell; its data comes from its token contract).
    const anon = { kind: 'anonymous' } as const;
    expect(gate.verdict('/r/Ab3dE5gH', anon, { codeOn: false, codeEntered: false })).toMatchObject({ kind: 'render', screen: 'SCR-CUS-06', status: 200 });
    // The contract side: the POST at the same path reaches the handler.
    const posted = await kitted.call('POST', '/r/Ab3dE5gH', { body: { rescheduleToken: 'ignored' } });
    expect(posted.status).toBe(200);
    expect(JSON.parse(await posted.text())).toMatchObject({ data: { ok: true } });
    // The kernel never answers the page's GET itself: no GET row at that path, so it is the kernel's own 404, never a page.
    expect((await kitted.call('GET', '/r/Ab3dE5gH')).status).toBe(404);
  });

  // why: FR-TEXT-4
  it('serves the live map page at the link path and API-116 under it, the 410 carrying the reason and no coordinate', async () => {
    const kitted = k();
    expect(pageGate(table).verdict('/m/7Hk2Zq9P', { kind: 'anonymous' } as const, { codeOn: false, codeEntered: false })).toMatchObject({ kind: 'render', screen: 'SCR-CUS-04' });
    const r = await kitted.call('GET', '/m/7Hk2Zq9P/data');
    expect(r.status).toBe(410);
    const body = await r.text();
    expect(JSON.parse(body)).toMatchObject({ code: 'gone', reason: 'changed', officePhone: null });
    expect(body).not.toMatch(/"(lon|lat|van|destination|route)"/);
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
  });
});
