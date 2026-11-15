// SPDX-License-Identifier: AGPL-3.0-or-later
// API-07 who am I and API-08 save my settings (UI-SPECIFICATION 12.2; SPECIFICATIONS FR-DISP-10, FR-DISP-11, FR-LANG-1).
// The office top bar reads API-07 for its menu (the role's screen keys from the policy table), the user button and the
// "/" switch; API-08 saves the language and the switch to the user row (user.language, user.slash_shortcut), so both hold
// at the next sign-in. Signed out, API-08 stores nothing and answers the choice back: a public page keeps it in the
// browser (SPECIFICATIONS FR-LANG-1).
import type { saveMySettings, whoAmI } from '@bw/api';
import type { z } from 'zod';
import { authorize } from '../kernel/authorize.ts';
import { policyTable } from '../policy.ts';
import type { Caller, Handler, PolicyEntry, Role } from '../types.ts';

type Me = z.infer<typeof whoAmI.response>;
type Settings = z.infer<typeof saveMySettings.response>;
type SettingsIn = z.infer<typeof saveMySettings.request>;

/**
 * The keys a role holds: the screen key of every page entry `authorize` admits for a signed-in person of that role, and the
 * contract id (API-61) of every API action it admits, so the UI shows a control only to a role that may use it
 * (owner ruling c025a9ec; UI-SPECIFICATION 2.4, FR-CONTRACT-7).
 */
export function permissionsOf(role: Role, table: readonly PolicyEntry[] = policyTable): string[] {
  const caller: Caller = { kind: 'staff', userId: '', role, client: 'web', via: 'password' };
  const keys = new Set<string>();
  for (const e of table) {
    if (!authorize(e, caller, { codeOn: false, codeEntered: false }).ok) continue;
    keys.add(e.kind === 'page' ? e.screen : e.contract);
  }
  return [...keys].sort();
}

interface UserRow {
  id: string;
  role: Role;
  branch_id: string;
  language: 'en' | 'es';
  slash_shortcut: boolean;
  employee_number: string | null;
  name: string;
  primary_skill: string | null;
}

const ME_SQL = `SELECT u.id, u.name, u.role, u.branch_id, u.language, u.slash_shortcut, u.employee_number,
                       t.primary_skill
                  FROM world."user" u LEFT JOIN world.technician t ON t.user_id = u.id
                 WHERE u.id = $1`;

const onOff = (b: boolean): 'on' | 'off' => (b ? 'on' : 'off');

export const whoAmIHandler: Handler<Me> = async (req, tx) => {
  if (req.caller.kind !== 'staff') return { ok: false, status: 401, code: 'unauthenticated' };
  const u = (await tx.query<UserRow>(ME_SQL, [req.caller.userId])).rows[0];
  // The session layer admits only an active user's session; a row gone since is not this caller any more.
  if (!u) return { ok: false, status: 404, code: 'not_found' };
  return {
    ok: true,
    status: 200,
    data: {
      userId: u.id, name: u.name, role: u.role, skill: u.primary_skill, branch: u.branch_id, employeeNumber: u.employee_number,
      language: u.language, slashShortcut: onOff(u.slash_shortcut), permissions: permissionsOf(u.role),
    },
  };
};

export const saveMySettingsHandler: Handler<Settings> = async (req, tx) => {
  const want = req.params as SettingsIn;
  if (req.caller.kind !== 'staff') return { ok: true, status: 200, data: { language: want.language ?? 'en', slashShortcut: want.slashShortcut ?? 'on' } };
  const r = await tx.query<{ language: 'en' | 'es'; slash_shortcut: boolean }>(
    `UPDATE world."user" SET language = COALESCE($2, language), slash_shortcut = COALESCE($3, slash_shortcut)
      WHERE id = $1 RETURNING language, slash_shortcut`,
    [req.caller.userId, want.language ?? null, want.slashShortcut === undefined ? null : want.slashShortcut === 'on'],
  );
  const u = r.rows[0];
  if (!u) return { ok: false, status: 404, code: 'not_found' };
  return { ok: true, status: 200, data: { language: u.language, slashShortcut: onOff(u.slash_shortcut) } };
};
