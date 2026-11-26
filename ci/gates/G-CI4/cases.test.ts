// SPDX-License-Identifier: AGPL-3.0-or-later
// Gate G-CI4's committed known-bad and known-good cases (W-38: they run on every gate run and in the merge set, not
// once by hand). Each instrument must fail its planted cases and pass its clean ones:
//   no-system-clock (the repo's eslint.config.mjs, inline config off), the realNow call-site listing, the host-zone
//   run check, and the use-tag list against SPECIFICATIONS sections 4.2 and 11.3.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REAL_TIME_USES } from '../../../packages/time/src/uses.ts';
import { ACCEPTED_SKIPS_RULING, ACCEPTED_ZONE_SKIPS, acceptedSkipFile } from './accepted-skips.ts';
import {
  CASES, ROOT, judgeSkips, loadCases, lintClockText, pinnedProblems, readZoneReport, specUnionTags, specUseTags, zoneRunProblems, zoneSetLine, zoneSetProblems,
  type SkipRules,
} from './lib.ts';
import { scanSource, scanTree } from './realnow-sites.ts';

// F-311: each case starts an ESLint run, which takes seconds on a loaded CI container; the 5 s default timed out 5 cases of one
// host-zone run (wave 13 closing pass, run 5), so the limit is stated.
vi.setConfig({ testTimeout: 60_000 });

const body = (text: string) => text.replace(/^\/\/ (case-as|expect):.*\n/gm, '');

describe('no-system-clock on the committed cases', () => {
  const cases = loadCases('no-system-clock');

  // why: FR-DEMO-2
  it('has the acceptance plant: a Date.now() outside @bw/time', () => {
    const plant = cases.find((c) => c.name === 'bad-date-now-in-app');
    expect(plant?.as).toBe('apps/web/src/planted.ts');
    expect(body(plant!.body)).toContain('Date.now()');
    expect(cases.filter((c) => c.expect === 'fail').length).toBeGreaterThanOrEqual(10);
    expect(cases.filter((c) => c.expect === 'pass').length).toBeGreaterThanOrEqual(3);
  });

  for (const c of cases) {
    // why: FR-DEMO-2 - a committed bad case fails the clock rule and a clean case passes it
    it(`${c.expect === 'fail' ? 'fails' : 'passes'} ${c.name} (as ${c.as})`, async () => {
      const out = await lintClockText(c.body, c.as);
      expect(out.fatal).toEqual([]);
      expect(out.hits.length, JSON.stringify(out.hits)).toBe(Number(c.detail));
      if (c.expect === 'fail') expect(out.hits[0]?.message).toMatch(/reads the system clock/);
    });
  }
});

describe('no-system-clock reads the F-177 survivors', () => {
  const survivors = [
    'bad-intl-format-no-argument',
    'bad-intl-format-to-parts-no-argument',
    'bad-date-alias',
    'bad-date-destructured',
    'bad-date-reflect-construct',
    'bad-new-date-empty-spread',
    'bad-mts-in-app',
    'bad-cts-in-package',
  ];
  const cases = loadCases('no-system-clock');

  for (const name of survivors) {
    // why: F-177 - a read the old syntax list let through must now fail the rule
    it(`fails ${name}`, async () => {
      const c = cases.find((x) => x.name === name);
      expect(c?.expect).toBe('fail');
      const out = await lintClockText(c!.body, c!.as);
      expect(out.hits.length).toBe(1);
    });
  }
});

