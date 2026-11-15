// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient, readClock } from '@bw/api';
import { describe, expect, it } from 'vitest';
import { createReader } from './reads.ts';

const ENVELOPE = {
  data: {
    demoNow: '2026-09-15T10:28:00-04:00[America/New_York]', realNow: '2026-11-01T08:00:00-04:00[America/New_York]', rate: 1, paused: false,
    worldEpoch: 1, lastMove: null, replay: { running: false, done: 0, total: 0 }, resetAvailableInSeconds: 0,
  },
  meta: { contract: 'API-10', worldEpoch: 1, demoNow: '2026-09-15T10:28:00-04:00[America/New_York]', viewer: { kind: 'public' }, labels: ['demo_mode'] },
};
const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('shell reads through @bw/api', () => {
  // why: FR-DEMO-1 with no API-10 row the strip shows its failure state, never an invented time
  it('reports a contract row that has not landed as unavailable, and sends nothing', async () => {
    let sent = 0;
    const reader = createReader({ client: createClient({ baseUrl: 'http://x', fetch: async () => (sent++, new Response('{}')) }), rows: [] });
    expect(await reader.read('API-10')).toEqual({ ok: false, reason: 'unavailable' });
    expect(sent).toBe(0);
  });

  // why: FR-DEMO-1 the clock comes from API-10's answer (page code calls only @bw/api, SPECIFICATIONS 4.1)
  it('reads a landed row through the typed client and its envelope check', async () => {
    const urls: string[] = [];
    const client = createClient({ baseUrl: 'http://x', fetch: async (u) => (urls.push(String(u)), answer(200, ENVELOPE)()) });
    const r = await createReader({ client, rows: [readClock] }).read('API-10');
    expect(r).toEqual({ ok: true, data: ENVELOPE.data });
    expect(urls).toEqual(['http://x/api/v1/clock']);
  });

  // why: F-129 the page acts on the Problem's code, so the read keeps it
  it('turns a Problem into a failure that keeps its code, and a broken answer into a failure', async () => {
    const problem = {
      type: 'https://bw.j7l.io/errors/forbidden',
      title: 'Forbidden',
      status: 403,
      code: 'forbidden',
      meta: { contract: 'API-10', worldEpoch: 1, demoNow: '2026-09-15T10:28:00-04:00[America/New_York]' },
    };
    const forbidden = createReader({ client: createClient({ baseUrl: 'http://x', fetch: answer(403, problem) }), rows: [readClock] });
    expect(await forbidden.read('API-10')).toMatchObject({ ok: false, reason: 'failed', code: 'forbidden', status: 403 });
    const broken = createReader({ client: createClient({ baseUrl: 'http://x', fetch: answer(200, { data: {} }) }), rows: [readClock] });
    expect(await broken.read('API-10')).toEqual({ ok: false, reason: 'failed' });
  });
});
