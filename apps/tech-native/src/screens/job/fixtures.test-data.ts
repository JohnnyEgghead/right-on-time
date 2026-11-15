// SPDX-License-Identifier: AGPL-3.0-or-later
// Test data for the native job screens' unit tests (not bundled: only *.test.ts import it): Harold Jenkins's Sep 15 job 24830 as
// API-101 answers it, a parts list as API-107 answers it, and a scripted server around the shell's (testing.ts) that also answers the
// job screens' reads (API-07, API-101, API-104, API-107) and the photo and signature uploads (API-103) from their files.
import { readFileSync } from 'node:fs';
import { problemType } from '@bw/api';
import type { UploadPort } from '../../net/transport.ts';
import { fakeServer, MARIA_ID } from '../../testing.ts';
import type { JobCopy, Part } from './model.ts';

export const HAROLD = 24830;

export function haroldJob(over: Partial<JobCopy['job']> = {}): JobCopy {
  return {
    job: {
      jobNumber: HAROLD, version: 3, status: 'scheduled', zone: 'America/New_York', date: '2026-09-15', today: true,
      window: { start: '2026-09-15T10:00:00-04:00[America/New_York]', end: '2026-09-15T12:00:00-04:00[America/New_York]' },
      serviceLabelKey: 'service.furnace_tune_up', problem: null, onTheWayAt: null, arrivedAt: null, endedAt: null,
      position: { index: 2, of: 5 }, nextJob: 24831, ...over,
    },
    customer: {
      name: 'Harold Jenkins', address: '418 Maple Hollow Ct', area: 'Westerville', phone: '(614) 555-0148', gettingIn: 'Use the side door. Knock firmly.',
      notes: [],
    },
    equipment: [{ id: 'e1', type: 'furnace', year: 2014, location: 'In the basement', details: null }],
    history: [{ date: '2025-10-14', what: 'Furnace tune-up', serviceLabelKey: null, technician: 'Maria Santos' }],
    notes: [{ id: 'n-office-1', kind: 'office', author: 'Keisha T.', body: 'The doorbell does not work.', at: '2026-09-10T15:12:00-04:00[America/New_York]' }],
    photos: [],
  };
}

export const PARTS: Part[] = [
  { partId: 'p-flt', name: 'Furnace filter 16x25x4 MERV 11', code: 'FLT-16254', priceCents: 4200 },
  { partId: 'p-fs', name: 'Flame sensor', code: 'FS-100', priceCents: 2900 },
  { partId: 'p-ign', name: 'Hot surface igniter', code: 'IGN-220', priceCents: 6100 },
];

const meta = (contract: string) => ({ contract, worldEpoch: 1, demoNow: '2026-09-15T10:28:00-04:00[America/New_York]', viewer: { kind: 'public' }, labels: [] });
const env = (contract: string, data: unknown) => JSON.stringify({ data, meta: meta(contract) });
const problem = (status: number, code: string) => JSON.stringify({ type: problemType(code as 'not_found'), title: code, status, code, meta: meta('API-101') });

/** The shell's scripted server, plus the job screens' reads and API-103 (each upload's bytes recorded by key, a key held answers duplicate). */
export function jobServer(origin: string, opts: { userId?: string; name?: string } = {}) {
  const base = fakeServer(origin);
  const state = { job: haroldJob(), parts: PARTS, mine: new Set([HAROLD]), userId: opts.userId ?? MARIA_ID, name: opts.name ?? 'Maria Santos', fault: false };
  const photos = new Map<string, { bytes: number; type: string; count: number }>();
  const reads: string[] = [];
  let signal = true;
  const answer = (method: string, url: string): { status: number; text: string } | null => {
    const p = url.replace(origin, '').split('?')[0] ?? '';
    const job = /^\/api\/v1\/tech\/jobs\/(\d+)$/.exec(p);
    if (method === 'GET' && job) {
      reads.push('API-101');
      if (state.fault) return { status: 500, text: problem(500, 'server_error') };
      return state.mine.has(Number(job[1])) ? { status: 200, text: env('API-101', state.job) } : { status: 404, text: problem(404, 'not_found') };
    }
    if (method === 'GET' && p === '/api/v1/parts') return state.fault ? { status: 500, text: problem(500, 'server_error') } : { status: 200, text: env('API-107', { parts: state.parts }) };
    if (method === 'GET' && p === '/api/v1/tech/route') {
      return { status: 200, text: env('API-104', { branch: 'columbus', leg: { from: { lon: 0, lat: 0 }, to: { lon: 1, lat: 1 }, track: [[0, 0], [1, 1]], minutes: 12, distanceMeters: 5000 }, insideWindow: true, steps: [] }) };
    }
    if (method === 'GET' && p === '/api/v1/me') {
      return { status: 200, text: env('API-07', { userId: state.userId, name: state.name, role: 'technician', skill: null, branch: 'columbus', employeeNumber: '40712', language: 'en', slashShortcut: 'off', permissions: [] }) };
    }
    return null;
  };
  const doFetch: typeof fetch = async (input, init) => {
    const a = answer(init?.method ?? 'GET', String(input));
    if (!a) return base.fetch(input, init);
    if (!signal) throw new TypeError('Network request failed');
    return new Response(a.text, { status: a.status });
  };
  const upload: UploadPort = {
    async upload(fileUri, url, init) {
      const key = /\/tech\/photos\/([0-9a-f-]{36})/.exec(url)?.[1];
      if (!key) return base.upload.upload(fileUri, url, init);
      if (!signal) throw new Error('The Internet connection appears to be offline.');
      const bytes = readFileSync(new URL(fileUri));
      const seen = photos.get(key);
      photos.set(key, { bytes: bytes.byteLength, type: init.headers['content-type'] ?? '', count: (seen?.count ?? 0) + 1 });
      return { status: 200, body: env('API-103', { key, result: seen ? 'duplicate' : 'applied', code: null, messageKey: null, values: null }), headers: { 'Content-Type': 'application/json' } };
    },
    bodyFile: (text) => base.upload.bodyFile(text),
  };
  return {
    ...base, fetch: doFetch, upload, state, photos, reads,
    setSignal: (on: boolean) => {
      signal = on;
      base.setSignal(on);
    },
  };
}