describe('the realNow call-site listing on the committed cases', () => {
  const cases = loadCases('realnow-sites');

  // why: FR-DEMO-2
  it('has the acceptance plant: a call with an unlisted tag', () => {
    const plant = cases.find((c) => c.name === 'bad-unlisted-tag');
    expect(body(plant!.body)).toContain("realNow('wall_clock'");
  });

  for (const c of cases) {
    // why: FR-DEMO-2 - a bad realNow case reports a problem and a good one lists its call sites by tag
    it(`${c.expect === 'fail' ? 'fails' : 'lists'} ${c.name}`, () => {
      const scan = scanSource(c.body, c.as);
      if (c.expect === 'fail') {
        expect(scan.problems.length).toBeGreaterThan(0);
        expect(scan.problems.join('\n')).toContain(c.detail);
        expect(scan.problems[0]).toMatch(new RegExp(`^${c.as.replace(/[.]/g, '\\.')}:\\d+:\\d+: `));
      } else {
        expect(scan.problems).toEqual([]);
        expect(scan.sites.map((s) => s.tag)).toEqual(c.detail.split(','));
      }
    });
  }
});

describe('the realNow listing reads inside the seam (F-179)', () => {
  // why: F-179 - the seam's literal-tag call is listed, a forwarder is not, a bad tag in the seam fails
  it('lists clock_anchor in the seam, skips the forwarder, fails a bad tag and a non-parameter variable', () => {
    const cases = loadCases('realnow-sites');
    const get = (n: string) => scanSource(cases.find((c) => c.name === n)!.body, 'packages/time/src/planted.ts');
    expect(get('good-seam-literal-and-forwarder').sites.map((s) => s.tag)).toEqual(['clock_anchor']);
    expect(get('bad-seam-unlisted-tag').problems.join()).toContain('is not a real-time use');
    expect(get('bad-seam-variable-not-a-parameter').problems.join()).toContain('not a string literal');
  });

  // why: F-179 - the real tree lists the seam's clock_anchor site, not 0 sites
  it('lists packages/time/src/clock.ts clock_anchor in the real tree', () => {
    const scan = scanTree(ROOT);
    expect(scan.problems).toEqual([]);
    expect(scan.sites.some((s) => s.file === 'packages/time/src/clock.ts' && s.tag === 'clock_anchor')).toBe(true);
  });
});

