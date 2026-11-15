// SPDX-License-Identifier: AGPL-3.0-or-later
// Test doubles for the native shell's unit tests (not bundled: only *.test.ts import it). A node:fs StoreDir, an in-memory Keychain, and
// a scripted Right On Time server that answers the typed client's calls and the background uploads the way the real one does: by the
// contracts' envelopes, with a ledger keyed by item key (a key it holds answers duplicate), and a "signal" that can be cut.
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { problemType } from '@bw/api';
import { TEMP_PREFIX, type StoreDir } from '@bw/outbox/src/items/native.ts';
import type { SecretStore } from './auth/session-store.ts';
import type { UploadPort, UploadResult } from './net/transport.ts';

export function nodeDir(root = mkdtempSync(path.join(tmpdir(), 'bw-native-'))): StoreDir & { root: string } {
  let n = 0;
  const at = (name: string) => path.join(root, name);
  return {
    root,
    list: () => readdirSync(root),
    readText: (name) => (existsSync(at(name)) ? readFileSync(at(name), 'utf8') : null),
    readBytes: (name) => (existsSync(at(name)) ? new Uint8Array(readFileSync(at(name))) : null),
    create(name, content) {
      if (existsSync(at(name))) throw new Error(`${name} exists`);
      const tmp = at(`${TEMP_PREFIX}${process.pid}-${n++}`);
      writeFileSync(tmp, content);
      renameSync(tmp, at(name));
    },
    remove: (name) => {
      if (existsSync(at(name))) unlinkSync(at(name));
    },
    uri: (name) => `file://${at(name)}`,
  };
}

export function memoryKeychain(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
  };
}

/** The sample token: repeated characters, never a real-looking secret. */
export const SAMPLE_TOKEN = 'a'.repeat(43);
export const MARIA_ID = '0192f000-0000-7000-8000-00000000aaaa';

export interface Call {
  method: string;
  url: string;
  via: 'fetch' | 'upload';
  auth: string | null;
  body: unknown;
}

const meta = (contract: string) => ({ contract, worldEpoch: 1, demoNow: '2026-09-15T10:28:00-04:00[America/New_York]', viewer: { kind: 'public' }, labels: [] });
const env = (contract: string, data: unknown) => JSON.stringify({ data, meta: meta(contract) });

export function fakeServer(origin: string, product = 'Right On Time') {
  const calls: Call[] = [];
  const ledger = new Map<string, number>();
  let signal = true;
  const answer = (method: string, url: string, body: unknown): { status: number; text: string } => {
    const p = url.replace(origin, '').split('?')[0];
    if (method === 'GET' && p === '/api/v1/server-info') return { status: 200, text: env('API-105', { product, version: '1.0' }) };
    if (method === 'POST' && p === '/api/v1/sessions') {
      const b = body as { login: string; password: string; client: string };
      if (b.password !== 'b'.repeat(12)) return { status: 401, text: JSON.stringify({ type: problemType('credentials_invalid'), title: 'x', status: 401, code: 'credentials_invalid', meta: meta('API-03') }) };
      return { status: 200, text: env('API-03', { user: { id: MARIA_ID, name: 'Maria Santos', role: 'technician', branch: 'columbus', language: 'en', employeeNumber: '40712' }, token: b.client === 'native' ? SAMPLE_TOKEN : null }) };
    }
    if (method === 'GET' && p === '/api/v1/me') {
      return { status: 200, text: env('API-07', { userId: MARIA_ID, name: 'Maria Santos', role: 'technician', skill: null, branch: 'columbus', employeeNumber: '40712', language: 'en', slashShortcut: 'off', permissions: [] }) };
    }
    if (method === 'GET' && p === '/api/v1/clock') {
      return { status: 200, text: env('API-10', { demoNow: '2026-09-15T10:28:00-04:00[America/New_York]', realNow: '2026-11-08T15:28:00Z[UTC]', rate: 1, paused: false, worldEpoch: 1, lastMove: null, replay: { running: false, done: 0, total: 0 }, resetAvailableInSeconds: 0 }) };
    }
    if (method === 'GET' && p === '/api/v1/app-info') return { status: 200, text: env('API-02', { demoMode: false, accessCodeOn: false, sourceUrl: 'x', sourceCommit: 'unknown' }) };
    if (method === 'POST' && p === '/api/v1/tech/sync-reports') return { status: 204, text: '' };
    if (method === 'POST' && p === '/api/v1/tech/items') {
      const items = (body as { items: { key: string }[] }).items.map((i) => {
        const seen = ledger.has(i.key);
        ledger.set(i.key, 1);
        return { key: i.key, result: seen ? 'duplicate' : 'applied', code: null, messageKey: null, values: null };
      });
      return { status: 200, text: env('API-102', { items }) };
    }
    if (method === 'DELETE' && p === '/api/v1/sessions/current') return { status: 204, text: '' };
    return { status: 404, text: '<html>not found</html>' };
  };
  const doFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method: init?.method ?? 'GET', url, via: 'fetch', auth: headers['authorization'] ?? null, body });
    if (!signal || !url.startsWith(origin)) throw new TypeError('Network request failed');
    const a = answer(init?.method ?? 'GET', url, body);
    return new Response(a.status === 204 ? null : a.text, { status: a.status });
  };
  const upload: UploadPort = {
    async upload(fileUri, url, init): Promise<UploadResult> {
      const text = readFileSync(new URL(fileUri), 'utf8');
      const body = JSON.parse(text) as unknown;
      calls.push({ method: init.method, url, via: 'upload', auth: init.headers['authorization'] ?? null, body });
      if (!signal || !url.startsWith(origin)) throw new Error('The Internet connection appears to be offline.');
      const a = answer(init.method, url, body);
      return { status: a.status, body: a.text, headers: { 'Content-Type': 'application/json' } };
    },
    bodyFile(text) {
      const dir = mkdtempSync(path.join(tmpdir(), 'bw-body-'));
      const f = path.join(dir, 'body.json');
      writeFileSync(f, text);
      return { uri: `file://${f}`, done: () => existsSync(f) && unlinkSync(f) };
    },
  };
  return { origin, calls, ledger, fetch: doFetch, upload, setSignal: (on: boolean) => (signal = on) };
}

export type FakeServer = ReturnType<typeof fakeServer>;

/** The phone's network over several servers: each call goes to the server whose origin it names; any other origin has no answer. */
export function fakeNet(...servers: FakeServer[]): { fetch: typeof fetch; upload: UploadPort } {
  const pick = (url: string) => servers.find((s) => url.startsWith(s.origin));
  return {
    fetch: (input, init) => {
      const s = pick(String(input));
      return s ? s.fetch(input, init) : Promise.reject(new TypeError('Network request failed'));
    },
    upload: {
      upload: (uri, url, init) => {
        const s = pick(url);
        return s ? s.upload.upload(uri, url, init) : Promise.reject(new Error('A server with the specified hostname could not be found.'));
      },
      bodyFile: (text) => (servers[0] as FakeServer).upload.bodyFile(text),
    },
  };
}
