// SPDX-License-Identifier: AGPL-3.0-or-later
// contract-diff command line. Run with node (type stripping): node packages/api/src/cli.ts <command>
//   diff [--rows <module>] [--baseline <file>] [--ref <git ref>]   exit 0 same or additive, 1 breaking change, 2 usage/read error
//   update-baseline                                                 write the baseline from the current rows (a release bump)
//   export                                                          print the exported JSON Schema
// Baseline: packages/api/contracts.baseline.json (the last release's export). With --ref the baseline is read from that
// git ref (for example the last release tag) instead of the working tree.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { diffContracts, formatBreakage } from './diff.ts';
import { exportContracts, type ExportedContracts } from './export.ts';
import type { ContractRow } from './contract.ts';

const pkgDir = path.resolve(import.meta.dirname, '..');
const defaultBaseline = path.join(pkgDir, 'contracts.baseline.json');
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function loadRows(): Promise<ContractRow[]> {
  const mod = opt('--rows');
  if (!mod) return (await import('./contracts/index.ts')).allContracts;
  const m = (await import(pathToFileURL(path.resolve(mod)).href)) as { rows?: ContractRow[] };
  if (!Array.isArray(m.rows)) throw new Error(`${mod} does not export rows`);
  return m.rows;
}

function readBaseline(): ExportedContracts {
  const ref = opt('--ref');
  const file = opt('--baseline') ?? defaultBaseline;
  if (ref) {
    // git show ref:path reads the path from the repository root, so build it from the root, not from the working directory (F-131).
    const top = execFileSync('git', ['-C', pkgDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const rel = path.relative(top, defaultBaseline).split(path.sep).join('/');
    return JSON.parse(execFileSync('git', ['-C', top, 'show', `${ref}:${rel}`], { encoding: 'utf8' })) as ExportedContracts;
  }
  return JSON.parse(readFileSync(file, 'utf8')) as ExportedContracts;
}

try {
  if (cmd === 'export') {
    process.stdout.write(`${JSON.stringify(exportContracts(await loadRows()), null, 2)}\n`);
  } else if (cmd === 'update-baseline') {
    writeFileSync(defaultBaseline, `${JSON.stringify(exportContracts(await loadRows()), null, 2)}\n`);
    console.log(`contract-diff: baseline written to ${path.relative(process.cwd(), defaultBaseline)}`);
  } else if (cmd === 'diff') {
    const broken = diffContracts(readBaseline(), exportContracts(await loadRows()));
    if (broken.length > 0) {
      console.error(`contract-diff: FAIL, ${broken.length} breaking change(s) against the baseline:\n${formatBreakage(broken)}`);
      console.error('Fix the contract, or bump the baseline with its callers (node packages/api/src/cli.ts update-baseline).');
      process.exit(1);
    }
    console.log('contract-diff: PASS, no removed or changed field against the baseline');
  } else {
    console.error('usage: cli.ts diff|update-baseline|export [--rows <module>] [--baseline <file>] [--ref <git ref>]');
    process.exit(2);
  }
} catch (e) {
  console.error(`contract-diff: ERROR ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
