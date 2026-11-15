// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1366 (asc.mjs add-to-group waits for App Store Connect to list a fresh upload, then adds it once; P6-BUILD5-FIXES)
// release/asc.mjs runs as the release runs it (node, its own process) against a stub App Store Connect on 127.0.0.1: BW_ASC_API points it
// there, a temporary HOME holds a key made for this run (no real key, no network beyond this machine), and BW_ASC_STEP_MS and BW_ASC_CAP_MS
// shorten the 60 s step and the 45-minute cap (the tool honors them only with BW_ASC_API set). Nothing here reaches Apple.
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, '../../apps/tech-native/release/asc.mjs');
const ISSUER = 'i'.repeat(36);

let home = '';
let server: Server | null = null;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'bw-asc-'));
  const keys = path.join(home, '.appstoreconnect');
  mkdirSync(keys);
  writeFileSync(path.join(keys, 'issuer_id.txt'), `${ISSUER}\n`);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  // F-1621: the key id is a stand-in (the owner's is in the owner's private file only); TESTKEY001 is the one an owner file names.
  for (const kid of ['TESTKEY000', 'TESTKEY001']) writeFileSync(path.join(keys, `AuthKey_${kid}.p8`), privateKey.export({ type: 'pkcs8', format: 'pem' }));
});
afterEach(async () => {
  await new Promise<void>((res) => (server ? server.close(() => res()) : res()));
  server = null;
  rmSync(home, { recursive: true, force: true });
});

/**
 * The stub: the app, the internal group Owner, and build `version`, listed from the `listedOn`-th read of the builds on (never with null).
 * F-1390: the build reads PROCESSING until the `validOn`-th read (default: the one it is listed on), then `finalState` (VALID or FAILED);
 * an add while it is not VALID is refused with 409, as Apple may refuse it, and counted in `refused`.
 */
async function stubAsc(version: string, listedOn: number | null, opts: { validOn?: number; finalState?: string; detail?: (read: number) => boolean } = {}) {
  const seen = { buildReads: 0, posts: [] as { path: string; body: unknown }[], refused: 0, unsigned: 0, requests: 0, kids: new Set<string>() };
  let state = 'PROCESSING';
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://stub');
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const auth = req.headers.authorization ?? '';
      seen.requests += 1;
      const jwt = /^Bearer ([\w-]+)\./.exec(auth);
      if (jwt) seen.kids.add((JSON.parse(Buffer.from(jwt[1]!, 'base64url').toString()) as { kid: string }).kid);
      if (req.method === 'HEAD') return void res.writeHead(200).end(); // the token's time: node's own Date header
      if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(auth)) {
        seen.unsigned += 1;
        return json(401, { errors: [{ status: '401' }] });
      }
      if (req.method === 'GET' && u.pathname === '/v1/apps') return json(200, { data: [{ id: 'app-1', type: 'apps' }] });
      if (req.method === 'GET' && u.pathname === '/v1/builds') {
        seen.buildReads += 1;
        const listed = listedOn !== null && seen.buildReads >= listedOn;
        state = seen.buildReads >= (opts.validOn ?? listedOn ?? 0) ? (opts.finalState ?? 'VALID') : 'PROCESSING';
        // F-1404: `detail(read)` true includes the build's buildBetaDetail in the answer; false lists the build WITHOUT it (a partial answer).
        const withDetail = opts.detail?.(seen.buildReads) ?? false;
        return json(200, {
          data: listed ? [{ id: 'build-5', type: 'builds', attributes: { version, processingState: state, uploadedDate: '2026-11-10T20:00:00-08:00', expired: false },
            relationships: opts.detail ? { buildBetaDetail: { data: { id: 'detail-5', type: 'buildBetaDetails' } } } : {} }] : [],
          included: listed && withDetail ? [{ id: 'detail-5', type: 'buildBetaDetails', attributes: { internalBuildState: 'IN_BETA_TESTING', externalBuildState: 'READY_FOR_BETA_SUBMISSION' } }] : [],
        });
      }
      if (req.method === 'GET' && u.pathname === '/v1/betaGroups') return json(200, { data: [{ id: 'group-owner', type: 'betaGroups', attributes: { name: 'Owner', isInternalGroup: true } }] });
      if (req.method === 'POST' && u.pathname === '/v1/betaGroups/group-owner/relationships/builds') {
        if (state !== 'VALID') {
          seen.refused += 1;
          return json(409, { errors: [{ status: '409', detail: 'build is still processing' }] });
        }
        seen.posts.push({ path: u.pathname, body: JSON.parse(body) as unknown });
        return void res.writeHead(204).end();
      }
      return json(404, { errors: [{ status: '404' }] });
    });
  });
  await new Promise<void>((res) => server!.listen(0, '127.0.0.1', () => res()));
  const port = (server!.address() as AddressInfo).port;
  return { seen, api: `http://127.0.0.1:${port}` };
}

