// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G-CI7, inv7-deny-by-default (SPECIFICATIONS section 14 item 7, invariant 7; FR-AUTH-1). The role-by-route
// test: every route of the app's route registries has a policy entry, and each entry gives every principal the verdict
// the specification expects. The expectations never come from the policy table itself:
//   pages  UI-SPECIFICATION 2.4 (access by role), 4.2 (Code needed: every web route except the 2 sign-in pages) and
//          SPECIFICATIONS SD-47 (route gating order, OI-18), over every acceptance/page-inventory.json row;
//   API    the 12.2 Callers column (each caller control's screen, then that screen's 2.4 access), 12.1 item 7 (the calls
//          that answer without the code) and SPECIFICATIONS 7.4 for its 2 endpoints.
// The registries: the contract rows of @bw/api (every API route), the page inventory (every page route), and the page
// and route files of the Next.js app (apps/web/app), so a route added in any of them with no entry fails.
// Verdicts are read from the real components: router.handle of the real mount over the real table and handlers, and
// pageGate over the real table, with real sessions resolved by the real session layer.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { CODE_FREE_CONTRACTS, type ContractRow } from '../../../packages/api/src/index.ts';
import type { PageGate } from '../../../packages/api-server/src/kernel/pages.ts';
import type { PolicyEntry, Role } from '../../../packages/api-server/src/types.ts';

export const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const ROLES: readonly Role[] = ['manager', 'office', 'technician'];

export type Expected = { kind: 'public' } | { kind: 'token'; tokenKind?: string } | { kind: 'one_time' } | { kind: 'roles'; roles: Role[] };

export interface ScreenRow { screen: string; name: string; type: string; route: string; phase: number; task: string }
export interface Inventory { screens: ScreenRow[]; routes: { screen: string; route: string; phase: number }[] }

export const readInventory = (root = ROOT): Inventory => JSON.parse(readFileSync(path.join(root, 'acceptance', 'page-inventory.json'), 'utf8')) as Inventory;
export const readUiSpec = (root = ROOT): string => readFileSync(path.join(root, 'docs', 'UI-SPECIFICATION.md'), 'utf8');
export const readBuildPlan = (root = ROOT): string => readFileSync(path.join(root, 'docs', 'BUILD_PLAN.md'), 'utf8');

/** The lowest phase the gate may certify (F-639): 1 plus the highest CP<n> the plan marks DONE, capped at 9. A hand-pinned or stale phase below it hides merged pages. */
export function phaseFloor(planText: string, done: (plan: string) => string[]): number {
  let top = 0;
  for (const id of done(planText)) {
    const m = /^CP([1-9])$/.exec(id);
    if (m) top = Math.max(top, Number(m[1]));
  }
  return Math.min(top + 1, 9);
}

function section(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`UI-SPECIFICATION section ${start} not found`);
  return text.slice(a, b);
}

/** Screen ids of a 2.4 first cell, ranges ("SCR-OFC-02 to SCR-OFC-10") expanded. */
export function screensOf(cell: string): string[] {
  const out: string[] = [];
  const rx = /SCR-([A-Z]+)-(\d+)(?:\s+to\s+SCR-\1-(\d+))?/g;
  for (const m of cell.matchAll(rx)) {
    const from = Number(m[2]);
    const to = m[3] ? Number(m[3]) : from;
    for (let n = from; n <= to; n++) out.push(`SCR-${m[1]}-${String(n).padStart(2, '0')}`);
  }
  return out;
}

/** UI-SPECIFICATION 2.4: each screen's access. Rows about controls (no screen first) are skipped. */
export function accessTable(uiSpec: string): Map<string, Expected> {
  const out = new Map<string, Expected>();
  for (const line of section(uiSpec, '### 2.4 Access by role', '\n## 3.').split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 7 || !cells[1]!.startsWith('SCR-')) continue;
    const [m, o, t, pub] = [cells[2]!, cells[3]!, cells[4]!, cells[5]!.toLowerCase()];
    let e: Expected;
    if (pub.startsWith('yes') || pub === 'public') e = { kind: 'public' };
    else if (pub === 'token') e = { kind: 'token' };
    else if (pub === 'one-time') e = { kind: 'one_time' };
    else if (pub === 'no') e = { kind: 'roles', roles: ROLES.filter((_, i) => [m, o, t][i]!.toLowerCase().startsWith('yes')) };
    else throw new Error(`2.4 row with an unreadable access cell: ${line.slice(0, 120)}`);
    for (const s of screensOf(cells[1]!)) out.set(s, e);
  }
  return out;
}

