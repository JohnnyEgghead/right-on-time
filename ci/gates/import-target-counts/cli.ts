// SPDX-License-Identifier: AGPL-3.0-or-later
// node ci/gates/import-target-counts/cli.ts [--dir <export folder>] [--truth <truth.json>] [--requirements <REQUIREMENTS.md>] [--measure]
//
// import-target-counts on the real path (P2-IMPORT; FR-IMP-6, FR-IMP-3): a PostgreSQL 18 server (BW_TEST_PG_URL,
// else the embedded 18.4), a fresh migrated database with the reference rows, the import's dry run of the export in
// --dir as bw_web, and its report read back from import_run; then targets.ts's 3 properties against REQUIREMENTS.md's
// table and the committed truth file. --measure also times the match stage (OQ-19): blocking and scoring of every
// customer, the median of 7 runs, beside the whole dry run's time.
// Exit 0: every property holds. Exit 1: a property fails (each printed on stderr). Exit 2: the run could not judge.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient, type Queryable } from '../../../packages/db/src/client.ts';
import { startPgServer } from '../../../packages/db/src/testing/pg-server.ts';
import { readExport } from '../../../packages/import/src/files.ts';
import { parseExport } from '../../../packages/import/src/layout.ts';
import { matchCustomers } from '../../../packages/import/src/match.ts';
import { buildModel, matchInputs } from '../../../packages/import/src/model.ts';
import { loadReference } from '../../../packages/import/src/runner.ts';
import { preparedWorld, storedDryRun } from './lib.ts';
import { checkTargets, parseTargets, TableError, type TruthLike } from './targets.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const fmt = (n: number) => n.toLocaleString('en-US');

async function main(): Promise<number> {
  const dir = arg('--dir', path.join(ROOT, '.build', 'data', 'generator'));
  const truthFile = arg('--truth', path.join(ROOT, 'packages', 'generator', 'truth.json'));
  let targets;
  try {
    targets = parseTargets(readFileSync(arg('--requirements', path.join(ROOT, 'docs', 'REQUIREMENTS.md')), 'utf8'));
  } catch (e) {
    if (e instanceof TableError) { console.error(e.message); return 2; }
    throw e;
  }
  const truth = JSON.parse(readFileSync(truthFile, 'utf8')) as TruthLike;
  const files = readExport(dir);

  const server = await startPgServer();
  const world = await preparedWorld(server.adminUrl);
  try {
    const t0 = performance.now();
    const run = await storedDryRun(world.url, files);
    const dryMs = performance.now() - t0;
    if (run.status !== 'done') { console.error(`import-target-counts: the dry run ended ${run.status}`); return 2; }
    const failures = checkTargets(run.report, truth, targets);
    for (const f of failures) console.error(`import-target-counts: FAIL ${f}`);
    if (failures.length > 0) {
      console.error(`import-target-counts: FAIL ${failures.length} property failure(s) (truth file ${path.relative(ROOT, truthFile)})`);
      return 1;
    }
    const r = run.report;
    console.log(`import-target-counts: ok (PostgreSQL ${server.version}; the dry run's stored report equals every number of the FR-IMP-6 table: `
      + `customers ${fmt(r.customers.total)} (${fmt(r.customers.clean)} clean, ${fmt(r.customers.flagged)} flagged), `
      + `visits ${fmt(r.visits.total)} (${fmt(r.visits.imported)} imported, ${fmt(r.visits.notImported)} not), `
      + `equipment ${fmt(r.equipment.total)} (${fmt(r.equipment.imported)} imported, ${fmt(r.equipment.notImported)} not), `
      + `problem rows ${fmt(r.problems.total)} (${Object.entries(r.problems.byReason).map(([k, v]) => `${k} ${v}`).join(', ')}), `
      + `duplicates ${fmt(r.duplicates.total)} (${r.duplicates.exact} exact, ${r.duplicates.likely} likely); `
      + `the pair sets equal ${path.relative(ROOT, truthFile)})`);

    if (process.argv.includes('--measure')) {
      const c = createClient({ connectionString: world.url });
      await c.connect();
      let ref;
      try {
        ref = await loadReference(c as unknown as Queryable);
      } finally {
        await c.end();
      }
      const parsed = parseExport(files);
      const model = buildModel(parsed, ref);
      const input = matchInputs(parsed, model.customers);
      const times: number[] = [];
      let found = 0;
      let comparisons = 0;
      for (let i = 0; i < 7; i++) {
        const s = performance.now();
        const m = matchCustomers(input);
        times.push(performance.now() - s);
        found = m.pairs.length;
        comparisons = m.comparisons;
      }
      times.sort((x, y) => x - y);
      const n = input.length;
      console.log(`import-target-counts: OQ-19 match stage with blocking keys on ${fmt(n)} customers: median ${(times[3] as number).toFixed(1)} ms `
        + `(min ${(times[0] as number).toFixed(1)}, max ${(times[6] as number).toFixed(1)}; 7 runs); ${fmt(comparisons)} scored comparisons in blocks `
        + `(all pairs would be ${fmt((n * (n - 1)) / 2)}); ${found} pairs; whole dry run ${(dryMs / 1000).toFixed(1)} s on PostgreSQL ${server.version}`);
    }
    return 0;
  } finally {
    await world.drop();
    await server.stop();
  }
}

main().then((code) => process.exit(code), (e: unknown) => {
  console.error(`import-target-counts: cannot judge: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(2);
});
