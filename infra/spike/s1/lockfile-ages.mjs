// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S1: check every name@version in the spike lockfile against the 14-day rule.
//   node infra/spike/s1/lockfile-ages.mjs <pnpm-lock.yaml> <cutoff ISO date>
// Prints 1 line per package and exits 1 if any release is younger than the cutoff.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [lockPath, cutoff] = process.argv.slice(2);
const text = readFileSync(lockPath, 'utf8');
// The lockfile holds several YAML documents (pnpm's self pin, then the project); read the
// top-level "packages:" block of each.
const seen = new Map();
let inPackages = false;
for (const line of text.split('\n')) {
  if (/^\S/.test(line)) inPackages = line === 'packages:';
  if (!inPackages) continue;
  const m = /^ {2}'?((?:@[^/\s]+\/)?[^@\s']+)@([^:'(\s]+)'?:/.exec(line);
  if (m) seen.set(`${m[1]}@${m[2]}`, [m[1], m[2]]);
}
const keys = [...seen.values()];
let bad = 0;
for (const [name, version] of keys) {
  const time = JSON.parse(execFileSync('npm', ['view', name, 'time', '--json'], { encoding: 'utf8' }))[version];
  const ok = Boolean(time) && time < cutoff;
  if (!ok) bad += 1;
  console.log(`${ok ? 'pass' : 'FAIL'} ${name}@${version} ${time ?? '(no date)'}`);
}
console.log(`${keys.length} packages, ${bad} younger than ${cutoff}`);
process.exit(bad > 0 ? 1 : 0);
