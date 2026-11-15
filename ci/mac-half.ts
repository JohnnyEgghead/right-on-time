// SPDX-License-Identifier: AGPL-3.0-or-later
// The mac half's plan (F-1201; owner ruling Nov 4, 2026 items 1 and 3; SPECIFICATIONS SD-38 `mac`): the gates of ci/gates.json with
// runner mac that a ci/wave-run.sh run of <mode> holds, by the same when rule as ci.sh's sets (ci/gates-lib.ts inSet). ci.sh never
// selects them in its sets; wave-run.sh runs them on this Mac, each under its own time limit, and a red one makes the run red.
//   node ci/mac-half.ts <all|nightly|gates> [--gates a,b]   prints 1 line per planned gate:  RUN<TAB>id<TAB>timeoutS<TAB>cmd
//                                                           and 1 per inactive one:          INACTIVE<TAB>id<TAB>activating task
// Env (for tests): CI_ROOT (the repo whose ci/active markers count), CI_GATES_FILE. Exit 0, or 2 on a bad map or usage.
import path from 'node:path';
import { inSet, isActive, loadMap, repoRoot, resolveGateCmd, runnerOf, timeoutFor, validateMap, type GateMap } from './gates-lib.ts';
import { isMain } from './is-main.ts';

export type MacMode = 'all' | 'nightly' | 'checkpoint' | 'gates';
export type MacLine = { kind: 'RUN'; id: string; timeoutS: number; cmd: string } | { kind: 'INACTIVE'; id: string; activates: string } | { kind: 'MISSING'; id: string; script: string };

/** The mac half of a <mode> run: map order, runner mac gates only. */
export function macPlan(map: GateMap, mode: MacMode, asked: readonly string[], active: (id: string) => boolean, root: string): MacLine[] {
  const out: MacLine[] = [];
  for (const g of map.gates) {
    if (runnerOf(g) !== 'mac' || !inSet(mode, g, asked)) continue;
    if (!active(g.id)) {
      out.push({ kind: 'INACTIVE', id: g.id, activates: g.activates });
      continue;
    }
    const r = resolveGateCmd(root, g);
    out.push('cmd' in r ? { kind: 'RUN', id: g.id, timeoutS: timeoutFor(map, g), cmd: r.cmd } : { kind: 'MISSING', id: g.id, script: r.missing });
  }
  return out;
}

export function formatLine(l: MacLine): string {
  if (l.kind === 'RUN') return `RUN\t${l.id}\t${l.timeoutS}\t${l.cmd}`;
  if (l.kind === 'INACTIVE') return `INACTIVE\t${l.id}\t${l.activates}`;
  return `MISSING\t${l.id}\t${l.script}`;
}

function main(argv: string[]): number {
  const mode = argv[0];
  if (mode !== 'all' && mode !== 'nightly' && mode !== 'checkpoint' && mode !== 'gates') {
    console.error('usage: node ci/mac-half.ts <all|nightly|checkpoint|gates> [--gates a,b]');
    return 2;
  }
  const gi = argv.indexOf('--gates');
  const asked = gi >= 0 ? (argv[gi + 1] ?? '').split(',').filter(Boolean) : [];
  const root = process.env['CI_ROOT'] ?? repoRoot();
  const map = loadMap(process.env['CI_GATES_FILE'] ?? path.join(root, 'ci', 'gates.json'));
  const errors = validateMap(map);
  if (errors.length > 0) {
    for (const e of errors) console.error(`mac-half: ${e}`);
    return 2;
  }
  for (const l of macPlan(map, mode, asked, (id) => isActive(root, id), root)) console.log(formatLine(l));
  return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
