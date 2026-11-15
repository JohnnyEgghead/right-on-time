// SPDX-License-Identifier: AGPL-3.0-or-later
// The contract rules of UI-SPECIFICATION 12.1 and the map-file exception of SPECIFICATIONS 7.1, encoded in @bw/api so a
// lane that copies its 12.2 row faithfully passes contract-tests without editing this package (finding F-130).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addressField, allowedErrors, createClient, defineContract, isLinkTokenRoute, mountedPath, NUMBERED_LIST_KEYS, numberedPage, cursorPage,
  phoneField, queryUnsafeFields, rowJsonSchema, ROOT_CONTRACTS, z, type ContractRow,
} from './index.ts';
import { allContracts } from './contracts/index.ts';

const repo = path.resolve(import.meta.dirname, '..', '..', '..');
const uiSpec = readFileSync(path.join(repo, 'docs', 'UI-SPECIFICATION.md'), 'utf8');

const row = (id: `API-${number}`, method: ContractRow['method'], p: string, request: z.ZodType = z.object({})): ContractRow =>
  defineContract({ id, name: id, method, path: p, request, response: z.object({}), errors: [], labels: [], examples: [] });

/** 12.2 rows: id, method and path cell. */
function specRows(): { id: string; method: string; path: string }[] {
  const out: { id: string; method: string; path: string }[] = [];
  for (const line of uiSpec.split('\n')) {
    const m = /^\| (API-\d+) \| [^|]+ \| (GET|POST|PUT|PATCH|DELETE) ([^|]+)\|/.exec(line);
    if (m) out.push({ id: m[1]!, method: m[2]!, path: m[3]!.trim() });
  }
  return out;
}

