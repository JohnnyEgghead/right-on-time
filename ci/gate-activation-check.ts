// SPDX-License-Identifier: AGPL-3.0-or-later
// gate-activation-check (BUILD_PLAN section 7 gate map, D-15):
//   node ci/gate-activation-check.ts
// Exit 0: no problem. Exit 1: a gate whose activating task has merged has no marker
// ci/active/<id>, or a marker names no gate. Exit 2: cannot judge (map invalid, or no
// integration ref to read merges from; fail closed, never a pass).
// "Merged" = a `Task: <ID>` trailer in a merge commit reachable from the integration branch
// (GATE_MAIN_REF, else origin/main, else main). See ci/README.md.
// Env: CI_ROOT (repo root, for tests), CI_GATES_FILE (gate map, for tests).
import path from 'node:path';
import { findActivationProblems, isShallow, listMarkers, loadMap, mergedTasks, repoRoot, resolveMainRef, validateMap } from './gates-lib.ts';

const root = process.env.CI_ROOT ? path.resolve(process.env.CI_ROOT) : repoRoot();
const file = process.env.CI_GATES_FILE ?? path.join(root, 'ci', 'gates.json');

const map = loadMap(file);
const errors = validateMap(map);
if (errors.length > 0) {
  for (const e of errors) console.error(`gate-activation-check: map error: ${e}`);
  process.exit(2);
}
const ref = resolveMainRef(root);
if (!ref) {
  console.error('gate-activation-check: no integration branch to read (tried GATE_MAIN_REF, origin/main, main); fetch it, never skip');
  process.exit(2);
}
if (isShallow(root)) {
  console.error('gate-activation-check: the clone is shallow, so merged tasks cannot be read; fetch full history (fetch-depth: 0), never skip');
  process.exit(2);
}
const merged = mergedTasks(root, ref);
const problems = findActivationProblems(map, listMarkers(root), merged);
for (const p of problems) console.error(`gate-activation-check: ${p}`);
if (problems.length > 0) process.exit(1);
console.log(`gate-activation-check: ok (${map.gates.length} gates, ${merged.size} merged tasks on ${ref})`);
