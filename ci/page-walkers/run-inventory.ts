// SPDX-License-Identifier: AGPL-3.0-or-later
// Reads acceptance/page-inventory.json and reports which rows the walkers check at the current phase.
//   node ci/page-walkers/run-inventory.ts   current phase from BW_PHASE, else 1 plus the highest merged CP<n> task
// The phase has no default: an unreadable phase exits 2 (F-39). Prints the per-type counts walked and handed off (F-38).
// A row is walked once its task is merged (F-154); rows waiting on an unmerged task are printed. A row of an earlier phase
// whose task is unmerged, or whose task is not in the plan, exits 2. An empty selection is stated and exits 0. Rows to walk with no app wiring (app-wiring.ts) exit 2; the wired ones are walked by app.pw.test.ts.
// Native-only rows are listed as handed to the native audit and do not by themselves fail the gate.
import { readFileSync } from 'node:fs';
import { wiringFor } from './app-wiring.ts';
import { countByType, currentPhase, emptyWalkWhy, loadInventory, mergedFromEnv, planTaskIds, planWalk, readMergedTasks } from './inventory.ts';

// F-154: one merged-task reader gives both the phase and the merged set. BW_MERGED_TASKS overrides it, and BW_PLAN_FILE / BW_INVENTORY_FILE point at fixtures (tests only, F-645).
const readMerged = mergedFromEnv(process.env.BW_MERGED_TASKS, readMergedTasks);
let phase: number;
let merged: Set<string>;
try {
  phase = currentPhase(process.env.BW_PHASE, readMerged);
  merged = new Set(readMerged());
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const knownTasks = planTaskIds(readFileSync(process.env.BW_PLAN_FILE ?? 'docs/BUILD_PLAN.md', 'utf8'));
const inventory = loadInventory(process.env.BW_INVENTORY_FILE ?? 'acceptance/page-inventory.json');
const plan = planWalk(inventory, phase, { merged, knownTasks });
if (plan.waiting.length > 0) {
  const byTask = new Map<string, string[]>();
  for (const r of plan.waiting) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r.screen]);
  for (const [t, ids] of byTask) console.log(`page-walkers: waiting on ${t}: ${ids.join(', ')}`);
}
for (const p of plan.problems) console.error(`page-walkers: RED ${p}`);
if (plan.problems.length > 0) process.exit(2);
if (plan.selected.length === 0) {
  console.log(`page-walkers: phase ${phase}: 0 inventory rows selected (${plan.waiting.length} waiting on an unmerged task); nothing to walk`);
  if (process.env.BW_MERGED_TASKS?.trim()) console.log(emptyWalkWhy(inventory, phase, merged));
  process.exit(0);
}
console.log(`page-walkers: phase ${phase}: ${plan.selected.length} inventory row(s) selected`);
console.log(`  walked as pages: ${plan.walked.length} (${countByType(plan.walked)})`);
console.log(`  opened on a host page: ${plan.hostOpened.length} (${countByType(plan.hostOpened)})`);
console.log(`  handed to the native audit: ${plan.handedOff.length} (${countByType(plan.handedOff)})`);
for (const r of plan.handedOff) console.log(`    native audit: ${r.screen} ${r.name}`);
// Every row to walk needs its app wiring (ci/page-walkers/app-wiring.ts); app.pw.test.ts walks the wired ones.
const { wired, unwired } = wiringFor([...plan.walked, ...plan.hostOpened]);
for (const r of wired) console.log(`    walked: ${r.screen} ${r.name} at ${r.path} (${r.status})`);
if (unwired.length > 0) {
  console.error(`page-walkers: ${unwired.length} row(s) to walk at or before phase ${phase} but no app wiring yet: ${unwired.map((r) => r.screen).join(', ')}`);
  process.exit(2);
}
