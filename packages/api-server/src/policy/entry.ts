// SPDX-License-Identifier: AGPL-3.0-or-later
// Builders for policy entries. An API entry takes its method, served path, schemas and codes from its contract row, so
// the policy table can never disagree with the shared contract; only the access is written here.
import { BEFORE_ACCESS_CODE, servedPath, type ContractRow } from '@bw/api';
import type { Access, ApiPolicyEntry, PagePolicyEntry, Role, TokenKind } from '../types.ts';

export const PUBLIC: Access = { kind: 'public' };
export const ONE_TIME: Access = { kind: 'one_time' };
export const token = (tokenKind: TokenKind): Access => ({ kind: 'token', tokenKind });
export const roles = (...r: Role[]): Access => ({ kind: 'roles', roles: r });

/** The office role and the manager role together (UI-SPECIFICATION 2.4, D13). */
export const OFFICE = roles('office', 'manager');
export const MANAGER = roles('manager');
export const TECHNICIAN = roles('technician');

export function api(row: ContractRow, access: Access): ApiPolicyEntry {
  return {
    kind: 'api', contract: row.id, method: row.method, path: servedPath(row), access,
    beforeAccessCode: BEFORE_ACCESS_CODE.has(row.id), request: row.request, response: row.response, errors: row.errors, row,
  };
}

/** A page route: a screen, a path and its access (UI-SPECIFICATION 2.3). `beforeAccessCode` is true only for the 2 sign-in pages, which open without the access code (SD-47 step 1). */
export function page(screen: `SCR-${string}`, path: string, access: Access, beforeAccessCode = false): PagePolicyEntry {
  return { kind: 'page', screen, path, access, beforeAccessCode };
}
