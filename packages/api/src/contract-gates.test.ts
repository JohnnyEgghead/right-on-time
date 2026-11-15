// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: SD-4, SD-5, FR-CONTRACT-4 (@bw/api: mounting, versioning, paging, envelope and labels, error catalog, contract-diff, typed client)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ApiError, API_BASE, ERROR_CODES, ERROR_STATUS, LABELS, V1_SUNSET_DAYS, addressField, checkAnswer, clampLimit, createClient, decodeCursor,
  defineContract, diffContracts, encodeCursor, exportContracts, fillPath, mountedPath, untaggedAddressFields, versionOfPath, z,
  type ContractRow, type ExportedContracts,
} from './index.ts';
import { allContracts, contractsByArea } from './contracts/index.ts';
import { healthz } from './contracts/health.ts';
import { cursorQuerySchema, numberedPage, PAGE_SIZE } from './paging.ts';

const repo = path.resolve(import.meta.dirname, '..', '..', '..');
const cli = path.join(repo, 'packages', 'api', 'src', 'cli.ts');
const baseline = JSON.parse(readFileSync(path.join(repo, 'packages', 'api', 'contracts.baseline.json'), 'utf8')) as ExportedContracts;
const META = { contract: 'API-171', worldEpoch: 1, demoNow: '2026-09-15T10:28:00-04:00[America/New_York]', viewer: { kind: 'public' } } as const;

// A sample enveloped row with an address field and a report-style label, the shape the kernel will answer.
const sample = defineContract({
  id: 'API-900',
  name: 'Sample report line',
  method: 'GET',
  path: '/samples/{id}',
  request: z.object({ id: z.string() }),
  response: z.object({ id: z.string(), home: addressField(), rate: z.number() }),
  errors: [],
  labels: ['simulated_pilot_data'],
  examples: [{ name: 'one', input: { id: 'x' }, expectStatus: 200 }],
});
const goodBody = { data: { id: 'x', home: '1 Main St', rate: 0.5 }, meta: { ...META, contract: 'API-900', labels: ['simulated_pilot_data', 'fictional_addresses'] } };

describe('error catalog', () => {
  it('has exactly the codes of UI-SPECIFICATION 4.3 (plus nothing, and offline stays client only)', () => {
    // why: FR-CONTRACT-4 the catalog in code must not drift from the table the UI maps messages from
    const doc = readFileSync(path.join(repo, 'docs', 'UI-SPECIFICATION.md'), 'utf8');
    const section = doc.slice(doc.indexOf('### 4.3 Error catalog'), doc.indexOf('### 4.4 Live updates'));
    const codes = [...section.matchAll(/^\| `([a-z_]+)`/gm)].map((m) => m[1]);
    expect(codes.filter((c) => c !== 'offline').sort()).toEqual([...ERROR_CODES].sort());
    expect(codes).toContain('offline');
    expect(Object.keys(ERROR_STATUS)).not.toContain('offline');
  });
});

describe('mounting, versioning and paging', () => {
  it('serves rows under /api/v1 except the origin-root exceptions', () => {
    // why: SD-4 base path and its exceptions (SD-17 routes, health check)
    expect(API_BASE).toBe('/api/v1');
    expect(mountedPath('API-20', '/board')).toBe('/api/v1/board');
    for (const id of ['API-115', 'API-116', 'API-117', 'API-118', 'API-164', 'API-171']) expect(mountedPath(id, '/x')).toBe('/x');
    expect(versionOfPath('/api/v1/jobs')).toBe('v1');
    expect(versionOfPath('/healthz')).toBeNull();
    expect(V1_SUNSET_DAYS).toBe(180);
    expect(fillPath('/jobs/{n}/assignment', { n: '24 8/5' })).toBe('/jobs/24%208%2F5/assignment');
  });

  it('pages by cursor (default 50, max 200) and by page number (size 50)', () => {
    // why: SD-4 paging
    expect(cursorQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(cursorQuerySchema.parse({ limit: '200' }).limit).toBe(200);
    expect(cursorQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(clampLimit(999)).toBe(200);
    expect(clampLimit(undefined)).toBe(50);
    const c = encodeCursor('2026-09-15', 'job-7');
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c)).toEqual({ sortKey: '2026-09-15', id: 'job-7' });
    expect(decodeCursor('not a cursor')).toBeNull();
    expect(numberedPage(z.string()).parse({ items: [], pages: 0 })).toEqual({ items: [], pages: 0 });
    expect(PAGE_SIZE).toBe(50);
  });
});

