// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI10's finish-path enumeration (SPECIFICATIONS section 6.6 FR-BILL-3: "a CI route test enumerates every policy
// entry that can set done and fails if one skips the validator"; invariant 10).
//
// The oracle is read from the spec, never from the code under test: section 6.6's FR-BILL-3 bullet names the routes the
// finishLines validator runs in (API-26, API-62 and API-102's finish item). For each 1 whose contract row exists, the
// lane that built it must register a finish probe (finish-probes.ts) that drives the real route through the mounted
// kernel with neither parts nor No parts used; the gate's database step runs every probe and requires
// `parts_required` with the job left unfinished and unbilled. A finish route that lands with no probe fails this check,
// so a route that skips the validator can never pass unseen. A route whose row does not exist yet is listed as absent.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BULLET = '**Parts or No parts used on every finish path (FR-BILL-3).**';

/** The finish routes section 6.6 names, sorted. Throws when the bullet is gone, so a spec edit cannot empty the oracle. */
export function finishOracleFromSpec(specText: string): string[] {
  const line = specText.split('\n').find((l) => l.includes(BULLET));
  if (!line) throw new Error(`SPECIFICATIONS section 6.6 has no bullet ${BULLET}`);
  const sentence = line.slice(line.indexOf(BULLET) + BULLET.length).split(': it refuses')[0] ?? '';
  const ids = [...new Set(sentence.match(/API-\d+/g) ?? [])].sort();
  if (ids.length === 0) throw new Error('the FR-BILL-3 bullet names no finish route');
  return ids;
}

export function readFinishOracle(root: string): string[] {
  return finishOracleFromSpec(readFileSync(path.join(root, 'docs', 'SPECIFICATIONS.md'), 'utf8'));
}

export interface FinishPathCheck {
  /** Finish routes with a contract row and a probe: the database step runs these. */
  probed: string[];
  /** Finish routes with no contract row yet. */
  absent: string[];
  problems: string[];
}

/** Pure: which finish routes exist, which are probed, and what is wrong. */
export function checkFinishPaths(input: { oracle: readonly string[]; contractIds: ReadonlySet<string>; probeIds: readonly string[] }): FinishPathCheck {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const id of input.probeIds) {
    if (seen.has(id)) problems.push(`${id}: registered twice in finish-probes.ts`);
    seen.add(id);
    if (!input.oracle.includes(id)) problems.push(`${id}: probed, but SPECIFICATIONS section 6.6 FR-BILL-3 names no such finish route (add it there first)`);
  }
  const probed: string[] = [];
  const absent: string[] = [];
  for (const id of input.oracle) {
    if (!input.contractIds.has(id)) {
      absent.push(id);
      if (seen.has(id)) problems.push(`${id}: probed, but it has no contract row`);
      continue;
    }
    if (seen.has(id)) probed.push(id);
    else problems.push(`${id}: a finish route has a contract row but no finish probe in ci/gates/G-CI10/finish-probes.ts, so nothing proves it runs finishLines`);
  }
  return { probed, absent, problems };
}