/**
 * The token kind a route's path names (F-213): the `{...Token}` parameter of the specified route, so token access is compared
 * by kind of token, not only by "a token". `{oneTimeToken}` is the one_time access, and a bare `{token}` names no kind.
 */
export function tokenKindOfPath(routePath: string): string | undefined {
  const name = /\{(\w*[tT]oken)\}/.exec(routePath)?.[1];
  if (!name || name === 'token' || name === 'oneTimeToken') return undefined;
  return name.slice(0, -'Token'.length).replace(/([A-Z])/g, (c) => `_${c.toLowerCase()}`);
}

/** Split a Markdown table row on its unescaped pipes (a cell may hold `\|`, as API-04's path does); `\|` reads as `|`. */
export function splitCells(line: string): string[] {
  return line.split(/(?<!\\)\|/).map((c) => c.replaceAll('\\|', '|').trim());
}

/** The gate's own page is shown to everyone before the code (2.4 has no row for it; section 5 and 4.2). */
const IMPLIED: Record<string, Expected> = { 'SCR-GATE-01': { kind: 'public' } };

/** Shared components on the callers list: the surface they sit on (UI-SPECIFICATION section 3); others name no access. */
const COMPONENT_ACCESS: Record<string, Expected> = {
  'CMP-01': { kind: 'public' }, 'CMP-02': { kind: 'public' }, 'CMP-03': { kind: 'public' }, 'CMP-04': { kind: 'public' }, 'CMP-15': { kind: 'public' },
  'CMP-07': { kind: 'roles', roles: ['manager', 'office'] }, 'CMP-08': { kind: 'roles', roles: ['manager', 'office'] },
  'CMP-10': { kind: 'roles', roles: ['technician'] },
};

/** SPECIFICATIONS 7.4's 2 endpoints, which 12.2 does not list: API-171 (no code, no session) and API-172 (office and manager). */
const SECTION_74: Record<string, Expected> = { 'API-171': { kind: 'public' }, 'API-172': { kind: 'roles', roles: ['manager', 'office'] } };

/**
 * Rows whose callers settle no single access, named here with the text that gives it (F-213):
 *   API-09 the event stream: SPECIFICATIONS 7.3 "the stream is filtered by the caller's branch and role" and UI-SPECIFICATION
 *     12.2 "stream closes on `unauthenticated`", so every signed-in role and no anonymous caller;
 *   API-106 the map file: SPECIFICATIONS 6.10 FR-MAP-1 (nginx serves the file from the app's own origin) and its callers include
 *     the customer map CTL-CUS-04-01 and the staff and technician maps, so it is public (nginx, outside the kernel, has no session);
 *   API-174 the click of the alert email link (CTL-OFC-16-23, CTL-OFC-28-04): managers only (FR-AUTH-8 note; F-660, F-735, F-776).
 *     UI-SPECIFICATION 2.4 gives its basis; its callers' screens (SCR-OFC-28 is open to managers and office) would widen it.
 *   API-175 the stored photo and signature file (P5-TWA-JOB; F-707, F-727), which 12.2 lists since UI-SPECIFICATION 0.14 (the row retired its AWAITING_12_2 entry):
 *     CTL-OFC-03-14 to -16 ("photo files from API-23") and CTL-OFC-03-30 on the office job page (SCR-OFC-03: office, manager) and
 *     CTL-TEC-04-10, -11 on the technician's job (SCR-TEC-04: technician, own jobs only, held by the handler).
 */
const NAMED_ACCESS: Record<string, Expected> = {
  'API-174': { kind: 'roles', roles: ['manager'] },
  'API-09': { kind: 'roles', roles: ['manager', 'office', 'technician'] },
  'API-106': { kind: 'public' },
};

/** Rows 12.2 does not list yet, each with its basis in NAMED_ACCESS's comment; the doc batch's 12.2 row retires its entry here. API-175's row is listed since UI-SPECIFICATION 0.14 (F-875 follow-on), so none waits. */
const AWAITING_12_2: Record<string, Expected> = {};

