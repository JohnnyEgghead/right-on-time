// SPDX-License-Identifier: AGPL-3.0-or-later
// The policy-table actions of the Technicians page (BUILD_PLAN section 4, Permission keys; owner ruling c025a9ec):
// each action's key (its contract id) is in API-07's list for every role its entry allows and absent for a role it denies.
import { addTechnician, addTimeOff, checkTextValue, editTechnician, removeTimeOff, technicianList } from '@bw/api';
import { describe, expect, it } from 'vitest';
import { policyTable } from '../policy.ts';
import type { Role } from '../types.ts';
import { handlers } from './index.ts';
import { permissionsOf } from './me.ts';

const ROWS = [technicianList, checkTextValue, editTechnician, addTechnician, addTimeOff, removeTimeOff];
const ROLES: Role[] = ['office', 'manager', 'technician'];

describe('the Technicians page calls in the policy table', () => {
  // why: FR-AUTH-1, FR-DISP-33, FR-AUTH-12 the 6 new API-07 keys (API-31, 32, 33, 147, 148, 169) are held by office and manager and by no technician (F-771)
  it('lists each action key for office and manager, and for no technician', () => {
    expect(ROWS.map((r) => r.id)).toEqual(['API-31', 'API-32', 'API-33', 'API-147', 'API-148', 'API-169']);
    for (const row of ROWS) {
      const entry = policyTable.find((e) => e.kind === 'api' && e.contract === row.id);
      expect(entry, row.id).toBeDefined();
      expect(entry?.access, row.id).toEqual({ kind: 'roles', roles: ['office', 'manager'] });
      expect(handlers[row.id], `${row.id} has a handler`).toBeTypeOf('function');
      for (const role of ROLES) {
        expect(permissionsOf(role).includes(row.id), `${row.id} for ${role}`).toBe(role !== 'technician');
      }
    }
  });
});
