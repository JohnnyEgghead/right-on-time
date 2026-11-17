// SPDX-License-Identifier: AGPL-3.0-or-later
// G-CI10 step 1 (no database): the finish-path check's committed must-fail cases, run every time (W-38), and the check
// over the real spec, contract table and probe list (invariant 10; FR-BILL-3).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allContracts } from '../../../packages/api/src/index.ts';
import { checkFinishPaths, finishOracleFromSpec, readFinishOracle } from './finish-paths.ts';
import { FINISH_PROBES } from './finish-probes.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
// F-1852: docs/SPECIFICATIONS.md is a private path (scripts/private-paths.txt), so in a public copy the real-tree case skips with a
// note naming it; the private checkout has it and the case runs. The planted cases need no file.
const noSpec = existsSync(path.join(ROOT, 'docs', 'SPECIFICATIONS.md')) ? '' : 'docs/SPECIFICATIONS.md is not in this copy (a private path the public export leaves out)';
const ORACLE = ['API-102', 'API-26', 'API-62'];

describe('G-CI10 finish-path check: committed must-fail cases', () => {
  // why: FR-BILL-3, invariant 10
  it('fails a finish route that has a contract row but no probe (an office finish route that skips the check)', () => {
    const r = checkFinishPaths({ oracle: ORACLE, contractIds: new Set(['API-26']), probeIds: [] });
    expect(r.problems).toEqual([expect.stringMatching(/^API-26: a finish route has a contract row but no finish probe/)]);
  });

  // why: FR-BILL-3
  it('fails a probe twice, a probe for a route the spec does not name, and a probe for a route with no row', () => {
    const r = checkFinishPaths({ oracle: ORACLE, contractIds: new Set(['API-26']), probeIds: ['API-26', 'API-26', 'API-99', 'API-62'] });
    expect(r.problems).toEqual([
      'API-26: registered twice in finish-probes.ts',
      expect.stringMatching(/^API-99: probed, but SPECIFICATIONS/),
      'API-62: probed, but it has no contract row',
    ]);
  });

  // why: FR-BILL-3
  it('passes probed routes and lists absent ones', () => {
    expect(checkFinishPaths({ oracle: ORACLE, contractIds: new Set(['API-62']), probeIds: ['API-62'] }))
      .toEqual({ probed: ['API-62'], absent: ['API-102', 'API-26'], problems: [] });
  });

  // why: FR-BILL-3
  it('reads the oracle from the FR-BILL-3 bullet and refuses a spec without it', () => {
    const line = '- **Parts or No parts used on every finish path (FR-BILL-3).** `@bw/domain`\'s `finishLines` validator runs in API-26, API-62 and API-102\'s finish item: it refuses neither (API-1).';
    expect(finishOracleFromSpec(line)).toEqual(ORACLE);
    expect(() => finishOracleFromSpec('no such bullet')).toThrow(/no bullet/);
  });
});

describe('G-CI10 finish-path check: the real tree', () => {
  // why: FR-BILL-3, invariant 10
  it('finds every finish route of section 6.6 either absent or probed', (ctx) => {
    if (noSpec) ctx.skip(noSpec);
    expect(readFinishOracle(ROOT)).toEqual(ORACLE);
    const r = checkFinishPaths({ oracle: readFinishOracle(ROOT), contractIds: new Set(allContracts.map((c) => c.id)), probeIds: FINISH_PROBES.map((p) => p.id) });
    expect(r.problems).toEqual([]);
    // The record of what the database step can drive today.
    process.stdout.write(`G-CI10 finish routes: probed [${r.probed.join(', ')}], not built yet [${r.absent.join(', ')}]\n`);
  });
});