/**
 * Union of accesses: public admits everyone, so it wins; roles merge. A row called both from a link page and from
 * staff pages (API-106, the map file) has no single access the callers settle: null, so its lane names it explicitly.
 */
export function union(list: Expected[]): Expected | null {
  if (list.length === 0) return null;
  if (list.some((e) => e.kind === 'public')) return { kind: 'public' };
  const kinds = new Set(list.map((e) => e.kind));
  if (kinds.size > 1) return null;
  for (const k of ['token', 'one_time'] as const) if (kinds.has(k)) return { kind: k } as Expected;
  const roles = new Set<Role>();
  for (const e of list) if (e.kind === 'roles') for (const r of e.roles) roles.add(r);
  return { kind: 'roles', roles: ROLES.filter((r) => roles.has(r)) };
}

/** The expected access of each 12.2 row, from its callers' screens (and 7.4). Rows no caller resolves map to null. */
export function apiExpectations(uiSpec: string): Map<string, Expected | null> {
  const access = accessTable(uiSpec);
  const out = new Map<string, Expected | null>(Object.entries({ ...SECTION_74 }));
  for (const line of section(uiSpec, '### 12.2 Contracts', '### 12.3').split('\n')) {
    const cells = splitCells(line);
    if (!/^API-\d+$/.test(cells[1] ?? '')) continue;
    const found: Expected[] = [];
    for (const m of (cells[7] ?? '').matchAll(/CTL-([A-Z]+)-(\d+)-\d+/g)) {
      const screen = `SCR-${m[1]}-${m[2]}`;
      const e = m[1] === 'CMP' ? COMPONENT_ACCESS[`CMP-${m[2]}`] : (access.get(screen) ?? IMPLIED[screen]);
      if (e) found.push(e);
    }
    if (found.length > 0 || !out.has(cells[1]!)) {
      const u = union(found);
      const kind = u?.kind === 'token' ? tokenKindOfPath(cells[3] ?? '') : undefined;
      out.set(cells[1]!, kind ? { kind: 'token', tokenKind: kind } : u); // 7.4 rows have "none: no UI control"
    }
  }
  for (const [id, e] of Object.entries(NAMED_ACCESS)) if (out.has(id)) out.set(id, e);
  for (const [id, e] of Object.entries(AWAITING_12_2)) if (!out.has(id)) out.set(id, e);
  return out;
}

/** The calls that answer without the code, read from 12.1 item 7 (the 5 named calls, and API-171). */
export function codeFreeCalls(uiSpec: string): Set<string> {
  const item = /^7\. Errors use the codes.*$/m.exec(section(uiSpec, '### 12.1', '### 12.2'))?.[0] ?? '';
  const five = /The 5 calls that answer without the code are[^:]*: (.*?)\. API-04/.exec(item)?.[1] ?? '';
  const ids = new Set([...five.matchAll(/API-\d+/g)].map((m) => m[0]));
  if (ids.size !== 5) throw new Error(`12.1 item 7: expected 5 calls before the code, read ${[...ids].join(', ')}`);
  if (/API-171, the health check, answers with no access code/.test(item)) ids.add('API-171');
  return ids;
}

export type RouteClass = { kind: 'paths'; paths: string[] } | { kind: 'gate' | 'forbidden' | 'not_found' | 'server_error' } | { kind: 'none' };

/** What an inventory row's route cell names: concrete paths, an "any route" behavior, or no route of its own. */
export function routeClass(row: ScreenRow, inv: Inventory): RouteClass | null {
  const r = row.route;
  const listed = inv.routes.filter((x) => x.screen === row.screen).map((x) => x.route);
  if (listed.length > 0) return { kind: 'paths', paths: listed };
  if (/^any route, shown before the page when the code is on$/.test(r)) return { kind: 'gate' };
  if (/^any route, answering the code forbidden$/.test(r)) return { kind: 'forbidden' };
  if (/^any route, answering 404$/.test(r)) return { kind: 'not_found' };
  if (/^any route, answering 5xx$/.test(r)) return { kind: 'server_error' };
  if (/^the live map link path/.test(r)) return { kind: 'paths', paths: ['/m/{liveMapToken}'] };
  if (/^the reschedule link path/.test(r)) return { kind: 'paths', paths: ['/r/{rescheduleToken}'] };
  if (r === '—' || /^(on |top-bar )/.test(r)) return { kind: 'none' };
  const paths = [...r.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.split('?')[0]!);
  return paths.length > 0 ? { kind: 'paths', paths } : null;
}