describe('the host-zone run check on the committed reports', () => {
  const dir = path.join(CASES, 'zone-reports');
  const check = (f: string) => zoneRunProblems(readZoneReport('America/Los_Angeles', path.join(dir, f)));

  // why: NFR-08
  it('fails a run whose host-zone probe did not pass, a run with a failure, and a run where nothing passed', () => {
    expect(check('bad-probe-missing.json').join()).toMatch(/probe did not pass/);
    expect(check('bad-test-failed.json').join()).toMatch(/1 tests failed/);
    expect(check('bad-nothing-passed.json').join()).toMatch(/no test passed/);
  });

  // why: F-246 - a red zone run keeps its failing assertion text in the gate output
  it('names each failed test with its failure text, and says so when the report holds none', () => {
    expect(check('bad-test-failed-text.json').join('\n')).toMatch(/failed dst\.test\.ts::dst a visit booked in EDT is at 9:00 AM EST: Error: Test timed out in 5000ms\./);
    expect(check('bad-test-failed.json').join('\n')).toMatch(/failed ::a Mon, Nov 2, 2026 visit booked in EDT is at 9:00 AM EST: no failure text in the report/);
  });

  // why: NFR-08
  it('passes a run where the probe and every test passed', () => {
    expect(check('good-run.json')).toEqual([]);
  });

  // why: F-373 - a gate pins its acceptance tests by name: a report without the pinned test is red, one with it passes
  it('fails a report that lacks a pinned test name, and passes one that holds it, none skipped', () => {
    expect(pinnedProblems(path.join(dir, 'good-run.json'), ['a Mon, Nov 2, 2026 visit booked in EDT is at 9:00 AM EST'])).toEqual([]);
    expect(pinnedProblems(path.join(dir, 'good-run.json'), ['holds Deborah Lin']).join()).toMatch(/pinned test "holds Deborah Lin" did not run and pass/);
    expect(pinnedProblems(path.join(dir, 'bad-skipped.json'), []).join()).toMatch(/1 tests skipped or todo/);
  });

  // why: F-636 - a pin names exactly 1 test: G-CI9's old pin "holds Deborah Lin" also matched a quiet-hours unit test, so
  // deleting UC-14's db case left the gate green
  describe('a pin names exactly 1 test (F-636)', () => {
    const UC14 = "holds Deborah Lin's 10:29 AM EDT booking text to 8:00 AM Pacific (11:00 AM EDT) and sends it then";
    const pin = (f: string, name: string) => pinnedProblems(path.join(dir, f), [name]).join('\n');

    // why: F-636
    it('passes UC-14 by its exact title beside the unit test that shares its words, and refuses the shared words as a pin', () => {
      expect(pin('good-pin-uc14.json', UC14)).toBe('');
      expect(pin('good-pin-uc14.json', 'holds Deborah Lin')).toMatch(/pinned test "holds Deborah Lin" did not run and pass: no test has that exact title/);
    });

    // why: F-636
    it('fails a pin that matches 2 tests', () => {
      expect(pin('bad-pin-two-tests.json', UC14)).toMatch(/names 2 tests; a pin must name exactly 1 test/);
    });

    // why: F-636
    it('fails when the pinned test is removed, though a test sharing its words still passes', () => {
      expect(pin('bad-pin-uc14-removed.json', UC14)).toMatch(/did not run and pass: no test has that exact title/);
    });

    // why: F-636
    it('fails when the pinned test failed', () => {
      expect(pin('bad-pin-uc14-failed.json', UC14)).toMatch(/did not run and pass: it is failed/);
    });
  });

  // why: F-178 - a zone run with a skipped test is not a full run; F-1422 - the red names the skipped test
  it('fails a run that skipped a test, naming the skip', () => {
    expect(check('bad-skipped.json').join()).toMatch(/1 tests skipped or todo/);
    expect(check('bad-skipped.json')).toContain('America/Los_Angeles: skipped ::Deborah Lin books across the fall-back night (skipped)');
  });

  // why: F-1422 - the set line said "none skipped" when the 3 zones skipped the same test and the run check was red
  it('says none skipped only when no zone skipped a test', () => {
    const rep = (zone: string, f: string) => readZoneReport(zone, path.join(dir, f));
    const skips = [rep('UTC', 'bad-skipped.json'), rep('America/New_York', 'bad-skipped.json'), rep('America/Los_Angeles', 'bad-skipped.json')];
    expect(zoneSetProblems(skips)).toEqual([]);
    expect(zoneSetLine(skips)).toBe('the 3 zones passed the same 2 tests; skipped or todo, not on the accepted list: UTC 1, America/New_York 1, America/Los_Angeles 1');
    const good = [rep('UTC', 'good-run.json'), rep('America/New_York', 'good-run.json'), rep('America/Los_Angeles', 'good-run.json')];
    expect(zoneSetLine(good)).toMatch(/^the 3 zones passed the same \d+ tests, none skipped$/);
  });

  // why: F-178 - the 3 zones must pass the same tests
  it('fails when one zone passed fewer tests than another, and passes when the sets match', () => {
    const rep = (zone: string, f: string) => readZoneReport(zone, path.join(dir, f));
    const mismatch = zoneSetProblems([rep('UTC', 'good-run.json'), rep('America/New_York', 'good-run.json'), rep('America/Los_Angeles', 'bad-fewer-tests.json')]);
    expect(mismatch.join('\n')).toMatch(/America\/Los_Angeles: did not pass 1 tests that passed in UTC/);
    expect(zoneSetProblems([rep('UTC', 'good-run.json'), rep('America/New_York', 'good-run.json'), rep('America/Los_Angeles', 'good-run.json')])).toEqual([]);
  });
});

