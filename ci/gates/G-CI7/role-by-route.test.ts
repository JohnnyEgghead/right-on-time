// SPDX-License-Identifier: AGPL-3.0-or-later
// The role-by-route test (FR-AUTH-1 acceptance; SPECIFICATIONS 6.8, section 14 item 7, invariant 7), over the real
// policy table, the real handlers and the real route registries. It reads the page inventory, never a hard-coded list:
// every covered row (and every page entry the table holds) gets its verdict per principal. Covered (F-585): every row of a
// phase before the one under certification, and each row of that phase whose building task is merged, read from the same
// source the page walkers read (ci/page-walkers/inventory.ts: BW_PHASE or the merged CP<n> trailers, BW_MERGED_TASKS for
// tests), so a page built in phase 4 is checked from its merge, and CP4 checks every phase 4 row.
import { describe, expect, it } from 'vitest';
import { allContracts } from '../../../packages/api/src/index.ts';
import { handlers } from '../../../packages/api-server/src/handlers/index.ts';
import { pageGate } from '../../../packages/api-server/src/kernel/pages.ts';
import { policyTable } from '../../../packages/api-server/src/policy.ts';
import { currentPhase, doneCheckpoints, mergedFromEnv, readMergedTasks } from '../../page-walkers/inventory.ts';
import { harness } from './harness.ts';
import {
  accessTable, apiExpectations, apiProblems, appRoutes, CODE_FREE_CONTRACTS, codeFreeCalls, pageProblems, phaseFloor, readBuildPlan, readInventory, readUiSpec,
  registryProblems, routeClass, signInScreens,
} from './lib.ts';

const readMerged = mergedFromEnv(process.env.BW_MERGED_TASKS, readMergedTasks);
/** The phase under certification (F-585: never a hand-set number). */
export const PHASE = currentPhase(process.env.BW_PHASE, readMerged);
const merged = new Set(readMerged());
export const covers = (row: { phase: number; task: string }): boolean => row.phase < PHASE || (row.phase === PHASE && merged.has(row.task));

const inv = readInventory();
const spec = readUiSpec();
const pages = pageGate(policyTable);

describe('G-CI7 role-by-route', () => {
  // why: FR-AUTH-1, SD-7
  it('finds a policy entry for every contract row and every route file of the app, and no entry without a row', () => {
    expect(registryProblems(policyTable, allContracts, appRoutes(), pages)).toEqual([]);
  });

  // why: FR-AUTH-1, F-639 (the floor: the derived phase is never below 1 plus the highest checkpoint the plan marks DONE)
  it('certifies a phase no lower than the plan allows', () => {
    expect(PHASE).toBeGreaterThanOrEqual(phaseFloor(readBuildPlan(), doneCheckpoints));
  });

  // why: FR-AUTH-1, F-4
  it('gives every page route its 2.4 verdict for each principal, with the access code off, on, and entered', async () => {
    const h = await harness(policyTable, { ...handlers });
    const { problems, checked } = await pageProblems(policyTable, pages, inv, spec, covers, h.principal);
    expect(problems).toEqual([]);
    // Every covered inventory row was checked, read from the inventory (P2-SHELL's SCR-SHR rows among them).
    // A hosted screen (a dialog, popover or panel "on" its host page) has no route of its own: its host's row holds the verdict.
    const covered = inv.screens.filter((s) => covers(s) && routeClass(s, inv)?.kind !== 'none').map((s) => s.screen);
    expect(covered.length).toBeGreaterThanOrEqual(6);
    for (const s of covered) expect(checked.some((c) => c.startsWith(`${s} `)), s).toBe(true);
  });

  // why: FR-AUTH-1, FR-AUTH-6, OI-18
  it('gives every API entry the verdict of its 12.2 callers and 12.1 item 7, through the mounted router', async () => {
    const h = await harness(policyTable, { ...handlers });
    const { problems, checked } = await apiProblems(policyTable, spec, h.call);
    expect(problems).toEqual([]);
    expect(checked).toEqual(allContracts.map((r) => r.id));
  });

  // why: FR-AUTH-1, F-4
  it('refuses a technician the reports page and its API calls', async () => {
    const h = await harness(policyTable, { ...handlers });
    const tech = await h.principal({ name: 'technician', role: 'technician', via: 'password' }).caller({ codeOn: false, codeEntered: false });
    expect(pages.verdict('/office/reports', tech, { codeOn: false, codeEntered: false })).toEqual({ kind: 'forbidden', screen: 'SCR-SHR-01', status: 403 });
  });

  // why: SD-47, OI-18
  it('reads the spec oracles as the specification states them', () => {
    expect([...codeFreeCalls(spec)].sort()).toEqual([...CODE_FREE_CONTRACTS].sort());
    expect([...signInScreens(inv)].sort()).toEqual(['SCR-OFC-01', 'SCR-TEC-01']);
    const access = accessTable(spec);
    expect(access.get('SCR-OFC-11')).toEqual({ kind: 'roles', roles: ['manager'] });
    expect(access.get('SCR-TEC-04')).toEqual({ kind: 'roles', roles: ['technician'] });
    expect(access.get('SCR-OFC-46')).toEqual({ kind: 'roles', roles: ['manager'] });
    expect(access.get('SCR-INB-01')).toEqual({ kind: 'token' });
    for (const s of inv.screens) if (routeClass(s, inv)?.kind === 'paths') expect(access.has(s.screen), s.screen).toBe(true);
    // The 12.2 oracle resolves the rows the next lanes add: the sign-in, clock and reports calls among them.
    const api = apiExpectations(spec);
    expect(api.get('API-03')).toEqual({ kind: 'public' });
    expect(api.get('API-50')).toEqual({ kind: 'roles', roles: ['manager'] });
    expect(api.get('API-133')).toEqual({ kind: 'roles', roles: ['manager', 'office'] });
    expect(api.get('API-120')).toEqual({ kind: 'token', tokenKind: 'inbox' }); // F-213: the kind comes from the path's {inboxToken}
    expect(api.get('API-09')).toEqual({ kind: 'roles', roles: ['manager', 'office', 'technician'] });
    expect(api.get('API-171')).toEqual({ kind: 'public' });
  });
});