/** The 2 sign-in pages of 4.2 (named "sign-in" in the inventory): the only pages that answer without the code. */
export const signInScreens = (inv: Inventory): Set<string> =>
  new Set(inv.screens.filter((s) => /sign-in/i.test(s.name) && s.type.includes('page')).map((s) => s.screen));

/** A concrete path for a template: every parameter filled with a sample value. */
export const fill = (template: string): string => template.replace(/\{(\w+)\}/g, (_, n: string) => (/token/i.test(n) ? 'Zq3xY9sampleToken' : '2481'));

/** Route files of the Next.js app (SD-2: apps/web), as path templates: page files and route handlers. */
export function appRoutes(root = ROOT): { file: string; template: string; kind: 'page' | 'route' }[] {
  const appDir = path.join(root, 'apps', 'web', 'app');
  const out: { file: string; template: string; kind: 'page' | 'route' }[] = [];
  if (!existsSync(appDir)) return out;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      const m = /^(page|route)\.(tsx|ts|jsx|js|mdx)$/.exec(name);
      if (!m) continue;
      const rel = path.relative(appDir, dir).split(path.sep).filter((s) => s !== '' && !/^\(.*\)$/.test(s) && !s.startsWith('@'));
      const template = `/${rel.map((s) => s.replace(/^\[\[?\.\.\.(\w+)\]\]?$/, '{...$1}').replace(/^\[(\w+)\]$/, '{$1}')).join('/')}`;
      out.push({ file: path.relative(root, full), template, kind: m[1] as 'page' | 'route' });
    }
  };
  walk(appDir);
  return out;
}

/** The registry check: every contract row and app route file has its entry, and no API entry names an unknown row. */
export function registryProblems(table: readonly PolicyEntry[], rows: readonly ContractRow[], app: ReturnType<typeof appRoutes>, pages: PageGate): string[] {
  const problems: string[] = [];
  const apiIds = new Map<string, number>();
  for (const e of table) if (e.kind === 'api') apiIds.set(e.contract, (apiIds.get(e.contract) ?? 0) + 1);
  for (const r of rows) {
    const n = apiIds.get(r.id) ?? 0;
    if (n === 0) problems.push(`route ${r.method} ${r.path} (${r.id}) has no policy entry`);
    if (n > 1) problems.push(`${r.id} has ${n} policy entries`);
  }
  const known = new Set<string>(rows.map((r) => r.id));
  for (const id of apiIds.keys()) if (!known.has(id)) problems.push(`policy entry ${id} names no contract row`);
  const apiPaths = table.filter((e) => e.kind === 'api').map((e) => e.path.replace(/\{\w+\}/g, '{}'));
  for (const f of app) {
    if (f.kind === 'page' && !pages.match(fill(f.template))) problems.push(`page file ${f.file} (route ${f.template}) has no policy entry`);
    if (f.kind === 'route' && !/\{\.\.\.\w+\}$/.test(f.template) && !apiPaths.includes(f.template.replace(/\{\w+\}/g, '{}'))) {
      problems.push(`route file ${f.file} (route ${f.template}) has no policy entry`);
    }
  }
  return problems;
}

/** Same access? (token kinds are not in 2.4; any link token matches `token`.) */
export function sameAccess(entry: PolicyEntry, want: Expected): boolean {
  if (entry.access.kind !== want.kind) return false;
  if (want.kind === 'token' && want.tokenKind && entry.access.kind === 'token' && entry.access.tokenKind !== want.tokenKind) return false;
  if (want.kind !== 'roles' || entry.access.kind !== 'roles') return true;
  return [...entry.access.roles].sort().join() === [...want.roles].sort().join();
}

/** The verdict a principal must get, by the spec: allow, or the refusal code, in the SD-47 order. */
export function expectedVerdict(
  want: Expected,
  codeFree: boolean,
  who: { role: Role | null; via: 'password' | 'sign_in_as' | null },
  gate: { codeOn: boolean; codeEntered: boolean },
): 'allow' | 'access_code_required' | 'unauthenticated' | 'forbidden' {
  // SD-8: a sign-in-as session counts only with the access cookie while the code is on.
  const role = who.via === 'sign_in_as' && gate.codeOn && !gate.codeEntered ? null : who.role;
  const passed = !gate.codeOn || gate.codeEntered || (role !== null && who.via === 'password');
  if (!codeFree && !passed) return 'access_code_required';
  if (want.kind !== 'roles') return 'allow';
  if (role === null) return 'unauthenticated';
  return want.roles.includes(role) ? 'allow' : 'forbidden';
}