describe('the 2 Mac-only skips the zone check accepts by name (F-1422, owner ruling 341a9f4e)', () => {
  const dir = path.join(CASES, 'zone-reports');
  const RS = 'render-session.test.ts::render-session (P6-TESTFLIGHT-4) refuses a mis-cased path into the repo (case-insensitive disks only)';
  const PH = 'seed-harold-photos.test.ts::F-1370 the pictures (macOS: rsvg-convert and sips) makes n labeled pictures, each matching a fresh render of its label, pairwise different, n by the count flag';
  // The 2 files come from the list, not spelled out: a repo path here reads to the F-410 walker as a file G-CI4 runs (accepted-skips.ts).
  const [RS_FILE, PH_FILE] = ACCEPTED_ZONE_SKIPS.map(acceptedSkipFile) as [string, string];
  // The fixtures' paths are under /work, the root the container that wrote a real report ran in (F-1426).
  const linux = { platform: 'linux', root: '/work' };
  const rep = (zone: string, f: string) => readZoneReport(zone, path.join(dir, f));
  const check = (f: string, rules: SkipRules = linux) => zoneRunProblems(rep('UTC', f), rules);
  const all3 = (f: string) => [rep('UTC', f), rep('America/New_York', f), rep('America/Los_Angeles', f)];

  // why: F-1422 - the owner ruled the gate accepts exactly these 2 tests, so the list holds them and nothing else
  it('lists exactly the 2 named Mac-only tests, each with its reason, and both files exist', () => {
    expect(ACCEPTED_ZONE_SKIPS.map((a) => a.id)).toEqual([RS, PH]);
    expect(ACCEPTED_ZONE_SKIPS.map((a) => a.dir)).toEqual(['infra/tests', 'infra/tests']);
    expect(ACCEPTED_SKIPS_RULING).toBe('owner ruling 341a9f4e');
    for (const a of ACCEPTED_ZONE_SKIPS) {
      expect(a.passesOn).toBe('darwin');
      expect(a.reason).toMatch(/^Mac-only: /);
      expect(existsSync(path.join(ROOT, acceptedSkipFile(a))), acceptedSkipFile(a)).toBe(true);
    }
  });

  // why: F-1422 - on Linux the 2 listed tests skip; the run is green and the set line names both skips as accepted
  it('accepts the 2 listed skips, and the set line names them as accepted, never none skipped', () => {
    expect(check('good-accepted-skips.json')).toEqual([]);
    expect(judgeSkips(rep('UTC', 'good-accepted-skips.json'), linux)).toEqual({ accepted: [RS, PH], refused: [], stale: [] });
    expect(zoneSetProblems(all3('good-accepted-skips.json'))).toEqual([]);
    expect(zoneSetLine(all3('good-accepted-skips.json'), linux)).toBe(
      `the 3 zones passed the same 4 tests; 2 skips in each zone, accepted by name under owner ruling 341a9f4e (Mac-only tests): ${RS}; ${PH}`,
    );
  });

  // why: F-1422 - any skip the list does not name stays red, and the red names it, even beside the 2 accepted ones
  it('fails an unlisted it.skip beside the 2 accepted ones, naming only it', () => {
    const p = check('bad-unlisted-skip-beside-accepted.json');
    expect(p).toEqual([
      'UTC: 1 tests skipped or todo, not counting the 2 accepted by name (owner ruling 341a9f4e); a zone run must run every test',
      'UTC: skipped dst.test.ts::dst a planted it.skip beside the 2 accepted ones (skipped)',
    ]);
    expect(zoneSetLine(all3('bad-unlisted-skip-beside-accepted.json'), linux)).toMatch(
      /; skipped or todo, not on the accepted list: UTC 1, America\/New_York 1, America\/Los_Angeles 1; 2 skips in each zone, accepted by name under owner ruling 341a9f4e/,
    );
  });

  // why: F-1422 - a listed test renamed in its file is stale (the list cannot rot), and its skip under the new name is red
  it('fails a listed test that was renamed: stale by its listed id, and its skip as unlisted', () => {
    const p = check('bad-accepted-skip-renamed.json');
    expect(p).toContain('UTC: skipped render-session.test.ts::render-session (P6-TESTFLIGHT-4) refuses a mis-cased path into the repo (skipped)');
    expect(p).toContain(
      `UTC: stale accepted skip ${RS}: no test of ${RS_FILE} has that full name (renamed or deleted); fix or remove it in ci/gates/G-CI4/accepted-skips.ts`,
    );
    expect(p.filter((x) => x.includes('stale'))).toHaveLength(1);
  });

  // why: F-1422 - a listed test that ran and passed off the Mac is no longer Mac-only, so it is stale; on the Mac it passes by design
  it('fails the 2 listed tests as stale when they pass on Linux, and passes them on macOS', () => {
    expect(check('listed-tests-passed.json')).toEqual([
      `UTC: stale accepted skip ${RS}: it ran and passed on linux, so it is no longer darwin-only; remove it from ci/gates/G-CI4/accepted-skips.ts`,
      `UTC: stale accepted skip ${PH}: it ran and passed on linux, so it is no longer darwin-only; remove it from ci/gates/G-CI4/accepted-skips.ts`,
    ]);
    expect(check('listed-tests-passed.json', { platform: 'darwin', root: '/work' })).toEqual([]);
    expect(zoneSetLine(all3('listed-tests-passed.json'), { platform: 'darwin', root: '/work' })).toBe('the 3 zones passed the same 6 tests, none skipped');
  });

  // why: F-1422 - a run without the listed files (G-CI4 step 3, G-CI9) cannot judge their tests, but a listed file that is gone is stale in every run
  it('leaves a run without the listed files alone, and fails it when a listed file is gone', () => {
    expect(check('good-run.json')).toEqual([]);
    const gone = check('good-run.json', { platform: 'linux', root: '/work', exists: (f) => f !== PH_FILE });
    expect(gone).toEqual([`UTC: stale accepted skip ${PH}: its file ${PH_FILE} is gone; fix or remove it in ci/gates/G-CI4/accepted-skips.ts`]);
  });

  // why: F-1422 - an entry names exactly 1 test (as a pin does, F-636): a copy under the same name would also be accepted
  it('fails a listed id that names 2 tests', () => {
    expect(check('bad-accepted-skip-two-tests.json')).toEqual([
      `UTC: stale accepted skip ${RS}: names 2 tests of ${RS_FILE}; an entry must name exactly 1; fix or remove it in ci/gates/G-CI4/accepted-skips.ts`,
    ]);
  });

  // why: F-1425 - the accepted-skip match refuses a listed id that is todo, not skipped: dropping the status test went green
  it('fails a listed test that is todo, naming it with its status', () => {
    expect(check('bad-listed-skip-as-todo.json')).toContain(`UTC: skipped ${RS} (todo)`);
    expect(judgeSkips(rep('UTC', 'bad-listed-skip-as-todo.json'), linux).accepted).toEqual([PH]);
  });

  // why: F-1425 and F-1426 - a listed id and name in a file outside the listed path (here packages/extra/infra/tests) is not accepted, suffix or not
  it('fails a listed test whose file is a copy under another directory ending in the listed path', () => {
    const p = check('bad-listed-skip-nested-dir.json');
    expect(p).toContain(`UTC: skipped ${RS} (skipped)`);
    expect(judgeSkips(rep('UTC', 'bad-listed-skip-nested-dir.json'), linux).accepted).toEqual([PH]);
  });
});

// F-1852: docs/SPECIFICATIONS.md is a private path (scripts/private-paths.txt), so in a public copy this case skips with a note
// naming it; the private checkout has it and the case runs.
const noSpec = existsSync(path.resolve(import.meta.dirname, '..', '..', '..', 'docs', 'SPECIFICATIONS.md'))
  ? '' : 'docs/SPECIFICATIONS.md is not in this copy (a private path the public export leaves out)';

describe('the use tags', () => {
  // why: FR-DEMO-2
  it('are exactly the named real-time uses of SPECIFICATIONS section 11.3, and its section 4.2 union', (ctx) => {
    if (noSpec) ctx.skip(noSpec);
    expect([...REAL_TIME_USES]).toEqual(specUseTags());
    expect([...REAL_TIME_USES]).toEqual(specUnionTags());
  });
});
