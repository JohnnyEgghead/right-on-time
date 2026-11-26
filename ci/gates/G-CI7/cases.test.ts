// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G-CI7's committed known-bad cases (W-38: they run on every gate run and in the merge set). Each instrument of
// the role-by-route test must fail its plant: a route with no policy entry (a contract row, an app page file, an
// inventory page), an entry whose access disagrees with the specification, and mount given a handler with no entry.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allContracts, defineContract, reports, z } from '../../../packages/api/src/index.ts';
import { handlers, tokenChecks } from '../../../packages/api-server/src/handlers/index.ts';
import { mount, MountError } from '../../../packages/api-server/src/kernel/mount.ts';
import { pageGate } from '../../../packages/api-server/src/kernel/pages.ts';
import { api, page, roles, TECHNICIAN } from '../../../packages/api-server/src/policy/entry.ts';
import { policyTable } from '../../../packages/api-server/src/policy.ts';
import { kit } from '../../../packages/api-server/src/testing.ts';
import type { Handler, PolicyEntry } from '../../../packages/api-server/src/types.ts';
import { currentPhase, doneCheckpoints } from '../../page-walkers/inventory.ts';
import { harness } from './harness.ts';
import { guardedFetch, outsideHost } from './outside-fetch-guard.ts';
import { apiExpectations, apiProblems, appRoutes, pageProblems, phaseFloor, readBuildPlan, readInventory, readUiSpec, registryProblems, sameAccess, splitCells, tokenKindOfPath } from './lib.ts';

// F-1852: docs/UI-SPECIFICATION.md and docs/BUILD_PLAN.md are private paths (scripts/private-paths.txt), so in a public copy the
// cases that read them skip with a note naming the path; the private checkout has both and every case runs.
const absent = (rel: string): string =>
  existsSync(path.resolve(import.meta.dirname, '..', '..', '..', rel)) ? '' : `${rel} is not in this copy (a private path the public export leaves out)`;
const noUiSpec = absent('docs/UI-SPECIFICATION.md');
const noPlan = absent('docs/BUILD_PLAN.md');
const inv = readInventory();
const spec = noUiSpec ? '' : readUiSpec();

/** The plant: a probe row shaped like the board-delay endpoint (API-172), entered in the shared contract with no policy entry. */
const planted = defineContract({
  id: 'API-173', name: 'Board delay probe', method: 'POST', path: '/board-delay-probes', request: z.object({ seq: z.number().int() }),
  response: z.undefined(), successStatus: [204], errors: [], labels: [], examples: [{ name: 'office posts', input: { seq: 1 }, expectStatus: 204 }],
});
const ok: Handler<unknown> = async () => ({ ok: true, status: 200, data: { status: 'ok' } });