export { CODE_FREE_CONTRACTS };

/** The principals every route is tried with: no session, a password session per role, and a Sign in as session. */
export const PRINCIPALS: readonly { name: string; role: Role | null; via: 'password' | 'sign_in_as' | null }[] = [
  { name: 'signed out', role: null, via: null },
  { name: 'manager', role: 'manager', via: 'password' },
  { name: 'office', role: 'office', via: 'password' },
  { name: 'technician', role: 'technician', via: 'password' },
  { name: 'office by Sign in as', role: 'office', via: 'sign_in_as' },
];

export const GATES: readonly { name: string; codeOn: boolean; codeEntered: boolean }[] = [
  { name: 'code off', codeOn: false, codeEntered: false },
  { name: 'code on, not entered', codeOn: true, codeEntered: false },
  { name: 'code on, entered', codeOn: true, codeEntered: true },
];

const isTech = (p: string) => p === '/tech' || p.startsWith('/tech/');

/** The page verdict kind the spec expects (4.2 states, SD-47 step 3, 2.4's "sign-in page with a return path"). */
function pageKind(v: ReturnType<typeof expectedVerdict>, p: string): string {
  if (v === 'allow') return 'render';
  if (v === 'forbidden') return 'forbidden';
  if (v === 'unauthenticated') return isTech(p) ? 'redirect /tech/sign-in' : 'redirect /sign-in';
  return isTech(p) && p !== '/tech/install' ? 'redirect /tech/sign-in' : 'gate';
}

export interface Principal {
  /** Resolve this principal's caller through the real session layer for 1 gate state. */
  caller(gate: { codeOn: boolean; codeEntered: boolean }): Promise<import('../../../packages/api-server/src/types.ts').Caller>;
}

/**
 * The page matrix: every inventory row `covers` selects (and every page entry of the table) against 2.4, 4.2 and SD-47,
 * through the real page gate. `principal` resolves a real session for a principal.
 */
