// SPDX-License-Identifier: AGPL-3.0-or-later
// acceptance/page-inventory.json: the shared audit anchor (BUILD_PLAN D-9), set-equal to
// docs/UI-SPECIFICATION.md section 2.3.
//   node ci/page-inventory.ts generate   write the manifest from section 2.3 (done once, by P1-GATES)
//   node ci/page-inventory.ts check      exit 1 unless the manifest and section 2.3 are set-equal
// Env (for tests): CI_ROOT (repo root), INVENTORY_SPEC (spec file), INVENTORY_JSON (manifest).
//
// Each row carries its target phase and building task. The task is the one the plan names for the
// screen (BUILD_PLAN task blocks: Design SSOT and Description lines). A screen a native task also
// builds (technician pages and native screens) lists it in nativeTask. Pages carry the screen ID
// as a data-screen root attribute (P2-SHELL owns the convention); no later lane edits this file.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMain } from './is-main.ts';
import { isDeepStrictEqual } from 'node:util';

export interface ScreenRow {
  screen: string;
  name: string;
  type: string;
  route: string;
  phase: number;
  task: string;
  nativeTask?: string;
}

export interface RouteRow {
  screen: string;
  route: string;
  phase: number;
  task: string;
}

export interface Inventory {
  source: string;
  screens: ScreenRow[];
  routes: RouteRow[];
}

/** Building task per screen, read from the plan's task blocks (web task; native task apart). */
const TASKS: Record<string, string> = {};
const NATIVE: Record<string, string> = {};
function assign(table: Record<string, string>, prefix: string, task: string, from: number, to = from): void {
  for (let n = from; n <= to; n++) table[`SCR-${prefix}-${String(n).padStart(2, '0')}`] = task;
}
assign(TASKS, 'GATE', 'P2-AUTH', 1, 2);
assign(TASKS, 'OFC', 'P2-AUTH', 1);
assign(TASKS, 'OFC', 'P4-BOARD', 2);
assign(TASKS, 'OFC', 'P4-JOB', 3);
assign(TASKS, 'OFC', 'P4-NEWJOB', 4);
assign(TASKS, 'OFC', 'P4-CUSTOMERS', 5, 6);
assign(TASKS, 'OFC', 'P4-TECHNICIANS', 7);
assign(TASKS, 'OFC', 'P4-MESSAGES', 8, 9);
assign(TASKS, 'OFC', 'P4-BILLING-UI', 10);
assign(TASKS, 'OFC', 'P4-REPORTS', 11);
assign(TASKS, 'OFC', 'P4-ADMIN-WINDOWS', 12);
assign(TASKS, 'OFC', 'P4-ADMIN-IMPORT', 13, 15);
assign(TASKS, 'OFC', 'P4-HEALTH', 16);
assign(TASKS, 'OFC', 'P4-CLOCK', 17);
assign(TASKS, 'OFC', 'P4-BOARD', 18, 19);
assign(TASKS, 'OFC', 'P4-JOB', 20, 23);
assign(TASKS, 'OFC', 'P4-ADMIN-WINDOWS', 24);
assign(TASKS, 'OFC', 'P4-ADMIN-IMPORT', 25, 26);
assign(TASKS, 'OFC', 'P4-CLOCK', 27);
assign(TASKS, 'OFC', 'P4-HEALTH', 28);
assign(TASKS, 'OFC', 'P4-BOARD', 29);
assign(TASKS, 'OFC', 'P4-JOBS', 30);
assign(TASKS, 'OFC', 'P4-BOARD', 31, 33);
assign(TASKS, 'OFC', 'P4-WEEK', 34);
assign(TASKS, 'OFC', 'P4-JOB', 35, 37);
assign(TASKS, 'OFC', 'P4-CUSTOMERS', 38, 40);
assign(TASKS, 'OFC', 'P4-TECHNICIANS', 41, 42);
assign(TASKS, 'OFC', 'P4-ACCOUNTS', 43, 46);
assign(TASKS, 'OFC', 'P4-BILLING-UI', 47);
assign(TASKS, 'PBS', 'P4-BILLING-UI', 1, 2);
assign(TASKS, 'TEC', 'P5-TWA-TODAY', 1, 3);
assign(TASKS, 'TEC', 'P5-TWA-JOB', 4, 7);
assign(TASKS, 'TEC', 'P5-TWA-MAP-ME', 8);
assign(TASKS, 'TEC', 'P5-TWA-JOB', 9);
assign(TASKS, 'TEC', 'P5-TWA-MAP-ME', 10, 11);
assign(TASKS, 'TEC', 'P6-NATIVE-SHELL', 12);
assign(TASKS, 'TEC', 'P5-TWA-TODAY', 13, 14);
assign(TASKS, 'TEC', 'P5-TWA-MAP-ME', 15, 16);
assign(NATIVE, 'TEC', 'P6-NATIVE-TODAY', 1, 3);
assign(NATIVE, 'TEC', 'P6-NATIVE-JOB', 4, 7);
assign(NATIVE, 'TEC', 'P6-NATIVE-MAP-ME', 8);
assign(NATIVE, 'TEC', 'P6-NATIVE-JOB', 9);
assign(NATIVE, 'TEC', 'P6-NATIVE-MAP-ME', 10);
assign(NATIVE, 'TEC', 'P6-NATIVE-TODAY', 13, 14);
assign(NATIVE, 'TEC', 'P6-NATIVE-MAP-ME', 15, 16);
assign(TASKS, 'CUS', 'P5-BOOKING', 1, 3);
assign(TASKS, 'CUS', 'P5-LIVEMAP', 4, 5);
assign(TASKS, 'CUS', 'P5-INBOX', 6);
assign(TASKS, 'CUS', 'P5-BOOKING-PAGES', 7);
assign(TASKS, 'INB', 'P5-INBOX', 1);
assign(TASKS, 'EML', 'P4-ACCOUNTS', 1, 3);
assign(TASKS, 'SHR', 'P2-SHELL', 1, 3);

