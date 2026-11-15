// SPDX-License-Identifier: AGPL-3.0-or-later
// @bw/generator command line (run from the repo root):
//   node packages/generator/src/cli.ts generate [--out <dir>]          write the 3 CSVs, fixture.json and truth.json
//   node packages/generator/src/cli.ts write-manifest                  regenerate; rewrite MANIFEST.json and truth.json
//   node packages/generator/src/cli.ts <check> [--dir <dir>]           check a generated folder; exit 1 on a failure
// Checks: generator-manifest, phone-range-scan, share-none, truth-check, target-counts, rates, booking-windows.
// The default folder is .build/data/generator (git-ignored, D7).
import { readFileSync, writeFileSync } from 'node:fs';
import {
  areasOfCityFrom, bookingWindowCheck, buildManifest, callsPer100, checkManifest, nohPct, onTimePct, phoneRangeScan, plantedCounts, ratesCheck,
  sd25Rates, shareNoneCheck, targetCountsCheck, truthCheck, type Files,
} from './checks.ts';
import { generate } from './generate.ts';
import { DEFAULT_OUT, loadInputs, MANIFEST_FILE, readManifest, readOutput, TRUTH_FILE, writeOutput } from './io.ts';
import { SEED } from './prng.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

function report(name: string, fails: string[], ok: string): number {
  if (fails.length === 0) {
    console.log(`${name}: ok (${ok})`);
    return 0;
  }
  for (const f of fails.slice(0, 40)) console.error(f);
  if (fails.length > 40) console.error(`... and ${fails.length - 40} more`);
  console.error(`${name}: FAIL ${fails.length} failure(s)`);
  return 1;
}

function main(): number {
  const cmd = process.argv[2];
  const dir = arg('--dir', arg('--out', DEFAULT_OUT));
  const files = (): Files => readOutput(dir);
  switch (cmd) {
    case 'generate': {
      const out = generate(loadInputs());
      writeOutput(dir, out);
      console.log(`generate: wrote customers.csv, visits.csv, equipment.csv, fixture.json and truth.json to ${dir} (seed ${SEED})`);
      return 0;
    }
    case 'write-manifest': {
      const out = generate(loadInputs());
      writeFileSync(MANIFEST_FILE, JSON.stringify(buildManifest(out, SEED), null, 2) + '\n');
      writeFileSync(TRUTH_FILE, out['truth.json']);
      console.log(`write-manifest: wrote ${MANIFEST_FILE} and ${TRUTH_FILE}`);
      return 0;
    }
    case 'generator-manifest':
      return report('generator-manifest', checkManifest(readManifest(), files()), `5 files match ${MANIFEST_FILE}`);
    case 'phone-range-scan':
      return report('phone-range-scan', phoneRangeScan(files(), areasOfCityFrom(loadInputs().streets)), 'every number is (614)/(937) 555-0100 to 555-0199 or a planted too-short bad number');
    case 'share-none':
      return report('share-none', shareNoneCheck(files()), 'no fixture customer is in a truth pair; each resolves to exactly 1 row');
    case 'truth-check': {
      const f = files();
      const fails = truthCheck(f);
      const gen = f['truth.json'];
      if (gen === undefined || Buffer.compare(Buffer.from(gen), readFileSync(TRUTH_FILE)) !== 0) fails.push(`truth-check: the generated truth.json differs from the committed ${TRUTH_FILE}`);
      return report('truth-check', fails, '812 exact and 428 likely pairs, equal to customers.csv and the committed truth file');
    }
    case 'target-counts': {
      const f = files();
      return report('target-counts', targetCountsCheck(f), JSON.stringify(plantedCounts(f)));
    }
    case 'booking-windows': {
      const branch = new Map(loadInputs().technicians.map((t) => [t.employeeNumber, t.branch]));
      return report('booking-windows', bookingWindowCheck(files(), (e) => branch.get(e)), 'no Columbus window is over the FR-BOOK-6 limits 12, 12, 11, 11, 10');
    }
    case 'rates': {
      const f = files();
      const r = sd25Rates(f);
      const line = (n: string, x: typeof r.before) => `${n}: ${x.visits} visits, on time ${onTimePct(x)}% of ${x.arrived} arrivals, no one home ${nohPct(x)}%, calls ${callsPer100(x)} per 100 visits`;
      console.log(line('before (weeks Jun 1 to Jul 13)', r.before));
      console.log(line('after (weeks Jul 20 to Sep 14)', r.after));
      console.log(line('board 7-day (Sep 8 to 14)', r.board7));
      return report('rates', ratesCheck(f), 'SD-25 bounds hold');
    }
    default:
      console.error('usage: cli.ts generate|write-manifest|generator-manifest|phone-range-scan|share-none|truth-check|target-counts|rates|booking-windows [--dir <dir>]');
      return 2;
  }
}

process.exitCode = main();