describe('G-CI7 must-fail cases', () => {
  // why: FR-AUTH-1, SD-7
  it('fails a planted contract row with no policy entry, and passes the real rows', () => {
    const pages = pageGate(policyTable);
    expect(registryProblems(policyTable, allContracts, appRoutes(), pages)).toEqual([]);
    expect(registryProblems(policyTable, [...allContracts, planted], appRoutes(), pages)).toEqual(['route POST /board-delay-probes (API-173) has no policy entry']);
  });

  // why: FR-AUTH-1, F-4, F-605 (the F-585 mechanism: the covered set follows the derived phase, so a merged phase 4 screen with no entry is caught; a pin to phase 3 hid it)
  it('fails a merged phase 4 screen (SCR-OFC-34) whose policy entry is missing, with the phase derived from the merged tasks', async (ctx) => {
    if (noUiSpec) ctx.skip(noUiSpec);
    const phase = currentPhase(undefined, () => ['CP1', 'CP2', 'CP3', 'P4-WEEK']);
    expect(phase).toBe(4);
    const covers = (r: { phase: number; task: string }): boolean => r.phase < phase || (r.phase === phase && r.task === 'P4-WEEK');
    const h = await harness(policyTable, { ...handlers });
    const without = policyTable.filter((e) => !(e.kind === 'page' && e.path === '/office/board/week'));
    const bad = await pageProblems(without, pageGate(without), inv, spec, covers, h.principal);
    expect(bad.problems).toContain('route /office/board/week (SCR-OFC-34) has no policy entry');
    // The same policy under the old pin (phase 3 or earlier) sees nothing: the plant that the pinned shape survived.
    const pinned = await pageProblems(without, pageGate(without), inv, spec, (r) => r.phase <= 3, h.principal);
    expect(pinned.problems).not.toContain('route /office/board/week (SCR-OFC-34) has no policy entry');
    const real = await pageProblems(policyTable, pageGate(policyTable), inv, spec, covers, h.principal);
    expect(real.problems).toEqual([]);
  });

  // why: FR-AUTH-1, F-639 (the floor: a phase pinned below the plan's done checkpoints is a plant the gate must fail)
  it('puts the phase floor at 1 plus the highest DONE checkpoint, so a pin to phase 3 fails once CP3 is DONE', (ctx) => {
    if (noPlan) ctx.skip(noPlan);
    const plan = '#### CP2 — Phase 2 checkpoint\nStatus: DONE\n\n#### CP3 — Phase 3 checkpoint\nStatus: DONE\n\n#### CP4 — Phase 4 checkpoint\nStatus: NEW\n';
    expect(phaseFloor(plan, doneCheckpoints)).toBe(4);
    expect(3 >= phaseFloor(plan, doneCheckpoints)).toBe(false);
    expect(4 >= phaseFloor(plan, doneCheckpoints)).toBe(true);
    expect(phaseFloor(readBuildPlan(), doneCheckpoints)).toBeGreaterThanOrEqual(5);
  });

  // why: FR-AUTH-1, SD-7
  it('fails a planted page file and a planted route file of the app with no policy entry', () => {
    const app = [
      { file: 'apps/web/app/office/secret/page.tsx', template: '/office/secret', kind: 'page' as const },
      { file: 'apps/web/app/office/reports/page.tsx', template: '/office/reports', kind: 'page' as const },
      { file: 'apps/web/app/api/v1/[...path]/route.ts', template: '/api/v1/{...path}', kind: 'route' as const },
      { file: 'apps/web/app/debug/route.ts', template: '/debug', kind: 'route' as const },
    ];
    expect(registryProblems(policyTable, allContracts, app, pageGate(policyTable))).toEqual([
      'page file apps/web/app/office/secret/page.tsx (route /office/secret) has no policy entry',
      'route file apps/web/app/debug/route.ts (route /debug) has no policy entry',
    ]);
  });

  // why: FR-AUTH-1, F-4
  it('fails a covered inventory page with no entry, an entry with the wrong access, and an entry outside the inventory', async (ctx) => {
    if (noUiSpec) ctx.skip(noUiSpec);
    const h = await harness(policyTable, { ...handlers });
    const without = policyTable.filter((e) => !(e.kind === 'page' && e.path === '/sign-in'));
    const r1 = await pageProblems(without, pageGate(without), inv, spec, (r) => r.phase <= 2, h.principal);
    expect(r1.problems).toContain('route /sign-in (SCR-OFC-01) has no policy entry');
    const open = policyTable.map((e): PolicyEntry => (e.kind === 'page' && e.path === '/office/reports' ? page('SCR-OFC-11', '/office/reports', roles('manager', 'technician')) : e));
    const r2 = await pageProblems(open, pageGate(open), inv, spec, (r) => r.phase <= 2, h.principal);
    expect(r2.problems.some((p) => p.startsWith('SCR-OFC-11 /office/reports: policy access'))).toBe(true);
    expect(r2.problems).toContain('SCR-OFC-11 /office/reports: technician, code off: got render, the spec says forbidden');
    const stray = [...policyTable, page('SCR-OFC-99', '/office/backdoor', TECHNICIAN)];
    expect((await pageProblems(stray, pageGate(stray), inv, spec, (r) => r.phase <= 2, h.principal)).problems).toContain('page entry SCR-OFC-99 /office/backdoor is no route of the page inventory');
  });

  // why: FR-AUTH-1, NFR-11
  it('fails an API entry whose access disagrees with the spec, through the router', async (ctx) => {
    if (noUiSpec) ctx.skip(noUiSpec);
    const health = allContracts.find((r) => r.id === 'API-171')!;
    const locked = policyTable.map((e): PolicyEntry => (e.kind === 'api' && e.contract === 'API-171' ? api(health, roles('manager')) : e));
    const h = await harness(locked, { ...handlers });
    expect((await apiProblems(locked, spec, h.call)).problems[0]).toMatch(/^API-171: policy access/);
    // The reports row (API-50, managers only, by the access of the screens that call it, UI-SPECIFICATION 12.2 and 2.4) planted open to everyone: the router lets the technician in.
    const open = policyTable.map((e): PolicyEntry => (e.kind === 'api' && e.contract === 'API-50' ? api(reports, { kind: 'public' }) : e));
    const h2 = await harness(open, { ...handlers });
    const { problems } = await apiProblems(open, spec, h2.call);
    expect(problems).toContain('API-50 GET /api/v1/reports: technician, code off: got allow, the spec says forbidden');
    expect(problems).toContain('API-50 GET /api/v1/reports: signed out, code off: got allow, the spec says unauthenticated');
  });

  // why: FR-AUTH-1, FR-AUTH-2 (F-213: the oracle reads an escaped pipe, names the rows no caller settles, and compares token kinds)
  it('reads API-04 past its escaped pipe, names API-09 and API-106, and compares access by token kind', (ctx) => {
    if (noUiSpec) ctx.skip(noUiSpec);
    expect(splitCells('| API-04 | Sample people | GET `/demo/people?app=office\\|tech` | — | people | x | CTL-OFC-01-05 | FR-AUTH-5 |')[3]).toBe('GET `/demo/people?app=office|tech`');
    const wants = apiExpectations(spec);
    expect(wants.get('API-04')).toEqual({ kind: 'public' });
    expect(wants.get('API-09')).toEqual({ kind: 'roles', roles: ['manager', 'office', 'technician'] });
    expect(wants.get('API-106')).toEqual({ kind: 'public' });
    expect(tokenKindOfPath('/m/{liveMapToken}')).toBe('live_map');
    expect(tokenKindOfPath('/inbox/{inboxToken}')).toBe('inbox');
    expect(tokenKindOfPath('/email/{oneTimeToken}')).toBeUndefined();
    const inboxPage = page('SCR-INB-01', '/inbox/{inboxToken}', { kind: 'token', tokenKind: 'booking' });
    expect(sameAccess(inboxPage, { kind: 'token', tokenKind: 'inbox' })).toBe(false);
    expect(sameAccess({ ...inboxPage, access: { kind: 'token', tokenKind: 'inbox' } }, { kind: 'token', tokenKind: 'inbox' })).toBe(true);
  });

  // why: FR-AUTH-1, SD-7
  it('makes mount refuse a planted handler with no entry, and mount the real table and handlers', () => {
    // The real table has token rows (API-166 to API-168): mount needs the real token checks too.
    const deps = { ...kit([], {}).deps, tokens: tokenChecks };
    expect(() => mount(policyTable, { ...handlers, 'API-998': ok }, deps)).toThrow(MountError);
    expect(() => mount(policyTable, { ...handlers, 'API-998': ok }, deps)).toThrow(/handler API-998 has no policy entry/);
    expect(() => mount(policyTable, {}, deps)).toThrow(/policy entry API-171 \(GET \/healthz\) has no handler/);
    expect(() => mount(policyTable, { ...handlers }, deps)).not.toThrow();
  });

  // why: F-683, F-643 - the guard refuses a fetch to a non-loopback host before any lookup, and lets loopback and relative calls through
  it('the outbound-fetch guard refuses a host name and passes loopback', async () => {
    const calls: string[] = [];
    const guarded = guardedFetch((async (u: unknown) => { calls.push(String(u)); return new Response('ok'); }) as typeof fetch);
    await expect(guarded('http://pbs.internal.example/api')).rejects.toThrow(/outbound fetch to pbs\.internal\.example/);
    await expect(guarded(new URL('https://billing.example.com/x'))).rejects.toThrow(/billing\.example\.com/);
    await expect(guarded(new Request('http://sms.example.org/send'))).rejects.toThrow(/sms\.example\.org/);
    expect(calls).toEqual([]);
    for (const ok of ['http://127.0.0.1:9', 'http://localhost:3000/x', 'http://[::1]:80/y', '/relative/path']) expect(outsideHost(ok), ok).toBeNull();
    expect((await guarded('http://127.0.0.1:9/z')).status).toBe(200);
    expect(calls).toEqual(['http://127.0.0.1:9/z']);
  });
});