describe('envelope check (contract-tests core)', () => {
  it('passes an answer with its envelope, contract id and required labels', () => {
    // why: SD-5 a labeled answer conforms
    expect(checkAnswer(sample, { status: 200, body: goodBody })).toEqual([]);
  });

  it('fails an answer missing its envelope labels', () => {
    // why: SD-5 only the kernel writes labels; an answer without them fails its contract test
    const noSimulated = { ...goodBody, meta: { ...goodBody.meta, labels: ['fictional_addresses'] } };
    expect(checkAnswer(sample, { status: 200, body: noSimulated })).toContain('missing envelope label simulated_pilot_data');
    const noAddress = { ...goodBody, meta: { ...goodBody.meta, labels: ['simulated_pilot_data'] } };
    expect(checkAnswer(sample, { status: 200, body: noAddress })).toContain('missing envelope label fictional_addresses');
    const noMeta = { data: goodBody.data };
    expect(checkAnswer(sample, { status: 200, body: noMeta })[0]).toMatch(/not a valid envelope/);
    const bare = goodBody.data;
    expect(checkAnswer(sample, { status: 200, body: bare })[0]).toMatch(/not a valid envelope/);
    const wrongLabelName = { ...goodBody, meta: { ...goodBody.meta, labels: ['made_up'] } };
    expect(checkAnswer(sample, { status: 200, body: wrongLabelName }).length).toBeGreaterThan(0);
  });

  it('fails a wrong contract id, and checks Problem bodies against the catalog', () => {
    // why: SD-5 meta.contract names the row; Problem is RFC 9457 with a catalog code
    const wrong = { ...goodBody, meta: { ...goodBody.meta, contract: 'API-901' } };
    expect(checkAnswer(sample, { status: 200, body: wrong })).toContain('meta.contract API-901 is not API-900');
    const pm = { worldEpoch: 1, demoNow: META.demoNow, contract: 'API-900' };
    const notFound = { type: 'https://bw.j7l.io/errors/not_found', title: 'Not found', status: 404, code: 'not_found', meta: pm };
    expect(checkAnswer(sample, { status: 404, body: notFound })).toEqual([]);
    expect(checkAnswer(sample, { status: 409, body: { ...notFound, status: 409 } }).join()).toMatch(/catalog status 404/);
    const conflict = { type: 'https://bw.j7l.io/errors/window_full', title: 'Full', status: 409, code: 'window_full', meta: pm };
    expect(checkAnswer(sample, { status: 409, body: conflict }).join()).toMatch(/not one API-900 may answer/);
    expect(checkAnswer(sample, { status: 500, body: 'oops' })[0]).toMatch(/not a Problem/);
  });

  it('tags address fields and flags an address-named field with no tag', () => {
    // why: SD-5 Labels: a contract test fails an address field with no tag
    const untagged = z.object({ customer: z.object({ street: z.string(), name: z.string() }) });
    const jsonOf = (s: z.ZodType) => exportContracts([defineContract({ id: 'API-901', name: 'n', method: 'GET', path: '/x', request: z.object({}), response: s, errors: [], labels: [], examples: [] })])['API-901']?.response;
    expect(untaggedAddressFields(jsonOf(untagged))).toEqual(['$.customer.street']);
    expect(untaggedAddressFields(jsonOf(z.object({ street: addressField() })))).toEqual([]);
    expect(allContracts.flatMap((r) => untaggedAddressFields(exportContracts([r])[r.id]?.response).map((f) => `${r.id} ${f}`))).toEqual([]);
  });

  it('checks the plain health answer (OI-46) and a 204 body', () => {
    // why: SD-5 the 7.4 health row answers a plain body
    expect(checkAnswer(healthz, { status: 200, body: { status: 'ok' } })).toEqual([]);
    expect(checkAnswer(healthz, { status: 200, body: { status: 'down' } })[0]).toMatch(/response schema/);
    expect(LABELS).toEqual(['simulated_pilot_data', 'fictional_addresses', 'entered_offline', 'demo_mode']);
  });
});

