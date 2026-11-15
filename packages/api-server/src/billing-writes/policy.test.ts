// SPDX-License-Identifier: AGPL-3.0-or-later
// The policy-table actions of the billing writes (owner ruling c025a9ec; SPECIFICATIONS section 4; UI-SPECIFICATION 2.4):
// each action's key (its contract id) is in API-07's list for every role its entry allows and absent for a role it denies.
import { correctFinish, markFixed, retryAll, retryNow, sendAgain, setPretendBillingMode } from '@bw/api';
import { describe, expect, it } from 'vitest';
import { permissionsOf } from '../handlers/me.ts';
import { handlers } from '../handlers/index.ts';
import { policyTable } from '../policy.ts';
import type { Role } from '../types.ts';

const ROWS = [sendAgain, correctFinish, retryNow, retryAll, markFixed, setPretendBillingMode];
const ROLES: Role[] = ['office', 'manager', 'technician'];

describe('the billing writes in the policy table', () => {
  // why: FR-AUTH-1, FR-BILL-7, FR-BILL-10, FR-BILL-11, FR-BILL-5
  it('lists each action key for the roles its entry allows and for no other role', () => {
    for (const row of ROWS) {
      const entry = policyTable.find((e) => e.kind === 'api' && e.contract === row.id);
      expect(entry, row.id).toBeDefined();
      expect(entry?.access, row.id).toEqual({ kind: 'roles', roles: ['office', 'manager'] });
      expect(handlers[row.id], `${row.id} has a handler`).toBeTypeOf('function');
      for (const role of ROLES) {
        const allowed = entry?.access.kind === 'roles' && entry.access.roles.includes(role);
        const keys = permissionsOf(role);
        expect(keys.includes(row.id), `${row.id} for ${role}`).toBe(allowed);
      }
    }
  });
});
