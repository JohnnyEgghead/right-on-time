// SPDX-License-Identifier: AGPL-3.0-or-later
// node ci/gates/G-CI4/cli.ts tree            the real tree: no system-clock read outside the seam (inline config off)
//                                            and the realNow call-site listing (printed; a bad site fails)
// node ci/gates/G-CI4/cli.ts zones <dir>     the 3 host-zone run reports in <dir> (tz-<zone>.json): each zone ran,
//                                            its probe saw that zone, nothing failed or was skipped, and the 3 passed the same tests;
//                                            the only skips accepted are the ones named in accepted-skips.ts (F-1422, owner ruling
//                                            341a9f4e), and a stale entry there is a red
//   node ci/gates/G-CI4/cli.ts pinned <report.json> <name>...   each pinned test name passed in the vitest JSON report (F-373)
// Exit 0: ok. Exit 1: a finding (printed on stderr). Exit 2: usage.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { HOST_ZONES, judgeSkips, lintClockTree, pinnedProblems, readZoneReport, ROOT, zoneRunProblems, zoneSetLine, zoneSetProblems, type ZoneReport } from './lib.ts';
import { formatListing, scanTree } from './realnow-sites.ts';

export const zoneReportFile = (dir: string, zone: string) => path.join(dir, `tz-${zone.replaceAll('/', '_')}.json`);

async function tree(): Promise<number> {
  let rc = 0;
  const reads = await lintClockTree();
  for (const r of reads) console.error(`no-system-clock: FAIL ${r}`);
  if (reads.length > 0) rc = 1;
  else console.log('no-system-clock: ok (apps/ and packages/, inline config off; only packages/time/src/real.ts reads the clock)');
  const scan = scanTree(ROOT);
  console.log(formatListing(scan));
  for (const p of scan.problems) console.error(`realnow-sites: FAIL ${p}`);
  if (scan.problems.length > 0) rc = 1;
  else console.log('realnow-sites: ok');
  return rc;
}

function zones(dir: string): number {
  let rc = 0;
  const reports: ZoneReport[] = [];
  for (const zone of HOST_ZONES) {
    const f = zoneReportFile(dir, zone);
    if (!existsSync(f)) {
      console.error(`host-zones: FAIL ${zone}: no report at ${path.relative(ROOT, f)}`);
      rc = 1;
      continue;
    }
    const rep = readZoneReport(zone, f);
    reports.push(rep);
    const problems = zoneRunProblems(rep);
    for (const p of problems) console.error(`host-zones: FAIL ${p}`);
    const accepted = judgeSkips(rep).accepted.length;
    if (problems.length > 0) rc = 1;
    else console.log(`host-zones: ${zone} ran: ${rep.passed} tests passed, 0 failed, ${accepted > 0 ? `${accepted} skips accepted by name, ` : ''}host-zone probe passed`);
  }
  const same = zoneSetProblems(reports);
  for (const p of same) console.error(`host-zones: FAIL ${p}`);
  if (same.length > 0) rc = 1;
  else if (reports.length === HOST_ZONES.length) console.log(`host-zones: ${zoneSetLine(reports)}`);
  return rc;
}

/** F-373: node cli.ts pinned <report.json> <test name>...: each name passed in the report, and nothing was skipped. */
function pinned(file: string, names: string[]): number {
  const problems = pinnedProblems(path.resolve(file), names);
  for (const p of problems) console.error(`pinned: FAIL ${path.relative(ROOT, path.resolve(file))}: ${p}`);
  if (problems.length === 0) console.log(`pinned: ${names.length} pinned test${names.length === 1 ? '' : 's'} passed in ${path.relative(ROOT, path.resolve(file))}, none skipped`);
  return problems.length > 0 ? 1 : 0;
}

const [mode, dir, ...more] = process.argv.slice(2);
if (mode === 'tree') process.exit(await tree());
else if (mode === 'zones' && dir) process.exit(zones(path.resolve(dir)));
else if (mode === 'pinned' && dir && more.length > 0) process.exit(pinned(dir, more));
else {
  console.error('usage: node ci/gates/G-CI4/cli.ts tree | zones <dir> | pinned <report.json> <test name>...');
  process.exit(2);
}