/**
 * asc.mjs in its own process (async: the stub answers from this one), with the stub, the temporary HOME, and the short step and cap.
 * F-1621: the key id is BW_ASC_KEY_ID=TESTKEY000 and the owner files point into the temporary HOME (absent unless a test writes one), so
 * the repo's own owner file is never read; `env` overrides, and an undefined value leaves that variable out.
 */
function asc(api: string, args: string[], capMs: number, env: Record<string, string | undefined> = {}): Promise<{ code: number | null; out: string; err: string }> {
  const all: Record<string, string | undefined> = {
    PATH: process.env['PATH'] ?? '', HOME: home, BW_ASC_API: api, BW_ASC_STEP_MS: '40', BW_ASC_CAP_MS: String(capMs),
    BW_ASC_KEY_ID: 'TESTKEY000', BW_OWNER_ENV: path.join(home, 'owner.env'), BW_OWNER_ENV_LOCAL: path.join(home, 'owner.local.env'), ...env,
  };
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], {
      env: Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => e[1] !== undefined)),
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (c: Buffer) => (out += c.toString()));
    p.stderr.on('data', (c: Buffer) => (err += c.toString()));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('release/asc.mjs add-to-group (F-1366)', () => {
  // why: F-1366 a fresh upload is not listed for minutes: add-to-group reads again until it is, then adds it to Owner once and exits 0
  it('polls until the build is listed (the 3rd read), adds it once, and exits 0', async () => {
    const { seen, api } = await stubAsc('5', 3);
    const r = await asc(api, ['add-to-group', '5'], 20_000);
    expect(r.err).toBe(`asc: BW_ASC_API is set: the target is the stub at ${api}, not App Store Connect\n`);
    expect(r.code).toBe(0);
    expect(seen.buildReads).toBe(3);
    expect(r.out.match(/build 5: not listed yet/g)).toHaveLength(2);
    expect(seen.posts).toEqual([{ path: '/v1/betaGroups/group-owner/relationships/builds', body: { data: [{ type: 'builds', id: 'build-5' }] } }]);
    expect(r.out).toContain('answered HTTP 204');
    expect(seen.unsigned).toBe(0);
  });

  // why: F-1366 a build already listed is added at the first read, with no wait
  it('adds a build listed at the first read straight away', async () => {
    const { seen, api } = await stubAsc('5', 1);
    const r = await asc(api, ['add-to-group', '5'], 20_000);
    expect(r.code).toBe(0);
    expect(seen.buildReads).toBe(1);
    expect(seen.posts).toHaveLength(1);
    expect(r.out).not.toContain('not listed yet');
  });

  // why: F-1366 a build that is never listed stops at the cap with a non-zero exit and nothing written
  it('exits 1 at the cap when the build is never listed, writing nothing', async () => {
    const { seen, api } = await stubAsc('5', null);
    const r = await asc(api, ['add-to-group', '5'], 600);
    expect(r.code).toBe(1);
    expect(r.err).toContain('build 5 still not listed after');
    expect(r.err).toContain('nothing written');
    expect(seen.buildReads).toBeGreaterThan(2);
    expect(seen.posts).toEqual([]);
  });

  // why: F-1390 a listed build is still PROCESSING for minutes; Apple is only seen to accept an add after VALID, so no POST goes out before it
  it('waits while the listed build is PROCESSING and adds only once it is VALID', async () => {
    const { seen, api } = await stubAsc('5', 1, { validOn: 4 });
    const r = await asc(api, ['add-to-group', '5'], 20_000);
    expect(r.code).toBe(0);
    expect(seen.refused).toBe(0);
    expect(seen.buildReads).toBe(4);
    expect(r.out.match(/build 5: processing PROCESSING/g)).toHaveLength(3);
    expect(seen.posts).toHaveLength(1);
  });

  // why: F-1390 a build that fails processing never reaches the group: non-zero exit, a clear line, nothing written
  it('exits 1 with a clear message when the build ends FAILED, writing nothing', async () => {
    const { seen, api } = await stubAsc('5', 1, { validOn: 3, finalState: 'FAILED' });
    const r = await asc(api, ['add-to-group', '5'], 20_000);
    expect(r.code).toBe(1);
    expect(r.err).toContain('build 5 processing FAILED; nothing written');
    expect(seen.posts).toEqual([]);
    expect(seen.refused).toBe(0);
  });

  // why: F-1390 a build that stays PROCESSING to the cap stops there, non-zero, nothing written
  it('exits 1 at the cap when the build never leaves PROCESSING', async () => {
    const { seen, api } = await stubAsc('5', 1, { validOn: 1_000_000 });
    const r = await asc(api, ['add-to-group', '5'], 600);
    expect(r.code).toBe(1);
    expect(r.err).toContain('still processing (PROCESSING)');
    expect(seen.posts).toEqual([]);
    expect(seen.refused).toBe(0);
  });

  // why: F-1391 BW_ASC_API takes only a stub on this machine: any other address exits non-zero before a token is signed or a request is sent
  it.each(['https://api.appstoreconnect.apple.com', 'http://example.com:80', 'http://127.0.0.1.evil.test:1', 'http://127.0.0.1', 'http://localhost:8080/x'])(
    'refuses BW_ASC_API=%s before signing anything',
    async (bad) => {
      const { seen } = await stubAsc('5', 1);
      const r = await asc(bad, ['add-to-group', '5'], 20_000);
      expect(r.code).toBe(2);
      expect(r.err).toContain('BW_ASC_API must be http://127.0.0.1:<port> or http://localhost:<port>');
      expect(r.out).toBe('');
      expect(seen.buildReads).toBe(0);
      expect(seen.unsigned).toBe(0);
    },
  );
});