describe('12.1 item 7: the codes every row may answer', () => {
  // why: F-130, FR-AUTH-6
  it('adds access_code_required to every call except the 5 before the code and the health check', () => {
    for (const id of ['API-01', 'API-02', 'API-03', 'API-10', 'API-105', 'API-171'] as const) {
      expect(allowedErrors(row(id, 'GET', '/x')).has('access_code_required'), id).toBe(false);
    }
    for (const id of ['API-04', 'API-05', 'API-20', 'API-165'] as const) {
      expect(allowedErrors(row(id, 'GET', '/x')).has('access_code_required'), id).toBe(true);
    }
  });

  // why: F-130, SD-4
  it('adds rate_limited to API-01, API-03, API-165 and every link-token route, and to nothing else', () => {
    for (const id of ['API-01', 'API-03', 'API-165'] as const) expect(allowedErrors(row(id, 'POST', '/x')).has('rate_limited'), id).toBe(true);
    expect(allowedErrors(row('API-120', 'GET', '/inbox/{inboxToken}/messages')).has('rate_limited')).toBe(true);
    expect(allowedErrors(row('API-115', 'GET', '/m/{liveMapToken}')).has('rate_limited')).toBe(true);
    expect(allowedErrors(row('API-20', 'GET', '/board')).has('rate_limited')).toBe(false);
    expect(allowedErrors(row('API-23', 'GET', '/jobs/{jobNumber}')).has('rate_limited')).toBe(false);
  });

  // why: F-130, SD-4
  it('finds every link-token row of 12.2 by its token path parameter', () => {
    const rows = specRows();
    const tokenRows = rows.filter((r) => /\{\w*Token\}/.test(r.path)).map((r) => r.id);
    expect(tokenRows).toEqual(['API-114', 'API-120', 'API-121', 'API-166', 'API-167', 'API-168']);
    for (const r of rows.filter((x) => tokenRows.includes(x.id))) expect(isLinkTokenRoute({ path: r.path.replace(/`/g, '').split(/[ ?]/)[0]! })).toBe(true);
    // The SD-17 link paths (API-115 to API-118, API-164) are printed as "the ... link path": their rows must name a token parameter.
    for (const c of allContracts.filter((x) => ['API-115', 'API-116', 'API-117', 'API-118', 'API-164'].includes(x.id))) {
      expect(isLinkTokenRoute(c), c.id).toBe(true);
    }
  });

  // why: F-130, NFR-11
  it('lets the sessionless health check answer neither unauthenticated nor forbidden', () => {
    const codes = allowedErrors(row('API-171', 'GET', '/healthz'));
    expect(codes.has('unauthenticated')).toBe(false);
    expect(codes.has('forbidden')).toBe(false);
    expect([...codes].sort()).toEqual(['not_found', 'server_error', 'validation_failed']);
    expect(allowedErrors(row('API-20', 'GET', '/board')).has('unauthenticated')).toBe(true);
  });
});

describe('12.1 item 6: no phone number or address in a query string', () => {
  // why: F-130, NFR-05
  it('holds for every GET and DELETE row in the shared contract', () => {
    const bad = allContracts
      .filter((r) => r.method === 'GET' || r.method === 'DELETE')
      .flatMap((r) => queryUnsafeFields(rowJsonSchema(r.request, 'input')).map((f) => `${r.id} ${f}`));
    expect(bad).toEqual([]);
  });

  // why: F-130, NFR-05
  it('flags address and phone fields, tagged or named, and free-text searches', () => {
    const req = z.object({ home: addressField(), mobile: phoneField(), street: z.string(), customerPhone: z.string(), query: z.string(), date: z.string() });
    expect(queryUnsafeFields(rowJsonSchema(req, 'input')).sort()).toEqual(['$.customerPhone', '$.home', '$.mobile', '$.query', '$.street']);
  });

  // why: F-130, NFR-05
  it('makes the typed client refuse to put such a field in a query string, and keeps it in a POST body', async () => {
    const seen: string[] = [];
    const fetchStub = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const client = createClient({ baseUrl: 'http://x', fetch: fetchStub });
    const getRow = defineContract({ ...row('API-901', 'GET', '/finds'), request: z.object({ query: z.string() }), envelope: false });
    await expect(client.raw(getRow, { query: '6145550100' })).rejects.toThrow(/query string/);
    expect(seen).toEqual([]);
    const postRow = defineContract({ ...row('API-902', 'POST', '/finds'), request: z.object({ query: z.string() }), envelope: false });
    await client.raw(postRow, { query: '6145550100' });
    expect(seen).toEqual(['http://x/api/v1/finds']);
  });
});

describe('SPECIFICATIONS 7.1 base path and the 2 page-numbered lists', () => {
  // why: F-130, FR-MAP-1
  it('serves the map file (API-106) at the origin root under /maps/, as nginx does', () => {
    expect(ROOT_CONTRACTS.has('API-106')).toBe(true);
    expect(mountedPath('API-106', '/maps/{branch}.pmtiles')).toBe('/maps/{branch}.pmtiles');
  });

  // why: F-130, SD-4
  it('names the list key of API-133 (rows) and API-149 (users), as 12.2 prints them', () => {
    const lines = uiSpec.split('\n');
    const cell = (id: string) => (lines.find((l) => l.startsWith(`| ${id} |`)) ?? '').split('|')[5] ?? '';
    for (const [id, key] of Object.entries(NUMBERED_LIST_KEYS)) {
      expect(cell(id), id).toMatch(new RegExp(`\\b${key} \\(`));
      expect(cell(id), id).toMatch(/\bpages\b/);
      const schema = numberedPage(z.object({ id: z.string() }), key);
      expect(schema.parse({ [key]: [{ id: 'a' }], pages: 1 })).toEqual({ [key]: [{ id: 'a' }], pages: 1 });
      expect(schema.safeParse({ items: [{ id: 'a' }], pages: 1 }).success, `${id} refuses the items key`).toBe(false);
    }
    expect(Object.keys(cursorPage(z.string(), 'texts').shape).sort()).toEqual(['next', 'texts']);
    expect(Object.keys(cursorPage(z.string()).shape).sort()).toEqual(['items', 'next']);
  });
});