export async function pageProblems(
  table: readonly PolicyEntry[],
  pages: PageGate,
  inv: Inventory,
  uiSpec: string,
  /** Whether the check covers an inventory row (F-585: role-by-route.test.ts derives it from the phase under certification). */
  covers: (row: Inventory['screens'][number]) => boolean,
  principal: (p: (typeof PRINCIPALS)[number]) => Principal,
): Promise<{ problems: string[]; checked: string[] }> {
  const access = accessTable(uiSpec);
  const signIn = signInScreens(inv);
  const problems: string[] = [];
  const checked: string[] = [];
  const pageEntries = table.filter((e) => e.kind === 'page');
  const tryAll = async (p: string, screen: string, want: Expected, codeFree: boolean) => {
    for (const who of PRINCIPALS) {
      const pr = principal(who);
      for (const g of GATES) {
        const v = pages.verdict(p, await pr.caller(g), g);
        const got = v.kind === 'redirect' ? `redirect ${v.to.split('?')[0]}` : v.kind;
        const exp = pageKind(expectedVerdict(want, codeFree, who, g), p);
        if (got !== exp) problems.push(`${screen} ${p}: ${who.name}, ${g.name}: got ${got}, the spec says ${exp}`);
      }
    }
  };
  for (const row of inv.screens) {
    const cls = routeClass(row, inv);
    if (cls === null) {
      if (covers(row)) problems.push(`${row.screen}: route "${row.route}" is not a route this test understands`);
      continue;
    }
    if (cls.kind !== 'paths') {
      if (!covers(row) || cls.kind === 'none') continue;
      checked.push(`${row.screen} (${cls.kind})`);
      // The "any route" behaviors of 4.2, over every page entry and an unknown path.
      if (cls.kind === 'not_found') {
        for (const who of PRINCIPALS) {
          const v = pages.verdict('/office/no-such-page', await principal(who).caller(GATES[0]!), GATES[0]!);
          if (v.kind !== 'not_found' || v.screen !== row.screen) problems.push(`${row.screen}: ${who.name} on an unknown route got ${v.kind}`);
        }
      }
      for (const e of pageEntries) {
        const p = fill(e.path);
        for (const who of PRINCIPALS) {
          if (cls.kind === 'gate') {
            const g = GATES[1]!;
            const v = pages.verdict(p, await principal(who).caller(g), g);
            const passes = signIn.has(e.screen) || who.via === 'password';
            const want = passes ? 'not the gate' : isTech(p) && p !== '/tech/install' ? 'redirect' : 'gate';
            if ((want === 'not the gate' && v.kind === 'gate') || (want !== 'not the gate' && v.kind !== want)) {
              problems.push(`${row.screen}: ${e.screen} ${p} for ${who.name} with the code on got ${v.kind}, want ${want}`);
            }
          }
          if (cls.kind === 'forbidden' && who.role && who.via === 'password' && e.access.kind === 'roles' && !e.access.roles.includes(who.role)) {
            const v = pages.verdict(p, await principal(who).caller(GATES[0]!), GATES[0]!);
            if (v.kind !== 'forbidden' || v.screen !== row.screen) problems.push(`${row.screen}: ${e.screen} ${p} for ${who.name} got ${v.kind}, want ${row.screen}`);
          }
        }
      }
      continue;
    }
    if (!covers(row) && cls.paths.every((p) => !pages.match(fill(p)))) {
      continue; // a page not covered yet with no entry yet: G-CI7 covers it once its phase (or its merged task) is covered
    }
    const want = access.get(row.screen);
    if (!want) {
      problems.push(`${row.screen}: no access in UI-SPECIFICATION 2.4`);
      continue;
    }
    for (const p of cls.paths) {
      const entry = pages.match(fill(p));
      if (!entry) {
        problems.push(`route ${p} (${row.screen}) has no policy entry`);
        continue;
      }
      const kindOfRoute = want.kind === 'token' ? tokenKindOfPath(p) : undefined;
      const wantHere: Expected = kindOfRoute ? { kind: 'token', tokenKind: kindOfRoute } : want;
      if (!sameAccess(entry, wantHere)) problems.push(`${row.screen} ${p}: policy access ${JSON.stringify(entry.access)}, 2.4 says ${JSON.stringify(wantHere)}`);
      checked.push(`${row.screen} ${p}`);
      await tryAll(fill(p), row.screen, want, signIn.has(row.screen));
    }
  }
  // An entry for a route no inventory row names is a route outside the specification.
  const named = new Set(inv.screens.flatMap((r) => {
    const c = routeClass(r, inv);
    return c?.kind === 'paths' ? c.paths : [];
  }));
  for (const e of pageEntries) if (!named.has(e.path)) problems.push(`page entry ${e.screen} ${e.path} is no route of the page inventory`);
  return { problems, checked };
}

/** A router call for 1 API entry by 1 principal: the Problem code, or 'allow' when the call passed authorization. */
export type ApiCall = (entry: Extract<PolicyEntry, { kind: 'api' }>, who: (typeof PRINCIPALS)[number], gate: (typeof GATES)[number]) => Promise<string>;

/** The API matrix: every API entry against its 12.2 callers' access and 12.1 item 7, through the real router. */
export async function apiProblems(table: readonly PolicyEntry[], uiSpec: string, call: ApiCall): Promise<{ problems: string[]; checked: string[] }> {
  const wants = apiExpectations(uiSpec);
  const free = codeFreeCalls(uiSpec);
  const problems: string[] = [];
  const checked: string[] = [];
  for (const e of table) {
    if (e.kind !== 'api') continue;
    const want = wants.get(e.contract);
    if (!want) {
      problems.push(`${e.contract}: no caller in 12.2 resolves to a 2.4 access; name its expected access in the oracle`);
      continue;
    }
    if (!sameAccess(e, want)) problems.push(`${e.contract}: policy access ${JSON.stringify(e.access)}, the spec says ${JSON.stringify(want)}`);
    checked.push(e.contract);
    for (const who of PRINCIPALS) {
      for (const g of GATES) {
        const got = await call(e, who, g);
        const exp = expectedVerdict(want, free.has(e.contract), who, g);
        if (got !== exp) problems.push(`${e.contract} ${e.method} ${e.path}: ${who.name}, ${g.name}: got ${got}, the spec says ${exp}`);
      }
    }
  }
  return { problems, checked };
}
