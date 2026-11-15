// SPDX-License-Identifier: AGPL-3.0-or-later
// import-target-counts' own planted cases (W-38: on every run, not once). The import's real dry run of the real
// generator output on PostgreSQL 18, its report read back from import_run, passes all 3 properties; a planted truth
// file with 1 exact pair removed (811 exact) fails the pairs property, through the checker and through the gate's CLI
// (exit 1, the property named); a planted report with 811 exact matches fails the counts property; a table the
// instrument cannot read makes it refuse to judge.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAdminUrl } from '../../../packages/db/src/testing/provided.ts';
import { generatedWorld } from '../../../packages/import/src/testing/world.ts';
import { preparedWorld, storedDryRun, type DryRunRecord } from './lib.ts';
import { checkTargets, parseTargets, TableError, type TruthLike } from './targets.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const REQUIREMENTS = readFileSync(path.join(ROOT, 'docs', 'REQUIREMENTS.md'), 'utf8');
const COMMITTED = JSON.parse(readFileSync(path.join(ROOT, 'packages', 'generator', 'truth.json'), 'utf8')) as TruthLike;
const targets = parseTargets(REQUIREMENTS);

/** The committed truth file with its first exact pair removed: 811 exact matches. */
function plantedTruth(): TruthLike {
  return { ...COMMITTED, counts: { ...COMMITTED.counts, exact: 811 }, exact: COMMITTED.exact.slice(1) };
}

let world: { url: string; drop(): Promise<void> };
let run: DryRunRecord;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'bw-itc-'));

beforeAll(async () => {
  world = await preparedWorld(pgAdminUrl());
  run = await storedDryRun(world.url, generatedWorld().files);
  for (const [name, text] of Object.entries(generatedWorld().files)) writeFileSync(path.join(tmp, name), text);
  writeFileSync(path.join(tmp, 'planted-truth.json'), JSON.stringify(plantedTruth()));
});
afterAll(async () => {
  rmSync(tmp, { recursive: true, force: true }); // F-263: the 3 export files are about 17 MB per run
  await world?.drop();
});

describe('import-target-counts', () => {
  // why: FR-IMP-6
  it('reads the FR-IMP-6 table from REQUIREMENTS.md', () => {
    expect(targets).toEqual({
      customers: { total: 18_400, clean: 17_912, flagged: 488 },
      visits: { total: 96_412, imported: 95_870, notImported: 542 },
      equipment: { total: 31_058, imported: 30_904, notImported: 154 },
      problems: { total: 1_184, byReason: { visit_no_customer: 418, missing_zip: 214, bad_phone: 187, visit_date_unreadable: 124, equipment_no_address: 154, customer_name_blank: 87 } },
      duplicates: { total: 1_240, exact: 812, likely: 428 },
    });
  });

  // why: FR-IMP-6, FR-IMP-3
  it('passes the real dry run of the real generator output: its stored report equals the table and the truth file', () => {
    expect(run.status).toBe('done');
    expect(checkTargets(run.report, COMMITTED, targets)).toEqual([]);
  });

  // why: FR-IMP-6, FR-IMP-3
  it('fails a planted truth file with 1 exact pair removed (811 exact matches), naming the pairs property', () => {
    const f = checkTargets(run.report, plantedTruth(), targets);
    expect(f.some((x) => x.startsWith('pairs (the exact and likely pair sets equal the committed planted-truth file): exact: 1 found but not in the truth file'))).toBe(true);
    expect(f.some((x) => x.startsWith("truth (the truth file's own counts equal the table)"))).toBe(true);
  });

  // why: FR-IMP-6
  it('the gate CLI exits 1 on the planted truth file and 0 on the committed one, on the same real dry run path', () => {
    const cli = (truth: string) => spawnSync('node', ['ci/gates/import-target-counts/cli.ts', '--dir', tmp, '--truth', truth], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, BW_TEST_PG_URL: pgAdminUrl() },
    });
    const bad = cli(path.join(tmp, 'planted-truth.json'));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/FAIL pairs \(the exact and likely pair sets equal the committed planted-truth file\): exact: 1 found but not in the truth file/);
    const good = cli(path.join(ROOT, 'packages', 'generator', 'truth.json'));
    expect(good.status).toBe(0);
    expect(good.stdout).toMatch(/^import-target-counts: ok \(PostgreSQL 18\./m);
  });

  // why: FR-IMP-6
  it('fails a report with 811 exact matches, or any other count, naming the counts property', () => {
    const planted = { ...run.report, duplicates: { ...run.report.duplicates, exact: 811 } };
    expect(checkTargets(planted, COMMITTED, targets)).toContain(
      'counts (the report equals every number of the FR-IMP-6 table): duplicates.exact is 811, the table says 812');
    const visits = { ...run.report, visits: { ...run.report.visits, imported: run.report.visits.imported + 1 } };
    expect(checkTargets(visits, COMMITTED, targets).filter((x) => x.startsWith('counts'))).toHaveLength(1);
  });

  // why: FR-IMP-6
  it('refuses to judge a table it cannot read or whose parts do not add up', () => {
    expect(() => parseTargets(REQUIREMENTS.replace('812 exact, merged', '811 exact, merged'))).toThrow(TableError);
    expect(() => parseTargets(REQUIREMENTS.replace('missing ZIP code 214', 'no ZIP 214'))).toThrow(/unknown problem reason/);
    expect(() => parseTargets(REQUIREMENTS.replace('**Import target counts (FR-IMP-6).**', ''))).toThrow(TableError);
  });
});
