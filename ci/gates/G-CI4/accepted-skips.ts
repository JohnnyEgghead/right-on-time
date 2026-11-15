// SPDX-License-Identifier: AGPL-3.0-or-later
// The only skipped tests a G-CI4 host-zone run accepts (F-1422; read by lib.ts zoneRunProblems for cli.ts zones, so by
// G-CI4 step 3, G-CI4-nightly and G-CI9). Every other skipped or todo test stays red (F-178).
//
// Owner ruling Nov 11, 2026, dashboard question 341a9f4e, answer "Gate accepts the 2 named": "The gate allows exactly these
// 2 named Mac-only tests. Fastest: CP6 is not delayed. But the 2 tests still run in no CI gate."
//
// Each entry is 1 test by the zone report's own id, <file name>::<full name> (vitest's fullName: the describe titles and the
// it title joined by spaces), and the folder of its file from the repo root. A skip is accepted only when its file and its
// id match an entry exactly, and only as a skip (a todo stays red). An entry is stale, and red, naming its id:
//   - when its file is gone (any run);
//   - when a run holds its file but no test there has the name (renamed or deleted), or 2 tests do;
//   - when the test passed on a platform other than passesOn: it ran instead of skipping, so it is no longer Mac-only.
// On macOS both tests run and pass, which is why they are listed, so a pass there is not stale.
//
// The folder and the id stay apart, never 1 repo path: the F-410 walker in ci/run-gates.test.ts reads every repo path in a
// gate's files as a file that gate runs, and this list names tests without running them. A full path here made G-CI2, G-CI4
// and G-CI9 read as running render-session's staging.sh (a container start), which no gate of theirs does.
export interface AcceptedSkip {
  /** The folder of the test's file, from the repo root. */
  dir: string;
  /** The zone report's id: the file name, "::", and the test's full name. */
  id: string;
  /** The platform where the test runs and passes (process.platform); everywhere else it must skip. */
  passesOn: NodeJS.Platform;
  reason: string;
}

export const ACCEPTED_SKIPS_FILE = 'ci/gates/G-CI4/accepted-skips.ts';
export const ACCEPTED_SKIPS_RULING = 'owner ruling 341a9f4e';

export const ACCEPTED_ZONE_SKIPS: readonly AcceptedSkip[] = [
  {
    dir: 'infra/tests',
    id: 'render-session.test.ts::render-session (P6-TESTFLIGHT-4) refuses a mis-cased path into the repo (case-insensitive disks only)',
    passesOn: 'darwin',
    reason: 'Mac-only: it needs a case-insensitive disk (F-1352); the Linux CI disk is case-sensitive, so the test calls ctx.skip()',
  },
  {
    dir: 'infra/tests',
    id: 'seed-harold-photos.test.ts::F-1370 the pictures (macOS: rsvg-convert and sips) makes n labeled pictures, each matching a fresh render of its label, pairwise different, n by the count flag',
    passesOn: 'darwin',
    reason: 'Mac-only: the script makes real pictures with rsvg-convert and sips (macOS), so the describe is skipIf not darwin',
  },
];

/** The entry's file from the repo root: its folder and the file name its id starts with. */
export const acceptedSkipFile = (a: AcceptedSkip): string => `${a.dir}/${a.id.slice(0, a.id.indexOf('::'))}`;
