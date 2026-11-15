// SPDX-License-Identifier: AGPL-3.0-or-later
// FR-AUTH-2: a customer never needs an account. Every booking, live map, reschedule and inbox entry of the policy table is public
// or a link token (never a role list), and the kernel admits an anonymous caller to a token page where the code is off.
import { describe, expect, it } from 'vitest';
import { authorize } from './kernel/authorize.ts';
import { pageGate } from './kernel/pages.ts';
import { policyByArea, policyTable } from './policy.ts';

const CUSTOMER_SCREEN = /^SCR-(CUS|INB)-/;

describe('no customer account (FR-AUTH-2)', () => {
  // why: FR-AUTH-2
  it('gives every booking, live map, reschedule and inbox entry public or token access', () => {
    const entries = [...policyByArea.booking, ...policyByArea.map, ...policyByArea.text];
    expect(entries.length).toBeGreaterThanOrEqual(9);
    for (const e of entries) expect(['public', 'token'], `${e.kind === 'page' ? e.screen : e.contract} ${e.path}`).toContain(e.access.kind);
    for (const e of policyTable) {
      if (e.kind === 'page' && CUSTOMER_SCREEN.test(e.screen)) expect(['public', 'token'], e.screen).toContain(e.access.kind);
    }
  });

  // why: FR-AUTH-2
  it('lets an anonymous visitor open a customer page where the code is off, with no sign-in redirect', () => {
    const gate = pageGate(policyTable);
    for (const path of ['/book', '/book/done/sometoken', '/m/sometoken', '/r/sometoken', '/inbox/sometoken']) {
      const v = gate.verdict(path, { kind: 'anonymous' }, { codeOn: false, codeEntered: false });
      expect(v.kind, path).toBe('render');
    }
    const entry = gate.match('/inbox/sometoken')!;
    expect(authorize(entry, { kind: 'anonymous' }, { codeOn: false, codeEntered: false })).toEqual({ ok: true, needs: 'token' });
  });
});