describe('release/asc.mjs readback with a partial answer (F-1404)', () => {
  // why: F-1404 a listed build with no buildBetaDetail in the answer was printed as a confident "NOT available" and exited 1; it is unknown (exit 2)
  it('reports a build listed without its beta detail as a partial answer, exit 2, never NOT available', async () => {
    const { api } = await stubAsc('5', 1, { detail: () => false });
    const r = await asc(api, ['readback', '5'], 20_000);
    expect(r.code).toBe(2);
    expect(r.out).toContain("answered without the build's beta state");
    expect(r.out).toContain('internalBuildState unknown');
    expect(r.out).not.toContain('NOT available');
    expect(r.out).not.toContain('AVAILABLE to internal testers');
  });

  // why: F-1404 the complete answer still reads AVAILABLE and exits 0
  it('reads a complete answer as AVAILABLE, exit 0', async () => {
    const { api } = await stubAsc('5', 1, { detail: () => true });
    const r = await asc(api, ['readback', '5'], 20_000);
    expect(r.code).toBe(0);
    expect(r.out).toContain('internalBuildState IN_BETA_TESTING');
    expect(r.out).toContain('asc: AVAILABLE to internal testers');
  });

  // why: F-1404 wait reads again after a partial answer and exits 0 on the complete one
  it('wait reads again after a partial answer and exits 0 once the state is in the answer', async () => {
    const { seen, api } = await stubAsc('5', 1, { detail: (read) => read >= 3 });
    const r = await asc(api, ['wait', '5'], 20_000);
    expect(r.code).toBe(0);
    expect(seen.buildReads).toBe(3);
    expect(r.out).toContain('internalBuildState unknown');
  });

  // why: F-1404 a wait that ends at the cap on partial answers is unknown (exit 2), not a confident negative (exit 1)
  it('wait that ends at the cap on partial answers exits 2', async () => {
    const { api } = await stubAsc('5', 1, { detail: () => false });
    const r = await asc(api, ['wait', '5'], 400);
    expect(r.code).toBe(2);
  });
});

describe('release/asc.mjs key id from the owner (F-1621)', () => {
  // why: F-1621 the key id is the owner's and is in no exported file: the token is signed with BW_ASC_KEY_ID from the environment
  it('signs with the key id from the environment', async () => {
    const { seen, api } = await stubAsc('5', 1);
    const r = await asc(api, ['add-to-group', '5'], 20_000);
    expect(r.code, r.err).toBe(0);
    expect([...seen.kids]).toEqual(['TESTKEY000']);
  });

  // why: F-1621 with no key id in the environment, the owner's private file (BW_OWNER_ENV) supplies it, read the way the shell helper reads it
  it('signs with the key id from the owner file when the environment has none', async () => {
    writeFileSync(path.join(home, 'owner.env'), '# the owner file\nBW_OTHER=1\nBW_ASC_KEY_ID=TESTKEY001\nBW_ASC_KEY_ID=TESTKEY000\n');
    const { seen, api } = await stubAsc('5', 1);
    const r = await asc(api, ['add-to-group', '5'], 20_000, { BW_ASC_KEY_ID: undefined });
    expect(r.code, r.err).toBe(0);
    expect([...seen.kids]).toEqual(['TESTKEY001']);
  });

  // why: F-1621 no key id anywhere, or a malformed one: exit 2 before anything is signed or sent, and the value is never printed
  it.each([
    ['no key id', { BW_ASC_KEY_ID: undefined }, 'BW_ASC_KEY_ID is not set'],
    ['an empty key id', { BW_ASC_KEY_ID: '' }, 'BW_ASC_KEY_ID is not set'],
    ['a malformed key id', { BW_ASC_KEY_ID: 'bad-key-id-77' }, 'BW_ASC_KEY_ID is set but is not 10 capitals or digits'],
  ])('refuses with %s, sending nothing', async (_what, env, message) => {
    const { seen, api } = await stubAsc('5', 1);
    const r = await asc(api, ['add-to-group', '5'], 20_000, env);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
    expect(r.err).toContain('nothing signed or sent');
    expect(r.err + r.out).not.toContain('bad-key-id-77');
    expect(seen.requests).toBe(0);
  });
});