const phaseOf = (task: string): number => Number(/^P(\d+)/.exec(task)?.[1] ?? NaN);

export interface SpecRow {
  screen: string;
  name: string;
  type: string;
  route: string;
}

/** The rows of the section 2.3 table, in document order. */
export function parseSpec(specText: string): SpecRow[] {
  const start = specText.indexOf('### 2.3 Page inventory');
  const end = specText.indexOf('### 2.4 ', start);
  if (start < 0 || end < 0) throw new Error('section 2.3 not found in the specification');
  const rows: SpecRow[] = [];
  for (const line of specText.slice(start, end).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const id = cells[1];
    if (id && /^SCR-[A-Z]+-\d+$/.test(id)) rows.push({ screen: id, name: cells[2] ?? '', type: cells[3] ?? '', route: cells[4] ?? '' });
  }
  return rows;
}

/** The backticked paths of a route cell. */
export function routesOf(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
}

export function build(rows: SpecRow[]): Inventory {
  const screens: ScreenRow[] = rows.map((r) => {
    const task = TASKS[r.screen];
    if (!task) throw new Error(`no building task known for ${r.screen}`);
    const row: ScreenRow = { screen: r.screen, name: r.name, type: r.type, route: r.route, phase: phaseOf(task), task };
    const nativeTask = NATIVE[r.screen];
    if (nativeTask) row.nativeTask = nativeTask;
    return row;
  });
  const cus07 = screens.find((s) => s.screen === 'SCR-CUS-07');
  const routes: RouteRow[] = cus07
    ? routesOf(cus07.route).map((route) => ({ screen: 'SCR-CUS-07', route, phase: cus07.phase, task: cus07.task }))
    : [];
  return { source: 'docs/UI-SPECIFICATION.md section 2.3', screens, routes };
}

/** Set differences between the specification and the manifest; an empty list means set-equal. */
export function compare(spec: SpecRow[], inv: Inventory): string[] {
  const problems: string[] = [];
  const specIds = new Set(spec.map((r) => r.screen));
  const invIds = inv.screens.map((s) => s.screen);
  const invSet = new Set(invIds);
  if (invSet.size !== invIds.length) problems.push('manifest lists a screen twice');
  for (const id of specIds) if (!invSet.has(id)) problems.push(`missing from the manifest: ${id}`);
  for (const id of invSet) if (!specIds.has(id)) problems.push(`extra in the manifest: ${id}`);
  const specCus = spec.find((r) => r.screen === 'SCR-CUS-07');
  const specRoutes = new Set(routesOf(specCus?.route ?? ''));
  const invRoutes = new Set(inv.routes.map((r) => r.route));
  for (const r of specRoutes) if (!invRoutes.has(r)) problems.push(`missing SCR-CUS-07 route: ${r}`);
  for (const r of invRoutes) if (!specRoutes.has(r)) problems.push(`extra SCR-CUS-07 route: ${r}`);
  for (const s of inv.screens) {
    if (!s.task || !Number.isInteger(s.phase) || s.phase !== phaseOf(s.task)) problems.push(`${s.screen}: needs a building task and the phase it names`);
  }
  if (problems.length === 0) {
    // Rebuild from the specification and deep-compare every field of every row (F-24).
    const want = build(spec);
    const bad = want.screens.findIndex((w, i) => !isDeepStrictEqual(w, inv.screens[i]));
    if (bad >= 0) problems.push(`${want.screens[bad]!.screen}: differs from the rebuilt manifest (expected ${JSON.stringify(want.screens[bad])}, found ${JSON.stringify(inv.screens[bad])})`);
    else {
      const badR = want.routes.findIndex((w, i) => !isDeepStrictEqual(w, inv.routes[i]));
      if (badR >= 0) problems.push(`SCR-CUS-07 route ${want.routes[badR]!.route}: differs from the rebuilt manifest (expected ${JSON.stringify(want.routes[badR])}, found ${JSON.stringify(inv.routes[badR])})`);
      else if (!isDeepStrictEqual(want, inv)) problems.push('manifest differs from the rebuilt manifest outside the rows (source or extra field)');
    }
  }
  return problems;
}

function main(argv: string[]): number {
  const root = process.env.CI_ROOT ? path.resolve(process.env.CI_ROOT) : path.resolve(import.meta.dirname, '..');
  const specFile = process.env.INVENTORY_SPEC ?? path.join(root, 'docs', 'UI-SPECIFICATION.md');
  const jsonFile = process.env.INVENTORY_JSON ?? path.join(root, 'acceptance', 'page-inventory.json');
  const spec = parseSpec(readFileSync(specFile, 'utf8'));
  if (argv[0] === 'generate') {
    const inv = build(spec);
    writeFileSync(jsonFile, JSON.stringify(inv, null, 2) + '\n');
    console.log(`page-inventory: wrote ${inv.screens.length} screens and ${inv.routes.length} routes to ${path.relative(root, jsonFile)}`);
    return 0;
  }
  if (argv[0] === 'check') {
    const inv = JSON.parse(readFileSync(jsonFile, 'utf8')) as Inventory;
    const problems = compare(spec, inv);
    for (const p of problems) console.error(`page-inventory: ${p}`);
    if (problems.length === 0) console.log(`page-inventory: ok (${inv.screens.length} screens, ${inv.routes.length} SCR-CUS-07 routes, set-equal to section 2.3)`);
    return problems.length === 0 ? 0 : 1;
  }
  console.error('usage: node ci/page-inventory.ts generate | check');
  return 2;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
