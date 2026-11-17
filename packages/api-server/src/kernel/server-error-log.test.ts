// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: F-1845, NFR-05
// A server_error answer is logged at error level with its cause code (F-1845), through the real router: a throw logs the
// error's code or class name (never its message), an answer outside the row's contract logs response_shape or
// cookie_not_allowed, and the caller's answer is the same server_error Problem as before. Other answers keep the info line.
import { defineContract, z, type ContractRow } from '@bw/api';
import { describe, expect, it } from 'vitest';
import { api, OFFICE } from '../policy/entry.ts';
import { kit, ORIGIN } from '../testing.ts';
import type { Handler } from '../types.ts';

const PRIVATE = 'Harold Jenkins 6145550100 at 12 Oak St';
const row: ContractRow = defineContract({
  id: 'API-22', name: 'API-22', method: 'POST', path: '/jobs/{jobNumber}/assignment',
  request: z.object({ jobNumber: z.coerce.number().int() }), response: z.object({ ok: z.boolean() }),
  errors: ['rule_refused'], labels: [], examples: [],
});

async function call(handler: Handler<unknown>) {
  const k = kit([api(row, OFFICE)], { 'API-22': handler });
  const { cookie, userId } = await k.signIn('office');
  const res = await k.call('POST', '/api/v1/jobs/24825/assignment', { headers: { cookie, origin: ORIGIN }, body: {} });
  const body = JSON.parse(await res.text()) as Record<string, unknown>;
  const line = k.lines.filter((l) => l.contract === 'API-22').at(-1)!;
  return { res, body, line, userId, all: JSON.stringify(k.lines) };
}

class StoreDown extends Error {
  override name = 'StoreDown';
}

describe('a server_error answer logs its cause at error level (F-1845)', () => {
  // why: F-1845: the kernel catch dropped the error, so a failing call logged an info line that named no cause.
  it('logs a throw by its code, else its class name, never its message, and answers the same Problem', async () => {
    const coded = Object.assign(new Error(PRIVATE), { code: '23505' });
    for (const [thrown, cause] of [[coded, '23505'], [new StoreDown(PRIVATE), 'StoreDown'], [new TypeError(PRIVATE), 'TypeError']] as const) {
      const { res, body, line, userId, all } = await call(async () => { throw thrown; });
      expect(res.status).toBe(500);
      expect(Object.keys(body).sort()).toEqual(['code', 'meta', 'status', 'title', 'type']);
      expect(body.code).toBe('server_error');
      expect(line).toMatchObject({ level: 'error', contract: 'API-22', route: '/api/v1/jobs/{jobNumber}/assignment', status: 500, errorCode: cause, userId });
      expect(all).not.toMatch(/Harold|6145550100|Oak/);
    }
  });

  // why: F-1845: an answer the kernel replaced with server_error logged nothing that said the handler broke its contract.
  it('logs response_shape or cookie_not_allowed for an answer outside the row, and the caller still sees server_error', async () => {
    const cases: [Handler<unknown>, string][] = [
      [async () => ({ ok: true, status: 200, data: { ok: 'yes' } }), 'response_shape'],
      [async () => ({ ok: true, status: 202 as 200, data: { ok: true } }), 'response_shape'],
      [async () => ({ ok: false, status: 409, code: 'window_full' }), 'response_shape'],
      [async () => ({ ok: false, status: 409, code: 'rule_refused', detail: { why: PRIVATE } }), 'response_shape'],
      [async () => ({ ok: true, status: 200, data: { ok: true }, cookies: ['bw_other=1; Path=/'] }), 'cookie_not_allowed'],
    ];
    for (const [handler, cause] of cases) {
      const { res, body, line, all } = await call(handler);
      expect(res.status).toBe(500);
      expect(body.code).toBe('server_error');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(line).toMatchObject({ level: 'error', status: 500, errorCode: cause });
      expect(all).not.toMatch(/Harold|6145550100|Oak/);
    }
  });

  // why: F-1845: only the failed answer moves to error level; a refusal the row allows and a good answer stay info lines.
  it('keeps a handler refusal the row allows and a good answer at info level, and a handler server_error is an error', async () => {
    const refused = await call(async () => ({ ok: false, status: 409, code: 'rule_refused' }));
    expect(refused.res.status).toBe(409);
    expect(refused.line).toMatchObject({ level: 'info', status: 409, errorCode: 'rule_refused' });
    const good = await call(async () => ({ ok: true, status: 200, data: { ok: true } }));
    expect(good.res.status).toBe(200);
    expect(good.line.level).toBe('info');
    expect(good.line).not.toHaveProperty('errorCode');
    const own = await call(async () => ({ ok: false, status: 500, code: 'server_error' }));
    expect(own.line).toMatchObject({ level: 'error', status: 500, errorCode: 'server_error' });
  });
});
