// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient, techSignIns } from '@bw/api';
import { describe, expect, it } from 'vitest';
import { createReader } from '../shell/reads.ts';
import { readSignInList } from './sign-in-list.ts';

const META = { contract: 'API-15', worldEpoch: 1, demoNow: '2026-09-15T10:28:00-04:00[America/New_York]' };
const problem = (status: number, code: string) => ({ type: `https://bw.j7l.io/errors/${code}`, title: code, status, code, meta: META });
const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const readerAnswering = (status: number, body: unknown) =>
  createReader({ client: createClient({ baseUrl: 'http://x', fetch: answer(status, body) }), rows: [techSignIns] });

describe('SCR-GATE-02 reads API-15 into the start page list state', () => {
  // why: F-552 CTL-GATE-02-04 is hidden until the access code is entered; a password session without the code is answered
  // access_code_required (F-288), and the start page must not show a read-failed panel whose Try again can never succeed
  it('hides the list on access_code_required, through the real reader and typed client', async () => {
    expect(await readSignInList(readerAnswering(403, problem(403, 'access_code_required')))).toBe('hidden');
  });

  // why: CTL-GATE-02-04 "read fails: The sample sign-ins could not load" with Try again stays the state for a real failure
  it('keeps the read-failed state for any other failure', async () => {
    expect(await readSignInList(readerAnswering(500, problem(500, 'server_error')))).toBe('error');
    expect(await readSignInList(readerAnswering(200, { data: {} }))).toBe('error');
  });

  // why: FR-AUTH-7 with the code entered (or off) the start page lists API-15's sign-ins as answered
  it('passes a good answer through as the list', async () => {
    const data = { signIns: [{ name: 'Maria Santos', branch: 'columbus', language: 'en', email: 'maria@example.test', password: 'pw' }], iosAppLink: null };
    expect(await readSignInList(readerAnswering(200, { data, meta: { ...META, viewer: { kind: 'public' }, labels: [] } }))).toEqual(data);
  });
});