describe('contract files', () => {
  it('has 1 file per area, ids unique, and every row carries at least 1 live example', () => {
    // why: SD-4 one Zod schema pair per row; every row runs against the stack
    expect(Object.keys(contractsByArea).sort()).toEqual(['auth', 'billing', 'booking', 'customers', 'demo', 'dispatch', 'health', 'import', 'map', 'report', 'tech', 'text']);
    const ids = allContracts.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of allContracts) expect(r.examples.length, r.id).toBeGreaterThan(0);
    expect(ids).toContain('API-171');
  });
});

describe('contract-diff', () => {
  const real = exportContracts(allContracts);

  it('passes an unchanged tree against the committed baseline', () => {
    // why: SD-4 contract-diff passes an unchanged tree
    expect(diffContracts(baseline, real)).toEqual([]);
  });

  it('fails a planted field rename, removed field, narrowed enum, new required request field and a removed row', () => {
    // why: SD-4 contract-diff fails a removed or changed field
    const row = (response: z.ZodType, request: z.ZodType = z.object({ a: z.string().optional() })): ContractRow =>
      defineContract({ id: 'API-950', name: 'n', method: 'POST', path: '/x', request, response, errors: [], labels: [], examples: [] });
    const base = exportContracts([row(z.object({ name: z.string(), kind: z.enum(['a', 'b']) }))]);
    const diff = (r: ContractRow) => diffContracts(base, exportContracts([r])).map((b) => `${b.at}: ${b.problem}`);
    expect(diff(row(z.object({ name: z.string(), kind: z.enum(['a', 'b']) })))).toEqual([]);
    expect(diff(row(z.object({ fullName: z.string(), kind: z.enum(['a', 'b']) })))).toEqual(['response.name: removed field']);
    expect(diff(row(z.object({ name: z.number(), kind: z.enum(['a', 'b']) })))[0]).toMatch(/response\.name: keyword type changed/);
    expect(diff(row(z.object({ name: z.string(), kind: z.enum(['a']) })))[0]).toMatch(/enum value "b" removed/);
    expect(diff(row(z.object({ name: z.string(), kind: z.enum(['a', 'b']) }), z.object({ a: z.string().optional(), b: z.string() })))).toEqual(['request.b: field became required']);
    expect(diffContracts(base, {})).toEqual([{ contract: 'API-950', at: '$', problem: 'contract removed' }]);
  });

  it('fails a constraint only the current request has, and a moved success status (F-127)', () => {
    // why: SD-4 contract-diff fails a removed or changed field; a new request constraint rejects input the baseline accepted
    const row = (request: z.ZodType, successStatus?: number[]): ContractRow =>
      defineContract({ id: 'API-950', name: 'n', method: 'POST', path: '/x', request, response: z.object({}), errors: [], labels: [], examples: [], ...(successStatus ? { successStatus } : {}) });
    const base = exportContracts([row(z.object({ q: z.string(), n: z.number() }))]);
    const diff = (r: ContractRow) => diffContracts(base, exportContracts([r])).map((b) => `${b.at}: ${b.problem}`);
    expect(diff(row(z.object({ q: z.string(), n: z.number() })))).toEqual([]);
    expect(diff(row(z.object({ q: z.string().max(10), n: z.number() })))[0]).toMatch(/request\.q: keyword maxLength added/);
    expect(diff(row(z.object({ q: z.string(), n: z.number().min(1) })))[0]).toMatch(/request\.n: keyword minimum added/);
    expect(diff(row(z.object({ q: z.string(), n: z.number() }).strict()))).toEqual(['request: keyword additionalProperties false added']);
    expect(diff(row(z.object({ q: z.string(), n: z.number() }), [204]))).toEqual(['successStatus: changed from [200] to [204]']);
  });

  it('passes additive changes: a new row, a new response field, a new optional request field', () => {
    // why: SD-4 within v1, changes are additive only
    const mk = (id: `API-${number}`, response: z.ZodType) => defineContract({ id, name: 'n', method: 'GET', path: '/x', request: z.object({}), response, errors: [], labels: [], examples: [] });
    const base = exportContracts([mk('API-950', z.object({ a: z.string() }))]);
    const cur = exportContracts([mk('API-950', z.object({ a: z.string(), b: z.string() })), mk('API-951', z.object({}))]);
    expect(diffContracts(base, cur)).toEqual([]);
  });

  it('fails the committed planted rename through the command line, and passes the real rows', () => {
    // why: SD-4 the gate proves it fails on every run
    const run = (...a: string[]) => spawnSync('node', [cli, 'diff', ...a], { encoding: 'utf8', cwd: repo });
    const good = run();
    expect(good.status, good.stderr).toBe(0);
    const bad = run('--rows', 'ci/gates/contract-gates/cases/renamed-field.rows.ts');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('API-171 response.status: removed field');
  });

  it('reads the baseline at --ref from any working directory, the package one included (F-131)', () => {
    // why: SD-4 the package script runs from packages/api, where a cwd-relative git path failed
    for (const cwd of [repo, path.join(repo, 'packages', 'api')]) {
      const r = spawnSync('node', [cli, 'diff', '--ref', 'HEAD'], { encoding: 'utf8', cwd });
      expect(r.status, r.stderr).toBe(0);
    }
  });
});

