// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-261, FR-DISP-6
// A refusal's contract-typed detail (F-261): the kernel puts a handler's detail into the Problem body as extension members
// (SPECIFICATIONS 7.2, RFC 9457) only through the row's errorDetails schema, through the real router.
import { allContracts, checkAnswer, defineContract, errorDetailProblems, z, type ContractRow } from '@bw/api';
import { describe, expect, it } from 'vitest';
import { api, OFFICE } from '../policy/entry.ts';
import { kit, ORIGIN } from '../testing.ts';
import type { Handler } from '../types.ts';
import { checkTable } from './mount.ts';

const conflict = z.object({ by: z.string().nullable(), currentVersion: z.number().int() });
const row = (extra: Partial<ContractRow> = {}): ContractRow => defineContract({
  id: 'API-22', name: 'API-22', method: 'POST', path: '/jobs/{jobNumber}/assignment',
  request: z.object({ jobNumber: z.coerce.number().int() }), response: z.object({ ok: z.boolean() }),
  errors: ['version_conflict', 'rule_refused'], errorDetails: { version_conflict: conflict }, labels: [], examples: [], ...extra,
});
const refusing = (code: 'version_conflict' | 'rule_refused', detail?: unknown): Handler<unknown> =>
  async () => ({ ok: false, status: 409, code, ...(detail === undefined ? {} : { detail }) });

async function call(handler: Handler<unknown>, r: ContractRow = row()) {
  const k = kit([api(r, OFFICE)], { 'API-22': handler });
  const { cookie } = await k.signIn('office');
  const res = await k.call('POST', '/api/v1/jobs/24825/assignment', { headers: { cookie, origin: ORIGIN }, body: {} });
  return { res, body: JSON.parse(await res.text()) as Record<string, unknown>, k };
}

describe('a refusal carries its contract-typed detail', () => {
  it('puts a valid detail into the Problem body beside its own members, and the body passes the contract check', async () => {
    const { res, body, k } = await call(refusing('version_conflict', { by: 'Dana Ruiz', currentVersion: 4, extra: 'dropped' }));
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ code: 'version_conflict', status: 409, by: 'Dana Ruiz', currentVersion: 4 });
    expect(body).not.toHaveProperty('extra'); // the schema strips a member it does not name
    expect(k.db.log.at(-1)).toBe('ROLLBACK');
    expect(checkAnswer(row(), { status: 409, body })).toEqual([]);
    expect(checkAnswer(row(), { status: 409, body: { ...body, currentVersion: 'four' } })).toEqual([expect.stringMatching(/version_conflict does not carry its members/)]);
  });

  it('answers server_error, with no members, for a missing or malformed detail of such a code', async () => {
    for (const detail of [undefined, { by: 7, currentVersion: 'four' }]) {
      const { res, body } = await call(refusing('version_conflict', detail));
      expect(res.status).toBe(500);
      expect(body.code).toBe('server_error');
      expect(body).not.toHaveProperty('currentVersion');
    }
  });

  it('answers server_error for a detail on a code whose row names none, and a plain refusal stays plain', async () => {
    expect((await call(refusing('rule_refused', { why: 'x' }))).body.code).toBe('server_error');
    const plain = await call(refusing('rule_refused'));
    expect(plain.res.status).toBe(409);
    expect(Object.keys(plain.body).sort()).toEqual(['code', 'meta', 'status', 'title', 'type']);
  });

  it('refuses at mount a detail for a code the row does not list, or one that would overwrite a Problem member', () => {
    const bad = row({ errorDetails: { window_full: conflict, version_conflict: z.object({ status: z.number() }) } });
    expect(errorDetailProblems(bad)).toEqual([
      'API-22: errorDetails names window_full, which is not in its errors',
      'API-22: the version_conflict detail member status is a Problem\'s own member',
    ]);
    expect(() => checkTable([api(bad, OFFICE)], { 'API-22': refusing('rule_refused') })).toThrow(/window_full, which is not in its errors/);
  });

  it('holds for every row of the shared contract', () => {
    expect(allContracts.flatMap(errorDetailProblems)).toEqual([]);
  });
});