describe('typed client', () => {
  const fakeFetch = (status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url);
      if (init) seen.init = init;
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }) as typeof fetch;

  it('returns typed data from an envelope, builds the served URL, and keeps path params out of the query', async () => {
    // why: SD-4 mounting seen from the client; SD-5 envelope
    const seen: { url?: string; init?: RequestInit } = {};
    const client = createClient({ baseUrl: 'http://x.test/', fetch: fakeFetch(200, goodBody, seen) });
    const r = await client.call(sample, { id: 'a b' });
    expect(seen.url).toBe('http://x.test/api/v1/samples/a%20b');
    expect(r.data.rate).toBe(0.5);
    expect(r.envelope?.meta.labels).toContain('fictional_addresses');
  });

  it('throws ApiError carrying the Problem, and reads the plain health answer', async () => {
    // why: SD-5 Problem; UI-SPECIFICATION 4.3 codes
    const pm = { worldEpoch: 1, demoNow: META.demoNow, contract: 'API-900' };
    const problem = { type: 'https://bw.j7l.io/errors/forbidden', title: 'No', status: 403, code: 'forbidden', meta: pm };
    const err = await createClient({ baseUrl: 'http://x.test', fetch: fakeFetch(403, problem) }).call(sample, { id: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).problem.code).toBe('forbidden');
    const ok = await createClient({ baseUrl: 'http://x.test', fetch: fakeFetch(200, { status: 'ok' }) }).call(healthz);
    expect(ok.data).toEqual({ status: 'ok' });
  });

  it('maps a 5xx that is no Problem (an nginx 502 page) to ApiError server_error, and accepts server_error at any 5xx, the health check\'s 503 included', async () => {
    // why: F-128, F-215
    const html = async () => new Response('<html>502 Bad Gateway</html>', { status: 502 });
    const err = await createClient({ baseUrl: 'http://x.test', fetch: html as unknown as typeof fetch }).call(healthz).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).problem.code).toBe('server_error');
    const pm = { worldEpoch: 1, demoNow: META.demoNow, contract: 'API-171' };
    const p503 = { type: 'https://bw.j7l.io/errors/server_error', title: 'error.server_error', status: 503, code: 'server_error', meta: pm };
    expect(checkAnswer(healthz, { status: 503, body: p503 })).toEqual([]);
    expect(checkAnswer(healthz, { status: 404, body: { ...p503, status: 404 } }).join()).toMatch(/status 404/);
    // a 4xx that is no Problem stays a contract defect, not a server error
    const bad = async () => new Response('nope', { status: 403 });
    const e2 = await createClient({ baseUrl: 'http://x.test', fetch: bad as unknown as typeof fetch }).call(healthz).catch((e: unknown) => e);
    expect(e2).not.toBeInstanceOf(ApiError);
  });
});
